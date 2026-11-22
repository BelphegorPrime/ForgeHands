// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The ticket watchdog (TICKET_STALL_MINUTES, ReviewSweep.watchStalled): an open ticket whose last run ended without a delivery is started once more,
// the second time the human is called; the parent-comment hand-back itself is covered in direct.test.ts.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { stallLine } from '../src/agent/review-sweep.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildStatus } from '../src/server/status.ts';
import { gaugeSamples, metrics } from '../src/metrics.ts';

const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const MINUTE = 60000;
const WORKER = '44444444-4444-4444-8444-444444444444';
const ESCALATE = '66666666-6666-4666-8666-666666666666';
const quiet = { error() {} };
let dir; let clock; let runs = 0;

const ROUTES = JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'free' },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' },
  'ai:plan': { profile: WORKER, tier: 'free' },
  'ci:success': { profile: WORKER, tier: 'strong', on: 'ci_success' }
});

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: ROUTES,
  ERROR_RETRIES: '0',
  TICKET_PREFLIGHT: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'stalled.json'),
  ...extra
});

// A fake Forgejo: the ticket (its state and labels come from `ticket`), the open pull requests, and the comments it receives.
function build(extra = {}, ticket = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'stalled-' + (runs++) + '.json'));
  const forge = { calls: [] };
  const send = async (url, request) => {
    const u = new URL(url);
    if (u.host !== 'forge.example') {
      if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + forge.calls.length, conversation_id: 'conv-' + forge.calls.length }) };
      return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, events: [] }) };
    }
    const path = u.pathname;
    const body = request.body ? JSON.parse(request.body) : undefined;
    forge.calls.push({ method: request.method, path, body });
    if (request.method === 'GET' && path === API + '/issues/26') {
      const value = { number: 26, title: 'T', html_url: 'https://forge.example/owner/hello/issues/26', state: ticket.state ?? 'open', labels: (ticket.labels ?? []).map((name) => ({ name })) };
      return { ok: true, status: 200, json: async () => value };
    }
    if (request.method === 'GET' && path === API + '/pulls') return { ok: true, status: 200, json: async () => ticket.pulls ?? [] };
    if (request.method === 'GET' && path === API + '/issues/26/dependencies') return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'GET' && path === API + '/issues/26/blocks') return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'GET' && path === API + '/labels') return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'POST' && path.endsWith('/comments')) return { ok: true, status: 201, json: async () => ({}) };
    if (request.method === 'POST' && path === API + '/issues/26/labels') {
      ticket.labels = [...new Set([...(ticket.labels ?? []), 'ai:blocked'])];
      return { ok: true, status: 200, json: async () => [] };
    }
    if (request.method === 'PUT' || request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 1, name: 'x' }) };
    return { ok: false, status: 404 };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock);
  return { config, jobs, dispatcher, forge, comments: () => forge.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments')).map((c) => c.body.body) };
}

// A finished (or failed, or running) run of ticket 26 on `label`, which ended `minutesAgo` minutes ago.
function seed(jobs, { label = 'ai:ready', status = 'done', minutesAgo = 200, number = 26 } = {}) {
  const ended = clock - minutesAgo * MINUTE;
  const job = jobs.add({
    key: repo + '#' + number + ':' + label, label, status, created: ended - MINUTE,
    event: { type: 'issues.labeled', label, repository: { full_name: repo, clone_url: null, default_branch: 'main' },
      issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, comments: 0, labels: [label] }, sender: { login: 'marcel' } }
  });
  Object.assign(job, { started: ended - MINUTE, finished: status === 'running' ? undefined : ended });
  return job;
}
const ticketJobs = (jobs) => jobs.list().filter((job) => job.key.startsWith(repo + '#26:'));
const stalled = (jobs) => jobs.stalled.get(repo + '#26');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-stalled-')); clock = 3_000_000_000; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('TICKET_STALL_MINUTES defaults to 180, and 0 switches the ticket watchdog off', () => {
  assert.equal(loadConfig(env()).ticketStallMinutes, 180);
  assert.throws(() => loadConfig(env({ TICKET_STALL_MINUTES: '-1' })), /TICKET_STALL_MINUTES must be an integer between 0 and 10080/);
  const t = build({ TICKET_STALL_MINUTES: '0' });
  seed(t.jobs);
  return t.dispatcher.sweep.watchStalled(repo, [], clock).then((acted) => {
    assert.equal(acted, 0);
    assert.equal(ticketJobs(t.jobs).length, 1, 'no run started');
    assert.equal(t.jobs.stalled.size, 0);
  });
});

test('a ticket stalled for TICKET_STALL_MINUTES is started once more on its own route, told that nothing was delivered', async () => {
  const t = build();
  seed(t.jobs);
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 1);
  const again = ticketJobs(t.jobs);
  assert.equal(again.length, 2);
  const restart = again.at(-1);
  assert.equal(restart.label, 'ai:ready');
  assert.equal(restart.event.stall_retry, true);
  assert.notEqual(restart.status, 'done');
  assert.deepEqual({ restarts: stalled(t.jobs).restarts, human: stalled(t.jobs).human }, { restarts: 1, human: false });
  assert.match(stallLine(restart.event), /ended without a pull request, without a comment and with the ticket still open/);
  assert.equal(stallLine({ stall_retry: false, issue: { number: 26 } }), '');
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 0, 'the new run is active: nothing more');
  assert.equal(ticketJobs(t.jobs).length, 2);
});

test('with escalate_to on the route, the one restart runs on the escalation route', async () => {
  const t = build({ LABEL_ROUTES: JSON.stringify({ ...JSON.parse(ROUTES), 'ai:ready': { profile: WORKER, tier: 'free', escalate_to: 'ai:escalate' } }) });
  seed(t.jobs);
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  assert.equal(ticketJobs(t.jobs).at(-1).label, 'ai:escalate');
});

test('a stall again after the restart calls the human: blocked label, mention, the ledger and the waiting list, and the dependents wait behind it', async () => {
  const t = build();
  seed(t.jobs);
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  const restart = ticketJobs(t.jobs).at(-1);
  // The restarted run ends too, without a delivery, and a ticket that waits for it is seen on the status page.
  Object.assign(restart, { status: 'done', started: clock - 190 * MINUTE, finished: clock - 180 * MINUTE });
  const waiting = t.jobs.list().length;
  Object.assign(seed(t.jobs, { number: 27, label: 'ai:ready', status: 'waiting', minutesAgo: 1 }), { waiting_for: [26] });
  assert.equal(t.jobs.list().length, waiting + 1);
  clock += 1000;
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 1);
  assert.equal(stalled(t.jobs).human, true);
  assert.equal(stalled(t.jobs).restarts, 1);
  assert.match(t.comments().at(-1), /^@marcel ForgeHands: issue #26 is stalled: its last run ended without a pull request, without a comment and with the ticket still open, and the run started once more ended the same way\./);
  const status = buildStatus(t.config, t.jobs, clock);
  assert.deepEqual(status.waiting_for_human.filter((entry) => entry.issue === 26).map((entry) => entry.reason), ['stalled_ticket']);
  assert.equal(status.issues.find((entry) => entry.issue === repo + '#27').state, 'waiting behind stalled #26');
  assert.equal(metrics.render().includes('forgehands_stalled_ticket_actions_total{action="human"}'), true);
  assert.equal(gaugeSamples(t.config, t.jobs, new Map(), clock).find((entry) => entry.name === 'forgehands_stalled_tickets').value, 1);
  // Nothing more while the label is on.
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 0);
});

test('a ticket with an open agent pull request, a running, queued or waiting run, or a blocked or hold label is left alone', async () => {
  const open = { number: 5, head: { ref: 'ai/issue-26' }, state: 'open', merged: false, updated_at: new Date(clock).toISOString() };
  const cases = {
    'an open agent pull request': { jobs: {}, ticket: { pulls: [open] } },
    'a running run': { jobs: { status: 'running', minutesAgo: 200 } },
    'a queued run': { jobs: { status: 'queued', minutesAgo: 200 } },
    'a waiting run': { jobs: { status: 'waiting', minutesAgo: 200 } },
    'the blocked label': { jobs: {}, ticket: { labels: ['ai:blocked'] } },
    'the hold label': { jobs: {}, ticket: { labels: ['ai:hold'] } }
  };
  for (const name of Object.keys(cases)) {
    const t = build({}, cases[name].ticket ?? {});
    seed(t.jobs, cases[name].jobs.status ? { status: cases[name].jobs.status, minutesAgo: 200 } : {});
    assert.equal(await t.dispatcher.sweep.watchStalled(repo, cases[name].ticket?.pulls ?? [], clock), 0, name);
    assert.equal(ticketJobs(t.jobs).length, 1, name);
    assert.equal(t.jobs.stalled.size, 0, name);
  }
});

test('a run that ended less than TICKET_STALL_MINUTES ago, an epic, or a closed ticket is left alone', async () => {
  const recent = build();
  seed(recent.jobs, { minutesAgo: 60 });
  assert.equal(await recent.dispatcher.sweep.watchStalled(repo, [], clock), 0);
  const epic = build();
  seed(epic.jobs, { label: 'ai:plan' });
  assert.equal(await epic.dispatcher.sweep.watchStalled(repo, [], clock), 0);
  assert.equal(ticketJobs(epic.jobs).length, 1);
  const closed = build({}, { state: 'closed' });
  seed(closed.jobs);
  assert.equal(await closed.dispatcher.sweep.watchStalled(repo, [], clock), 0);
  assert.equal(ticketJobs(closed.jobs).length, 1);
});

test('when the human takes the blocked label off, the ticket is looked at afresh and started once more', async () => {
  const ticket = { labels: [] };
  const t = build({}, ticket);
  seed(t.jobs);
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  Object.assign(ticketJobs(t.jobs).at(-1), { status: 'failed', started: clock - 190 * MINUTE, finished: clock - 180 * MINUTE });
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 1, 'the second stall calls the human');
  assert.equal(stalled(t.jobs).human, true);
  assert.deepEqual(ticket.labels, ['ai:blocked']);
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 0, 'the label is on: nothing more');
  ticket.labels = [];
  clock += 60 * MINUTE;
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  assert.equal(stalled(t.jobs).human, false, 'the record is started afresh');
  assert.equal(ticketJobs(t.jobs).length, 3);
});

test('DRY_RUN: the review sweep starts nothing and calls nobody', async () => {
  const t = build({ DRY_RUN: '1' });
  seed(t.jobs);
  await t.dispatcher.sweep.run();
  assert.equal(ticketJobs(t.jobs).length, 1);
  assert.equal(t.forge.calls.filter((c) => c.method !== 'GET').length, 0);
});
