import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { TokenKeys } from '../../lib/tokens';

let cachedKeys: TokenKeys | undefined;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function loadTokenKeys(): Promise<TokenKeys> {
  const now = Date.now();
  if (cachedKeys && now - cacheTime < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const secretArn = process.env.TOKEN_KEYS_SECRET_ARN;
  if (!secretArn) {
    throw new Error('TOKEN_KEYS_SECRET_ARN not set');
  }

  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!response.SecretString) {
    throw new Error('Token keys secret is empty');
  }

  const parsed = JSON.parse(response.SecretString);
  const keys: TokenKeys = {};
  for (const [kid, keyValue] of Object.entries(parsed)) {
    if (typeof keyValue !== 'string') {
      throw new Error(`Invalid key value for ${kid}`);
    }
    // Support both raw strings (from CDK-generated secret) and base64url-encoded keys
    const isBase64Url = /^[A-Za-z0-9_-]+$/.test(keyValue) && keyValue.length % 4 !== 1 && Buffer.from(keyValue, 'base64url').toString('base64url') === keyValue;
    keys[kid] = isBase64Url ? Buffer.from(keyValue, 'base64url') : Buffer.from(keyValue, 'utf-8');
  }

  cachedKeys = keys;
  cacheTime = now;
  return keys;
}
