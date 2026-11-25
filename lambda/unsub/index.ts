import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { verifySecureToken, generateMailtoToken } from '../../lib/tokens';
import { loadTokenKeys } from '../lib/keys';
import { recordUnsubscribe, recordSubscribe, isSuppressed } from '../lib/unsubscribe';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface Context {
  unsubTokensTable: string;
  recipientsTable: string;
  domainId: string;
}

function getContext(): Context {
  return {
    unsubTokensTable: requireEnv('UNSUB_TOKENS_TABLE'),
    recipientsTable: requireEnv('RECIPIENTS_TABLE'),
    domainId: requireEnv('DOMAIN_ID'),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function htmlResponse(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body,
  };
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const maskedLocal = local.length <= 2 ? '*'.repeat(local.length) : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
  return `${maskedLocal}@${domain}`;
}

async function resolveSecureToken(ctx: Context, token: string): Promise<{ emailHash: string; campaignId: string; recipientId: string; email?: string } | null> {
  const keys = await loadTokenKeys();
  let payload;
  try {
    payload = verifySecureToken(keys, token);
  } catch {
    return null;
  }
  const recipient = await docClient.send(
    new GetCommand({
      TableName: ctx.recipientsTable,
      Key: { campaign_id: payload.campaignId, recipient_id: payload.recipientId },
    }),
  );
  if (!recipient.Item) return null;
  return {
    emailHash: recipient.Item.email_hash as string,
    campaignId: payload.campaignId,
    recipientId: payload.recipientId,
    email: recipient.Item.email as string,
  };
}

async function resolveMailtoToken(ctx: Context, token: string): Promise<{ emailHash: string; campaignId: string; recipientId: string; email?: string } | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: ctx.unsubTokensTable,
      Key: { mailto_token: token },
    }),
  );
  if (!result.Item) return null;
  return {
    emailHash: result.Item.email_hash as string,
    campaignId: result.Item.campaign_id as string,
    recipientId: result.Item.recipient_id as string,
    email: result.Item.email as string,
  };
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; }
    button { padding: 12px 24px; font-size: 16px; cursor: pointer; }
    .reason { margin: 16px 0; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const ctx = getContext();
  const method = event.requestContext.http.method;
  const path = event.rawPath || '';

  // POST /u/{token} — RFC 8058 one-click unsubscribe
  const oneClickMatch = path.match(/^\/u\/([^/]+)$/);
  if (oneClickMatch && method === 'POST') {
    const token = oneClickMatch[1];
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8').toString('utf-8') : '';
    if (!body.includes('List-Unsubscribe=One-Click')) {
      return jsonResponse(400, { error: 'Invalid one-click request' });
    }
    const resolved = await resolveSecureToken(ctx, token);
    if (!resolved) return htmlResponse(200, '');
    await recordUnsubscribe({
      emailHash: resolved.emailHash,
      campaignId: resolved.campaignId,
      recipientId: resolved.recipientId,
      method: 'one_click',
      scope: 'global',
      sourceCampaignId: resolved.campaignId,
      unsubscribedAt: new Date().toISOString(),
    });
    return { statusCode: 200, body: '' };
  }

  // GET /u/{token} — show landing page (never unsubscribe on GET)
  if (oneClickMatch && method === 'GET') {
    const token = oneClickMatch[1];
    const resolved = await resolveSecureToken(ctx, token);
    const email = resolved?.email;
    const masked = email ? maskEmail(email) : 'this address';
    const body = page('Unsubscribe', `
      <h1>Unsubscribe</h1>
      <p>Confirm that you want to unsubscribe <strong>${masked}</strong> from Lexara emails.</p>
      <form method="post" action="/p/${token}">
        <div class="reason">
          <label>Optional: why are you leaving?</label><br>
          <select name="reason">
            <option value="">—</option>
            <option value="no_longer_relevant">No longer relevant</option>
            <option value="too_frequent">Too frequent</option>
            <option value="did_not_sign_up">I didn't sign up</option>
            <option value="other">Other</option>
          </select>
        </div>
        <button type="submit">Unsubscribe</button>
      </form>
    `);
    return htmlResponse(200, body);
  }

  // GET /p/{token} — landing page
  const pageMatch = path.match(/^\/p\/([^/]+)$/);
  if (pageMatch && method === 'GET') {
    const token = pageMatch[1];
    const resolved = await resolveSecureToken(ctx, token);
    const email = resolved?.email;
    const masked = email ? maskEmail(email) : 'this address';
    const body = page('Unsubscribe', `
      <h1>Unsubscribe</h1>
      <p>Confirm that you want to unsubscribe <strong>${masked}</strong> from Lexara emails.</p>
      <form method="post" action="/p/${token}">
        <div class="reason">
          <label>Optional: why are you leaving?</label><br>
          <select name="reason">
            <option value="">—</option>
            <option value="no_longer_relevant">No longer relevant</option>
            <option value="too_frequent">Too frequent</option>
            <option value="did_not_sign_up">I didn't sign up</option>
            <option value="other">Other</option>
          </select>
        </div>
        <button type="submit">Unsubscribe</button>
      </form>
    `);
    return htmlResponse(200, body);
  }

  // POST /p/{token} — confirm unsubscribe
  if (pageMatch && method === 'POST') {
    const token = pageMatch[1];
    const resolved = await resolveSecureToken(ctx, token);
    if (!resolved) {
      return htmlResponse(200, page('Unsubscribed', '<p>You have been unsubscribed.</p>'));
    }
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8').toString('utf-8') : '';
    const params = new URLSearchParams(body);
    const reason = params.get('reason') || undefined;
    await recordUnsubscribe({
      emailHash: resolved.emailHash,
      campaignId: resolved.campaignId,
      recipientId: resolved.recipientId,
      method: 'landing_page',
      reason,
      scope: 'global',
      sourceCampaignId: resolved.campaignId,
      unsubscribedAt: new Date().toISOString(),
    });
    const bodyHtml = page('Unsubscribed', `
      <h1>You are unsubscribed</h1>
      <p>${resolved.email ? maskEmail(resolved.email) : 'This address'} will no longer receive Lexara emails.</p>
      <p><a href="/s">Subscribe again</a></p>
    `);
    return htmlResponse(200, bodyHtml);
  }

  // GET /s — subscribe form
  if (path === '/s' && method === 'GET') {
    const body = page('Subscribe', `
      <h1>Subscribe</h1>
      <form method="post" action="/s">
        <label>Email address<br><input type="email" name="email" required style="width:100%;padding:8px"></label>
        <br><br>
        <button type="submit">Request subscription</button>
      </form>
    `);
    return htmlResponse(200, body);
  }

  // POST /s — request subscribe (Phase 2 stub: sends confirmation email)
  if (path === '/s' && method === 'POST') {
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8').toString('utf-8') : '';
    const params = new URLSearchParams(body);
    const email = params.get('email');
    if (!email || !email.includes('@')) {
      return htmlResponse(400, page('Error', '<p>Please provide a valid email address.</p>'));
    }
    // TODO: send confirmation email
    return htmlResponse(200, page('Check your email', '<p>A confirmation email has been sent. Click the link in that email to complete your subscription.</p>'));
  }

  return jsonResponse(404, { error: 'Not found' });
}
