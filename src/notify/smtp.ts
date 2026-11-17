// A small SMTP client over node:net and node:tls, enough to hand one plain text message to a server: plain, STARTTLS or implicit TLS,
// AUTH PLAIN (AUTH LOGIN as a fallback), dot-stuffing, multi-line replies, timeouts. No library.
// Header safety: every value that goes into a header or an SMTP command is cleaned of control characters first, and an address that does
// not match a plain pattern is refused. Errors never contain the password, and nothing here logs.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { Channel, Notification } from './channel.ts';

export interface SmtpOptions {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user: string | null;
  password: string | null;
  from: string;
  to: string[];
  /** false accepts a certificate that does not verify (self-signed); `ca` trusts a PEM instead of the system store. */
  tlsVerify: boolean;
  ca: string | null;
  /** The name for EHLO. */
  hostname?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const MAX_SUBJECT = 200;

export const isAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value);

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// A header value on one line: control characters (CR and LF above all) become a space, so nothing can start a header of its own.
export function headerValue(value: string): string {
  return String(value).replace(CONTROL, ' ').trim();
}

// Cut by characters, not by UTF-16 units, so that no half of a surrogate pair is left.
function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

// RFC 2047: a subject with non-ASCII characters becomes encoded words (=?UTF-8?B?...?=), each at most 75 characters, folded with CRLF and a space.
export function encodeSubject(subject: string): string {
  const clean = cut(headerValue(subject), MAX_SUBJECT);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let current = '';
  for (const char of Array.from(clean)) {
    if (Buffer.byteLength(current + char) > 42) { words.push(current); current = ''; }
    current += char;
  }
  if (current) words.push(current);
  return words.map((word) => '=?UTF-8?B?' + Buffer.from(word, 'utf8').toString('base64') + '?=').join('\r\n ');
}

// Quoted-printable (RFC 2045) of UTF-8 text with CRLF line ends: lines of at most 76 characters, '=' and non-ASCII bytes as =XX, white space at
// the end of a line encoded. Chosen over 8bit because a server without 8BITMIME would damage 8bit text.
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const tokens: string[] = [];
    const bytes = Buffer.from(line, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      tokens.push(plain ? String.fromCharCode(byte) : '=' + byte.toString(16).toUpperCase().padStart(2, '0'));
    }
    let row = '';
    for (const token of tokens) {
      // 75 characters plus the soft line break "=" stay within 76.
      if (row.length + token.length > 75) { out.push(row + '='); row = ''; }
      row += token;
    }
    out.push(row);
  }
  return out.join('\r\n');
}

// The whole message as it goes over the wire in DATA (before dot-stuffing).
export function buildMessage(options: Pick<SmtpOptions, 'from' | 'to'>, message: Notification, now = new Date(), hostPart?: string): string {
  const domain = hostPart || options.from.split('@')[1] || 'localhost';
  const body = message.text + (message.link ? '\n\n' + headerless(message.link) : '');
  return [
    'Date: ' + now.toUTCString().replace('GMT', '+0000'),
    'From: ' + options.from,
    'To: ' + options.to.join(', '),
    'Subject: ' + encodeSubject(message.subject),
    'Message-ID: <' + randomBytes(12).toString('hex') + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(body)
  ].join('\r\n');
}

// The link is on a line of its own in the body; one line, no control characters.
const headerless = (link: string): string => headerValue(link);

// Each line that starts with a dot gets a second one (RFC 5321 4.5.2); the data ends with CRLF.CRLF.
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..') + '\r\n.\r\n';
}

interface Reply { code: number; lines: string[] }

// Reads the replies of a socket, a reply being one or more lines "250-..." ending with "250 ...".
class Wire {
  socket!: net.Socket;
  buffer = '';
  replies: Reply[] = [];
  pending: string[] = [];
  failure: Error | null = null;
  waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  data = (chunk: string) => {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) { this.fail(new Error('SMTP server sent too much data')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      const match = /^(\d{3})([ -])(.*)$/.exec(line) || /^(\d{3})()$/.exec(line);
      if (!match) { this.fail(new Error('SMTP server sent a line that is not a reply')); return; }
      this.pending.push(match[3] ?? '');
      if (match[2] !== '-') {
        this.replies.push({ code: Number(match[1]), lines: this.pending });
        this.pending = [];
      }
    }
    this.flush();
  };
  closed = () => this.fail(new Error('the SMTP connection was closed'));
  errored = (error: Error) => this.fail(error);

  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', this.data);
    socket.on('error', this.errored);
    socket.on('close', this.closed);
  }
  detach(): void {
    this.socket.off('data', this.data);
    this.socket.off('error', this.errored);
    this.socket.off('close', this.closed);
  }
  fail(error: Error): void {
    this.failure ||= error;
    if (this.waiter) { clearTimeout(this.waiter.timer); const { reject } = this.waiter; this.waiter = null; reject(this.failure); }
  }
  flush(): void {
    if (this.waiter && this.replies.length) { clearTimeout(this.waiter.timer); const { resolve } = this.waiter; this.waiter = null; resolve(this.replies.shift()!); }
  }
  read(timeoutMs: number): Promise<Reply> {
    if (this.replies.length) return Promise.resolve(this.replies.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('the SMTP server did not answer within ' + Math.round(timeoutMs / 1000 * 10) / 10 + ' s')); }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
}

// Waits for one event of a socket, an error or the time limit, whichever comes first.
function once(socket: net.Socket, event: string, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(what + ' timed out after ' + Math.round(ms / 1000 * 10) / 10 + ' s')); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); socket.off(event, done); socket.off('error', fail); };
    socket.once(event, done);
    socket.once('error', fail);
  });
}

export class SmtpChannel implements Channel {
  name = 'smtp';
  options: SmtpOptions;

  constructor(options: SmtpOptions) {
    this.options = options;
  }

  // Replaces the password (and its base64 form) wherever a message of a library or the server might repeat it.
  scrub(text: string): string {
    const { password } = this.options;
    if (!password) return text;
    return text.split(password).join('***').split(Buffer.from(password).toString('base64')).join('***');
  }

  async send(message: Notification): Promise<void> {
    try { await this.deliver(message); }
    catch (error) { throw new Error(this.scrub(String(error?.message || error))); }
  }

  async deliver(message: Notification): Promise<void> {
    const { from, to, host, port, security, user, password } = this.options;
    const commandMs = this.options.commandTimeoutMs ?? 30000;
    const connectMs = this.options.connectTimeoutMs ?? 10000;
    // Refused before anything is sent: an address that does not match, no recipient.
    const sender = headerValue(from);
    const recipients = to.map(headerValue);
    if (sender !== from || !isAddress(sender)) throw new Error('SMTP_FROM is not a plain address');
    if (!recipients.length || recipients.some((address, i) => address !== to[i] || !isAddress(address))) throw new Error('SMTP_TO holds an address that is not a plain address');
    if (user !== null && security === 'none' && !isLoopback(host)) throw new Error('refusing to send the SMTP password in clear text to ' + host + ' (use starttls or tls)');
    const data = dotStuff(buildMessage({ from: sender, to: recipients }, message));

    const wire = new Wire();
    const tlsOptions = { rejectUnauthorized: this.options.tlsVerify, ...(this.options.ca ? { ca: this.options.ca } : {}), ...(net.isIP(host) ? {} : { servername: host }) };
    let socket: net.Socket;
    if (security === 'tls') {
      socket = tls.connect({ host, port, ...tlsOptions });
      wire.attach(socket);
      await once(socket, 'secureConnect', connectMs, 'the TLS connection');
    } else {
      socket = net.connect({ host, port });
      wire.attach(socket);
      await once(socket, 'connect', connectMs, 'the connection');
    }
    try {
      const expect = async (label: string, ok: number[], ms = commandMs): Promise<Reply> => {
        const reply = await wire.read(ms);
        if (!ok.includes(reply.code)) throw new Error('SMTP ' + label + ' was refused: ' + reply.code + ' ' + reply.lines.join(' ').slice(0, 200));
        return reply;
      };
      const command = async (line: string, label: string, ok: number[]): Promise<Reply> => {
        wire.socket.write(line + '\r\n');
        return expect(label, ok);
      };
      let encrypted = security === 'tls';
      await expect('greeting', [220]);
      const hello = (): Promise<Reply> => command('EHLO ' + (this.options.hostname || 'forgehands'), 'EHLO', [250]);
      let capabilities = (await hello()).lines.map((line) => line.toUpperCase());
      if (security === 'starttls') {
        // No fallback to clear text: a server without STARTTLS is an error, never a reason to send the password openly.
        if (!capabilities.some((line) => line === 'STARTTLS')) throw new Error('the SMTP server does not offer STARTTLS');
        await command('STARTTLS', 'STARTTLS', [220]);
        wire.socket.on('error', () => {}); // an error of the raw socket is reported through the TLS socket that wraps it
        wire.detach();
        const secure = tls.connect({ socket: wire.socket, ...tlsOptions });
        wire.buffer = '';
        wire.attach(secure);
        socket = secure;
        await once(secure, 'secureConnect', connectMs, 'the TLS handshake');
        encrypted = true;
        capabilities = (await hello()).lines.map((line) => line.toUpperCase());
      }
      if (user !== null) {
        if (!encrypted && !isLoopback(host)) throw new Error('refusing to send the SMTP password in clear text to ' + host);
        const mechanisms = capabilities.filter((line) => /^AUTH[ =]/.test(line)).flatMap((line) => line.slice(5).split(/\s+/));
        const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
        if (mechanisms.includes('PLAIN')) await command('AUTH PLAIN ' + b64('\u0000' + user + '\u0000' + (password ?? '')), 'AUTH PLAIN', [235]);
        else if (mechanisms.includes('LOGIN')) {
          await command('AUTH LOGIN', 'AUTH LOGIN', [334]);
          await command(b64(user), 'AUTH LOGIN user', [334]);
          await command(b64(password ?? ''), 'AUTH LOGIN password', [235]);
        } else throw new Error('the SMTP server offers neither AUTH PLAIN nor AUTH LOGIN');
      }
      await command('MAIL FROM:<' + sender + '>', 'MAIL FROM', [250]);
      for (const address of recipients) await command('RCPT TO:<' + address + '>', 'RCPT TO', [250, 251]);
      await command('DATA', 'DATA', [354]);
      wire.socket.write(data);
      await expect('message', [250]);
      try { wire.socket.write('QUIT\r\n'); } catch { /* the message is delivered; QUIT is a courtesy */ }
    } finally {
      wire.detach();
      wire.socket.on('error', () => {});
      wire.socket.destroy();
      socket.destroy();
    }
  }
}
