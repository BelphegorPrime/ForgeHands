import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const STATUS_COOKIE = 'forgehands_status';
const SESSION_MS = 8 * 60 * 60 * 1000;

// Does the Authorization header carry the token? `Bearer <token>`, or HTTP basic auth with the token as password (any user name), so that
// a browser can open the page. Both sides are hashed first, so the comparison takes the same time whatever the length of the guess.
export function hasToken(header: string | string[] | undefined, token: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return false;
  let given = '';
  const bearer = /^Bearer +(\S+)$/i.exec(value);
  if (bearer) given = bearer[1];
  else {
    const basic = /^Basic +(\S+)$/i.exec(value);
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      given = decoded.slice(decoded.indexOf(':') + 1);
    }
  }
  return timingSafeEqual(digest(given), digest(token)) && given.length > 0;
}

export function statusSessionCookie(token: string, now = Date.now(), secure = false): string {
  const expires = now + SESSION_MS;
  const signature = createHmac('sha256', token).update(STATUS_COOKIE + ':' + expires).digest('base64url');
  return STATUS_COOKIE + '=' + expires + '.' + signature + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800' + (secure ? '; Secure' : '');
}

export function hasStatusSession(cookie: string | undefined, token: string, now = Date.now()): boolean {
  const value = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(STATUS_COOKIE + '='))?.slice(STATUS_COOKIE.length + 1);
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value || '');
  if (!match || Number(match[1]) <= now) return false;
  const expected = createHmac('sha256', token).update(STATUS_COOKIE + ':' + match[1]).digest();
  const given = Buffer.from(match[2], 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
