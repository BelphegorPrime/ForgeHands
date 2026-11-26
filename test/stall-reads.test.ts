// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The ticket watchdog's reads (ReviewSweep.watchStalled): a ticket the ledger knows as closed is not read, a read that finds a ticket closed is
// remembered in the ledger, and a pass starts where the last one stopped, so that every candidate is reached when there are more than STALL_MAX_READS.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';

const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const MINUTE = 60000;
const WORKER = '44444444-4444-4444-8444-444444444444';
const ROUTES = JSON.stringify({
  'ai:ready': { profile: WORKER, tier: 'free' },
  'ci:success': { profile: WORKER, tier: 'strong', on: 'ci_success' }
});
const quiet = { error() {} };
let dir; let clock; let stores = 0;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: ROUTES,
  ERROR_RETRIES: '0',
  TICKET_PREFLIGHT: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'reads.json'),
  ...extra
});

// A fake Forgejo that answers for any issue number: `tickets` maps the number to its state. `reads` counts the issue reads of the forge.
function build(tickets = {}) {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'reads-' + (stores++) + '.json'));
  const reads = new Map();
  const send = async (url, request) => {
    const u = new URL(url);
    if (u.host !== 'forge.example') {
      if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + reads.size, conversation_id: 'conv-' + reads.size }) };
      return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, events: [] }) };
    }
    const path = u.pathname;
    if (request.method === 'GET' && path.startsWith(API + '/issues/') && /^\/api\/v1\/repos\/owner\/hello\/issues\/\d+$/.test(path)) {
      const number = Number(path.slice((API + '/issues/').length));
      reads.set(number, (reads.get(number) ?? 0) + 1);
      const ticket = tickets[number];
      if (!ticket) return { ok: false, status: 404 };
      const value = { number, title: 'T', html_url: 'https://forge.example/owner/hello/issues/' + number, state: ticket.state ?? 'open', labels: (ticket.labels ?? []).map((name) => ({ name })) };
      return { ok: true, status: 200, json: async () => value };
    }
    if (request.method === 'GET' && path === API + '/pulls') return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'GET' && /\/issues\/\d+\/(dependencies|blocks)$/.test(path)) return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'GET' && path === API + '/labels') return { ok: true, status: 200, json: async () => [] };
    if (request.method === 'POST' || request.method === 'PUT') return { ok: true, status: 201, json: async () => ({}) };
    return { ok: false, status: 404 };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock);
  return { config, jobs, dispatcher, reads };
}

// A finished run of ticket `number` on ai:ready that ended `minutesAgo` minutes ago.
function seed(jobs, number, { status = 'done', minutesAgo = 200 } = {}) {
  const ended = clock - minutesAgo * MINUTE;
  const job = jobs.add({
    key: repo + '#' + number + ':ai:ready', label: 'ai:ready', status, created: ended - MINUTE,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, clone_url: null, default_branch: 'main' },
      issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, comments: 0, labels: ['ai:ready'] }, sender: { login: 'marcel' } }
  });
  Object.assign(job, { started: ended - MINUTE, finished: ended });
  return job;
}
const restarted = (jobs, number) => jobs.list().filter((job) => job.key.startsWith(repo + '#' + number + ':') && job.event.stall_retry).length;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-reads-')); clock = 3_000_000_000; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('closed tickets the ledger knows as closed are not read, and the stalled ones are restarted in the first pass', async () => {
  const tickets = {};
  for (let n = 100; n < 130; n += 1) tickets[n] = { state: 'closed' };
  for (const n of [201, 202, 203]) tickets[n] = { state: 'open' };
  const t = build(tickets);
  // The old test tickets are older than the stalled ones, so they come first in the ledger order.
  for (let n = 100; n < 130; n += 1) seed(t.jobs, n, { minutesAgo: 900 });
  for (let n = 100; n < 130; n += 1) t.jobs.markClosed(repo + '#' + n);
  for (const n of [201, 202, 203]) seed(t.jobs, n, { minutesAgo: 200 });
  assert.equal(t.jobs.list().filter((job) => job.archived_view).length, 30);
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 3);
  for (const n of [201, 202, 203]) assert.equal(restarted(t.jobs, n), 1, 'ticket ' + n + ' restarted');
  for (let n = 100; n < 130; n += 1) assert.equal(t.reads.get(n) ?? 0, 0, 'closed ticket ' + n + ' not read');
});

test('a ticket found closed by a read is remembered in the ledger and never read again, and it does not use up the reads of the pass', async () => {
  const tickets = {};
  for (let n = 100; n < 130; n += 1) tickets[n] = { state: 'closed' };
  for (const n of [201, 202, 203]) tickets[n] = { state: 'open' };
  const t = build(tickets);
  // Not marked by the ledger sync: the closed tickets are read once each, and they are older, so they come first.
  for (let n = 100; n < 130; n += 1) seed(t.jobs, n, { minutesAgo: 900 });
  for (const n of [201, 202, 203]) seed(t.jobs, n, { minutesAgo: 200 });
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 3, 'the open tickets are restarted in the first pass');
  for (let n = 100; n < 130; n += 1) assert.equal(t.reads.get(n), 1, 'closed ticket ' + n + ' read once');
  assert.equal(t.jobs.list().filter((job) => job.key.startsWith(repo + '#100:')).every((job) => job.archived_view), true, 'remembered as closed');
  await t.dispatcher.sweep.watchStalled(repo, [], clock + 60 * MINUTE);
  for (let n = 100; n < 130; n += 1) assert.equal(t.reads.get(n), 1, 'closed ticket ' + n + ' not read again');
});

test('with 50 open candidates, every one is reached within 3 passes, 20 at most per pass', async () => {
  const tickets = {};
  for (let n = 1; n <= 50; n += 1) tickets[n] = { state: 'open' };
  const t = build(tickets);
  for (let n = 1; n <= 50; n += 1) seed(t.jobs, n, { minutesAgo: 200 + n });
  const perPass = [];
  for (let pass = 0; pass < 3; pass += 1) perPass.push(await t.dispatcher.sweep.watchStalled(repo, [], clock + pass * MINUTE));
  assert.deepEqual(perPass, [20, 20, 10]);
  for (let n = 1; n <= 50; n += 1) assert.equal(restarted(t.jobs, n), 1, 'ticket ' + n + ' reached');
});

test('the ticket watchdog reads at most 20 open tickets per pass when the candidates keep waiting (stalled but not restarted)', async () => {
  const tickets = {};
  for (let n = 1; n <= 45; n += 1) tickets[n] = { state: 'open', labels: ['ai:blocked'] };
  const t = build(tickets);
  for (let n = 1; n <= 45; n += 1) seed(t.jobs, n, { minutesAgo: 200 + n });
  const before = [...t.reads.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(await t.dispatcher.sweep.watchStalled(repo, [], clock), 0);
  const after = [...t.reads.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(after - before, 20);
  await t.dispatcher.sweep.watchStalled(repo, [], clock);
  assert.equal(t.reads.size, 40, 'the second pass reads the next 20 and the cursor moved on');
});
