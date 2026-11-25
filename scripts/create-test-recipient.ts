import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createSecureToken, generateMailtoToken } from '../lib/tokens';
import { ulid } from 'ulidx';
import { createHash } from 'crypto';

const region = process.env.AWS_REGION || 'us-east-1';
const secretArn = process.env.TOKEN_KEYS_SECRET_ARN || '';
const contactsTable = process.env.CONTACTS_TABLE || '';
const recipientsTable = process.env.RECIPIENTS_TABLE || '';
const unsubTokensTable = process.env.UNSUB_TOKENS_TABLE || '';

if (!secretArn || !contactsTable || !recipientsTable || !unsubTokensTable) {
  console.error('Set TOKEN_KEYS_SECRET_ARN, CONTACTS_TABLE, RECIPIENTS_TABLE, UNSUB_TOKENS_TABLE');
  process.exit(1);
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

async function main() {
  const sm = new SecretsManagerClient({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const secret = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const parsed = JSON.parse(secret.SecretString || '{}');
  const keys: { [kid: string]: Buffer } = {};
  for (const [kid, val] of Object.entries(parsed)) {
    if (typeof val === 'string') {
      keys[kid] = Buffer.from(val, 'base64url');
    }
  }

  const contactId = process.env.CONTACT_ID || ulid();
  const campaignId = 'test-campaign';
  const recipientId = 'test-recipient-001';
  const email = 'shawnswaner@gmail.com';
  const emailHash = hashEmail(email);
  const mailtoToken = generateMailtoToken();

  await ddb.send(
    new PutCommand({
      TableName: contactsTable,
      Item: {
        contact_id: contactId,
        email_hash: emailHash,
        email,
        first_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }),
  );

  await ddb.send(
    new PutCommand({
      TableName: recipientsTable,
      Item: {
        campaign_id: campaignId,
        recipient_id: recipientId,
        contact_id: contactId,
        email,
        email_hash: emailHash,
        domain: 'gmail.com',
        provider: 'google',
        priority: 3,
        status: 'QUEUED',
        created_at: new Date().toISOString(),
      },
    }),
  );

  const { token: secureToken } = createSecureToken(keys, campaignId, contactId, recipientId);

  await ddb.send(
    new PutCommand({
      TableName: unsubTokensTable,
      Item: {
        mailto_token: mailtoToken,
        secure_token: secureToken,
        contact_id: contactId,
        email_hash: emailHash,
        campaign_id: campaignId,
        recipient_id: recipientId,
        email,
        created_at: new Date().toISOString(),
      },
    }),
  );

  console.log('Test contact created:');
  console.log('  contact_id:', contactId);
  console.log('  campaign_id:', campaignId);
  console.log('  recipient_id:', recipientId);
  console.log('  email:', email);
  console.log('  email_hash:', emailHash);
  console.log('  mailto_token:', mailtoToken);
  console.log('  secure_token:', secureToken);
  console.log('');
  console.log('Landing page:');
  console.log(`  https://unsub.lexara.vip/p/${secureToken}`);
  console.log('One-click POST URL:');
  console.log(`  https://unsub.lexara.vip/u/${secureToken}`);
  console.log('Mailto unsubscribe:');
  console.log(`  u-${mailtoToken}@optout.lexara.vip`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
