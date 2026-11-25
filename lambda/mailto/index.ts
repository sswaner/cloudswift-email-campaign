import { S3Handler, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { recordUnsubscribe, resolveContactByEmailHash } from '../lib/unsubscribe';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createHash } from 'crypto';

const s3 = new S3Client({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function extractMailtoToken(address: string): string | null {
  // u-{token}@optout.lexara.vip
  const match = address.match(/^u-([^@]+)@/i);
  return match ? match[1] : null;
}

export const handler: S3Handler = async (event: S3Event) => {
  const unsubTokensTable = requireEnv('UNSUB_TOKENS_TABLE');
  const recipientsTable = requireEnv('RECIPIENTS_TABLE');

  for (const record of event.Records) {
    const { bucket, object } = record.s3;
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: bucket.name, Key: object.key }),
    );
    const raw = await obj.Body?.transformToString();
    if (!raw) continue;

    const parsed = await simpleParser(raw);
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    const toAddress = to?.text || '';
    const fromAddress = parsed.from?.text || '';

    let token = extractMailtoToken(toAddress);
    let resolved: { contactId: string; emailHash: string; campaignId?: string; recipientId?: string; email?: string } | null = null;

    if (token) {
      const result = await docClient.send(
        new GetCommand({
          TableName: unsubTokensTable,
          Key: { mailto_token: token },
        }),
      );
      if (result.Item) {
        resolved = {
          contactId: result.Item.contact_id as string,
          emailHash: result.Item.email_hash as string,
          campaignId: result.Item.campaign_id as string,
          recipientId: result.Item.recipient_id as string,
          email: result.Item.email as string,
        };
      }
    }

    // Fallback: match From address against contacts by email hash
    if (!resolved && fromAddress) {
      const emailMatch = fromAddress.match(/<([^>]+)>/);
      const rawEmail = emailMatch ? emailMatch[1] : fromAddress;
      const emailHash = hashEmail(rawEmail);
      const contact = await resolveContactByEmailHash(emailHash);
      if (contact) {
        resolved = {
          contactId: contact.contactId,
          emailHash,
          email: contact.email,
        };
        console.log(`Mailto fallback matched From address ${rawEmail} to contact ${contact.contactId}; marked needs_review`);
        // Don't auto-unsubscribe from fallback; record as pending review
        continue;
      }
    }

    if (!resolved) {
      console.log('No recipient resolved for mailto unsubscribe');
      continue;
    }

    await recordUnsubscribe({
      emailHash: resolved.emailHash,
      contactId: resolved.contactId,
      campaignId: resolved.campaignId,
      recipientId: resolved.recipientId,
      method: 'mailto',
      scope: 'global',
      sourceCampaignId: resolved.campaignId,
      unsubscribedAt: new Date().toISOString(),
    });
  }
};
