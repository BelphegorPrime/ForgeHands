import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

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
