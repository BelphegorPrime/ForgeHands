// SMTP_*, NOTIFY_* and HUMAN_MENTION, validated like the rest of the configuration: a wrong value is an error that names the variable.
import { readFileSync } from 'node:fs';
import type { NotifyConfig, NotifyLanguage } from '../types.ts';
import { NOTIFY_KINDS } from '../types.ts';
import { isAddress, isLoopback } from './smtp.ts';

const HOST = /^[A-Za-z0-9._-]+$|^\[?[0-9A-Fa-f:.]+\]?$/;

function flag(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(name + ' must be 0 or 1');
}

export function notifyChannels(notify: Pick<NotifyConfig, 'smtp' | 'webhook'>): string[] {
  return [...(notify.smtp ? ['smtp'] : []), ...(notify.webhook ? ['webhook'] : [])];
}

export function parseNotify(env: NodeJS.ProcessEnv): NotifyConfig {
  const get = (name: string): string => String(env[name] ?? '').trim();
  const humanMention = flag(env.HUMAN_MENTION, 'HUMAN_MENTION', true);

  // SMTP is configured when host, sender and recipient are all there; one of the three or a login alone is a half-configured setup.
  let smtp: NotifyConfig['smtp'] = null;
  const named = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_TO', 'SMTP_USER', 'SMTP_PASSWORD'].filter((name) => get(name));
  if (named.length) {
    const missing = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_TO'].filter((name) => !get(name));
    if (missing.length) throw new Error('SMTP is half configured: ' + missing.join(', ') + (missing.length > 1 ? ' are' : ' is') + ' missing (SMTP_HOST, SMTP_FROM and SMTP_TO are needed together)');
    const host = get('SMTP_HOST');
    if (!HOST.test(host)) throw new Error('SMTP_HOST must be a host name or an address');
    const port = get('SMTP_PORT') === '' ? 587 : Number(get('SMTP_PORT'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid TCP port');
    const security = (get('SMTP_SECURITY') || 'starttls').toLowerCase();
    if (security !== 'starttls' && security !== 'tls' && security !== 'none') throw new Error('SMTP_SECURITY must be starttls, tls or none');
    const from = get('SMTP_FROM');
    if (!isAddress(from)) throw new Error('SMTP_FROM must be a plain address such as forgehands@example.org');
    const to = get('SMTP_TO').split(',').map((value) => value.trim()).filter(Boolean);
    if (!to.length || to.some((address) => !isAddress(address))) throw new Error('SMTP_TO must be a comma separated list of plain addresses');
    const user = env.SMTP_USER ? String(env.SMTP_USER) : null;
    const password = env.SMTP_PASSWORD ? String(env.SMTP_PASSWORD) : null;
    if ((user === null) !== (password === null)) throw new Error('SMTP_USER and SMTP_PASSWORD are set together or not at all');
    if (user !== null && /[\u0000-\u001f]/.test(user + password)) throw new Error('SMTP_USER and SMTP_PASSWORD must not contain control characters');
    if (user !== null && security === 'none' && !isLoopback(host)) throw new Error('SMTP_USER needs SMTP_SECURITY=starttls or tls: a password must not travel in clear text (only to localhost it may)');
    const tlsVerify = flag(env.SMTP_TLS_VERIFY, 'SMTP_TLS_VERIFY', true);
    let ca: string | null = null;
    if (get('SMTP_CA_FILE')) {
      try { ca = readFileSync(get('SMTP_CA_FILE'), 'utf8'); } catch { throw new Error('SMTP_CA_FILE cannot be read'); }
      if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('SMTP_CA_FILE must be a PEM file with a certificate');
    }
    smtp = { host, port, security, user, password, from, to, tlsVerify, ca };
  }

  let webhook: NotifyConfig['webhook'] = null;
  if (get('NOTIFY_WEBHOOK_URL')) {
    let url: URL;
    try { url = new URL(get('NOTIFY_WEBHOOK_URL')); } catch { throw new Error('NOTIFY_WEBHOOK_URL must be a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('NOTIFY_WEBHOOK_URL requires http(s) and no embedded credentials');
    const auth = get('NOTIFY_WEBHOOK_AUTH') || null;
    if (auth && /[\u0000-\u001f\u007f]/.test(auth)) throw new Error('NOTIFY_WEBHOOK_AUTH must not contain control characters');
    webhook = { url: url.toString(), auth };
  } else if (get('NOTIFY_WEBHOOK_AUTH')) throw new Error('NOTIFY_WEBHOOK_AUTH needs NOTIFY_WEBHOOK_URL');

  const immediate = [...new Set(get('NOTIFY_IMMEDIATE').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const unknown = immediate.find((kind) => !(NOTIFY_KINDS as readonly string[]).includes(kind));
  if (unknown) throw new Error('NOTIFY_IMMEDIATE names ' + unknown + ', the kinds are ' + NOTIFY_KINDS.join(', '));

  const digest = get('NOTIFY_DIGEST') || null;
  if (digest !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(digest)) throw new Error('NOTIFY_DIGEST must be a time such as 08:00 (HH:MM)');

  const timezone = get('NOTIFY_TIMEZONE') || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('NOTIFY_TIMEZONE must be an IANA time zone such as Europe/Berlin'); }

  const language = (get('NOTIFY_LANGUAGE') || 'en').toLowerCase();
  if (language !== 'en' && language !== 'de') throw new Error('NOTIFY_LANGUAGE must be en or de');

  if ((immediate.length || digest) && !smtp && !webhook) {
    throw new Error((immediate.length ? 'NOTIFY_IMMEDIATE' : 'NOTIFY_DIGEST') + ' needs a channel: set SMTP_HOST, SMTP_FROM and SMTP_TO, or NOTIFY_WEBHOOK_URL');
  }
  return { smtp, webhook, immediate, digest, timezone, language: language as NotifyLanguage, humanMention };
}
