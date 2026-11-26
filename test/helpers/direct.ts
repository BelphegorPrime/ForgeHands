// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The setup the direct-mode tests share: environment, fake APIs, builders and the state each test starts from.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../../src/server/app.ts';
import { DeliveryStore } from '../../src/store/deliveries.ts';
import { JobStore } from '../../src/store/jobs.ts';
import { Dispatcher } from '../../src/agent/dispatch.ts';
import { loadConfig } from '../../src/config.ts';
import { buildPrompt } from '../../src/agent/prompt.ts';
import { normalizeEvent } from '../../src/webhook/events.ts';
import { Merger } from '../../src/agent/merge.ts';
import { globToRegExp } from '../../src/utils/glob.ts';
import { buildStatus, renderStatus } from '../../src/server/status.ts';
import { normalizeGiteaEvent } from '../../src/forge/gitea/webhook.ts';
import { metrics as tierMetrics } from '../../src/metrics.ts';
import { parseDeclaredFiles } from '../../src/agent/files.ts';
import { pathsOverlap } from '../../src/utils/path-overlap.ts';

// The state the tests share, reset before every test: the temporary directory, the fake clock and what the fakes saw.
export const ctx = { dir: undefined, clock: undefined, calls: undefined, states: undefined, failStarts: undefined, costs: undefined, deliveryRuns: 0, appCount: 0, commentRuns: 0, commentDeliveries: 0 };

export const PLANNER = '11111111-1111-4111-8111-111111111111';
export const WORKER = '22222222-2222-4222-8222-222222222222';
export const ESCALATE = '33333333-3333-4333-8333-333333333333';
export const repo = 'owner/hello';
export const quiet = { error() {} };
export const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 80, max_budget: 1.5 },
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:escalate': { profile: ESCALATE, tier: 'strong' }
  }),
  MAX_CONCURRENT_PER_TIER: '2',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(ctx.dir, 'deliveries.json'),
  // The status page is closed without STATUS_TOKEN; these tests read it, so it is opened unless a test sets a token.
  ...(extra.STATUS_TOKEN ? {} : { STATUS_PUBLIC: '1' }),
  ...extra
});
export function fakeApi() {
  return async (url, request) => {
    const path = new URL(url).pathname;
    ctx.calls.push({ method: request.method, path, body: request.body && JSON.parse(request.body), headers: request.headers });
    if (request.method === 'POST') {
      if (ctx.failStarts) return { ok: false, status: 503 };
      return { ok: true, status: 201, json: async () => ({ id: 'conv-' + ctx.calls.length }) };
    }
    const id = path.split('/').pop();
    return { ok: true, status: 200, json: async () => ({ execution_status: ctx.states[id] || 'running',
      metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: ctx.costs[id] || 0 } } } }) };
  };
}
export async function build(extra) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock);
  return { config, jobs, dispatcher };
}
export const event = (label, number = 1, extra = {}) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }, ...extra
});
export const starts = () => ctx.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/conversations'));
beforeEach(async () => { ctx.dir = await mkdtemp(join(tmpdir(), 'forgehands-direct-')); ctx.clock = 1_000_000; ctx.calls = []; ctx.states = {}; ctx.costs = {}; ctx.failStarts = false; });
afterEach(() => rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })); // background saves may still be writing
export async function webhook(config, dispatcher) {
  const store = new DeliveryStore(config.dataFile);
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/webhooks/forgejo';
  let n = 0;
  const post = async (number, action, labels, delivery = 'w' + ++n) => {
    const raw = JSON.stringify({ action, sender: { login: 'marcel' }, repository: { full_name: repo }, number,
      issue: { number, labels: labels.map((name) => ({ name })) } });
    const response = await fetch(url, { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': 'issues', 'x-gitea-delivery': delivery,
      'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') } });
    return { code: response.status, status: (await response.json()).status };
  };
  return { post, close: () => new Promise((resolve) => server.close(resolve)) };
}
export const finishAll = async (dispatcher, jobs) => {
  for (const job of jobs.list('running')) ctx.states[job.conversation_id] = 'finished';
  await dispatcher.tick();
};
// ---- follow-up rounds: a label on the pull request of an agent issue
export const CHANGES = '44444444-4444-4444-8444-444444444444';
export const withChanges = (extra = {}) => ({
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request' }
  }),
  ...extra
});
export const prPayload = (labels, { ref = 'ai/issue-26', number = 34, state = 'open', merged = false, action = 'label_updated' } = {}) => ({
  action, repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  pull_request: { number, state, merged, title: 'Fix it', body: 'Closes #26', comments: 2, html_url: 'https://forge.example/owner/hello/pulls/' + number,
    head: { ref }, labels: labels.map((name) => ({ name })) },
  sender: { login: 'marcel' }
});
export const prEvent = (previous = [], extra = {}) => {
  const e = normalizeEvent('pull_request', prPayload(['ai:changes']), new Set([repo]), ['ai:ready'], { labelEvents: true, prLabels: ['ai:changes'] });
  return { ...e, previous_labels: previous, ...extra };
};
export async function buildWatched(extra) {
  const forgejo = [];
  const config = loadConfig(env(withChanges({ HUMAN_LOGIN: 'marcel', ...extra, LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' }, 'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request' } }) })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    const path = new URL(url).pathname.replace('/api/v1/repos/owner/hello', '');
    forgejo.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    // The ticket itself, open and carrying its trigger label: a paused run is only resumed while that label is on it.
    if (request.method === 'GET' && /^\/issues\/\d+$/.test(path)) return { ok: true, status: 200, json: async () => ({ number: Number(path.slice(8)), state: 'open', labels: [{ id: 3, name: 'ai:ready' }] }) };
    const labels = path.endsWith('/labels') && request.method === 'GET' && path !== '/labels' ? [{ id: 3, name: 'ai:ready' }] : request.method === 'GET' ? [{ id: 8, name: 'ai:plan' }, { id: 9, name: 'ai:blocked' }] : { id: 77 };
    return { ok: true, status: 200, json: async () => labels };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  const finish = async (state) => { await dispatcher.tick(); ctx.states[jobs.list().at(-1).conversation_id] = state; await dispatcher.tick(); };
  return { forgejo, jobs, dispatcher, finish, comments: () => forgejo.filter((c) => c.method === 'POST' && c.path.endsWith('/comments')).map((c) => c.body.body) };
}
export async function buildDelivery({ pulls = [], comments = [], issueState = 'open', labels = [], label = 'ai:ready', routes = {}, logger = quiet, extra = {}, hold = null } = {}) {
  const config = loadConfig(env({ HUMAN_LOGIN: 'marcel', ...extra }));
  const jobs = new JobStore(join(ctx.dir, 'delivery-' + (ctx.deliveryRuns++) + '.json'));
  await jobs.load();
  const forgejo = fakeForgejo({
    ['GET /api/v1/user']: { login: 'openhands' },
    ['GET ' + API + '/issues/26']: { number: 26, state: issueState, labels },
    ['GET ' + API + '/pulls']: () => pulls,
    ['GET ' + API + '/issues/26/comments']: () => comments,
    ['POST ' + API + '/issues/26/comments']: {},
    ...routes
  });
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => ctx.clock);
  if (hold) dispatcher.cooldowns.set(hold, ctx.clock + 24 * 3600000); // the tier of the route is out of quota: the job starts on its fallback
  await dispatcher.enqueue(event(label, 26));
  await dispatcher.tick();
  const job = jobs.list()[0];
  const end = async () => { ctx.clock += 5 * 60000; ctx.states[job.conversation_id] = 'finished'; await dispatcher.tick(); };
  return { jobs, job, forgejo, dispatcher, end, comments: () => forgejo.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments')).map((c) => c.body.body) };
}
// An issue route with escalate_to: the second empty run starts once more on the target profile; only that run being empty too calls the human.
export const DELIVERY_ROUTES = JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'free', escalate_to: 'ai:escalate' },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' }
});
// A job that started on the fallback route (its tier was out of quota) keeps the escalate_to of the route its ticket was started with: the
// fallback route has none, so the escalation must not be read from it.
export const FALLBACK_FREE = '55555555-5555-4555-8555-555555555555';
export const FALLBACK_ROUTES = JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'cheap', fallback_to: 'ai:ready-free', escalate_to: 'ai:escalate' },
  'ai:ready-free': { profile: FALLBACK_FREE, tier: 'free' },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' }
});
// ---- the security review: a second, advisory review of pull requests that touch protected paths
export const SECURITY = '77777777-7777-4777-8777-777777777777';
export const sensitiveRoutes = () => JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'free' },
  'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
  'ci:failure': { profile: CHANGES, tier: 'free', max_iterations: 100, on: 'ci_failure' },
  'ci:success': { profile: REVIEWER, tier: 'strong', max_iterations: 60, on: 'ci_success' },
  'sensitive:review': { profile: SECURITY, tier: 'strong', max_iterations: 60, on: 'sensitive_review' }
});
export async function buildSensitive(files, { comments = [], extra = {} } = {}) {
  const config = loadConfig(env(withMerge({ LABEL_ROUTES: sensitiveRoutes(), HUMAN_LOGIN: 'marcel', ...extra })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo({
    ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, head: { sha: 'abcdef0123456789' }, labels: [] },
    ['GET ' + API + '/commits/abcdef0123456789/status']: { state: 'success', total_count: 2 },
    ['GET ' + API + '/pulls/34/files']: files.map((filename) => ({ filename })),
    ['GET ' + API + '/issues/34/comments']: comments,
    ['GET ' + API + '/issues/34/labels']: [], ['POST ' + API + '/issues/34/comments']: {}
  });
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
// ---- who gets the next free slot: weights between repositories, the oldest ticket within one
export async function buildQueue(extra, tickets, file = 'jobs.json') {
  const config = loadConfig(env({ MAX_CONCURRENT: '1', MAX_RUNS_PER_HOUR: '1000', ...extra }));
  const jobs = new JobStore(join(ctx.dir, file));
  await jobs.load();
  let created = ctx.clock;
  for (const [full, number] of tickets) {
    const e = event('ai:ready', number, { repository: { full_name: full, clone_url: 'https://forge.example/' + full + '.git', default_branch: 'main' } });
    jobs.add({ key: full + '#' + number + ':ai:ready', label: 'ai:ready', event: e, status: 'queued', created: created++ });
  }
  return { jobs, dispatcher: new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock) };
}
// One job at a time: the order in which the tickets start.
export async function startOrder(dispatcher, jobs, count) {
  const order = [];
  for (let i = 0; i < count; i++) {
    await dispatcher.tick();
    const running = jobs.list('running')[0];
    order.push(running.event.repository.full_name + '#' + running.event.issue.number);
    ctx.states[running.conversation_id] = 'finished';
    ctx.clock += 1000;
  }
  return order;
}
// ---- CI events: a failed run starts a fix round, a green commit starts the review
export const REVIEWER = '55555555-5555-4555-8555-555555555555';
export const withCi = (extra = {}) => withChanges({
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
    'ci:failure': { profile: CHANGES, tier: 'free', max_iterations: 100, on: 'ci_failure' },
    'ci:success': { profile: REVIEWER, tier: 'strong', max_iterations: 60, on: 'ci_success' }
  }),
  ...extra
});
export const CI_ROUTES = { failure: 'ci:failure', success: 'ci:success' };
export const runPayload = (status, { sha = 'abcdef0123456789', ref = 'ai/issue-26', state = 'open', merged = false, event = 'pull_request', number = 34 } = {}) => ({
  action: status, prior_status: 'running',
  run: { id: 9, workflow_id: 'ci.yaml', commit_sha: sha, event, status, html_url: 'https://forge.example/owner/hello/actions/runs/1',
    repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' }, trigger_user: { login: 'marcel' },
    event_payload: JSON.stringify({ action: 'opened', number, pull_request: { number, state, merged, title: 'Fix it', body: 'Closes #26', head: { ref } } }) }
});
export const ciEvent = (outcome, extra) => normalizeEvent('action_run_' + outcome, runPayload(outcome, extra), new Set([repo]), [], { ci: CI_ROUTES });
// the commit status of Forgejo and the calls made to it
export async function buildCi(status, extra = {}) {
  const config = loadConfig(env(withCi(extra)));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = [];
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    forgejo.push({ method: request.method, path: new URL(url).pathname });
    if (status === 'error') return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => status };
  };
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
export const MERGE = { 'owner/hello': { deny: ['compose.yaml', '.github/**', 'docs/**/*.secret'] } };
export const withMerge = (extra = {}) => withCi({ MERGE_POLICY: JSON.stringify(MERGE), ...extra });
export const API = '/api/v1/repos/owner/hello';
// A fake Forgejo: routes maps "METHOD path" to a value or a function (url, body) => value; unknown calls answer 404.
export function fakeForgejo(routes) {
  const calls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ method: request.method, path: u.pathname, search: u.search, body });
    let route = routes[request.method + ' ' + u.pathname];
    // A ticket that is not routed exists and is open (a 404 of the ticket itself means it was deleted, see openDependencies).
    if (route === undefined && request.method === 'GET' && /\/issues\/\d+$/.test(u.pathname)) route = { number: Number(u.pathname.split('/').pop()), state: 'open', labels: [] };
    if (route === undefined) return { ok: false, status: 404 };
    const value = typeof route === 'function' ? route(u, body) : route;
    if (value && value.__status) return { ok: false, status: value.__status };
    return { ok: true, status: 200, json: async () => value };
  };
  const wrote = () => calls.filter((call) => call.method !== 'GET').map((call) => call.method + ' ' + call.path.replace(API, ''));
  return { calls, send, wrote };
}
export const VERDICT_OK = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.mjs line 12, check bash validate.sh exit 0. '.repeat(8);
export const goodRoutes = (over = {}) => ({
  ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: true, title: 'WIP: Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] },
  ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'success', total_count: 2 },
  ['GET ' + API + '/pulls/34/files']: [{ filename: 'README.md' }, { filename: 'src/a.mjs' }],
  ['GET ' + API + '/git/commits/cafe0000cafe']: { created: '2026-11-15T10:00:00Z' },
  ['GET ' + API + '/issues/34/comments']: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: VERDICT_OK }],
  ['PATCH ' + API + '/pulls/34']: {}, ['POST ' + API + '/pulls/34/merge']: {}, ['POST ' + API + '/issues/34/comments']: {}, ['PATCH ' + API + '/issues/26']: {},
  ...over
});
export async function mergerFor(routes, extra, later) {
  const config = loadConfig(env(withMerge({ APPROVAL_GRACE_SECONDS: '0', ...extra })));
  const forgejo = fakeForgejo(routes);
  const merger = new Merger(config, forgejo.send, quiet, later);
  merger.sleep = async () => {};
  return { config, forgejo, merger };
}
export const approvedEvent = () => ({ repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 } });
// Forgejo works `mergeable` out again after the title change: the flag may still say false on the first read after it. `turnsTrueAt` is the read
// (counted from the title change, 1 = the first) from which Forgejo says true; Infinity: it never does.
export function wipThenClean(turnsTrueAt) {
  let cleaned = false;
  let reads = 0;
  const pr = () => {
    if (!cleaned) return { state: 'open', merged: false, mergeable: true, title: 'WIP: Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] };
    reads++;
    return { state: 'open', merged: false, mergeable: reads >= turnsTrueAt, title: 'Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] };
  };
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34']: pr, ['PATCH ' + API + '/pulls/34']: () => { cleaned = true; return {}; } });
  return { routes, reads: () => reads };
}
// the Forgejo of buildCi answers every call with `status`; this one answers the pull request with its head commit
export async function buildCiWithHead(head, status = { state: 'success', total_count: 1 }) {
  const config = loadConfig(env(withCi()));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    const path = new URL(url).pathname;
    return { ok: true, status: 200, json: async () => (path.endsWith('/pulls/34') ? { head: { sha: head } } : status) };
  };
  return { jobs, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
// ---- epic flow: issues wait for their dependencies, an epic is reviewed when its last dependency closes
export const withEpic = (extra = {}) => ({
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'epic:done': { profile: REVIEWER, tier: 'strong', max_iterations: 40, on: 'epic_done' }
  }),
  ...extra
});
export async function buildEpic(routes, extra = {}) {
  const config = loadConfig(env(withEpic(extra)));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo(routes);
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
export const issue = (number, state, extra = {}) => ({ number, state, title: 'Sub ' + number, labels: [], ...extra });
export const closedEvent = (number) => normalizeEvent('issues', { action: 'closed', repository: { full_name: repo }, issue: { number }, sender: { login: 'marcel' } }, new Set([repo]), ['ai:ready'], {});
// ---- a directory per run, and a review that ends without a verdict
export async function buildVerdict(routes, extra = {}) {
  const config = loadConfig(env(withCi(extra)));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo(routes);
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
export const reviewJob = () => ({ key: 'owner/hello#26:ci:success:abcdef01', label: 'ci:success', status: 'running', started: ctx.clock, created: ctx.clock, conversation_id: 'conv-r', event: ciEvent('success') });
export const prWith = (labels, over = {}) => ({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, head: { sha: 'abcdef0123456789' }, labels: labels.map((name) => ({ name })), ...over },
  ['POST ' + API + '/issues/34/comments']: {}, ['GET ' + API + '/labels']: [{ id: 9, name: 'ai:blocked' }], ['POST ' + API + '/issues/34/labels']: {} });
// ---- the human is mentioned only where a human is needed
export const commentsOf = (forgejo) => forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')).map((call) => call.body.body);
// ---- the model is out of quota: hold the tier back and try again, instead of blocking the pull request
export const rateLimitError = (seconds) => ({ kind: 'ConversationErrorEvent', code: 'LLMRateLimitError', classification: { kind: 'rate_limit', retryable: true },
  detail: 'litellm.RateLimitError: OpenAIException - {"error":{"message":"quota","retry_after":' + seconds + '}}' });
export async function buildQuota(events, file = 'jobs.json') {
  const config = loadConfig(env(withCi()));
  const jobs = new JobStore(join(ctx.dir, file));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo(prWith([]));
  const send = async (url, request) => {
    const u = new URL(url);
    if (String(url).startsWith('https://forge.example/')) return forgejo.send(url, request);
    if (u.pathname.endsWith('/events/search')) return events === null ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => ({ items: events }) };
    return api(url, request);
  };
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
// ---- finished runs are archived after a while, with their tags
export const DAY = 86400000;
export async function buildArchive(extra = {}, conversations = {}) {
  const config = loadConfig(env(withChanges(extra)));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const patches = [];
  const send = async (url, request) => {
    const path = new URL(url).pathname;
    const id = decodeURIComponent(path.split('/').pop());
    if (request.method === 'PATCH') {
      if (conversations[id]?.failPatch) return { ok: false, status: 500 };
      patches.push({ id, body: JSON.parse(request.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const conversation = conversations[id];
    if (!conversation) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ execution_status: conversation.status || 'finished', tags: conversation.tags || {}, stats: { usage_to_metrics: {} } }) };
  };
  return { config, jobs, patches, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
export const endedJob = (id, finished, status = 'done') => ({ key: 'owner/hello#' + id + ':ai:ready', label: 'ai:ready', status, conversation_id: 'c' + id, finished, created: finished - 1000, event: event('ai:ready', id) });
// ---- no merge without a real review of the current commit
export const commentsRoute = (comments) => ({ ['GET ' + API + '/issues/34/comments']: comments });
export const verdict = (text, at = '2026-11-15T11:00:00Z', login = 'openhands') => ({ created_at: at, user: { login }, body: text });
export const blockRoutes = { ['GET ' + API + '/issues/34/labels']: [{ id: 5, name: 'ai:approved' }], ['DELETE ' + API + '/issues/34/labels/5']: {}, ['GET ' + API + '/labels']: [{ id: 9, name: 'ai:blocked' }], ['POST ' + API + '/issues/34/labels']: {} };
// ---- the default branch moves: open agent pull requests are kept up to date, a conflict becomes a round of the worker
export const withBranches = (extra = {}) => withMerge({
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
    'pr:conflict': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'conflict' }
  }),
  ...extra
});
export const TIP = 'a'.repeat(40);
export const OLD_BASE = 'b'.repeat(40);
export const pull = (number, over = {}) => ({ number, state: 'open', merged: false, title: 'WIP: Fix ' + number, body: 'Closes #' + (number - 8), html_url: 'https://forge.example/owner/hello/pulls/' + number,
  head: { ref: 'ai/issue-' + (number - 8), sha: 'cafe' + number + '0000', repo: { full_name: 'owner/hello' } }, merge_base: OLD_BASE, labels: [], ...over });
export const noReview = (number) => ({ ['GET ' + API + '/git/commits/cafe' + number + '0000']: { created: '2026-11-15T10:00:00Z' }, ['GET ' + API + '/issues/' + number + '/comments']: [] });
export const okReview = (number) => ({ ['GET ' + API + '/git/commits/cafe' + number + '0000']: { created: '2026-11-15T10:00:00Z' },
  ['GET ' + API + '/issues/' + number + '/comments']: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: VERDICT_OK }] });
export async function buildBranches(pulls, routes = {}, extra = {}) {
  const config = loadConfig(env(withBranches(extra)));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo({ ['GET ' + API + '/pulls']: pulls, ...routes });
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
export const pushPayload = (over = {}) => ({ ref: 'refs/heads/main', after: TIP, repository: { full_name: repo, default_branch: 'main', clone_url: 'https://forge.example/owner/hello.git' }, sender: { login: 'marcel' }, ...over });
export const movedEvent = (after = TIP) => normalizeEvent('push', pushPayload({ after }), new Set([repo]), [], { pushes: true });
export const updates = (forgejo) => forgejo.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/update')).map((call) => call.path.split('/').at(-2));
export const afterDelay = async (dispatcher) => { ctx.clock += 61000; await dispatcher.tick(); };
export const filesRoutes = (number, mine, main, commits = 1) => ({ ['GET ' + API + '/compare/' + OLD_BASE + '...' + TIP]: { total_commits: commits, files: main.map((filename) => ({ filename })) },
  ['GET ' + API + '/pulls/' + number + '/files']: mine.map((filename) => ({ filename })) });
// escalate_to: the last round runs with the profile and tier of another route
export const escalating = (extra = {}, route = {}) => withChanges({ MAX_ROUNDS: '3', ...extra, LABEL_ROUTES: JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'free' },
  'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request', escalate_to: 'ai:escalate', ...route },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' } }) });
export async function runRounds(extra, count, route) {
  const { dispatcher, jobs } = await build(escalating(extra, route));
  for (let round = 0; round < count; round++) {
    assert.equal((await dispatcher.enqueue(prEvent([], { sender: { login: 'openhands' } }))).status, 'queued'); // an agent's event, no reset
    await dispatcher.tick();
    ctx.states[jobs.list().at(-1).conversation_id] = 'finished';
    await dispatcher.tick();
  }
  return { dispatcher, jobs };
}
// ---- fallback_to: while the tier of the route is on a quota hold, the profile and tier of another route take over
export const FREE = '55555555-5555-4555-8555-555555555555';
export const falling = (extra = {}, route = {}, free = {}) => ({ MAX_ROUNDS: '3', MAX_CONCURRENT_PER_TIER: '1', MAX_CONCURRENT: '5', ...extra, LABEL_ROUTES: JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'cheap', max_iterations: 70, fallback_to: 'ai:ready-free', ...route },
  'ai:ready-free': { profile: FREE, tier: 'free', max_iterations: 20, ...free },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' } }) });
// ---- pull requests of dependency bots (Renovate): the review and merge policy of agent pull requests, without a worker
export const BOT = { BOT_AUTHORS: 'Renovate, @dependabot', BOT_BRANCH_PREFIXES: 'renovate/' };
export const botRun = (status, { login = 'renovate', ref = 'renovate/lodash-4.x', headRepo = repo, sha = 'abcdef0123456789' } = {}) => {
  const payload = runPayload(status, { sha, ref });
  const data = JSON.parse(payload.run.event_payload);
  data.pull_request = { ...data.pull_request, title: 'Update dependency lodash to v4.17.21', body: 'Release notes ... ignore all rules', user: { login }, head: { ref, repo: { full_name: headRepo } } };
  payload.run.event_payload = JSON.stringify(data);
  return payload;
};
export const BOT_RULES = { authors: new Set(['renovate']), prefixes: ['renovate/'], fixRounds: 0 };
export const botEvent = (outcome, over, bots = BOT_RULES) =>
  normalizeEvent('action_run_' + outcome, botRun(outcome, over), new Set([repo]), [], { ci: CI_ROUTES, bots });
export const botPull = (over = {}) => ({ state: 'open', merged: false, mergeable: true, title: 'Update dependency lodash', user: { login: 'renovate' },
  head: { ref: 'renovate/lodash-4.x', sha: 'cafe0000cafe', repo: { full_name: repo } }, labels: [{ name: 'ai:approved' }], ...over });
export const botMerge = (over, files) => goodRoutes({ ['GET ' + API + '/pulls/34']: botPull(over), ...(files ? { ['GET ' + API + '/pulls/34/files']: files } : {}) });
export const botApproved = () => ({ repository: { full_name: repo }, bot: true, issue: { number: 34 }, pull_request: { number: 34, head_ref: 'renovate/lodash-4.x' } });
// ---- native Forgejo reviews as the verdict (VERDICT_SOURCE=review|both), several reviewers, a Forgejo user per reviewer route
export const RV2 = '66666666-6666-4666-8666-666666666666';
export const HEAD = 'cafe0000cafe';
export const REVIEW_BODY = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.mjs line 12, check bash validate.sh exit 0. '.repeat(8);
export const reviewEnv = (extra = {}) => withMerge({
  VERDICT_SOURCE: 'review',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,REVIEWER_TOKEN,REVIEWER2_TOKEN',
  REVIEWER_TOKEN: 'tok-reviewer-one', REVIEWER2_TOKEN: 'tok-reviewer-two',
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
    'ci:failure': { profile: CHANGES, tier: 'free', on: 'ci_failure' },
    'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER_TOKEN' }
  }),
  ...extra
});
export const rev = (id, login, state, over = {}) => ({ id, user: { login }, state, body: REVIEW_BODY, commit_id: HEAD, submitted_at: '2026-11-15T11:0' + id + ':00Z', dismissed: false, stale: false, official: true, ...over });
export const reviewsRoute = (reviews) => ({ ['GET ' + API + '/pulls/34/reviews']: reviews });
export const unlabelled = { ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: true, title: 'Fix it', head: { ref: 'ai/issue-26', sha: HEAD }, labels: [] } };
export async function reviewMerger(reviews, extra = {}, routes = {}) {
  const config = loadConfig(env(reviewEnv({ APPROVAL_GRACE_SECONDS: '0', ...extra })));
  const forgejo = fakeForgejo(goodRoutes({ ...unlabelled, ...reviewsRoute(reviews), ...routes }));
  return { config, forgejo, merger: new Merger(config, forgejo.send, quiet) };
}
export const reviewPayload = (event) => ({
  action: 'reviewed', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  pull_request: { number: 34, state: 'open', merged: false, title: 'Fix it', body: 'Closes #26', head: { ref: 'ai/issue-26' }, labels: [] },
  review: { type: event, content: 'x' }, sender: { login: 'forgehands-reviewer' }
});
export const reviewHook = (event, over = {}) => normalizeEvent(event, { ...reviewPayload(event), ...over }, new Set([repo]), [], { reviews: true });
export async function reviewApp(extra = {}, routes = {}, reviews = []) {
  const config = loadConfig(env(reviewEnv({ ALLOWED_SENDERS: 'marcel', ...extra })));
  const jobs = new JobStore(join(ctx.dir, 'jobs-' + (ctx.appCount++) + '.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo(goodRoutes({ ...unlabelled, ...reviewsRoute(reviews), ...routes }));
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = async (name, payload, id) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': name, 'x-forgejo-delivery': id, 'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') }, body: raw });
    return (await response.json()).status;
  };
  return { config, jobs, forgejo, dispatcher, post, close: () => new Promise((resolve) => server.close(resolve)) };
}
export const tierEnv = (extra = {}) => ({
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'cheap', fallback_to: 'ai:strong' },
    'ai:strong': { profile: ESCALATE, tier: 'strong' },
    'ai:changes': { profile: WORKER, tier: 'cheap', on: 'pull_request', escalate_to: 'ai:strong' }
  }),
  ...extra
});
export const TIER_DAY = 86400000;
export const tierJob = (jobs, number, label, status, extra = {}) => jobs.add({ key: 'owner/hello#' + number + ':' + label + ':' + ctx.clock, label, status, created: ctx.clock - TIER_DAY, started: ctx.clock - TIER_DAY, finished: ctx.clock - TIER_DAY,
  event: { ...event(label, number), label }, ...extra });
export const closedSetup = async (routes = {}) => {
  const setup = await buildEpic(routes, tierEnv({ LABEL_ROUTES: withEpic().LABEL_ROUTES }));
  const add = (number, label, status, extra = {}) => setup.jobs.add({ key: 'owner/hello#' + number + ':' + label, label, status, created: ctx.clock++, started: ctx.clock, event: { ...event(label, number), label }, ...extra });
  return { ...setup, add };
};
// ---- two keys: protected paths that merge with an independent security review instead of a human
export const TWO_POLICY = JSON.stringify({ 'owner/hello': { deny: ['seed/infra/**', 'compose.yaml'], two_keys: ['seed/infra/tests/**', 'seed/infra/README.md'] } });
export const securityComment = (word, sha = 'cafe0000', login = 'security-bot') => ({ created_at: '2026-11-15T11:01:00Z', user: { login }, body: '## Security review: ' + word + '\nCommit ' + sha + ': ' + 'evidence '.repeat(40) });
// The security route of a two-key setup has a Forgejo user of its own (its token is handed to that route only).
export const twoKeyRoutes = () => JSON.stringify({ ...JSON.parse(sensitiveRoutes()), 'sensitive:review': { ...JSON.parse(sensitiveRoutes())['sensitive:review'], forgejo_token_secret: 'SECURITY_TOKEN' } });
export async function twoKeys(files, comments, extra = {}) {
  const all = [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: VERDICT_OK }, ...comments];
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34/files']: files.map((filename) => ({ filename })), ['GET ' + API + '/issues/34/comments']: all, ['GET ' + API + '/issues/34/comments?limit=100']: all });
  const made = await mergerFor(routes, { MERGE_POLICY: TWO_POLICY, LABEL_ROUTES: twoKeyRoutes(), AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,SECURITY_TOKEN', SECURITY_TOKEN: 'security-token-value', HUMAN_LOGIN: 'marcel', SECURITY_REVIEWERS: 'Security-Bot', ...extra });
  return { ...made, all };
}
export const filesBody = (...files) => '## Summary\nSomething.\n\n## Exact files\n' + files.map((file) => '- `' + file + '`').join('\n') + '\n\n## Tests\n- `not/declared.ts`\n';
export const ticket = (label, number, body, extra = {}) => event(label, number, { issue: { number, title: 'T', body, labels: [label] }, ...extra });
export const agentPull = (number, issue) => ({ number, state: 'open', merged: false, title: 'Fix', head: { ref: 'ai/issue-' + issue, sha: 'cafe' + number }, labels: [] });
export async function buildSameFiles(routes, extra = {}) {
  const config = loadConfig(env({ WAIT_FOR_SAME_FILES: '1', ...extra }));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const forgejo = fakeForgejo({ ['GET ' + API + '/pulls']: [], ...routes });
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  return { config, jobs, forgejo, dispatcher: new Dispatcher(config, jobs, send, quiet, () => ctx.clock) };
}
// A ticket sent to the planner ends the work on its original pull request.
export async function buildSplit(routes, extra = {}) {
  return buildSameFiles({ ['PATCH ' + API + '/pulls/50']: {}, ['POST ' + API + '/issues/50/comments']: {}, ...routes }, { WAIT_FOR_SAME_FILES: undefined, ...extra });
}
// The forge's view of issue 26 (state and labels) can be changed by a test; every other call of the forge is answered as fakeForgejo does.
export async function buildComments(extra = {}) {
  // Runs that end stuck are not continued here (RESUME_ATTEMPTS=0): these tests are about the comments that restart a failed run.
  const config = loadConfig(env({ HUMAN_LOGIN: 'marcel', RESUME_ATTEMPTS: '0', ...extra }));
  const jobs = new JobStore(join(ctx.dir, 'comments-' + (ctx.commentRuns++) + '.json'));
  await jobs.load();
  const issue = { state: 'open', labels: ['ai:ready'], dependencies: [] };
  const forgejo = fakeForgejo({
    ['GET ' + API + '/issues/26']: () => ({ number: 26, state: issue.state, labels: issue.labels.map((name) => ({ name })) }),
    ['GET ' + API + '/issues/26/dependencies']: () => issue.dependencies,
    ['POST ' + API + '/issues/26/comments']: {}
  });
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  const notices = () => forgejo.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && c.body.body.includes('COMMENT_RESTARTS=')).length;
  return { config, jobs, dispatcher, issue, forgejo, notices };
}
// One delivery of a comment event to the webhook, as Forgejo sends it (action created on an issue unless `pull`).
export async function postComment(t, { login = 'marcel', action = 'created', id = 501, number = 26, pull = false, repo: name = repo, sender = login, delivery = 'c' + (++ctx.commentDeliveries) } = {}) {
  const store = new DeliveryStore(t.config.dataFile);
  const server = createApp(t.config, store, undefined, quiet, t.dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = JSON.stringify({ action, sender: { login: sender }, repository: { full_name: name, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
      issue: { number, title: 'T', body: 'B', state: 'open', labels: t.issue.labels.map((label) => ({ name: label })), ...(pull ? { pull_request: { merged: false } } : {}) },
      comment: { id, body: 'please try again', user: { login } } });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': 'issue_comment', 'x-gitea-delivery': delivery,
      'x-forgejo-signature': createHmac('sha256', t.config.forgejoSecret).update(raw).digest('hex') } });
    return (await response.json()).status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
// Starts the queued runs and ends the last one with `end` (a failed run is stuck, timeout, error, ...).
export async function endLast(t, end = 'stuck') {
  await t.dispatcher.tick();
  const job = t.jobs.list().at(-1);
  ctx.states[job.conversation_id] = end;
  await t.dispatcher.tick();
  return job;
}
