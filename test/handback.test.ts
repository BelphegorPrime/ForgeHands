// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { classifyHandback, handbackOf, pushLine, quoteOf } from '../src/agent/handback.ts';
import { JobStore } from '../src/store/jobs.ts';
import { loadConfig } from '../src/config.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const ESCALATE = '33333333-3333-4333-8333-333333333333';
const API = '/api/v1/repos/owner/hello';
const repo = 'owner/hello';
const quiet = { error() {} };
// Label ids of the fake forge: a label's id is what the forge writes and deletes by.
const IDS = { 'ai:ready': 3, 'ai:plan': 8, 'ai:blocked': 9, 'ai:escalate': 4 };
const LEVELUP = 'Blocked by conflicting scope and acceptance requirements. A fresh checkout has no CDK npm lockfile, and npm ci exits with EUSAGE.';
const NOT_PUSHED = 'Implementation complete in working tree at packages/api. I could not run the optional lint step, so nothing is pushed.';
let dir; let clock; let n = 0;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' },
    'ai:ready': { profile: WORKER, tier: 'free', escalate_to: 'ai:escalate' },
    'ai:escalate': { profile: ESCALATE, tier: 'strong' }
  }),
  MAX_CONCURRENT_PER_TIER: '2',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const ok = (value) => ({ ok: true, status: 200, json: async () => value });
const event = (label, number = 26) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});

// The Forgejo calls a hand-back makes, answered from the state of the test. Unrouted reads are 404, as in test/direct.test.ts.
function fakeForge(state) {
  const calls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    const p = u.pathname;
    calls.push({ method: request.method, path: p, body });
    const get = request.method === 'GET';
    if (get && p === '/api/v1/user') return ok({ login: 'openhands' });
    if (get && p === API + '/issues/26') return ok({ number: 26, state: 'open', labels: state.labels });
    if (get && p === API + '/issues/26/labels') return ok(state.labels);
    if (get && p === API + '/labels') return ok(Object.entries(IDS).map(([name, id]) => ({ id, name })));
    if (get && p === API + '/pulls') return ok(state.pulls);
    if (get && p === API + '/issues/26/comments') return ok(state.comments);
    if (request.method === 'POST' && p === API + '/issues/26/comments') return ok({});
    if (request.method === 'POST' && p === API + '/issues/26/labels') {
      for (const id of body.labels) if (!state.labels.some((label) => label.id === id)) state.labels.push({ id, name: Object.keys(IDS).find((name) => IDS[name] === id) });
      return ok([]);
    }
    if (request.method === 'DELETE' && p.startsWith(API + '/issues/26/labels/')) {
      const id = Number(p.split('/').pop());
      state.labels = state.labels.filter((label) => label.id !== id);
      return ok({});
    }
    if (get && /\/issues\/\d+$/.test(p)) return ok({ number: Number(p.split('/').pop()), state: 'open', labels: [] });
    return { ok: false, status: 404 };
  };
  return { calls, send, writes: () => calls.filter((call) => call.method !== 'GET') };
}

function fakeApi(state, runs) {
  return async (url, request) => {
    const path = new URL(url).pathname;
    runs.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + runs.length }) };
    const id = path.split('/').pop();
    return ok({ execution_status: state.states[id] || 'running', metrics: null, stats: null });
  };
}

// One worker run on issue 26 that was started and is now followed by the test. `end(text)` ends the run and, when text is given, the run
// wrote that comment while it ran (so it counts as written since the run began).
async function setup({ extra = {}, comments = [], pulls = [], labels = ['ai:ready'] } = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const state = { comments, pulls, labels: labels.map((name) => ({ id: IDS[name], name })), states: {} };
  const runs = [];
  const forge = fakeForge(state);
  const api = fakeApi(state, runs);
  const send = (url, request) => (String(url).startsWith('https://forge.example/') ? forge.send(url, request) : api(url, request));
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock);
  await dispatcher.enqueue(event('ai:ready', 26));
  await dispatcher.tick();
  const job = jobs.list()[0];
  const end = async (text) => {
    if (text !== undefined) state.comments.push({ created_at: new Date(clock + 1000).toISOString(), body: text, user: { login: 'openhands' } });
    clock += 5 * 60000;
    state.states[job.conversation_id] = 'finished';
    await dispatcher.tick();
  };
  const starts = () => runs.filter((call) => call.method === 'POST' && call.path.startsWith('/api/conversations'));
  const posted = () => forge.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')).map((call) => call.body.body);
  return { config, jobs, dispatcher, job, end, starts, posted, forge, state, comments: state.comments, pulls: state.pulls };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-handback-')); clock = 1_000_000; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })); // background saves may still be writing

test('the classifier reads blockers and "done but not pushed" in English and German, and leaves questions, plans and progress alone', () => {
  assert.equal(classifyHandback(LEVELUP), 'blocker');
  assert.equal(classifyHandback(NOT_PUSHED), 'pushed_nothing', 'done but nothing pushed wins over the blocker words of the same comment');
  assert.equal(classifyHandback('Implementation complete, no pull request exists.'), 'pushed_nothing');
  assert.equal(classifyHandback('Work is done, but I have not pushed the branch.'), 'pushed_nothing');
  assert.equal(classifyHandback('Blockiert: der Lockfile fehlt im Checkout.'), 'blocker');
  assert.equal(classifyHandback('Ich kann nicht fortfahren, npm ci bricht ab.'), 'blocker');
  assert.equal(classifyHandback('Implementierung abgeschlossen, aber noch nicht gepusht.'), 'pushed_nothing');
  assert.equal(classifyHandback('Should I use Vitest or node:test for the new tests?'), 'other');
  assert.equal(classifyHandback('Plan: first the parser, then the tests, then the docs.'), 'other');
  assert.equal(classifyHandback('Progress: 3 of 5 steps done, continuing with the tests.'), 'other');
  assert.equal(classifyHandback('Unblocked the import, continuing.'), 'other', 'a word that contains a blocker word is not one');
  assert.equal(classifyHandback(''), 'other');
  assert.equal(classifyHandback(undefined), 'other');
});

test('the newest comment since the run decides the hand-back, and a question after a blocker is a delivery', () => {
  const at = (ms, body) => ({ created_at: new Date(clock + ms).toISOString(), body });
  assert.deepEqual(handbackOf([at(1000, 'Should I go on?'), at(2000, LEVELUP)]), { kind: 'blocker', text: LEVELUP });
  assert.equal(handbackOf([at(1000, LEVELUP), at(2000, 'Resolved, continuing with the tests.')]), null);
  assert.equal(handbackOf([]), null);
});

test('the quote of a hand-back is cut, has no mentions and no secrets, and the push line names the issue', () => {
  assert.equal(quoteOf('one\ntwo @marcel', []), '> one\n> two @​marcel');
  assert.match(quoteOf('token hunter2hunter2 left', ['hunter2hunter2']), /\[redacted\]/);
  assert.doesNotMatch(quoteOf('token hunter2hunter2 left', ['hunter2hunter2']), /hunter2hunter2/);
  assert.ok(quoteOf('x'.repeat(2000), []).length < 700, 'the quote is cut');
  assert.equal(pushLine(26), 'Your last run reported work but pushed nothing and opened no pull request: push the branch ai/issue-26 and open the pull request, even if an optional check could not run.');
});

test('a run that says the work is done but nothing was pushed is run once more, told to push the branch', async () => {
  const t = await setup();
  await t.end(NOT_PUSHED);
  assert.equal(t.job.status, 'running', 'queued again and started in the same pass');
  assert.equal(t.job.handback_retry, true);
  assert.equal(t.starts().length, 2);
  assert.equal(t.starts()[1].body.agent_profile_id, WORKER, 'the same route, the same profile');
  assert.ok(t.starts()[1].body.initial_message.content[0].text.endsWith(pushLine(26)), 'the extra prompt line is there');
  assert.equal(t.starts()[0].body.initial_message.content[0].text.includes(pushLine(26)), false, 'the first run is not told');
  assert.equal(t.job.escalated, undefined);
  assert.deepEqual(t.posted(), [], 'no comment of ForgeHands yet');
});

test('a blocker is escalated once to escalate_to, and the escalated run is not told to push', async () => {
  const t = await setup();
  await t.end(LEVELUP);
  assert.equal(t.job.escalated, true);
  assert.equal(t.job.escalated_after, 'handback');
  assert.equal(t.job.failure_escalation, true);
  assert.equal(t.job.status, 'running');
  assert.equal(t.starts().length, 2);
  assert.equal(t.starts()[1].body.agent_profile_id, ESCALATE);
  assert.equal(t.job.handback_push, undefined);
  assert.equal(t.dispatcher.tierOf(t.job), 'strong', 'the escalated run counts for the tier it runs on');
  assert.deepEqual(t.posted(), [], 'no notice yet');
});

test('a second blocker with no planner route goes to the human: the label, the mention and the worker\'s words', async () => {
  const t = await setup();
  await t.end(LEVELUP);
  await t.end('Blocked again: the lockfile is still missing.');
  assert.equal(t.starts().length, 2, 'no third run');
  assert.equal(t.job.status, 'failed');
  assert.equal(t.job.result, 'handback');
  assert.equal(t.posted().length, 1);
  assert.match(t.posted()[0], /^@marcel ForgeHands: the worker reported a blocker after a run was handed back, and no planner \(SPLIT_LABEL\) takes it\. A human has to look at the ticket\./);
  assert.match(t.posted()[0], /> Blocked again: the lockfile is still missing\./);
  assert.ok(t.state.labels.some((label) => label.name === 'ai:blocked'), 'BLOCKED_LABEL is on the ticket');
  assert.ok(!t.state.labels.some((label) => label.name === 'ai:ready'), 'the trigger label comes off');
});

test('a second hand-back of a route without escalate_to goes to the planner, quoted, with the trigger label swapped for SPLIT_LABEL', async () => {
  const t = await setup({ extra: { SPLIT_LABEL: 'ai:plan' } });
  await t.end(LEVELUP);
  await t.end(LEVELUP);
  assert.equal(t.starts().length, 2);
  assert.equal(t.job.result, 'handback');
  assert.match(t.posted()[0], /^ForgeHands: the worker reported a blocker after a run was handed back, so the ticket goes back to the planner \(ai:plan\)/);
  assert.match(t.posted()[0], /> Blocked by conflicting scope and acceptance requirements\./);
  assert.doesNotMatch(t.posted()[0], /^@marcel/, 'no mention when the planner takes the ticket');
  assert.deepEqual(t.state.labels.map((label) => label.name), ['ai:plan']);
});

test('a route without escalate_to sends its first blocker straight to the planner', async () => {
  const extra = { SPLIT_LABEL: 'ai:plan', LABEL_ROUTES: JSON.stringify({ 'ai:plan': { profile: PLANNER, tier: 'strong' }, 'ai:ready': { profile: WORKER, tier: 'free' } }) };
  const t = await setup({ extra });
  await t.end(LEVELUP);
  assert.equal(t.starts().length, 1, 'no escalation without escalate_to');
  assert.equal(t.job.escalated, undefined);
  assert.equal(t.job.result, 'handback');
  assert.deepEqual(t.state.labels.map((label) => label.name), ['ai:plan']);
});

test('a question, a plan or progress comment is a delivery, as before', async () => {
  const texts = ['Should I use Vitest or node:test for the new tests?', 'Plan: first the parser, then the tests, then the docs.', 'Progress: 3 of 5 steps done, continuing with the tests.'];
  for (const text of texts) {
    const t = await setup();
    await t.end(text);
    assert.equal(t.job.status, 'done', text);
    assert.equal(t.job.result, 'finished', text);
    assert.equal(t.job.delivery_retry, undefined, text);
    assert.equal(t.job.handback_retry, undefined, text);
    assert.equal(t.starts().length, 1, text);
    assert.deepEqual(t.posted(), [], text);
  }
});

test('a run that opened or updated its pull request is a delivery, even if it also comments a blocker', async () => {
  const t = await setup();
  t.pulls.push({ number: 5, head: { ref: 'ai/issue-26' }, updated_at: new Date(clock + 60000).toISOString(), state: 'open', merged: false });
  await t.end(LEVELUP);
  assert.equal(t.job.status, 'done');
  assert.equal(t.job.result, 'finished');
  assert.equal(t.job.escalated, undefined);
  assert.equal(t.starts().length, 1);
  assert.deepEqual(t.posted(), []);
});

test('an empty run with a blocker is not a delivery: without the comment, the run is only run once more as before', async () => {
  const t = await setup();
  await t.end();
  assert.equal(t.job.delivery_retry, 1);
  assert.equal(t.job.handback_retry, undefined);
  assert.equal(t.starts().length, 2);
});

test('HANDBACK_HANDLING=0 restores the old behaviour: any comment is a delivery', async () => {
  for (const text of [LEVELUP, NOT_PUSHED]) {
    const t = await setup({ extra: { HANDBACK_HANDLING: '0' } });
    await t.end(text);
    assert.equal(t.job.status, 'done', text);
    assert.equal(t.job.result, 'finished', text);
    assert.equal(t.job.escalated, undefined, text);
    assert.equal(t.job.delivery_retry, undefined, text);
    assert.equal(t.starts().length, 1, text);
  }
});

test('DRY_RUN: a hand-back that reaches the human decides in the ledger, but nothing is written to the forge', async () => {
  // No escalate_to here: the first blocker goes straight to the human, which writes a comment and two labels when the run is live.
  const extra = { DRY_RUN: '1', LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }) };
  const t = await setup({ extra });
  // A dry run starts nothing, so the run is set up as a running one by hand: the hand-back is what is under test.
  Object.assign(t.job, { status: 'running', started: clock, conversation_id: 'conv-dry' });
  t.comments.push({ created_at: new Date(clock + 1000).toISOString(), body: LEVELUP, user: { login: 'openhands' } });
  clock += 5 * 60000;
  await t.dispatcher.checkDelivery(t.job);
  assert.equal(t.job.result, 'handback', 'the decision is taken in memory');
  assert.equal(t.forge.writes().length, 0, 'no comment or label reached the forge');
  assert.equal(t.starts().length, 0, 'no conversation was started');
});

test('HANDBACK_HANDLING is validated: 1 by default, 0 switches it off, anything else is refused', () => {
  const base = env();
  assert.equal(loadConfig(base).handbackHandling, true);
  assert.equal(loadConfig({ ...base, HANDBACK_HANDLING: '1' }).handbackHandling, true);
  assert.equal(loadConfig({ ...base, HANDBACK_HANDLING: '0' }).handbackHandling, false);
  assert.throws(() => loadConfig({ ...base, HANDBACK_HANDLING: 'yes' }), /HANDBACK_HANDLING must be 0 or 1/);
});

// The forge reads after a run ended take a while. `t.hold()` holds the read of the issue's comments until the test lets it go, so that a
// webhook can arrive in between, as one does in production.
function holdComments(t) {
  const send = t.forge.send;
  let release; let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  t.forge.send = async (url, request) => {
    if (request.method === 'GET' && new URL(url).pathname === API + '/issues/26/comments') { reached(); await gate; }
    return send(url, request);
  };
  return { arrived, release };
}

for (const [what, text] of [['an empty run', undefined], ['a hand-back', NOT_PUSHED]]) {
  test(`a label set while ${what} is looked at queues the one fresh run, and the old run is not run again`, async () => {
    const t = await setup();
    const held = holdComments(t);
    const ending = t.end(text);
    await held.arrived;
    // The human sets the label again while the ended run is being looked at: the old job is done, so this queues a fresh one.
    assert.equal((await t.dispatcher.enqueue(event('ai:ready', 26))).status, 'queued');
    held.release();
    await ending;
    await t.dispatcher.tick();
    const active = t.jobs.list(true);
    assert.equal(active.length, 1, 'one active run on the ticket: ' + active.map((job) => job.id + ' ' + job.status).join(', '));
    assert.notEqual(active[0].id, t.job.id, 'the fresh run is the one that goes on');
    assert.equal(t.job.status, 'done');
    assert.equal(t.job.delivery_retry, undefined);
    assert.equal(t.job.handback_retry, undefined);
    assert.equal(t.starts().length, 2, 'the first run and the fresh one, no third');
    assert.deepEqual(t.posted(), [], 'no human is called');
  });
}
