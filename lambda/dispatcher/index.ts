import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { createSecureToken, generateMailtoToken } from '../../lib/tokens';
import { loadTokenKeys } from '../lib/keys';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sesClient = new SESv2Client({});

interface Context {
  fromAddress: string;
  replyToAddress: string;
  configurationSetName: string;
  recipientsTable: string;
  unsubTokensTable: string;
  contactsTable: string;
  domainId: string;
  maxPerInvocation: number;
  sendWindowTimezone: string;
  sendWindowStart: string;
  sendWindowEnd: string;
  sendWindowDays: number[];
}

function getContext(): Context {
  return {
    fromAddress: requireEnv('FROM_ADDRESS'),
    replyToAddress: requireEnv('REPLY_TO_ADDRESS'),
    configurationSetName: requireEnv('CONFIGURATION_SET_NAME'),
    recipientsTable: requireEnv('RECIPIENTS_TABLE'),
    unsubTokensTable: requireEnv('UNSUB_TOKENS_TABLE'),
    contactsTable: requireEnv('CONTACTS_TABLE'),
    domainId: requireEnv('DOMAIN_ID'),
    maxPerInvocation: parseInt(process.env.MAX_PER_INVOCATION || '1', 10),
    sendWindowTimezone: process.env.SEND_WINDOW_TIMEZONE || 'America/Detroit',
    sendWindowStart: process.env.SEND_WINDOW_START || '08:00',
    sendWindowEnd: process.env.SEND_WINDOW_END || '17:00',
    sendWindowDays: (process.env.SEND_WINDOW_DAYS || '1,2,3,4,5').split(',').map((d) => parseInt(d, 10)),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function isInSendWindow(ctx: Context): boolean {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ctx.sendWindowTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value || 'Sun');
  const hourMin = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
  if (!ctx.sendWindowDays.includes(day)) return false;
  return hourMin >= ctx.sendWindowStart && hourMin <= ctx.sendWindowEnd;
}

async function fetchQueuedRecipients(ctx: Context, limit: number) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: ctx.recipientsTable,
      IndexName: 'by-status',
      KeyConditionExpression: 'campaign_id = :c AND #status = :s',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':c': ctx.domainId, ':s': 'QUEUED' },
      Limit: limit,
    }),
  );
  return result.Items || [];
}

function buildEmailBody(ctx: Context, recipient: Record<string, unknown>, token: string, mailtoToken: string): { text: string; html: string } {
  const email = recipient.email as string;
  const maskedEmail = email.replace(/(.{2}).+(@.+)/, '$1***$2');
  const unsubUrl = `https://${process.env.UNSUB_DOMAIN || 'unsub.lexara.vip'}/p/${token}`;
  const oneClickUrl = `https://${process.env.UNSUB_DOMAIN || 'unsub.lexara.vip'}/u/${token}`;
  const mailtoAddr = `u-${mailtoToken}@${process.env.OPTOUT_DOMAIN || 'optout.lexara.vip'}`;

  const text = `Hi there,

This is a test campaign message from Lexara.

Unsubscribe: ${unsubUrl}
Or reply to ${mailtoAddr} with subject "Unsubscribe".

Lexara
500 W. Hickman #318, Waukee, IA 50263
`;

  const html = `<!doctype html>
<html><body>
<p>Hi there,</p>
<p>This is a test campaign message from Lexara.</p>
<p><a href="${unsubUrl}">Unsubscribe</a></p>
<p style="font-size:12px;color:#666;">
  You are receiving this because ${maskedEmail} is on our mailing list.<br>
  Lexara · 500 W. Hickman #318, Waukee, IA 50263
</p>
</body></html>`;

  return { text, html };
}

async function sendOne(ctx: Context, recipient: Record<string, unknown>, keys: Record<string, Buffer>): Promise<{ messageId?: string; error?: string }> {
  const campaignId = recipient.campaign_id as string;
  const recipientId = recipient.recipient_id as string;
  const contactId = recipient.contact_id as string;
  const email = recipient.email as string;
  const emailHash = recipient.email_hash as string;

  const mailtoToken = generateMailtoToken();
  const { token: secureToken } = createSecureToken(keys, campaignId, contactId, recipientId);

  // Store token mapping
  await docClient.send(
    new UpdateCommand({
      TableName: ctx.unsubTokensTable,
      Key: { mailto_token: mailtoToken },
      UpdateExpression: 'SET secure_token = :s, contact_id = :c, email_hash = :h, campaign_id = :camp, recipient_id = :r, email = :e, created_at = :now',
      ExpressionAttributeValues: {
        ':s': secureToken,
        ':c': contactId,
        ':h': emailHash,
        ':camp': campaignId,
        ':r': recipientId,
        ':e': email,
        ':now': new Date().toISOString(),
      },
    }),
  );

  const { text, html } = buildEmailBody(ctx, recipient, secureToken, mailtoToken);

  const input: SendEmailCommandInput = {
    FromEmailAddress: ctx.fromAddress,
    Destination: { ToAddresses: [email] },
    ConfigurationSetName: ctx.configurationSetName,
    Content: {
      Simple: {
        Subject: { Data: 'Test campaign from Lexara' },
        Body: { Text: { Data: text }, Html: { Data: html } },
        Headers: [
          { Name: 'List-Unsubscribe', Value: `<mailto:${mailtoToken}@${process.env.OPTOUT_DOMAIN || 'optout.lexara.vip'}?subject=Unsubscribe>, <https://${process.env.UNSUB_DOMAIN || 'unsub.lexara.vip'}/u/${secureToken}>` },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        ],
      },
    },
  };

  try {
    const result = await sesClient.send(new SendEmailCommand(input));
    return { messageId: result.MessageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

async function markSent(ctx: Context, recipient: Record<string, unknown>, messageId?: string, error?: string) {
  const status = error ? 'FAILED' : 'SENT';
  await docClient.send(
    new UpdateCommand({
      TableName: ctx.recipientsTable,
      Key: {
        campaign_id: recipient.campaign_id as string,
        recipient_id: recipient.recipient_id as string,
      },
      UpdateExpression: 'SET #status = :s, sent_at = :now, ses_message_id = :mid, last_error = :err',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':now': new Date().toISOString(),
        ':mid': messageId || null,
        ':err': error || null,
      },
    }),
  );
}

export async function handler(): Promise<{ sent: number; failed: number; skipped: number }> {
  const ctx = getContext();
  if (!isInSendWindow(ctx)) {
    console.log('Outside send window; skipping.');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const keys = await loadTokenKeys();
  const recipients = await fetchQueuedRecipients(ctx, ctx.maxPerInvocation);
  if (recipients.length === 0) {
    console.log('No queued recipients.');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const result = await sendOne(ctx, recipient, keys);
    await markSent(ctx, recipient, result.messageId, result.error);
    if (result.messageId) sent++;
    else failed++;
  }

  console.log(`Dispatcher done: sent=${sent}, failed=${failed}`);
  return { sent, failed, skipped: 0 };
}
