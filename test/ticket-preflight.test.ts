// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { ticketRevision, ticketViolations } from '../src/agent/preflight.ts';
import { JobStore } from '../src/store/jobs.ts';
import { loadConfig } from '../src/config.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const quiet = { error() {} };
let dir; let clock; let calls;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' },
    'ai:ready': { profile: WORKER, tier: 'free' }
  }),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// A ticket that passes every rule when src/a.ts exists.
const GOOD = ['## Steps', '1. Change `src/a.ts`.', '', '## Files', '- `src/a.ts`', '', '## Acceptance', '```sh', 'npm test -- a', '```'].join('\n');

// What the forge says in the pre-flight: a fake of the writes and reads the pre-flight uses.
function fakeForge(labels = ['ai:ready'], missing = []) {
  return {
    comments: [], removed: [], added: [], labels: [...labels],
    async addComment(repository, number, body, on) { this.comments.push({ number, body, on }); },
    async labelsOf() { return this.labels.map((name) => ({ id: name, name })); },
    async removeLabel(repository, number, label) { this.removed.push(label.name); this.labels = this.labels.filter((name) => name !== label.name); },
    async findOrCreateLabel(repository, name) { return { id: name, name }; },
    async addLabels(repository, number, list) { for (const label of list) { this.added.push(label.name); this.labels.push(label.name); } },
    async fileExists(repository, path) { return !missing.includes(path); }
  };
}

// OpenHands: every start is a POST to /api/conversations; the forge is not reached through this fake.
function fakeSend() {
  return async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + calls.length }) };
    if (path.endsWith('/labels')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
}

async function build(extra = {}, labels = ['ai:ready'], missing = []) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeSend(), quiet, () => clock);
  const forge = fakeForge(labels, missing);
  dispatcher.preflight.forge = forge;
  return { config, jobs, dispatcher, forge };
}

const ticket = (label, body, number = 1, extra = {}) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body, html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }, ...extra
});
const starts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/conversations'));
const rulesOf = (list) => list.map((v) => v.rule);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-preflight-')); clock = 1_000_000; calls = []; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })); // background saves may still be writing

// The rules, read from a ticket body.

test('a path named in Steps but not listed in Files breaks rule 1', async () => {
  const body = ['## Steps', '1. Change `src/a.ts` and `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const found = await ticketViolations(body);
  assert.deepEqual(rulesOf(found), [1]);
  assert.match(found[0].text, /`src\/b\.ts` is named in Steps but not listed in Files/);
});

test('a bare slash path in Steps counts for rule 1 as well as a code span', async () => {
  const body = ['## Steps', 'Edit src/c.ts after that.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(rulesOf(await ticketViolations(body)), [1]);
});

test('a version number or a dotted value in backticks is not a path, so it breaks no rule', async () => {
  const body = ['## Steps', 'Pin `v0.9.7` and set `max_budget` to `1.5`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body, async () => true), []);
});

test('Steps that name only listed files pass rule 1, and the Exact files heading is read as Files', async () => {
  const body = ['## Steps', '1. Change `src/a.ts`.', '## Exact files', '- `src/a.ts` (new)', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body), []);
});

test('a ticket without a Steps section has nothing for rule 1 to check', async () => {
  const body = ['## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body), []);
});

test('rule 2 breaks on a missing Acceptance section, one without a fence, and one with an empty fence', async () => {
  const missing = ['## Steps', '1. Do it.'].join('\n');
  const nofence = ['## Acceptance', 'Run npm test and read the output.'].join('\n');
  const empty = ['## Acceptance', '```sh', '   ', '```'].join('\n');
  const [a, b, c] = await Promise.all([missing, nofence, empty].map((body) => ticketViolations(body)));
  assert.deepEqual(rulesOf(a), [2]);
  assert.match(a[0].text, /no Acceptance section/);
  assert.deepEqual(rulesOf(b), [2]);
  assert.match(b[0].text, /no fenced command block/);
  assert.deepEqual(rulesOf(c), [2]);
});

test('rule 2 is not fooled by a heading inside a code block', async () => {
  const body = ['## Steps', '```md', '## Acceptance', '```', '1. Do it.'].join('\n');
  assert.deepEqual(rulesOf(await ticketViolations(body)), [2]);
});

test('rule 3 breaks on a placeholder command and on a quote that is never closed', async () => {
  const placeholder = ['## Acceptance', '```sh', '<command>', '```'].join('\n');
  const dots = ['## Acceptance', '```sh', '...', '```'].join('\n');
  const open = ['## Acceptance', '```sh', 'echo "hello', '```'].join('\n');
  assert.match((await ticketViolations(placeholder))[0].text, /placeholder/);
  assert.match((await ticketViolations(dots))[0].text, /placeholder/);
  assert.deepEqual(rulesOf(await ticketViolations(open)), [3]);
  assert.match((await ticketViolations(open))[0].text, /quote that is never closed/);
});

test('rule 3 is not fooled by an apostrophe in a comment, and reads a quote that closes on a later line', async () => {
  const comment = ['## Acceptance', '```sh', "# don't panic", 'npm test', '```'].join('\n');
  const multiline = ['## Acceptance', '```sh', 'grep -q "a', 'b" file.txt', '```'].join('\n');
  assert.deepEqual(await ticketViolations(comment), []);
  assert.deepEqual(await ticketViolations(multiline), []);
});

test('rule 4 breaks on a listed file that is not on the default branch, unless it is marked new or the forge cannot say', async () => {
  const body = ['## Files', '- `src/a.ts`', '- `src/gone.ts`', '- `src/new.ts` (new)', '- `src/unknown.ts`', '- `src/*.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const asked = [];
  const answers = { 'src/a.ts': true, 'src/gone.ts': false, 'src/unknown.ts': null };
  const found = await ticketViolations(body, async (path) => { asked.push(path); return answers[path] ?? true; });
  assert.deepEqual(rulesOf(found), [4]);
  assert.match(found[0].text, /`src\/gone\.ts` is listed in Files but does not exist/);
  assert.deepEqual(asked.sort(), ['src/a.ts', 'src/gone.ts', 'src/unknown.ts']);
});

test('without an exists function rule 4 is not checked', async () => {
  const body = ['## Files', '- `src/gone.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body), []);
});

test('a ticket that follows the format passes every rule', async () => {
  assert.deepEqual(await ticketViolations(GOOD, async () => true), []);
});

test('the revision of a ticket is the hash of its title and body: an edit is a new revision', () => {
  assert.equal(ticketRevision('T', GOOD), ticketRevision('T', GOOD));
  assert.notEqual(ticketRevision('T', GOOD), ticketRevision('T', GOOD + '\n'));
  assert.notEqual(ticketRevision('T', GOOD), ticketRevision('U', GOOD));
});

// The dispatcher: a worker run does not start, the ticket goes back, once per revision.

test('a worker ticket that breaks a rule starts no run, gets one comment and goes back to the planner', async () => {
  const broken = ['## Steps', '1. Change `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' });
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'ticket_rejected');
  assert.equal(starts().length, 0);
  assert.equal(forge.comments.length, 1);
  assert.match(forge.comments[0].body, /rule 1: `src\/b\.ts`/);
  assert.doesNotMatch(forge.comments[0].body, /@/); // the planner takes it: no mention of the human
  assert.deepEqual(forge.removed, ['ai:ready']);
  assert.deepEqual(forge.added, ['ai:plan']);
});

test('a rejected ticket is commented once per revision; the next label event routes it again without a second comment', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge, jobs } = await build({ SPLIT_LABEL: 'ai:plan' });
  await dispatcher.enqueue(ticket('ai:ready', broken));
  // The label is set again on the same ticket: the forge now shows the planner label, the worker label comes back.
  forge.labels = ['ai:ready'];
  const again = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(again.status, 'ticket_rejected');
  assert.equal(starts().length, 0);
  assert.equal(forge.comments.length, 1);
  assert.deepEqual(forge.added, ['ai:plan', 'ai:plan']);
  assert.equal(jobs.noted('preflight:owner/hello#1:' + ticketRevision('T', broken)), true);
});

test('an edited ticket is a new revision and is commented again', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' });
  await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.enqueue(ticket('ai:ready', broken + '\nMore text.'));
  assert.equal(forge.comments.length, 2);
});

test('without SPLIT_LABEL a rejected ticket gets BLOCKED_LABEL and one comment that mentions the human', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge, config } = await build({ HUMAN_LOGIN: 'marcel' });
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'ticket_rejected');
  assert.equal(starts().length, 0);
  assert.equal(forge.comments.length, 1);
  assert.match(forge.comments[0].body, /^@marcel ForgeHands: the ticket breaks the pre-flight/);
  assert.deepEqual(forge.removed, ['ai:ready']);
  assert.deepEqual(forge.added, [config.blockedLabel]);
});

test('a ticket that passes starts normally: one run, no comment, the label stays', async () => {
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' });
  const result = await dispatcher.enqueue(ticket('ai:ready', GOOD));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.equal(starts().length, 1);
  assert.equal(starts()[0].path, '/api/conversations');
  assert.equal(forge.comments.length, 0);
  assert.deepEqual(forge.removed, []);
});

test('a ticket whose file is missing on the default branch starts no run', async () => {
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['src/a.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', GOOD));
  assert.equal(result.status, 'ticket_rejected');
  assert.match(forge.comments[0].body, /rule 4: `src\/a\.ts` is listed in Files but does not exist/);
});

test('rule 4 reads the Forgejo contents API: a 404 breaks the ticket, a file that is there passes', async () => {
  const send = async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (path.endsWith('/contents/src/gone.ts')) return { ok: false, status: 404, json: async () => ({}) };
    if (path.includes('/contents/')) return { ok: true, status: 200, json: async () => ({ type: 'file' }) };
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    if (path.endsWith('/labels')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
  const config = loadConfig(env({ SPLIT_LABEL: 'ai:plan' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock);
  const broken = ['## Files', '- `src/gone.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const rejected = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.equal(rejected.status, 'ticket_rejected');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/v1/repos/owner/hello/contents/src/gone.ts'));
  const passed = await dispatcher.enqueue(ticket('ai:ready', GOOD, 2));
  await dispatcher.tick();
  assert.equal(passed.status, 'queued');
  assert.equal(starts().length, 1);
});

test('TICKET_PREFLIGHT=0 starts the broken ticket as before, without a look at the forge', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge } = await build({ TICKET_PREFLIGHT: '0', SPLIT_LABEL: 'ai:plan' });
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.equal(starts().length, 1);
  assert.equal(forge.comments.length, 0);
});

test('TICKET_PREFLIGHT takes 1 (default) or 0, and says so for anything else', () => {
  assert.equal(loadConfig(env()).ticketPreflight, true);
  assert.equal(loadConfig(env({ TICKET_PREFLIGHT: '1' })).ticketPreflight, true);
  assert.equal(loadConfig(env({ TICKET_PREFLIGHT: '0' })).ticketPreflight, false);
  assert.throws(() => loadConfig(env({ TICKET_PREFLIGHT: 'yes' })), /TICKET_PREFLIGHT must be 1 or 0/);
});

test('a planner ticket is not checked: a broken ticket still starts its planner', async () => {
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:plan']);
  const result = await dispatcher.enqueue(ticket('ai:plan', 'no sections at all'));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.equal(starts()[0].body.agent_profile_id, PLANNER);
  assert.equal(forge.comments.length, 0);
});

test('DRY_RUN writes nothing to the forge and keeps no once-per-revision mark', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const config = loadConfig(env({ DRY_RUN: '1', SPLIT_LABEL: 'ai:plan' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeSend(), quiet, () => clock);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'ticket_rejected');
  const forgeWrites = calls.filter((c) => c.path.startsWith('/api/v1/') && c.method !== 'GET');
  assert.deepEqual(forgeWrites, []);
  assert.equal(jobs.noted('preflight:owner/hello#1:' + ticketRevision('T', broken)), false);
});
