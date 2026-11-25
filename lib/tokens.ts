import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface TokenPayload {
  v: number;
  kid: string;
  campaignId: string;
  contactId: string;
  recipientId: string;
  issuedAt: number;
}

export interface TokenKeys {
  [kid: string]: Buffer;
}

export function base64UrlEncode(input: Buffer): string {
  return input.toString('base64url');
}

export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function generateMailtoToken(): string {
  // 16 bytes -> 26 chars base64url, prefixed with 'u' for unsubscribe
  return 'u' + base64UrlEncode(randomBytes(16));
}

export function createSecureToken(
  keys: TokenKeys,
  campaignId: string,
  contactId: string,
  recipientId: string,
): { token: string; kid: string; payload: TokenPayload } {
  const kids = Object.keys(keys);
  if (kids.length === 0) {
    throw new Error('No token signing keys configured');
  }
  const kid = kids[kids.length - 1]; // use latest key
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    v: 1,
    kid,
    campaignId,
    contactId,
    recipientId,
    issuedAt,
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', keys[kid])
    .update(payloadBuf)
    .digest()
    .slice(0, 22);
  const token = `${base64UrlEncode(payloadBuf)}.${base64UrlEncode(signature)}`;
  return { token, kid, payload };
}

export function verifySecureToken(keys: TokenKeys, token: string): TokenPayload {
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) {
    throw new Error('Invalid token format');
  }
  const payloadBuf = base64UrlDecode(payloadB64);
  const providedSig = base64UrlDecode(sigB64);
  let payload: TokenPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf-8'));
  } catch {
    throw new Error('Invalid token payload');
  }
  const key = keys[payload.kid];
  if (!key) {
    throw new Error('Unknown token key');
  }
  const expectedSig = createHmac('sha256', key).update(payloadBuf).digest().slice(0, 22);
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new Error('Invalid token signature');
  }
  return payload;
}
