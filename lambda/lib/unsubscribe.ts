import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

export interface UnsubscribeEvent {
  emailHash: string;
  campaignId: string;
  recipientId?: string;
  method: 'one_click' | 'landing_page' | 'mailto' | 'manual';
  reason?: string;
  scope: 'global';
  sourceCampaignId: string;
  unsubscribedAt: string;
}

export interface SubscribeEvent {
  emailHash: string;
  method: 'confirmed_opt_in' | 'operator_recorded';
  evidence: string;
  scope: 'global';
  requestedAt?: string;
  confirmedAt: string;
  confirmationIp?: string;
  confirmationUserAgent?: string;
}

export interface SuppressionResult {
  wasSuppressed: boolean;
  firstAt?: string;
  recorded: boolean;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export async function isSuppressed(emailHash: string): Promise<boolean> {
  const tableName = getEnv('SUPPRESSION_TABLE');
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { email_hash: emailHash },
    }),
  );
  return !!result.Item;
}

export async function recordUnsubscribe(event: UnsubscribeEvent): Promise<SuppressionResult> {
  const suppressionTable = getEnv('SUPPRESSION_TABLE');
  const ledgerTable = getEnv('SUBSCRIPTION_LEDGER_TABLE');
  const recipientsTable = getEnv('RECIPIENTS_TABLE');
  const eventBucket = getEnv('EVENT_BUCKET');

  const now = event.unsubscribedAt;
  const eventId = `unsub_${now}_${event.emailHash.slice(0, 8)}`;

  // Idempotent suppression write
  const existing = await docClient.send(
    new GetCommand({
      TableName: suppressionTable,
      Key: { email_hash: event.emailHash },
    }),
  );

  if (!existing.Item) {
    await docClient.send(
      new PutCommand({
        TableName: suppressionTable,
        Item: {
          email_hash: event.emailHash,
          scope: event.scope,
          reason: 'UNSUBSCRIBE',
          method: event.method,
          source_campaign_id: event.campaignId,
          first_at: now,
          last_at: now,
          count: 1,
        },
        ConditionExpression: 'attribute_not_exists(email_hash)',
      }),
    );
  } else {
    await docClient.send(
      new UpdateCommand({
        TableName: suppressionTable,
        Key: { email_hash: event.emailHash },
        UpdateExpression: 'SET last_at = :now ADD count :one',
        ExpressionAttributeValues: {
          ':now': now,
          ':one': 1,
        },
      }),
    );
  }

  // Append-only ledger entry
  await docClient.send(
    new PutCommand({
      TableName: ledgerTable,
      Item: {
        email_hash: event.emailHash,
        ts_event_id: `${now}#${eventId}`,
        event_type: 'unsubscribe',
        scope: event.scope,
        method: event.method,
        reason: event.reason ?? null,
        campaign_id: event.campaignId,
        source_campaign_id: event.sourceCampaignId,
        recipient_id: event.recipientId ?? null,
        at: now,
      },
    }),
  );

  // Update recipient row if we know the recipient
  if (event.recipientId && event.campaignId) {
    await docClient.send(
      new UpdateCommand({
        TableName: recipientsTable,
        Key: {
          campaign_id: event.campaignId,
          recipient_id: event.recipientId,
        },
        UpdateExpression: 'SET unsubscribed_at = :now, unsub_method = :method, #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':now': now,
          ':method': event.method,
          ':status': 'UNSUBSCRIBED',
        },
      }),
    );
  }

  // Write event to event lake (async, best-effort)
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});
    const dt = now.slice(0, 10).replace(/-/g, '-'); // assuming ISO string
    await s3.send(
      new PutObjectCommand({
        Bucket: eventBucket,
        Key: `events/unsubscribe/dt=${dt}/${eventId}.json`,
        Body: JSON.stringify({
          event_id: eventId,
          event_type: 'unsubscribe',
          source: 'unsub',
          ts: now,
          domain_id: 'lexara',
          campaign_id: event.campaignId,
          recipient_id: event.recipientId ?? null,
          email_hash: event.emailHash,
          method: event.method,
          reason: event.reason ?? null,
        }),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    console.error('Failed to write event lake object', err);
  }

  return {
    wasSuppressed: !!existing.Item,
    firstAt: existing.Item ? existing.Item.first_at : now,
    recorded: true,
  };
}

export async function recordSubscribe(event: SubscribeEvent): Promise<void> {
  const suppressionTable = getEnv('SUPPRESSION_TABLE');
  const ledgerTable = getEnv('SUBSCRIPTION_LEDGER_TABLE');
  const eventBucket = getEnv('EVENT_BUCKET');

  const now = event.confirmedAt;
  const eventId = `sub_${now}_${event.emailHash.slice(0, 8)}`;

  // Remove from suppression table
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: suppressionTable,
        Key: { email_hash: event.emailHash },
        ConditionExpression: 'attribute_exists(email_hash)',
      }),
    );
  } catch (err: any) {
    if (err.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
    // Already not suppressed; continue to ledger
  }

  // Append-only ledger entry
  await docClient.send(
    new PutCommand({
      TableName: ledgerTable,
      Item: {
        email_hash: event.emailHash,
        ts_event_id: `${now}#${eventId}`,
        event_type: 'subscribe',
        scope: event.scope,
        method: event.method,
        evidence: event.evidence,
        requested_at: event.requestedAt ?? null,
        confirmed_at: event.confirmedAt,
        confirmation_ip: event.confirmationIp ?? null,
        confirmation_user_agent: event.confirmationUserAgent ?? null,
        at: now,
      },
    }),
  );

  // Write event to event lake
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});
    const dt = now.slice(0, 10);
    await s3.send(
      new PutObjectCommand({
        Bucket: eventBucket,
        Key: `events/subscribe/dt=${dt}/${eventId}.json`,
        Body: JSON.stringify({
          event_id: eventId,
          event_type: 'subscribe',
          source: 'unsub',
          ts: now,
          domain_id: 'lexara',
          email_hash: event.emailHash,
          method: event.method,
          evidence: event.evidence,
        }),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    console.error('Failed to write event lake object', err);
  }
}
