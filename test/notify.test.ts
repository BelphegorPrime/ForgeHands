// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { Merger } from '../src/agent/merge.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Notifier, RETRY_DELAYS_MS, mentionOf } from '../src/notify/index.ts';
import { immediateMessage, digestMessage, cleanTitle } from '../src/notify/texts.ts';
import { buildMessage } from '../src/notify/smtp.ts';
import { buildStatus } from '../src/server/status.ts';
import { metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const DAY = 86400000;
const quiet = { error() {} };
let dir; let clock;

const SMTP = { SMTP_HOST: 'smtp.invalid', SMTP_FROM: 'forgehands@example.org', SMTP_TO: 'marcel@example.org' };
const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' }, 'ai:other': { profile: WORKER, tier: 'strong' } }),
  FORGEJO_TOKEN: 'tok', FORGEJO_URL: 'https://forge.example',
  HUMAN_LOGIN: 'marcel',
  MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml', 'stacks/**'], reasons: { 'stacks/**': 'stacks are deployed to production' } } }),
  APPROVAL_GRACE_SECONDS: '0', ARCHIVE_AFTER_DAYS: '0',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});
const fakeChannel = () => ({ name: 'fake', sent: [], fail: 0, async send(message) { if (this.fail > 0) { this.fail -= 1; throw new Error('boom'); } this.sent.push(message); } });
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
const notifier = (channel, immediate = ['handover', 'blocked', 'conflict', 'failed', 'reminder'], dry = () => false) => new Notifier([channel], immediate, dry, quiet, () => {});

function fakeForgejo(routes) {
  const calls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    calls.push({ method: request.method, path: u.pathname, body: request.body ? JSON.parse(request.body) : undefined });
    const route = routes[request.method + ' ' + u.pathname];
    if (route === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => (typeof route === 'function' ? route(u) : route) };
  };
  return { calls, send, comments: () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')).map((call) => call.body.body) };
}
const VERDICT_OK = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.mjs line 12, check bash validate.sh exit 0. '.repeat(8);
const pullRoute = (over = {}) => ({ state: 'open', merged: false, mergeable: true, title: 'Fix it', html_url: 'https://forge.example/owner/hello/pulls/34', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }], ...over });
const routes = (over = {}) => ({
  ['GET ' + API + '/pulls/34']: pullRoute(),
  ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'success', total_count: 2 },
  ['GET ' + API + '/pulls/34/files']: [{ filename: 'README.md' }],
  ['GET ' + API + '/git/commits/cafe0000cafe']: { created: '2026-11-15T10:00:00Z' },
  ['GET ' + API + '/issues/34/comments']: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: VERDICT_OK }],
  ['PATCH ' + API + '/pulls/34']: {}, ['POST ' + API + '/pulls/34/merge']: {}, ['POST ' + API + '/issues/34/comments']: {}, ['PATCH ' + API + '/issues/26']: {},
  ['GET ' + API + '/labels']: [], ['POST ' + API + '/labels']: { id: 1, name: 'ai:blocked' }, ['POST ' + API + '/issues/34/labels']: {}, ['GET ' + API + '/issues/34/labels']: [{ name: 'ai:approved', id: 2 }], ['DELETE ' + API + '/issues/34/labels/2']: {},
  ...over
});
const approvedEvent = () => ({ repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 } });
async function merging(extra, over, channel = fakeChannel(), immediate) {
  const config = loadConfig(env({ ...SMTP, NOTIFY_IMMEDIATE: 'handover,blocked,conflict,failed,reminder', ...extra }));
  const forgejo = fakeForgejo(routes(over));
  const merger = new Merger(config, forgejo.send, quiet);
  merger.notifier = notifier(channel, immediate);
  return { config, forgejo, merger, channel };
}
async function dispatching(extra, channel = fakeChannel(), immediate) {
  const config = loadConfig(env({ ...SMTP, NOTIFY_IMMEDIATE: 'handover,blocked,conflict,failed,reminder', ...extra }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo(routes());
  return { config, jobs, forgejo, channel, dispatcher: new Dispatcher(config, jobs, forgejo.send, quiet, () => clock, notifier(channel, immediate)) };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-notify-')); clock = Date.parse('2026-11-17T06:00:00Z'); metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

// ---- configuration

test('notifications are off by default: no channel, no immediate kind, no digest, UTC, English, the mention stays', () => {
  const { notify } = loadConfig(env());
  assert.deepEqual(notify, { smtp: null, webhook: null, immediate: [], digest: null, timezone: 'UTC', language: 'en', humanMention: true });
});

test('SMTP and notification variables are validated and every error names its variable', async () => {
  const ok = loadConfig(env({ ...SMTP, SMTP_USER: 'u', SMTP_PASSWORD: 'pw-secret', SMTP_TO: 'a@example.org, b@example.org', NOTIFY_IMMEDIATE: 'handover, blocked', NOTIFY_DIGEST: '08:00', NOTIFY_TIMEZONE: 'Europe/Berlin', NOTIFY_LANGUAGE: 'de', HUMAN_MENTION: '0' })).notify;
  assert.deepEqual([ok.smtp.port, ok.smtp.security, ok.smtp.tlsVerify, ok.smtp.to, ok.immediate, ok.digest, ok.timezone, ok.language, ok.humanMention], [587, 'starttls', true, ['a@example.org', 'b@example.org'], ['handover', 'blocked'], '08:00', 'Europe/Berlin', 'de', false]);
  const bad = (extra, message) => assert.throws(() => loadConfig(env({ ...SMTP, ...extra })), (error) => { assert.match(error.message, message); assert.ok(!/pw-secret/.test(error.message)); return true; });
  assert.throws(() => loadConfig(env({ SMTP_HOST: 'h', SMTP_FROM: 'a@example.org' })), /half configured: SMTP_TO is missing/);
  assert.throws(() => loadConfig(env({ SMTP_HOST: 'h' })), /half configured: SMTP_FROM, SMTP_TO are missing/);
  assert.throws(() => loadConfig(env({ SMTP_USER: 'u', SMTP_PASSWORD: 'pw-secret' })), /half configured: SMTP_HOST, SMTP_FROM, SMTP_TO/);
  bad({ SMTP_PORT: '70000' }, /SMTP_PORT/);
  bad({ SMTP_SECURITY: 'ssl' }, /SMTP_SECURITY/);
  bad({ SMTP_FROM: 'not an address' }, /SMTP_FROM/);
  bad({ SMTP_TO: 'a@example.org, nope' }, /SMTP_TO/);
  bad({ SMTP_USER: 'u' }, /SMTP_USER and SMTP_PASSWORD/);
  bad({ SMTP_USER: 'u', SMTP_PASSWORD: 'pw-secret', SMTP_SECURITY: 'none' }, /SMTP_USER needs SMTP_SECURITY/);
  bad({ SMTP_TLS_VERIFY: 'yes' }, /SMTP_TLS_VERIFY must be 0 or 1/);
  bad({ SMTP_CA_FILE: join(dir, 'missing.pem') }, /SMTP_CA_FILE cannot be read/);
  await writeFile(join(dir, 'x.pem'), 'not a certificate');
  bad({ SMTP_CA_FILE: join(dir, 'x.pem') }, /SMTP_CA_FILE must be a PEM/);
  bad({ NOTIFY_IMMEDIATE: 'handover,loud' }, /NOTIFY_IMMEDIATE names loud/);
  bad({ NOTIFY_DIGEST: '8am' }, /NOTIFY_DIGEST/);
  bad({ NOTIFY_DIGEST: '24:00' }, /NOTIFY_DIGEST/);
  bad({ NOTIFY_TIMEZONE: 'Mars/Base' }, /NOTIFY_TIMEZONE/);
  bad({ NOTIFY_LANGUAGE: 'fr' }, /NOTIFY_LANGUAGE/);
  bad({ HUMAN_MENTION: '2' }, /HUMAN_MENTION/);
  assert.throws(() => loadConfig(env({ NOTIFY_IMMEDIATE: 'handover' })), /NOTIFY_IMMEDIATE needs a channel/);
  assert.throws(() => loadConfig(env({ NOTIFY_DIGEST: '08:00' })), /NOTIFY_DIGEST needs a channel/);
  assert.throws(() => loadConfig(env({ NOTIFY_WEBHOOK_URL: 'ftp://x' })), /NOTIFY_WEBHOOK_URL/);
  assert.throws(() => loadConfig(env({ NOTIFY_WEBHOOK_URL: 'https://u:p@x.example/' })), /NOTIFY_WEBHOOK_URL/);
  assert.throws(() => loadConfig(env({ NOTIFY_WEBHOOK_AUTH: 'Bearer x' })), /NOTIFY_WEBHOOK_AUTH needs NOTIFY_WEBHOOK_URL/);
  const hook = loadConfig(env({ NOTIFY_WEBHOOK_URL: 'https://ntfy.example/topic', NOTIFY_WEBHOOK_AUTH: 'Bearer t', NOTIFY_IMMEDIATE: 'failed' })).notify;
  assert.deepEqual([hook.smtp, hook.webhook.auth], [null, 'Bearer t']);
});

test('/status.json says which channels, kinds and digest time are set, and has no secret', async () => {
  const config = loadConfig(env({ ...SMTP, SMTP_USER: 'u', SMTP_PASSWORD: 'pw-secret', NOTIFY_IMMEDIATE: 'blocked', NOTIFY_DIGEST: '07:30' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const status = buildStatus(config, jobs, clock);
  assert.deepEqual(status.notify, { channels: ['smtp'], immediate: ['blocked'], digest: '07:30' });
  assert.ok(!JSON.stringify(status).includes('pw-secret'));
  assert.deepEqual(buildStatus(loadConfig(env()), jobs, clock).notify, { channels: [], immediate: [], digest: null });
});

// ---- the notifier

test('Notifier: sends to every channel, counts it, and does not block or throw', async () => {
  const a = fakeChannel(); const b = { ...fakeChannel(), name: 'other' };
  const n = new Notifier([a, b], ['blocked'], () => false, quiet, () => {});
  assert.equal(n.notify({ kind: 'blocked', subject: 'S', text: 'T' }), undefined);
  await wait();
  assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 1);
  const page = metrics.render();
  assert.match(page, /forgehands_notifications_total\{channel="fake",kind="blocked",result="sent"\} 1/);
  assert.match(page, /forgehands_notifications_total\{channel="other",kind="blocked",result="sent"\} 1/);
  const throwing = new Notifier([{ name: 'x', send() { throw new Error('sync'); } }], ['blocked'], () => false, quiet, () => {});
  assert.doesNotThrow(() => throwing.notify({ kind: 'blocked', subject: 'S', text: 'T' }));
});

test('Notifier: a failed send is tried again after 1, 5 and 30 minutes, then logged and counted', async () => {
  const channel = fakeChannel();
  const timers = []; const logs = [];
  const n = new Notifier([channel], ['failed'], () => false, { error: (...args) => logs.push(args.join(' ')) }, (run, ms) => timers.push({ run, ms }));
  channel.fail = 2;
  n.notify({ kind: 'failed', subject: 'S', text: 'T' });
  await wait();
  assert.deepEqual(timers.map((t) => t.ms), [RETRY_DELAYS_MS[0]]);
  assert.deepEqual(RETRY_DELAYS_MS, [60000, 300000, 1800000]);
  timers[0].run(); await wait();
  assert.deepEqual(timers.map((t) => t.ms), [60000, 300000]);
  timers[1].run(); await wait();
  assert.equal(channel.sent.length, 1, 'the third attempt went through');
  assert.equal(n.pending, 0);
  assert.match(metrics.render(), /result="sent"\} 1/);
  // A channel that never recovers: three retries, then the failure is counted once.
  metrics.reset(); timers.length = 0; logs.length = 0;
  channel.fail = 99;
  n.notify({ kind: 'failed', subject: 'S2', text: 'T' });
  await wait();
  for (let i = 0; i < 3; i++) { timers.shift().run(); await wait(); }
  assert.equal(timers.length, 0);
  assert.deepEqual(metrics.render().match(/forgehands_notifications_total\{[^}]*\} \d+/g), ['forgehands_notifications_total{channel="fake",kind="failed",result="failed"} 1']);
  assert.match(logs.at(-1), /failed for good: boom/);
  assert.equal(n.pending, 0);
});

test('Notifier: a dry run only logs one line with the subject; kinds that are not switched on are not sent', async () => {
  const channel = fakeChannel(); const logs = [];
  const n = new Notifier([channel], ['blocked'], () => true, { error: (...args) => logs.push(args.join(' ')) }, () => {});
  n.notify({ kind: 'blocked', subject: '[hello] #1 is blocked', text: 'T' });
  await wait();
  assert.equal(channel.sent.length, 0);
  assert.deepEqual(logs, ['DRY RUN, not sent: notification "[hello] #1 is blocked"']);
  assert.match(metrics.render(), /result="dry"\} 1/);
  const live = new Notifier([channel], ['blocked'], () => false, quiet, () => {});
  assert.equal(live.wants('handover'), false);
  assert.equal(live.wants('blocked'), true);
  assert.equal(live.wants('digest'), true, 'the digest is switched by NOTIFY_DIGEST, not by the list');
  live.notify({ kind: 'handover', subject: 'S', text: 'T' });
  await wait();
  assert.equal(channel.sent.length, 0);
  assert.equal(new Notifier([], ['blocked'], () => false, quiet, () => {}).wants('blocked'), false);
});

test('a dry run (DRY_RUN) of the dispatcher notifies nobody', async () => {
  const channel = fakeChannel();
  const config = loadConfig(env({ ...SMTP, NOTIFY_IMMEDIATE: 'blocked', DRY_RUN: '1' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const dispatcher = new Dispatcher(config, jobs, fakeForgejo(routes()).send, quiet, () => clock, Notifier.fromConfig(config));
  dispatcher.notifier.channels = [channel];
  await dispatcher.roundsUsedUp({ repository: { full_name: repo }, issue: { number: 26, title: 'T' }, pull_request: { number: 34 } });
  await wait();
  assert.equal(channel.sent.length, 0);
  assert.match(metrics.render(), /kind="blocked",result="dry"\} 1/);
});

// ---- the texts

test('immediate messages: short, plain, in English and in German, with a cut title and no control characters', () => {
  const facts = { repository: repo, number: 140, title: 'ingressctl: resolve presets\nBcc: x ' + 'long '.repeat(30), link: 'https://forge.example/o/r/pulls/140', files: 3, reason: 'stacks are deployed to production', security: 'ok' };
  const en = immediateMessage('en', 'handover', facts);
  assert.equal(en.subject, '[hello] #140 waits for you to merge');
  assert.equal(en.kind, 'handover');
  assert.equal(en.link, facts.link);
  const lines = en.text.split('\n');
  assert.ok(lines.length >= 3 && lines.length <= 6, en.text);
  assert.match(en.text, /Security review: no concerns/);
  assert.match(en.text, /Why you: stacks are deployed to production/);
  assert.match(en.text, /Files in protected paths: 3/);
  assert.ok(Array.from(lines[0]).length <= 80 && lines[0].endsWith('…') && !lines[0].includes('\n'));
  const de = immediateMessage('de', 'handover', facts);
  assert.equal(de.subject, '[hello] #140 wartet auf deinen Merge');
  assert.match(de.text, /Sicherheitsprüfung: ohne Bedenken/);
  assert.match(de.text, /Warum du: stacks are deployed/);
  assert.match(immediateMessage('en', 'handover', { ...facts, reason: '' }).text, /Why you: it touches protected paths/);
  assert.match(immediateMessage('de', 'handover', { ...facts, reason: null, security: 'concerns' }).text, /Warum du: er berührt geschützte Pfade[\s\S]*BEDENKEN|BEDENKEN[\s\S]*geschützte Pfade/);
  assert.match(immediateMessage('en', 'handover', { ...facts, security: 'concerns' }).text, /CONCERNS/);
  assert.match(immediateMessage('en', 'handover', { ...facts, security: 'none' }).text, /Security review: none/);
  assert.match(immediateMessage('en', 'blocked', { ...facts, why: 'rounds_used_up' }).text, /follow-up rounds are used up/);
  assert.equal(immediateMessage('de', 'blocked', { ...facts }).subject, '[hello] #140 ist blockiert');
  assert.match(immediateMessage('en', 'conflict', facts).text, /cannot resolve it/);
  assert.match(immediateMessage('en', 'failed', { ...facts, why: 'timeout' }).text, /took too long/);
  assert.match(immediateMessage('de', 'failed', { ...facts, why: 'merge_failed' }).text, /Merge selbst ist gescheitert/);
  assert.equal(immediateMessage('en', 'reminder', { ...facts, days: 3, nth: 1, of: 3 }).subject, '[hello] #140 has waited 3 days for you');
  assert.equal(immediateMessage('de', 'reminder', { ...facts, days: 1, nth: 1, of: 3 }).subject, '[hello] #140 wartet seit 1 Tag auf dich');
  assert.throws(() => immediateMessage('en', 'nope', facts));
  assert.equal(cleanTitle('a\u0000b\r\nc'), 'a b c');
});

// ---- where the immediate messages come from

test('a protected-path hand-over sends one message with the reason of the policy, the file count and the link; the comment stays as it was', async () => {
  const { merger, forgejo, channel } = await merging({}, { ['GET ' + API + '/pulls/34/files']: [{ filename: 'stacks/a/compose.yaml' }, { filename: 'stacks/b/compose.yaml' }, { filename: 'README.md' }] });
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  await wait();
  assert.equal(channel.sent.length, 1);
  const [message] = channel.sent;
  assert.equal(message.kind, 'handover');
  assert.equal(message.subject, '[hello] #34 waits for you to merge');
  assert.equal(message.link, 'https://forge.example/owner/hello/pulls/34');
  assert.match(message.text, /Why you: stacks are deployed to production/);
  assert.match(message.text, /Files in protected paths: 2/);
  assert.match(message.text, /Security review: none/);
  assert.doesNotMatch(message.text, /compose\.yaml|stacks\//, 'no file names, no code');
  assert.match(forgejo.comments()[0], /^@marcel ForgeHands: approved and green, but not merged automatically/);
  // A pattern without a reason falls back to the fixed sentence.
  const plain = await merging({}, { ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }] });
  await plain.merger.handle(approvedEvent());
  await wait();
  assert.match(plain.channel.sent[0].text, /Why you: it touches protected paths/);
});

test('conflict, failed merge and an approval without review each send their kind', async () => {
  const conflict = await merging({}, { ['GET ' + API + '/pulls/34']: pullRoute({ mergeable: false }) });
  assert.equal(await conflict.merger.handle(approvedEvent()), 'not_mergeable');
  await wait();
  assert.deepEqual(conflict.channel.sent.map((m) => m.kind), ['conflict']);
  const failed = await merging({}, { ['POST ' + API + '/pulls/34/merge']: undefined });
  assert.equal(await failed.merger.handle(approvedEvent()), 'merge_failed');
  await wait();
  assert.deepEqual(failed.channel.sent.map((m) => [m.kind, m.subject]), [['failed', '[hello] #34 a run failed']]);
  assert.match(failed.channel.sent[0].text, /merge itself failed/);
  const untrusted = await merging({}, { ['GET ' + API + '/issues/34/comments']: [] });
  assert.equal(await untrusted.merger.handle(approvedEvent()), 'no_valid_review');
  await wait();
  assert.deepEqual(untrusted.channel.sent.map((m) => m.kind), ['blocked']);
  assert.match(untrusted.channel.sent[0].text, /no valid review/);
  const merged = await merging({});
  assert.equal(await merged.merger.handle(approvedEvent()), 'merged');
  await wait();
  assert.equal(merged.channel.sent.length, 0, 'a merge needs nobody');
});

test('rounds used up, a conflict without a route, a failed run on a pull request and on an issue each send their kind', async () => {
  const { dispatcher, channel, forgejo } = await dispatching({});
  const event = { repository: { full_name: repo }, issue: { number: 26, title: 'Fix the thing', html_url: 'https://forge.example/owner/hello/issues/26' }, pull_request: { number: 34, html_url: 'https://forge.example/owner/hello/pulls/34' } };
  await dispatcher.roundsUsedUp(event);
  await dispatcher.markForHuman(event, 'ForgeHands: conflicts', 'conflict');
  await dispatcher.markForHuman(event, 'ForgeHands: no verdict', 'no_verdict');
  await dispatcher.reportFailure({ label: 'ai:ready', key: 'owner/hello#26:ai:ready', event }, 'timeout');
  await dispatcher.reportFailure({ label: 'ai:ready', key: 'owner/hello#27:ai:ready', event: { ...event, pull_request: undefined, issue: { number: 27, title: 'Other', html_url: 'https://forge.example/owner/hello/issues/27' } } }, 'stuck');
  await wait();
  assert.deepEqual(channel.sent.map((m) => m.kind), ['blocked', 'conflict', 'blocked', 'failed', 'failed']);
  assert.match(channel.sent[0].text, /follow-up rounds are used up/);
  assert.match(channel.sent[2].text, /ended twice without a verdict/);
  assert.match(channel.sent[3].text, /took too long/);
  assert.equal(channel.sent[3].link, 'https://forge.example/owner/hello/pulls/34');
  assert.equal(channel.sent[4].subject, '[hello] #27 a run failed');
  assert.equal(channel.sent[4].link, 'https://forge.example/owner/hello/issues/27');
  assert.ok(forgejo.comments().every((text) => text.startsWith('@marcel ForgeHands: ')), 'the comments are written as before');
});

test('a reminder sends a message with the days waited and which reminder it is', async () => {
  const { dispatcher, channel, forgejo } = await dispatching({ REMIND_AFTER_DAYS: '3' });
  const pull = { number: 34, state: 'open', merged: false, title: 'Fix it', html_url: 'https://forge.example/owner/hello/pulls/34', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe', repo: { full_name: repo } },
    labels: [{ name: 'ai:blocked' }], created_at: new Date(clock - 10 * DAY).toISOString(), updated_at: new Date(clock - 5 * DAY).toISOString() };
  forgejo.calls.length = 0;
  const send = fakeForgejo({ ...routes(), ['GET ' + API + '/pulls']: [pull], ['GET ' + API + '/issues/34/comments']: [] });
  const reminder = dispatcher.reminder;
  reminder.send = send.send;
  reminder.transport = (await import('../src/forge/index.ts')).createTransport(dispatcher.config, send.send, reminder.dry);
  await reminder.run(clock);
  await wait();
  assert.deepEqual(channel.sent.map((m) => m.kind), ['reminder']);
  assert.equal(channel.sent[0].subject, '[hello] #34 has waited 5 days for you');
  assert.match(channel.sent[0].text, /Reminder 1 of 3\./);
  assert.match(send.comments()[0], /^@marcel ForgeHands: reminder 1 of 3/);
});

test('NOTIFY_IMMEDIATE decides which kinds are sent; the comments are written either way', async () => {
  const only = await merging({}, { ['GET ' + API + '/pulls/34']: pullRoute({ mergeable: false }) }, fakeChannel(), ['handover']);
  assert.equal(await only.merger.handle(approvedEvent()), 'not_mergeable');
  await wait();
  assert.equal(only.channel.sent.length, 0);
  assert.match(only.forgejo.comments()[0], /does not merge cleanly/);
  const none = await merging({}, { ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }] }, fakeChannel(), []);
  await none.merger.handle(approvedEvent());
  await wait();
  assert.equal(none.channel.sent.length, 0);
  assert.equal(none.forgejo.comments().length, 1);
  // Without NOTIFY_IMMEDIATE (today's behaviour) the built notifier wants nothing.
  const config = loadConfig(env({ ...SMTP }));
  assert.equal(Notifier.fromConfig(config).wants('handover'), false);
});

test('HUMAN_MENTION=0 writes the same comments without the @login and nothing else changes', async () => {
  const files = { ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }] };
  const mention = await merging({}, files);
  const quietOne = await merging({ HUMAN_MENTION: '0' }, files);
  await mention.merger.handle(approvedEvent());
  await quietOne.merger.handle(approvedEvent());
  assert.match(mention.forgejo.comments()[0], /^@marcel ForgeHands: /);
  assert.equal(quietOne.forgejo.comments()[0], mention.forgejo.comments()[0].replace(/^@marcel /, ''));
  await wait();
  assert.equal(quietOne.channel.sent.length, 1, 'the notification does not depend on the mention');
  const d = await dispatching({ HUMAN_MENTION: '0' });
  await d.dispatcher.roundsUsedUp({ repository: { full_name: repo }, issue: { number: 26, title: 'T' }, pull_request: { number: 34 } });
  await d.dispatcher.reportFailure({ label: 'ai:ready', key: 'k', event: { repository: { full_name: repo }, issue: { number: 27, title: 'T' } } }, 'stuck');
  assert.ok(d.forgejo.comments().length === 2 && d.forgejo.comments().every((text) => text.startsWith('ForgeHands: ')));
  assert.equal(mentionOf(loadConfig(env({ HUMAN_MENTION: '0' }))), '');
  assert.equal(mentionOf(loadConfig(env())), '@marcel ');
});

// ---- the digest

const addJob = (jobs, number, extra = {}, title = 'ingressctl: resolve presets', pr = number + 100) => jobs.add({ key: repo + '#' + number + ':ai:ready', label: 'ai:ready', status: 'done', created: clock - 3 * DAY,
  event: { repository: { full_name: repo }, issue: { number, title }, pull_request: { number: pr } }, ...extra });
const digestSetup = (extra) => dispatching({ NOTIFY_DIGEST: '08:00', NOTIFY_TIMEZONE: 'Europe/Berlin', ...extra });

test('the digest goes out once a day at the time of the time zone, and not before', async () => {
  const { dispatcher, jobs, channel } = await digestSetup();
  addJob(jobs, 5, { blocked_at: clock - DAY });
  clock = Date.parse('2026-11-17T06:30:00Z'); // 07:30 in Berlin
  await dispatcher.tick(); await wait();
  assert.equal(channel.sent.length, 0);
  clock = Date.parse('2026-11-17T07:00:00Z'); // 08:00
  await dispatcher.tick(); await wait();
  assert.equal(channel.sent.length, 1);
  clock += 3600000;
  await dispatcher.tick(); await wait();
  assert.equal(channel.sent.length, 1, 'once per day');
  clock = Date.parse('2026-11-18T07:05:00Z');
  await dispatcher.tick(); await wait();
  assert.equal(channel.sent.length, 2, 'the next day again');
  assert.equal(channel.sent[0].kind, 'digest');
});

test('a restart neither sends the digest twice nor skips the day', async () => {
  const first = await digestSetup();
  addJob(first.jobs, 5, { blocked_at: clock - DAY });
  clock = Date.parse('2026-11-17T07:30:00Z');
  await first.dispatcher.tick(); await wait();
  assert.equal(first.channel.sent.length, 1);
  await first.jobs.persist(clock);
  const second = await digestSetup();
  assert.equal(second.jobs.meta.digest_sent, '2026-11-17');
  await second.dispatcher.tick(); await wait();
  assert.equal(second.channel.sent.length, 0, 'the same day, after a restart');
  // A process that was down at the time sends when it is up again the same day; one that starts after the next time sends once.
  const third = await dispatching({ NOTIFY_DIGEST: '08:00', NOTIFY_TIMEZONE: 'Europe/Berlin', JOBS_FILE: join(dir, 'other.json') });
  addJob(third.jobs, 5, { blocked_at: clock - DAY });
  clock = Date.parse('2026-11-19T15:00:00Z');
  await third.dispatcher.tick(); await wait();
  assert.equal(third.channel.sent.length, 1);
});

test('no digest when there is nothing for the human, and the day counts as done', async () => {
  const { dispatcher, jobs, channel } = await digestSetup();
  addJob(jobs, 5, { merged_at: clock - 3600000, merged_by: 'agent' });
  clock = Date.parse('2026-11-17T09:00:00Z');
  await dispatcher.tick(); await wait();
  assert.equal(channel.sent.length, 0);
  assert.equal(jobs.meta.digest_sent, '2026-11-17');
});

test('the digest lists waiting, blocked, quota and failed items with the merged count, in English or German, and never code', async () => {
  const { dispatcher, jobs, channel, config } = await digestSetup({ ALLOWED_REPOS: repo + ',owner/other' });
  clock = Date.parse('2026-11-17T07:30:00Z');
  addJob(jobs, 40, {}, 'ingressctl: resolve presets and some more text that goes on and on and on until it is cut at eighty characters');
  dispatcher.reminder.waiting.set('owner/hello#140', { repository: repo, issue: 40, pr: 140, since: clock - 2 * DAY - 3600000, reason: 'x' });
  addJob(jobs, 41, { blocked_at: clock - DAY }, 'Blocked ticket');
  addJob(jobs, 42, { status: 'failed', result: 'stuck', finished: clock - 3600000 }, 'Failed ticket');
  addJob(jobs, 43, { status: 'failed', result: 'stuck', finished: clock - 3 * DAY }, 'Old failure');
  addJob(jobs, 44, { merged_at: clock - 3600000 }, 'Merged one');
  addJob(jobs, 45, { merged_at: clock - 2 * 3600000 }, 'Merged two');
  dispatcher.cooldowns.set('strong', clock + 3600000);
  await dispatcher.tick(); await wait();
  const [digest] = channel.sent;
  assert.equal(digest.subject, 'ForgeHands: 4 things need you');
  assert.match(digest.text, /Waiting for you \(1\):\nhello#140 ingressctl: resolve presets and some more text that goes on and on and on until… \(waiting 2 days\)/);
  assert.match(digest.text, /Blocked \(1\):\nhello#141 Blocked ticket/);
  assert.match(digest.text, /Held back by a quota \(1\):\nstrong \(back about 09:30 Europe\/Berlin\)/);
  assert.match(digest.text, /Failed in the last 24 hours \(1\):\nhello#142 Failed ticket \(got stuck\)/);
  assert.doesNotMatch(digest.text, /Old failure/);
  assert.match(digest.text, /Merged in the last 24 hours: 2\./);
  assert.equal(config.notify.language, 'en');
  const de = digestMessage('de', { waiting: [{ repository: repo, number: 140, title: 'T', days: 1 }], blocked: [], failed: [], quota: [], merged: 0 }, false);
  assert.equal(de.subject, 'ForgeHands: 1 Sache braucht dich');
  assert.match(de.text, /Wartet auf dich \(1\):\n#140 T \(wartet seit 1 Tag\)/);
  assert.doesNotMatch(de.text, /Gemergt/, 'no merged line without merges');
  assert.equal(digestMessage('en', { waiting: [], blocked: [], failed: [], quota: [], merged: 5 }, false), null);
});

test('the digest shows at most 15 items and then "and N more"', () => {
  const waiting = Array.from({ length: 20 }, (_, i) => ({ repository: repo, number: i + 1, title: 'Item ' + (i + 1), days: 1 }));
  const en = digestMessage('en', { waiting, blocked: [], failed: [], quota: [], merged: 0 }, false);
  assert.equal(en.text.split('\n').filter((line) => /^#\d+ /.test(line)).length, 15);
  assert.match(en.text, /and 5 more/);
  assert.equal(en.subject, 'ForgeHands: 20 things need you');
  assert.match(digestMessage('de', { waiting, blocked: [], failed: [], quota: [], merged: 0 }, false).text, /und 5 weitere/);
});

test('NOTIFY_DIGEST in the German setting writes German; the dispatcher uses NOTIFY_LANGUAGE', async () => {
  const { dispatcher, jobs, channel } = await digestSetup({ NOTIFY_LANGUAGE: 'de' });
  addJob(jobs, 5, { blocked_at: clock - DAY });
  clock = Date.parse('2026-11-17T09:00:00Z');
  await dispatcher.tick(); await wait();
  assert.match(channel.sent[0].subject, /Sache braucht dich/);
  assert.match(channel.sent[0].text, /Blockiert \(1\)/);
});

// ---- the mail as HTML: tables, links, escaping
test('the digest is also an HTML table per section with a link on every number, escaped, and no WIP prefix', () => {
  const data = {
    waiting: [{ repository: repo, number: 219, title: 'WIP: Factory mail <b>&</b> "quotes"', days: 2, url: 'https://forge.example/owner/hello/pulls/219' }],
    blocked: [{ repository: repo, number: 5, title: 'Blocked', url: 'javascript:alert(1)' }],
    failed: [{ repository: repo, number: 73, title: 'A ticket', result: 'max_iterations', url: 'https://forge.example/owner/hello/issues/73' }],
    quota: [{ tier: 'smart', back: '09:30 Europe/Berlin' }], merged: 3
  };
  const digest = digestMessage('de', data, false);
  assert.ok(digest.html.startsWith('<!doctype html>'));
  assert.match(digest.html, /<th [^>]*>Ticket<\/th><th [^>]*>Titel<\/th><th [^>]*>Stand<\/th>/);
  assert.match(digest.html, /<a href="https:\/\/forge\.example\/owner\/hello\/pulls\/219"[^>]*>#219<\/a>/);
  assert.match(digest.html, /<a href="https:\/\/forge\.example\/owner\/hello\/issues\/73"[^>]*>#73<\/a>/);
  assert.match(digest.html, /Factory mail &lt;b&gt;&amp;&lt;\/b&gt; &quot;quotes&quot;/, 'the title is escaped');
  assert.doesNotMatch(digest.html, /WIP/, 'the WIP prefix is dropped');
  assert.doesNotMatch(digest.html, /javascript:/, 'only an http(s) link becomes a link');
  assert.match(digest.html, /Iterationslimit erreicht/);
  assert.match(digest.html, /Gemergt in den letzten 24 Stunden: 3/);
  assert.doesNotMatch(digest.html, /<script|<img|<link|src=|onclick/i);
  // the plain text carries the same items, with the link below
  assert.match(digest.text, /#219 Factory mail <b>&<\/b> "quotes" \(wartet seit 2 Tagen\)\n  https:\/\/forge\.example\/owner\/hello\/pulls\/219/);
});

test('an immediate message is also HTML with a button to the pull request; the mail has both parts', () => {
  const message = immediateMessage('de', 'handover', { repository: repo, number: 140, title: 'WIP: ingress <x>', link: 'https://forge.example/owner/hello/pulls/140', files: 5, reason: 'it decides what is reachable', security: 'ok' });
  assert.match(message.html, /\[hello\] #140 wartet auf deinen Merge/);
  assert.match(message.html, /ingress &lt;x&gt;/);
  assert.match(message.html, /<a href="https:\/\/forge\.example\/owner\/hello\/pulls\/140"[^>]*>Öffnen<\/a>/);
  assert.doesNotMatch(message.html, /WIP/);
  const bad = immediateMessage('en', 'conflict', { repository: repo, number: 1, title: 't', link: 'file:///etc/passwd' });
  assert.doesNotMatch(bad.html, /file:|href=/, 'no link when it is not http(s)');
  const mail = buildMessage({ from: 'a@example.org', to: ['b@example.org'] }, message, new Date('2026-11-17T08:00:00Z'), 'example.org');
  assert.match(mail, /Content-Type: multipart\/alternative; boundary="=_fh_[0-9a-f]+"/);
  assert.match(mail, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(mail, /Content-Type: text\/html; charset=utf-8/);
  const boundary = /boundary="([^"]+)"/.exec(mail)[1];
  assert.equal(mail.split('--' + boundary).length, 4, 'two parts and the closing line');
  assert.ok(mail.trimEnd().endsWith('--' + boundary + '--'));
  // a message without HTML stays a plain mail
  assert.match(buildMessage({ from: 'a@example.org', to: ['b@example.org'] }, { kind: 'x', subject: 's', text: 't' }), /Content-Type: text\/plain/);
});

test('the digest does not list a ticket whose newest run is not a failure (split, retried, running)', async () => {
  const { dispatcher, jobs, channel } = await digestSetup();
  clock = Date.parse('2026-11-17T07:30:00Z');
  addJob(jobs, 60, { status: 'failed', result: 'max_iterations', finished: clock - 3600000 }, 'Split ticket');
  addJob(jobs, 61, { status: 'failed', result: 'error', finished: clock - 7200000 }, 'Retried ticket');
  addJob(jobs, 62, { status: 'failed', result: 'error', finished: clock - 3600000 }, 'Really failed');
  const retried = jobs.list().filter((job) => job.key.includes('#61'));
  jobs.add({ key: repo + '#61:ai:ready:retry', label: 'ai:ready', status: 'done', created: retried[0].created + 10, event: retried[0].event, result: 'finished', finished: clock - 1800000 });
  const split = jobs.list().find((job) => job.key.includes('#60'));
  split.split_at = clock - 3000000;
  await dispatcher.tick(); await wait();
  const [digest] = channel.sent;
  assert.match(digest.text, /Really failed/);
  assert.doesNotMatch(digest.text, /Split ticket|Retried ticket/);
});
