// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Operator prerequisites (OPERATOR_LABEL): the planner's prompt, an operator ticket that starts no run and is told once, and a worker whose ticket
// waits for the operator ticket it made, which is not a failed delivery.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { JobStore } from '../src/store/jobs.ts';
import { loadConfig } from '../src/config.ts';
import { Notifier } from '../src/notify/index.ts';
import { buildStatus } from '../src/server/status.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const API = '/api/v1/repos/owner/hello';
const repo = 'owner/hello';
const quiet = { error() {} };
let dir; let clock; let n = 0;
let world; let sent;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' },
    'ai:ready': { profile: WORKER, tier: 'free' }
  }),
  MAX_CONCURRENT_PER_TIER: '2',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const ok = (value) => ({ ok: true, status: 200, json: async () => value });
const created = (value) => ({ ok: true, status: 201, json: async () => value });
const label = (name) => ({ id: name.length, name });

// The forge as the operator and the worker see it: issues with labels and state, dependencies (Forgejo's /issues/n/dependencies: the issues n
// depends on), blocks (the issues that depend on n), comments. Unknown reads are 404.
function fakeForge() {
  const forge = { calls: [], posted: [], issues: {}, deps: {}, blocks: {}, comments: {}, closed: new Set() };
  forge.send = async (url, request) => {
    const path = new URL(url).pathname;
    const body = request.body ? JSON.parse(request.body) : undefined;
    forge.calls.push({ method: request.method, path, body });
    if (request.method === 'POST' && /\/comments$/.test(path)) { forge.posted.push({ path, body: body.body }); return created({}); }
    if (request.method !== 'GET') return { ok: false, status: 404 };
    if (path === '/api/v1/user') return ok({ login: 'openhands' });
    if (path === API + '/pulls') return ok([]);
    const dependencies = /\/issues\/(\d+)\/dependencies$/.exec(path);
    if (dependencies) return ok((forge.deps[Number(dependencies[1])] || []).map((number) => forge.issue(number)));
    const blocks = /\/issues\/(\d+)\/blocks$/.exec(path);
    if (blocks) return ok((forge.blocks[Number(blocks[1])] || []).map((number) => forge.issue(number)));
    const comments = /\/issues\/(\d+)\/comments$/.exec(path);
    if (comments) return ok(forge.comments[Number(comments[1])] || []);
    const issue = /\/issues\/(\d+)$/.exec(path);
    if (issue) return ok(forge.issue(Number(issue[1])));
    return { ok: false, status: 404 };
  };
  forge.issue = (number) => {
    const known = forge.issues[number] || {};
    return { number, title: known.title || 'Issue ' + number, html_url: 'https://forge.example/owner/hello/issues/' + number,
      state: forge.closed.has(number) ? 'closed' : 'open', labels: (known.labels || []).map(label) };
  };
  return forge;
}

function fakeOpenHands(runs) {
  const states = {};
  const send = async (url, request) => {
    const path = new URL(url).pathname;
    runs.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return created({ id: 'conv-' + runs.length });
    return ok({ execution_status: states[path.split('/').pop()] || 'running', metrics: null, stats: null });
  };
  return { send, states };
}

async function build(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const runs = [];
  const openhands = fakeOpenHands(runs);
  const send = (url, request) => (String(url).startsWith('https://forge.example/') ? world.send(url, request) : openhands.send(url, request));
  const notifier = new Notifier([{ name: 'test', send: async (message) => { sent.push(message); } }], ['handover'], () => false, quiet, () => {});
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock, notifier);
  const starts = () => runs.filter((call) => call.method === 'POST' && call.path.startsWith('/api/conversations'));
  return { config, jobs, dispatcher, runs, starts, states: openhands.states };
}

const event = (labelName, number, extra = {}) => ({
  type: 'issues.labeled', label: labelName,
  repository: { full_name: repo, clone_url: null, default_branch: 'main' },
  issue: { number, title: world.issues[number]?.title ?? 'Ticket ' + number, body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [labelName] },
  sender: { login: 'marcel' }, ...extra
});
const closedEvent = (number) => ({
  type: 'issues.closed', label: undefined,
  repository: { full_name: repo, clone_url: null, default_branch: 'main' },
  issue: { number, title: 'Ticket ' + number, body: '', html_url: null, labels: [] }, sender: { login: 'marcel' }
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-operator-'));
  clock = 1_000_000; world = fakeForge(); sent = [];
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })); // background saves may still be writing

test('the planner prompt lists operator prerequisites before it splits, and the worker prompt says what to do when it needs one', () => {
  const config = loadConfig(env());
  const plan = buildPrompt(event('ai:plan', 5), config);
  assert.match(plan, /Operator prerequisites come first, before you split anything/);
  assert.match(plan, /ONE ticket/);
  assert.match(plan, /title is "Operator: <what>"/);
  assert.match(plan, /only label is "needs:operator"/);
  assert.match(plan, /POST \$FORGEJO_URL\/api\/v1\/repos\/owner\/hello\/issues\/<worker ticket>\/dependencies/);
  assert.ok(plan.indexOf('Operator prerequisites come first') < plan.indexOf('<<<UNTRUSTED_ISSUE_TEXT'), 'the rule is in the instructions, not in the quoted ticket');
  assert.doesNotMatch(plan, /If your ticket needs something only the operator can provide/);

  const work = buildPrompt(event('ai:ready', 7), config);
  assert.match(work, /If your ticket needs something only the operator can provide/);
  assert.match(work, /POST \$FORGEJO_URL\/api\/v1\/repos\/owner\/hello\/issues\/7\/dependencies/, 'the worker makes its own ticket depend on the operator ticket');
  assert.match(work, /Do not push a branch for that step/);
  assert.doesNotMatch(work, /Operator prerequisites come first/);
});

test('OPERATOR_LABEL names the label in both prompts, and a label with a comma is refused', () => {
  const config = loadConfig(env({ OPERATOR_LABEL: 'waits:human' }));
  assert.match(buildPrompt(event('ai:plan', 5), config), /only label is "waits:human"/);
  assert.match(buildPrompt(event('ai:ready', 7), config), /label "waits:human" only/);
  assert.equal(loadConfig(env()).operatorLabel, 'needs:operator');
  assert.throws(() => loadConfig(env({ OPERATOR_LABEL: 'a,b' })), /OPERATOR_LABEL must be a label name/);
});

test('an operator ticket starts no run, even with a route label, is listed for the human and is told about once', async () => {
  const t = await build();
  world.issues[31] = { title: 'Operator: npm publish token', labels: ['needs:operator'] };
  assert.equal((await t.dispatcher.enqueue(event('needs:operator', 31))).status, 'operator_prerequisite');
  // The same ticket again (another event, a label added later): still one message, still no run.
  await t.dispatcher.enqueue(event('needs:operator', 31, { type: 'issues.opened' }));
  // A route label added by mistake to an operator ticket: no run either.
  world.issues[32] = { title: 'Operator: registry setting', labels: ['ai:ready', 'needs:operator'] };
  await t.dispatcher.enqueue({ ...event('ai:ready', 32), issue: { number: 32, title: 'Operator: registry setting', body: '', html_url: null, labels: ['ai:ready', 'needs:operator'] } });
  await t.dispatcher.tick();
  assert.equal(t.starts().length, 0, 'no conversation is started for an operator ticket');
  assert.equal(t.jobs.list().length, 0, 'and no job is queued for it');
  assert.equal(sent.length, 2, 'one message per operator ticket (31 and 32), none for the repeated event');
  assert.deepEqual(sent.map((message) => message.kind), ['handover', 'handover']);
  assert.match(sent[0].subject, /needs an operator/);
  assert.match(sent[0].text, /Operator: npm publish token/);
  // The operator ticket shows on /status as waiting for a human, with its title and the reason.
  const status = buildStatus(t.config, t.jobs, clock, undefined, t.dispatcher.operatorWaiting());
  const entry = status.waiting_for_human.find((item) => item.issue === 31);
  assert.deepEqual({ reason: entry.reason, title: entry.title, pr: entry.pr, repository: entry.repository }, { reason: 'operator_prerequisite', title: 'Operator: npm publish token', pr: null, repository: repo });
  assert.equal(status.waiting_for_human.length, 2);
  assert.equal(status.factory.operator_tickets.count, 2, 'the factory section lists them too');
  assert.equal(status.factory.operator_tickets.list[0].title, 'Operator: npm publish token');
});

test('a worker that made an operator ticket and depends on it waits: no hand-back, no retry, and it starts when the operator ticket is closed', async () => {
  const t = await build();
  world.issues[30] = { title: 'Publish the image', labels: ['ai:ready'] };
  await t.dispatcher.enqueue(event('ai:ready', 30));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  assert.equal(t.starts().length, 1);
  // The run ends: it wrote one comment (a blocker in its words) and created operator ticket 33, which its ticket depends on.
  world.issues[33] = { title: 'Operator: container registry token', labels: ['needs:operator'] };
  world.deps[30] = [33];
  world.comments[30] = [{ created_at: new Date(clock + 60000).toISOString(), body: 'Blocked: the registry token is missing, I cannot publish. I created Operator ticket #33 for it.', user: { login: 'openhands' } }];
  t.states[job.conversation_id] = 'finished';
  clock += 5 * 60000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'waiting');
  assert.deepEqual(job.waiting_for, [33]);
  assert.notEqual(job.result, 'handback');
  assert.notEqual(job.result, 'no_delivery');
  assert.equal(job.escalated, undefined, 'no escalation');
  assert.deepEqual(world.posted, [], 'ForgeHands writes no comment of its own');
  assert.equal(t.starts().length, 1, 'no second run');
  assert.equal(sent.length, 1, 'the human is told about the operator ticket once');
  assert.equal(t.dispatcher.operatorWaiting()[0].issue, 33);
  // Further passes change nothing: the ticket keeps waiting and is not told again.
  clock += 60000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'waiting');
  assert.equal(sent.length, 1);
  // The operator closes the prerequisite: the dependent ticket starts, and the operator ticket leaves the list.
  world.closed.add(33);
  world.deps[30] = [33];
  world.blocks[33] = [30];
  await t.dispatcher.onClosed(closedEvent(33));
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(t.starts().length, 2, 'the ticket runs again once the prerequisite is done');
  assert.equal(t.dispatcher.operatorWaiting().length, 0);
});

test('a ticket that depends on an open operator ticket from the start waits for it, and starts when it is closed', async () => {
  const t = await build();
  world.issues[40] = { title: 'Publish the CLI', labels: ['ai:ready'] };
  world.issues[41] = { title: 'Operator: npm token', labels: ['needs:operator'] };
  world.deps[40] = [41];
  await t.dispatcher.enqueue(event('ai:ready', 40));
  await t.dispatcher.tick();
  assert.equal(t.jobs.list()[0].status, 'waiting');
  assert.deepEqual(t.jobs.list()[0].waiting_for, [41]);
  assert.equal(t.starts().length, 0, 'no worker runs before the prerequisite is done');
  world.closed.add(41);
  world.deps[40] = [41];
  world.blocks[41] = [40];
  await t.dispatcher.onClosed(closedEvent(41));
  await t.dispatcher.tick();
  assert.equal(t.starts().length, 1);
});

test('a ticket seen before a restart stays in the ledger and is not told again', async () => {
  const first = await build();
  world.issues[50] = { title: 'Operator: DNS record', labels: ['needs:operator'] };
  await first.dispatcher.enqueue({ ...event('needs:operator', 50), issue: { number: 50, title: 'Operator: DNS record', body: '', html_url: null, labels: ['needs:operator'] } });
  await first.jobs.persist(clock);
  const reloaded = new JobStore(first.jobs.file);
  await reloaded.load();
  assert.equal(reloaded.operatorTickets.get(repo.toLowerCase() + '#50').title, 'Operator: DNS record');
  const after = await build();
  after.jobs.operatorTickets = reloaded.operatorTickets;
  await after.dispatcher.enqueue({ ...event('needs:operator', 50, { type: 'issues.opened' }), issue: { number: 50, title: 'Operator: DNS record', body: '', html_url: null, labels: ['needs:operator'] } });
  assert.equal(sent.length, 1, 'one message in all, from the first start');
});

test('OPERATOR_LABEL must be a label name: a comma or more than 50 characters is refused', () => {
  assert.throws(() => loadConfig(env({ OPERATOR_LABEL: 'x'.repeat(51) })), /OPERATOR_LABEL/);
});

test('the ticket watchdog leaves a ticket that waits for an open operator ticket alone, and drops a stall record it had', async () => {
  const t = await build();
  world.issues[30] = { title: 'Publish the image', labels: ['ai:ready'] };
  world.issues[33] = { title: 'Operator: registry token', labels: ['needs:operator'] };
  t.jobs.add({ key: repo + '#30:ai:ready', label: 'ai:ready', status: 'waiting', waiting_for: [33], created: clock - 300 * 60000, attempts: 0,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, clone_url: null, default_branch: 'main' },
      issue: { number: 30, title: 'Publish the image', body: '', html_url: null, labels: ['ai:ready'] }, sender: { login: 'marcel' } } });
  t.jobs.operatorTickets.set(repo.toLowerCase() + '#33', { repository: repo, issue: 33, title: 'Operator: registry token', at: clock });
  t.jobs.stalled.set(repo.toLowerCase() + '#30', { repository: repo, issue: 30, run: 'old', restarts: 0, human: false, at: clock - 1000 });
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  assert.equal(t.starts().length, 0, 'no restart of the ticket');
  assert.equal(t.jobs.stalled.has(repo.toLowerCase() + '#30'), false, 'the stall record goes: the ticket waits for the operator');
  assert.equal(t.dispatcher.operatorWaiting().length, 1, 'the operator ticket stays listed');
});
