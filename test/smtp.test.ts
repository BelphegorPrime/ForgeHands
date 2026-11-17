// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The SMTP client against a real loopback server written here. The key pair under test/fixtures is a throwaway self-signed one for 127.0.0.1 and localhost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { SmtpChannel, quotedPrintable, dotStuff, encodeSubject, headerValue, isAddress } from '../src/notify/smtp.ts';
import { WebhookChannel } from '../src/notify/webhook.ts';

const KEY = readFileSync(new URL('./fixtures/smtp-throwaway-test-key.pem', import.meta.url));
const CERT = readFileSync(new URL('./fixtures/smtp-throwaway-test-cert.pem', import.meta.url));
const PASSWORD = 'correct horse battery staple';

// A server that speaks enough SMTP: EHLO with STARTTLS and AUTH capabilities, the STARTTLS upgrade, AUTH PLAIN and LOGIN, DATA.
async function server(options = {}) {
  const { starttls = false, implicit = false, auth = 'plain login', password = PASSWORD, silent = false, echoPassword = false } = options;
  const state = { sessions: 0, commands: [], from: null, rcpt: [], raw: null, message: null, user: null, mechanism: null, sawPassword: null };
  const serve = (socket, greet = true) => {
    let buffer = '';
    let data = null;
    let login = null;
    const secure = socket instanceof tls.TLSSocket;
    const send = (text) => socket.write(text + '\r\n');
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    if (greet) { state.sessions += 1; if (!silent) send('220 test.local ESMTP'); }
    const check = (user, pass) => {
      state.user = user; state.sawPassword = pass;
      if (pass === password) send('235 2.7.0 accepted');
      else send('535 5.7.8 authentication failed' + (echoPassword ? ' for ' + pass : ''));
    };
    const lines = () => {
      for (;;) {
        if (data !== null) {
          data += buffer; buffer = '';
          const end = data.indexOf('\r\n.\r\n');
          if (end < 0) return;
          state.raw = data.slice(0, end + 2);
          state.message = state.raw.replace(/(^|\r\n)\.\./g, '$1.');
          data = null;
          send('250 2.0.0 queued');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (login === 'user') { login = 'pass'; state.loginUser = Buffer.from(line, 'base64').toString(); send('334 UGFzc3dvcmQ6'); continue; }
        if (login === 'pass') { login = null; check(state.loginUser, Buffer.from(line, 'base64').toString()); continue; }
        state.commands.push(line.split(' ')[0].toUpperCase());
        if (/^EHLO/i.test(line)) {
          const caps = ['test.local'];
          if (starttls && !secure) caps.push('STARTTLS');
          if (auth && (secure || implicit || !starttls)) caps.push('AUTH ' + auth.toUpperCase());
          caps.push('8BITMIME');
          send(caps.map((cap, i) => '250' + (i === caps.length - 1 ? ' ' : '-') + cap).join('\r\n'));
        } else if (/^STARTTLS/i.test(line)) {
          send('220 2.0.0 ready');
          socket.removeAllListeners('data');
          serve(new tls.TLSSocket(socket, { isServer: true, key: KEY, cert: CERT }), false);
          return;
        } else if (/^AUTH PLAIN /i.test(line)) {
          state.mechanism = 'PLAIN';
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000');
          check(user, pass);
        } else if (/^AUTH LOGIN/i.test(line)) { state.mechanism = 'LOGIN'; login = 'user'; send('334 VXNlcm5hbWU6'); }
        else if (/^MAIL FROM:/i.test(line)) { state.from = line.slice(10); send('250 ok'); }
        else if (/^RCPT TO:/i.test(line)) { state.rcpt.push(line.slice(8)); send('250 ok'); }
        else if (/^DATA/i.test(line)) { data = ''; send('354 go ahead'); }
        else if (/^QUIT/i.test(line)) { send('221 bye'); socket.end(); return; }
        else send('502 not implemented');
      }
    };
    socket.on('data', (chunk) => { buffer += chunk; lines(); });
  };
  const srv = implicit ? tls.createServer({ key: KEY, cert: CERT }, serve) : net.createServer((socket) => serve(socket));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { state, port: srv.address().port, close: () => new Promise((resolve) => { srv.close(resolve); srv.closeAllConnections?.(); }) };
}

const channel = (port, extra = {}) => new SmtpChannel({ host: '127.0.0.1', port, security: 'starttls', user: 'forgehands', password: PASSWORD, from: 'forgehands@example.org',
  to: ['marcel@example.org'], tlsVerify: false, ca: null, connectTimeoutMs: 2000, commandTimeoutMs: 2000, ...extra });
const mail = { kind: 'handover', subject: '[homegraf] #140 waits for you to merge', text: 'Reviewed, CI green.\n.a line that starts with a dot\nÜber 200 € and a long line ' + 'word '.repeat(40) + '\nend', link: 'https://forge.example/o/r/pulls/140' };
const decodeQp = (text) => Buffer.from(text.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
const parts = (message) => { const [head, ...rest] = message.split('\r\n\r\n'); return { head, body: rest.join('\r\n\r\n'), headers: Object.fromEntries(head.split('\r\n').map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 2)])) }; };

test('SMTP: STARTTLS and AUTH PLAIN deliver the message with the right headers, a dot-stuffed quoted-printable body and CRLF line ends', async () => {
  const srv = await server({ starttls: true });
  try {
    await channel(srv.port).send(mail);
    assert.equal(srv.state.mechanism, 'PLAIN');
    assert.equal(srv.state.user, 'forgehands');
    assert.equal(srv.state.from, '<forgehands@example.org>');
    assert.deepEqual(srv.state.rcpt, ['<marcel@example.org>']);
    assert.deepEqual(srv.state.commands.slice(0, 3), ['EHLO', 'STARTTLS', 'EHLO']);
    const { headers, body } = parts(srv.state.message);
    assert.equal(headers.from, 'forgehands@example.org');
    assert.equal(headers.to, 'marcel@example.org');
    assert.equal(headers.subject, '[homegraf] #140 waits for you to merge');
    assert.equal(headers['mime-version'], '1.0');
    assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(headers['content-transfer-encoding'], 'quoted-printable');
    assert.match(headers.date, /^\w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/);
    assert.match(headers['message-id'], /^<[0-9a-f]{24}@example\.org>$/);
    // The wire form has the second dot, the receiver takes it away again.
    assert.ok(srv.state.raw.includes('\r\n..a line that starts with a dot'));
    assert.ok(srv.state.message.includes('\r\n.a line that starts with a dot'));
    assert.ok(!/(?<!\r)\n/.test(srv.state.raw), 'every line ends with CRLF');
    assert.ok(srv.state.raw.split('\r\n').every((line) => line.length <= 78));
    assert.equal(decodeQp(body).replace(/\r\n/g, '\n').trimEnd(), mail.text + '\n\n' + mail.link);
  } finally { await srv.close(); }
});

test('SMTP: every message gets its own Message-ID', async () => {
  const ids = new Set();
  for (let i = 0; i < 2; i++) {
    const srv = await server({ starttls: true });
    try { await channel(srv.port).send(mail); ids.add(parts(srv.state.message).headers['message-id']); } finally { await srv.close(); }
  }
  assert.equal(ids.size, 2);
});

test('SMTP: AUTH LOGIN is used when PLAIN is not offered', async () => {
  const srv = await server({ starttls: true, auth: 'login' });
  try {
    await channel(srv.port).send(mail);
    assert.equal(srv.state.mechanism, 'LOGIN');
    assert.equal(srv.state.user, 'forgehands');
    assert.equal(srv.state.sawPassword, PASSWORD);
  } finally { await srv.close(); }
});

test('SMTP: implicit TLS (port 465 style) and no encryption at all both deliver', async () => {
  const implicit = await server({ implicit: true });
  try {
    await channel(implicit.port, { security: 'tls' }).send(mail);
    assert.equal(implicit.state.user, 'forgehands');
    assert.ok(implicit.state.message);
  } finally { await implicit.close(); }
  const plain = await server({ auth: '' });
  try {
    await channel(plain.port, { security: 'none', user: null, password: null }).send(mail);
    assert.ok(plain.state.message);
    assert.equal(plain.state.user, null);
  } finally { await plain.close(); }
});

test('SMTP: a wrong password is an error, and neither the error nor a server that echoes it shows the password', async () => {
  const srv = await server({ starttls: true, password: 'something else', echoPassword: true });
  try {
    await assert.rejects(channel(srv.port).send(mail), (error) => {
      assert.match(error.message, /AUTH PLAIN was refused: 535/);
      assert.ok(!error.message.includes(PASSWORD), error.message);
      assert.ok(!error.message.includes(Buffer.from(PASSWORD).toString('base64')));
      return true;
    });
    assert.equal(srv.state.message, null);
  } finally { await srv.close(); }
});

test('SMTP: TLS verification refuses a self-signed certificate, SMTP_TLS_VERIFY=0 accepts it, and a CA file trusts it', async () => {
  const srv = await server({ starttls: true });
  try {
    await assert.rejects(channel(srv.port, { tlsVerify: true }).send(mail), /self.signed|certificate/i);
    assert.equal(srv.state.user, null, 'no password went over a connection that failed verification');
    await channel(srv.port, { tlsVerify: false }).send(mail);
    assert.ok(srv.state.message);
    srv.state.message = null;
    await channel(srv.port, { tlsVerify: true, ca: CERT.toString() }).send(mail);
    assert.ok(srv.state.message);
  } finally { await srv.close(); }
  const implicit = await server({ implicit: true });
  try { await assert.rejects(channel(implicit.port, { security: 'tls', tlsVerify: true }).send(mail), /self.signed|certificate/i); } finally { await implicit.close(); }
});

test('SMTP: a server without STARTTLS is an error, never a reason to send the password in clear text', async () => {
  const srv = await server({ starttls: false });
  try {
    await assert.rejects(channel(srv.port).send(mail), /does not offer STARTTLS/);
    assert.equal(srv.state.user, null);
  } finally { await srv.close(); }
  // And a password to a host that is not this machine is refused before any connection is made.
  await assert.rejects(channel(1, { security: 'none', host: '192.0.2.1' }).send(mail), /clear text/);
});

test('SMTP: CR and LF in a subject or an address cannot inject a header or a command', async () => {
  const srv = await server({ starttls: true });
  try {
    await channel(srv.port).send({ ...mail, subject: 'hello\r\nBcc: evil@example.org\r\n\r\ninjected body' });
    const { head, headers } = parts(srv.state.message);
    assert.ok(!/^bcc:/im.test(head));
    assert.equal(headers.subject, 'hello Bcc: evil@example.org injected body');
    assert.equal(srv.state.rcpt.length, 1);
    const before = srv.state.sessions;
    await assert.rejects(channel(srv.port, { to: ['a@example.org\r\nRCPT TO:<x@example.org>'] }).send(mail), /not a plain address/);
    await assert.rejects(channel(srv.port, { from: 'a@example.org>\r\nMAIL FROM:<x@example.org' }).send(mail), /not a plain address/);
    await assert.rejects(channel(srv.port, { to: ['not an address'] }).send(mail), /not a plain address/);
    assert.equal(srv.state.sessions, before, 'refused before connecting');
  } finally { await srv.close(); }
  assert.equal(headerValue('a\r\nb\u0000c\td'), 'a b c d');
  assert.ok(isAddress('forgehands@example.org') && !isAddress('a@b@c') && !isAddress('a b@c.d') && !isAddress('<a@b.c>'));
});

test('SMTP: a non-ASCII subject is an RFC 2047 encoded word, and a long one is cut at 200 characters', async () => {
  const srv = await server({ starttls: true });
  try {
    const subject = 'Prüfung fällig: ✓ ' + 'ü'.repeat(300);
    await channel(srv.port).send({ ...mail, subject });
    const header = srv.state.message.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
    const value = /^Subject: (.*)$/m.exec(header)[1];
    assert.match(value, /^=\?UTF-8\?B\?/);
    const decoded = value.split(' ').map((word) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)[1], 'base64').toString('utf8')).join('');
    assert.equal(Array.from(decoded).length, 200);
    assert.ok(decoded.startsWith('Prüfung fällig: ✓ ü'));
    assert.ok(srv.state.message.split('\r\n').every((line) => line.length <= 78));
  } finally { await srv.close(); }
  assert.equal(encodeSubject('plain ascii'), 'plain ascii');
  assert.equal(encodeSubject('x'.repeat(500)).length, 200);
});

test('SMTP: a server that does not answer times out, with a message that names no secret', async () => {
  const srv = await server({ silent: true });
  try {
    const started = Date.now();
    await assert.rejects(channel(srv.port, { commandTimeoutMs: 150 }).send(mail), /did not answer within 0\.2 s|did not answer/);
    assert.ok(Date.now() - started < 2000);
  } finally { await srv.close(); }
  // Nothing listens: the connect error is reported, not hung.
  await assert.rejects(channel(1, { connectTimeoutMs: 300 }).send(mail), /ECONNREFUSED|timed out/);
});

test('quoted-printable and dot-stuffing: encoded, wrapped at 76, trailing blanks kept, a lone dot line doubled', () => {
  const encoded = quotedPrintable('a=b ü\r\ntrailing \r\n' + 'x'.repeat(200));
  assert.ok(encoded.includes('a=3Db =C3=BC'));
  assert.ok(encoded.includes('trailing=20\r\n'));
  assert.ok(encoded.split('\r\n').every((line) => line.length <= 76));
  assert.equal(decodeQp(encoded), 'a=b ü\r\ntrailing \r\n' + 'x'.repeat(200));
  assert.equal(dotStuff('a\r\n.\r\n..b\r\n'), 'a\r\n..\r\n...b\r\n\r\n.\r\n');
});

test('webhook channel: posts the message as JSON with the optional Authorization header; an error names neither URL nor token', async () => {
  const seen = [];
  let status = 200;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(body) }); res.writeHead(status); res.end('{}'); });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + srv.address().port + '/hook/secret-path-token';
  try {
    await new WebhookChannel(url, 'Bearer tok-1').send({ kind: 'blocked', subject: 'S', text: 'T', link: 'https://x/y' });
    assert.deepEqual(seen[0].body, { subject: 'S', text: 'T', link: 'https://x/y', kind: 'blocked' });
    assert.equal(seen[0].auth, 'Bearer tok-1');
    assert.equal(seen[0].type, 'application/json');
    await new WebhookChannel(url, null).send({ kind: 'digest', subject: 'S', text: 'T' });
    assert.equal(seen[1].auth, undefined);
    assert.equal(seen[1].body.link, null);
    status = 500;
    await assert.rejects(new WebhookChannel(url, 'Bearer tok-1').send({ kind: 'digest', subject: 'S', text: 'T' }), (error) => { assert.match(error.message, /HTTP 500/); assert.doesNotMatch(error.message, /secret-path-token|tok-1/); return true; });
  } finally { srv.close(); }
  await assert.rejects(new WebhookChannel('http://127.0.0.1:1/secret-path-token', 'Bearer tok-1').send({ kind: 'digest', subject: 'S', text: 'T' }), (error) => { assert.doesNotMatch(error.message, /secret-path-token|tok-1/); return true; });
});
