import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret, raw) {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function verifyForgejoSignature(secret, raw, header) {
  if (typeof header !== 'string' || !/^[a-f0-9]{64}$/i.test(header)) return false;
  const expected = Buffer.from(signPayload(secret, raw), 'hex');
  const actual = Buffer.from(header, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function deliveryId(headers, raw, event) {
  const candidate = headers['x-forgejo-delivery'] || headers['x-gitea-delivery'];
  if (typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(candidate)) {
    return candidate;
  }
  return createHash('sha256').update(event + ':').update(raw).digest('hex');
}
