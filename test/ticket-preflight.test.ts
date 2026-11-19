// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { splitViolations, ticketRevision, ticketViolations } from '../src/agent/preflight.ts';
import { preflightNoteLines } from '../src/agent/prompt.ts';
import { JobStore } from '../src/store/jobs.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';

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
// `pulls` are the open pull requests of the repository (listPulls); `closed` collects every pull request the pre-flight closes (none must be).
function fakeForge(labels = ['ai:ready'], missing = [], pulls = []) {
  return {
    comments: [], removed: [], added: [], closed: [], labels: [...labels],
    async addComment(repository, number, body, on) { this.comments.push({ number, body, on }); },
    async labelsOf() { return this.labels.map((name) => ({ id: name, name })); },
    async removeLabel(repository, number, label) { this.removed.push(label.name); this.labels = this.labels.filter((name) => name !== label.name); },
    async findOrCreateLabel(repository, name) { return { id: name, name }; },
    async addLabels(repository, number, list) { for (const label of list) { this.added.push(label.name); this.labels.push(label.name); } },
    async fileExists(repository, path) { return !missing.includes(path); },
    async listPulls() { return pulls; },
    async closePull(repository, number) { this.closed.push(number); }
  };
}

// An open pull request of a ticket's agent branch, as Forgejo lists it.
const pullOf = (number, issue) => ({ number, state: 'open', head: { ref: 'ai/issue-' + issue, label: 'ai/issue-' + issue } });

// OpenHands: every start is a POST to /api/conversations; the forge is not reached through this fake.
function fakeSend() {
  return async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + calls.length }) };
    if (path.endsWith('/labels')) return { ok: true, status: 200, json: async () => [] };
    if (path.endsWith('/pulls')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
}

async function build(extra = {}, labels = ['ai:ready'], missing = [], pulls = []) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeSend(), quiet, () => clock);
  const forge = fakeForge(labels, missing, pulls);
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
// The rules of the findings that reject a ticket under a TICKET_PREFLIGHT_BLOCK list (default 2,3).
const blockingRules = (list, block = [2, 3]) => splitViolations(list, block).blocking.map((v) => v.rule);
// A forge answer for a repository: a path answers false when it is in `absent`, true otherwise.
const notOnBranch = (absent) => async (path) => !absent.includes(path);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-preflight-')); clock = 1_000_000; calls = []; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })); // background saves may still be writing

// The rules, read from a ticket body.

test('rule 1 advises: a path named in Steps but not listed in Files does not block by default, and blocks when TICKET_PREFLIGHT_BLOCK lists 1', async () => {
  const body = ['## Steps', '1. Change `src/a.ts` and `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const found = await ticketViolations(body);
  assert.deepEqual(rulesOf(found), [1]);
  assert.match(found[0].text, /`src\/b\.ts` is named in Steps but not listed in Files/);
  assert.match(found[0].note, /the Steps name `src\/b\.ts`, which the Files list does not contain/);
  assert.deepEqual(blockingRules(found), []);
  assert.deepEqual(blockingRules(found, [1, 2, 3]), [1]);
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

test('rule 4 breaks when no listed file exists and nothing in the ticket says that it creates one', async () => {
  const body = ['## Steps', '1. Change `src/gone.ts`.', '## Files', '- `src/gone.ts`', '- `src/also-gone.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const found = await ticketViolations(body, async () => false);
  assert.deepEqual(rulesOf(found), [4, 4]);
  // Blocking only in this form (no listed file exists, nothing says it is created), and only when TICKET_PREFLIGHT_BLOCK lists 4.
  assert.deepEqual(blockingRules(found), []);
  assert.deepEqual(blockingRules(found, [2, 3, 4]), [4, 4]);
  assert.match(found[0].text, /`src\/gone\.ts` is listed in Files but does not exist/);
  assert.match(found[1].text, /`src\/also-gone\.ts` is listed in Files but does not exist/);
});

test('rule 4 is advisory when Steps say the ticket creates a file or when one listed file exists; a file marked new is not read', async () => {
  const acceptance = ['## Acceptance', '```sh', 'npm test', '```'];
  const marked = ['## Steps', '1. Change `src/new.ts`.', '## Files', '- `src/new.ts` (new)', ...acceptance].join('\n');
  const created = ['## Steps', '1. Create `src/gone.ts` with the rule.', '## Files', '- `src/gone.ts`', ...acceptance].join('\n');
  const oneExists = ['## Steps', '1. Change `src/a.ts`.', '## Files', '- `src/a.ts`', '- `src/gone.ts`', ...acceptance].join('\n');
  const answers = { 'src/a.ts': true };
  const exists = async (path) => answers[path] ?? false;
  assert.deepEqual(await ticketViolations(marked, exists), []);
  const creating = await ticketViolations(created, exists);
  assert.deepEqual(rulesOf(creating), [4]);
  assert.equal(creating[0].blockable, false);
  assert.deepEqual(blockingRules(creating, [2, 3, 4]), []);
  const mixed = await ticketViolations(oneExists, exists);
  assert.deepEqual(rulesOf(mixed), [4]);
  assert.equal(mixed[0].blockable, false);
  assert.match(mixed[0].text, /`src\/gone\.ts` is listed in Files but does not exist/);
  assert.deepEqual(blockingRules(mixed, [2, 3, 4]), []);
});

test('rule 4 is not broken when the forge cannot say whether a listed file exists', async () => {
  const body = ['## Steps', '1. Change `src/gone.ts`.', '## Files', '- `src/gone.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body, async () => null), []);
});

test('a ticket that marks one file new is not read for rule 4 at all', async () => {
  const body = ['## Files', '- `src/a.ts`', '- `src/new.ts` (new)', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const asked = [];
  assert.deepEqual(await ticketViolations(body, async (path) => { asked.push(path); return true; }), []);
  assert.deepEqual(asked, []); // a marked-new file says the ticket creates files, so nothing is read
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

test('a worker ticket that breaks a blocking rule starts no run, gets one comment and goes back to the planner', async () => {
  const broken = ['## Steps', '1. Change `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  // src/b.ts is not in the repository (the fake says so), so it is no file that exists: rule 1 breaks, because TICKET_PREFLIGHT_BLOCK lists it.
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '1,2,3' }, ['ai:ready'], ['src/b.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'ticket_rejected');
  assert.equal(starts().length, 0);
  assert.equal(forge.comments.length, 1);
  assert.match(forge.comments[0].body, /rule 1: `src\/b\.ts`/);
  assert.doesNotMatch(forge.comments[0].body, /@/); // the planner takes it: no mention of the human
  assert.deepEqual(forge.removed, ['ai:ready']);
  assert.deepEqual(forge.added, ['ai:plan']);
  assert.deepEqual(forge.closed, []);
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

test('a ticket whose file is missing on the default branch starts no run when TICKET_PREFLIGHT_BLOCK lists rule 4', async () => {
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '2,3,4' }, ['ai:ready'], ['src/a.ts']);
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
    if (path.endsWith('/pulls')) return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    if (path.endsWith('/labels')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
  const config = loadConfig(env({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '2,3,4' }));
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

// Rule 1 and rule 4 on realistic tickets. The bodies are written as the planner writes them: code spans, a comma-separated Files line, fenced
// code in Steps, and bare file names. openapi-generator#53 was rejected for the names of Steps that are code, versions, or files that exist
// or that the ticket lists under another path; levelUp#75 and #76 for files that the ticket creates.

const OPENAPI_53 = [
  '## Steps',
  '1. Add a TypeScript target: the generator is in `src/targets/typescript/index.ts`, and it renders each schema through `src/targets/typescript/models.ts`.',
  '2. Register the target in `src/targets/index.ts` (add the target only, the other targets stay as they are).',
  '3. `index.ts` re-exports the models of `models.ts`; the shared types stay in src/models.ts, which the new module imports from.',
  '4. Resolve the spec next to the generator with `import.meta.url`, and read the fixture users-3.1.yaml that the test uses.',
  '5. Create `test/ts-models.test.ts` with one case per schema kind (object, enum, array).',
  '6. In `package.json` change only the `build` script, so that it runs the target; it reads `process.env.OUTPUT_DIR` when that is set.',
  '',
  '```ts',
  'const dir = path.dirname(fileURLToPath(import.meta.url));',
  'const list = Array.isArray(schema) ? schema : [schema];',
  '```',
  '',
  '## Files',
  '- `src/targets/typescript/index.ts`, `src/targets/typescript/models.ts`, `src/targets/index.ts` (add the target only), `package.json` (only the `build` script, see step 2), `test/ts-models.test.ts`',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- ts-models',
  '```',
].join('\n');
// The default branch of openapi-generator: the generator files that the ticket names and that exist there, and src/models.ts which Steps names.
// test/ts-models.test.ts is created by the ticket (Steps say so) and does not exist yet.
const OPENAPI_REPO = { 'src/targets/typescript/index.ts': true, 'src/targets/typescript/models.ts': true, 'src/targets/index.ts': true, 'package.json': true, 'src/models.ts': true };
const onOpenapi = async (path) => OPENAPI_REPO[path] ?? false;

const LEVEL_UP_75 = [
  '## Steps',
  '1. Create `src/checks/level-up.ts` with the rule that compares the level of each member.',
  '2. Add its test as `test/checks/level-up.test.ts`.',
  '',
  '## Files',
  '- `src/checks/level-up.ts`',
  '- `test/checks/level-up.test.ts`',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- level-up',
  '```',
].join('\n');
const LEVEL_UP_76 = [
  '## Steps',
  '1. Implement the rule in `src/checks/level-up.ts`.',
  '2. Cover it with a test in `test/checks/level-up.test.ts`.',
  '',
  '## Files',
  '- `src/checks/level-up.ts`',
  '- `test/checks/level-up.test.ts`',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- level-up',
  '```',
].join('\n');
const nothingExists = async () => false;

test('the openapi-generator#53 ticket is not blocked: its names are listed, code, versions or files of the default branch; the new test file is advisory', async () => {
  const found = await ticketViolations(OPENAPI_53, onOpenapi);
  assert.deepEqual(rulesOf(found), [4]); // test/ts-models.test.ts: Steps create it, and it is not marked new
  assert.match(found[0].note, /`test\/ts-models\.test\.ts` is listed in Files but does not exist/);
  assert.deepEqual(blockingRules(found, [1, 2, 3, 4]), []);
  // Without the repository only src/models.ts is a name that is neither listed nor code: rule 1, which blocks only when the list has 1.
  const bare = await ticketViolations(OPENAPI_53);
  assert.deepEqual(rulesOf(bare), [1]);
  assert.match(bare[0].text, /`src\/models\.ts` is named in Steps but not listed in Files/);
  assert.deepEqual(blockingRules(bare), []);
  assert.deepEqual(blockingRules(bare, [1]), [1]);
});

test('code, URLs, versions, prose words and fenced code are not paths for rule 1', async () => {
  const body = ['## Steps',
    '1. Read `process.env.OUTPUT_DIR` and call `Array.isArray` on the list.',
    '2. Follow https://forge.example/docs/guide.md and forge.example/docs/format.md for the format.',
    '3. Pin `v1.2.3`; the target is Node.js 22 and users-3.1.yaml is the fixture.',
    '4. Use `import.meta.url` and `e.g.` in the examples.',
    '```ts',
    'const dir = path.dirname(fileURLToPath(import.meta.url));',
    '```',
    '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(body), []);
});

test('a bare file name in Steps is a violation unless a listed file has that basename or the repository has it', async () => {
  const unlisted = ['## Steps', '1. Edit utils.ts after that.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(rulesOf(await ticketViolations(unlisted)), [1]);
  assert.match((await ticketViolations(unlisted))[0].text, /`utils\.ts` is named in Steps but not listed in Files/);
  assert.deepEqual(await ticketViolations(unlisted, async (path) => path === 'utils.ts' || path === 'src/a.ts'), []);
  const suffix = ['## Steps', '1. Change `targets/typescript/models.ts`.', '## Files', '- `src/targets/typescript/models.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  assert.deepEqual(await ticketViolations(suffix), []);
});

test('a path inside a fenced block of Steps counts only with a slash', async () => {
  const fenced = ['## Steps', '```sh', 'cat models.ts', 'cat src/x.ts', '```', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const found = await ticketViolations(fenced);
  assert.deepEqual(rulesOf(found), [1]);
  assert.match(found[0].text, /`src\/x\.ts`/);
});

test('the levelUp#75 ticket, whose files are all created, has advisory rule 4 findings only, because Steps say that it creates them', async () => {
  const found = await ticketViolations(LEVEL_UP_75, nothingExists);
  assert.deepEqual(rulesOf(found), [4, 4]);
  assert.deepEqual(blockingRules(found, [2, 3, 4]), []);
});

test('the levelUp#76 ticket breaks rule 4 for each file when no listed file exists and no step says a file is created', async () => {
  const found = await ticketViolations(LEVEL_UP_76, nothingExists);
  assert.deepEqual(rulesOf(found), [4, 4]);
  assert.deepEqual(blockingRules(found, [2, 3, 4]), [4, 4]);
  assert.match(found[0].text, /`src\/checks\/level-up\.ts` is listed in Files but does not exist/);
});

test('the openapi-generator#53 ticket starts with its open pull request #85 and nothing is closed or commented; its advisory finding is counted', async () => {
  metrics.reset();
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['test/ts-models.test.ts'], [pullOf(85, 1)]);
  const result = await dispatcher.enqueue(ticket('ai:ready', OPENAPI_53));
  assert.equal(result.status, 'queued');
  assert.deepEqual(forge.comments, []);
  assert.deepEqual(forge.closed, []);
  assert.deepEqual(forge.added, []);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="advised",rule="4"}'), 1);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="ok",rule="none"}'), undefined);
});

test('a rejected ticket with an open pull request is skipped: no comment, no label change, no close call', async () => {
  metrics.reset();
  const broken = ['## Steps', '1. Change `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '1,2,3' }, ['ai:ready'], ['src/b.ts'], [pullOf(85, 1)]);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.notEqual(result.status, 'ticket_rejected');
  assert.deepEqual(forge.comments, []);
  assert.deepEqual(forge.removed, []);
  assert.deepEqual(forge.added, []);
  assert.deepEqual(forge.closed, []);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="skipped",rule="none"}'), 1);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="rejected",rule="1"}'), undefined);
});

test('a ticket that was worked on before is skipped even when its pull request is gone', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge, jobs } = await build({ SPLIT_LABEL: 'ai:plan' });
  jobs.add({ key: 'owner/hello#1:ai:ready', label: 'ai:ready', event: ticket('ai:ready', GOOD), status: 'done', created: clock - 1, finished: clock - 1 });
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.equal(result.status, 'queued');
  assert.deepEqual(forge.comments, []);
  assert.deepEqual(forge.closed, []);
});

test('when the open pull requests cannot be read, a ticket is not rejected', async () => {
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' });
  dispatcher.preflight.forge.listPulls = async () => { throw new Error('forge down'); };
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.equal(result.status, 'queued');
  assert.deepEqual(forge.comments, []);
  assert.deepEqual(forge.closed, []);
});

test('a rejected ticket without a pull request is routed to the planner and no pull request is closed', async () => {
  const broken = ['## Steps', '1. Change `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '1,2,3' }, ['ai:ready'], ['src/b.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.equal(result.status, 'ticket_rejected');
  assert.deepEqual(forge.added, ['ai:plan']);
  assert.deepEqual(forge.closed, []);
});

test('the rejection comment names at most six violations and counts the rest', async () => {
  const names = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => '`src/x' + i + '.ts`');
  const broken = ['## Steps', '1. Touch ' + names.join(', ') + '.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const missing = names.map((name) => name.slice(1, -1));
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan', TICKET_PREFLIGHT_BLOCK: '1,2,3' }, ['ai:ready'], missing);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  assert.equal(result.status, 'ticket_rejected');
  const body = forge.comments[0].body;
  assert.equal(body.split('\n').filter((line) => line.startsWith('- rule 1: ')).length, 6);
  assert.match(body, /- and 2 more/);
  assert.doesNotMatch(body, /src\/x7\.ts/);
});

test('the pre-flight counts its results and the rules it rejects', async () => {
  metrics.reset();
  const broken = ['## Steps', '1. Do it.'].join('\n');
  const { dispatcher } = await build({ SPLIT_LABEL: 'ai:plan' });
  await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.enqueue(ticket('ai:ready', GOOD, 2));
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="rejected",rule="2"}'), 1);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="ok",rule="none"}'), 1);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="rejected",rule="1"}'), undefined);
});

// Advisory findings: rule 1 and the weaker rule 4. A worker can do these tickets. The names are what the planner writes about the output of a
// generator, a helper script read for context, or a file that is read but not changed. None of them is on the default branch.

// openapi-generator: the generator's Steps name the files it emits (commands.ts, models.ts, src/models.ts, dist/index.js, dist/index.d.ts) and a
// helper script (scripts/update-golden.sh). The ticket changes only the template and the fixture, which are listed.
const EMITTED = ['commands.ts', 'models.ts', 'src/models.ts', 'dist/index.js', 'dist/index.d.ts', 'scripts/update-golden.sh'];
const GENERATOR_TICKET = [
  '## Steps',
  '1. In `src/generators/typescript/index.ts` render the discriminator of a oneOf schema.',
  '2. The generated `commands.ts` and `models.ts` are the output of the generator: do not edit them, the golden files show the expected output.',
  '3. Keep `src/models.ts`, `dist/index.js` and `dist/index.d.ts` in step with the template; `scripts/update-golden.sh` regenerates the golden files.',
  '4. Add one fixture under `test/golden/oneof/`.',
  '',
  '## Files',
  '- `src/generators/typescript/index.ts`',
  '- `src/generators/typescript/templates/model.mustache`',
  '- `test/golden/oneof/spec.yaml` (new)',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- golden',
  '```'
].join('\n');

// homegraf#235: a helper script that the Steps read for the output format; it lives in another repository.
const HOMEGRAF_235 = [
  '## Steps',
  '1. Add the `--check` flag to the smoke runner in `scripts/smoke.sh`.',
  '2. The report has the format that `factory_smoke.py` prints: read it for the field names, do not change it.',
  '',
  '## Files',
  '- `scripts/smoke.sh`',
  '- `test/smoke.test.ts`',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- smoke',
  '```'
].join('\n');

// levelUp#61: the CI file and the architecture note are named in Steps; the ticket changes neither.
const LEVEL_UP_61 = [
  '## Steps',
  '1. Implement the level check in `src/checks/level-up.ts`.',
  '2. The CI job that runs it is in `ci.yaml`: keep its job names, only add the step.',
  '3. Document the rule in `docs/architecture.md`, section "Checks".',
  '',
  '## Files',
  '- `src/checks/level-up.ts`',
  '- `test/checks/level-up.test.ts`',
  '',
  '## Acceptance',
  '```sh',
  'npm test -- level-up',
  '```'
].join('\n');

test('openapi-generator tickets: the names of the emitted files and of the helper script are advisory, and the ticket is not rejected', async () => {
  const found = await ticketViolations(GENERATOR_TICKET, notOnBranch(EMITTED));
  assert.deepEqual(rulesOf(found), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(blockingRules(found), []);
  assert.deepEqual(blockingRules(found, [1, 2, 3]), [1, 1, 1, 1, 1, 1]);
});

test('homegraf#235: a helper script read for the output format is advisory, not a rejection', async () => {
  const found = await ticketViolations(HOMEGRAF_235, notOnBranch(['factory_smoke.py']));
  assert.deepEqual(rulesOf(found), [1]);
  assert.match(found[0].note, /the Steps name `factory_smoke\.py`, which the Files list does not contain/);
  assert.deepEqual(blockingRules(found), []);
});

test('levelUp#61: the CI file and the architecture note named in Steps are advisory, not a rejection', async () => {
  const found = await ticketViolations(LEVEL_UP_61, notOnBranch(['ci.yaml', 'docs/architecture.md']));
  assert.deepEqual(rulesOf(found), [1, 1]);
  assert.deepEqual(blockingRules(found), []);
});

test('an advisory finding goes into the worker prompt as one pre-flight note: the run starts, with no comment and no label change', async () => {
  metrics.reset();
  const body = ['## Steps', '1. Change `src/a.ts` and emit `commands.ts` from it.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['commands.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', body));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.equal(starts().length, 1);
  const text = starts()[0].body.initial_message.content[0].text;
  assert.ok(text.includes('Pre-flight notes, not blockers: the Steps name `commands.ts`, which the Files list does not contain. Stay within the Files list unless the step clearly needs it, and say so in the pull request.'), text);
  assert.ok(text.indexOf('Pre-flight notes, not blockers:') < text.indexOf('<<<UNTRUSTED_ISSUE_TEXT'), 'the note comes before the untrusted ticket text');
  assert.deepEqual(forge.comments, []);
  assert.deepEqual(forge.removed, []);
  assert.deepEqual(forge.added, []);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="advised",rule="1"}'), 1);
  assert.equal(metrics.counters.get('forgehands_preflight_total{result="rejected",rule="1"}'), undefined);
});

test('rule 1 advises by default on the same ticket as before: the run starts and the prompt names the file', async () => {
  const broken = ['## Steps', '1. Change `src/b.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['src/b.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', broken));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.equal(starts().length, 1);
  assert.match(starts()[0].body.initial_message.content[0].text, /Pre-flight notes, not blockers: the Steps name `src\/b\.ts`, which the Files list does not contain\./);
  assert.deepEqual(forge.comments, []);
});

test('rule 4 in its strict form starts the run by default, with a note; the note names the missing file', async () => {
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['src/a.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', GOOD));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.match(starts()[0].body.initial_message.content[0].text, /Pre-flight notes, not blockers: `src\/a\.ts` is listed in Files but does not exist on the default branch and is not marked new\./);
  assert.deepEqual(forge.comments, []);
});

test('rule 2 and rule 3 still block by default: no run starts, and the comment names only the blocking rule', async () => {
  const noCommand = ['## Steps', '1. Change `src/a.ts` and emit `commands.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', 'Run the tests and read the output.'].join('\n');
  const placeholder = ['## Steps', '1. Change `src/a.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', '<command>', '```'].join('\n');
  assert.deepEqual(blockingRules(await ticketViolations(noCommand, notOnBranch(['commands.ts']))), [2]);
  assert.deepEqual(blockingRules(await ticketViolations(placeholder)), [3]);
  const { dispatcher, forge } = await build({ SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['commands.ts']);
  const result = await dispatcher.enqueue(ticket('ai:ready', noCommand));
  await dispatcher.tick();
  assert.equal(result.status, 'ticket_rejected');
  assert.equal(starts().length, 0);
  assert.equal(forge.comments.length, 1);
  assert.match(forge.comments[0].body, /- rule 2: the Acceptance section has no fenced command block/);
  assert.doesNotMatch(forge.comments[0].body, /rule 1/);
  assert.match(forge.comments[0].body, /rule 2/);
});

test('TICKET_PREFLIGHT_BLOCK is a comma list of rule numbers from 1 to 4 (default 2,3, or none); anything else is refused', () => {
  assert.deepEqual(loadConfig(env()).ticketPreflightBlock, [2, 3]);
  assert.deepEqual(loadConfig(env({ TICKET_PREFLIGHT_BLOCK: '' })).ticketPreflightBlock, [2, 3]);
  assert.deepEqual(loadConfig(env({ TICKET_PREFLIGHT_BLOCK: ' 4 , 2,2 ' })).ticketPreflightBlock, [2, 4]);
  assert.deepEqual(loadConfig(env({ TICKET_PREFLIGHT_BLOCK: '1,2,3,4' })).ticketPreflightBlock, [1, 2, 3, 4]);
  assert.deepEqual(loadConfig(env({ TICKET_PREFLIGHT_BLOCK: 'none' })).ticketPreflightBlock, []);
  for (const bad of ['5', '0', '2,,3', '2;3', 'two', '1.5', 'none,2', '2,3,']) {
    assert.throws(() => loadConfig(env({ TICKET_PREFLIGHT_BLOCK: bad })), /TICKET_PREFLIGHT_BLOCK must be a comma list of rule numbers from 1 to 4/, bad);
  }
});

test('the pre-flight notes: none for no findings; at most six named, then the count', () => {
  assert.deepEqual(preflightNoteLines([]), []);
  const notes = [1, 2, 3, 4, 5, 6, 7].map((i) => 'note ' + i);
  assert.deepEqual(preflightNoteLines(notes), ['Pre-flight notes, not blockers: note 1; note 2; note 3; note 4; note 5; note 6 (and 1 more). Stay within the Files list unless the step clearly needs it, and say so in the pull request.']);
});

test('TICKET_PREFLIGHT=0 gives no notes and no rejection: the advisory findings are not read at all', async () => {
  const { dispatcher, forge } = await build({ TICKET_PREFLIGHT: '0', SPLIT_LABEL: 'ai:plan' }, ['ai:ready'], ['commands.ts']);
  const body = ['## Steps', '1. Emit `commands.ts`.', '## Files', '- `src/a.ts`', '## Acceptance', '```sh', 'npm test', '```'].join('\n');
  const result = await dispatcher.enqueue(ticket('ai:ready', body));
  await dispatcher.tick();
  assert.equal(result.status, 'queued');
  assert.doesNotMatch(starts()[0].body.initial_message.content[0].text, /Pre-flight notes/);
  assert.deepEqual(forge.comments, []);
});
