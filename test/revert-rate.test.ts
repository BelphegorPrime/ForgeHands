// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The revert rate (src/agent/revert-rate.ts): reverted merges over merges of 30 days, the gauge, the status page and REVERT_RATE_ALERT.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { markReverted, revertRate } from '../src/agent/revert-rate.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Notifier } from '../src/notify/index.ts';
import { buildStatus, renderStatus } from '../src/server/status.ts';
import { gaugeSamples, metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const REVERTER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const quiet = { error() {} };
const DAY = 24 * 3600000;
const MINUTE = 60000;
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const PARENT = '7777777777777777777777777777777777777777';
const RATE_SERIES = 'forgehands_merges_reverted_total{repository="owner/hello"}';
let dir; let clock; let world; let openhands; let counter = 0;
const logger = quiet;
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
const fakeChannel = () => ({ name: 'fake', sent: [], async send(message) { this.sent.push(message); } });

const ROUTES = { 'ai:ready': { profile: WORKER, tier: 'free' }, 'main:red': { profile: REVERTER, tier: 'free', on: 'main_red' } };
const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };
// A fake Forgejo: pull requests by number, the closed list, the issue 26 and the status of commits. Writes are recorded.
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') { openhands.push(JSON.parse(request.body)); return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) }; }
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: {} } }) };
  }
  const path = u.pathname.replace(API, '');
  if (request.method !== 'GET') world.writes.push({ method: request.method, path });
  if (request.method === 'GET') {
    if (path === '/pulls') return answer(world.closed);
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) return answer(world.pulls[one[1]] ?? { __status: 404 });
    if (path === '/git/commits/' + SHA) return answer({ parents: [{ sha: PARENT }] });
    if (path === '/commits/' + PARENT + '/status') return answer({ state: 'success', total_count: 2 });
    if (/^\/commits\/[0-9a-f]+\/status$/.test(path)) return answer({ state: 'failure', total_count: 2 });
    if (path.endsWith('/dependencies') || path.endsWith('/blocks') || path.endsWith('/labels')) return answer([]);
    if (/^\/issues\/\d+$/.test(path)) return answer({ number: Number(path.split('/').pop()), title: 'Change', body: '', state: 'closed', labels: [] });
  }
  return answer({});
}
async function build(extra = {}, notifier = undefined) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock, notifier);
  return { config, jobs, dispatcher };
}
// A merge ForgeHands made of pull request n, `ago` ms before now, and the done run of its ticket (so that a revert can start it again).
function seed(t, number, { ago = DAY, sha = null, branch = 'ai/issue-' + number } = {}) {
  t.jobs.add({ key: repo + '#' + number + ':ai:ready', label: 'ai:ready', status: 'done', created: clock - 2 * DAY, finished: clock - 2 * DAY + 60000, attempts: 0,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number, title: 'Change ' + number, body: '', labels: [] }, sender: { login: 'marcel' } } });
  t.jobs.merges.push({ repository: repo, number, branch, sha, merged_at: clock - ago, two_keys: false });
  world.pulls[number] = { number, state: 'closed', merged: true, title: 'Change ' + number, head: { ref: branch, sha: SHA }, base: { ref: 'main' } };
}
// The revert pull request ai/revert-<original>, merged into the default branch, listed as closed (the push that merged it).
function mergedRevert(revert, original) {
  const pull = { number: revert, state: 'closed', merged: true, merged_at: new Date(clock).toISOString(), title: 'WIP: Revert: Change ' + original, body: '',
    head: { ref: 'ai/revert-' + original, sha: 'beef' + '0'.repeat(36) }, base: { ref: 'main' } };
  world.pulls[revert] = pull;
  world.closed.push(pull);
}
const pushDefault = () => ({ type: 'push.default', source: 'forgejo', repository: { full_name: repo, default_branch: 'main' }, sender: { login: 'forgehands' }, after: SHA });
const red = (sha = SHA) => ({ type: 'ci.main_failure', source: 'forgejo', action: 'action_run_failure', label: 'main:red', repository: { full_name: repo, default_branch: 'main' },
  issue: { number: 0, title: '', body: '', html_url: null, comments: 0, labels: [] }, ci: { run_id: 1, workflow: 'ci.yaml', commit_sha: sha, status: 'failure', html_url: null }, sender: { login: null } });
const counterOf = (series) => metrics.counters.get(series) || 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-revert-rate-'));
  clock = Date.parse('2026-11-18T12:00:00Z');
  world = { pulls: {}, closed: [], writes: [] };
  openhands = [];
  metrics.reset();
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('no merges: the rate is null, the gauge is absent, nothing is alerted, and the status says null', async () => {
  const t = await build({ REVERT_RATE_ALERT: '1', REVERT_RATE_MIN_MERGES: '0' }, new Notifier([fakeChannel()], ['failed'], () => false, quiet, () => {}));
  assert.deepEqual(revertRate([], repo, clock), { merges: 0, reverted: 0, needed_human: 0, ratio: null });
  assert.equal(gaugeSamples(t.config, t.jobs, new Map(), clock).some((sample) => sample.name === 'forgehands_merges_reverted_ratio'), false);
  assert.equal(await t.dispatcher.checkRevertRate(clock), false);
  assert.equal(buildStatus(t.config, t.jobs, clock).summary[repo].last_30_days.revert_rate.ratio, null);
});

test('a reverted merge counts once, however many merged revert pull requests name it; the rate, gauge, status and counter agree', async () => {
  const t = await build();
  seed(t, 27);
  mergedRevert(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  mergedRevert(41, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.deepEqual(revertRate(t.jobs.merges, repo, clock), { merges: 1, reverted: 1, needed_human: 0, ratio: 1 });
  assert.equal(t.jobs.merges[0].reverted_by, 40, 'the first merged revert is the one kept');
  assert.equal(counterOf(RATE_SERIES), 1, 'the counter counts the merge once');
  const sample = gaugeSamples(t.config, t.jobs, new Map(), clock).find((entry) => entry.name === 'forgehands_merges_reverted_ratio');
  assert.deepEqual([sample.labels, sample.value], [{ repository: repo }, 1]);
  const month = buildStatus(t.config, t.jobs, clock).summary[repo].last_30_days;
  assert.deepEqual(month.revert_rate, { merges: 1, reverted: 1, needed_human: 0, ratio: 1 });
  assert.match(renderStatus(buildStatus(t.config, t.jobs, clock)), /<th>Reverted merges<\/th>/);
});

test('a revert of a revert does not count a second time, and merges of revert pull requests are not merges', async () => {
  const t = await build();
  seed(t, 27);
  // ForgeHands merged the revert ai/revert-27 as a merge of its own (pull request 40); a human then reverted that revert (pull request 45).
  t.jobs.merges.push({ repository: repo, number: 40, branch: 'ai/revert-27', sha: null, merged_at: clock - DAY, two_keys: false });
  mergedRevert(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  mergedRevert(45, 40);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.deepEqual(revertRate(t.jobs.merges, repo, clock), { merges: 1, reverted: 1, needed_human: 0, ratio: 1 });
  assert.equal(counterOf(RATE_SERIES), 1);
  assert.equal(markReverted(t.jobs.merges, repo, 40, 46), undefined, 'a merge of a revert pull request is never marked as reverted');
});

test('a revert that is only started does not count: the rate stays 0 until its pull request is merged', async () => {
  const t = await build();
  seed(t, 27, { sha: SHA, ago: 10 * MINUTE });
  assert.equal((await t.dispatcher.enqueue(red())).status, 'queued', 'the revert run starts');
  assert.deepEqual(revertRate(t.jobs.merges, repo, clock), { merges: 1, reverted: 0, needed_human: 0, ratio: 0 });
  assert.equal(counterOf(RATE_SERIES), 0);
});

test('the window is 30 days: an older merge leaves the rate, a merge exactly 30 days old is in it', async () => {
  const t = await build();
  t.jobs.merges.push(
    { repository: repo, number: 1, branch: 'ai/issue-1', sha: null, merged_at: clock - 29 * DAY, two_keys: false, reverted_by: 90 },
    { repository: repo, number: 2, branch: 'ai/issue-2', sha: null, merged_at: clock - 31 * DAY, two_keys: false, reverted_by: 91 },
    { repository: repo, number: 3, branch: 'ai/issue-3', sha: null, merged_at: clock - DAY, two_keys: false },
    { repository: repo, number: 4, branch: 'ai/issue-4', sha: null, merged_at: clock - 30 * DAY, two_keys: false });
  assert.deepEqual(revertRate(t.jobs.merges, repo, clock), { merges: 3, reverted: 1, needed_human: 0, ratio: 1 / 3 });
  assert.equal(revertRate(t.jobs.merges, repo, clock, 7 * DAY).merges, 1, 'the 7-day window of the status page is its own');
  const status = buildStatus(t.config, t.jobs, clock).summary[repo];
  assert.deepEqual([status.last_30_days.revert_rate.merges, status.last_7_days.revert_rate.merges], [3, 1]);
});

test('a red default branch that no revert could undo counts as needed a human, once', async () => {
  const t = await build({ LABEL_ROUTES: JSON.stringify({ 'ai:ready': ROUTES['ai:ready'] }) });
  seed(t, 27, { sha: SHA, ago: 10 * MINUTE });
  assert.equal((await t.dispatcher.enqueue(red())).status, 'handed_to_human');
  await t.dispatcher.enqueue(red());
  assert.deepEqual(revertRate(t.jobs.merges, repo, clock), { merges: 1, reverted: 0, needed_human: 1, ratio: 0 });
  assert.equal(counterOf('forgehands_reverts_needing_human_total{repository="owner/hello"}'), 1);
});

// The alert is checked by every dispatch pass: the pass that runs after a merged revert (the restart of its ticket starts one) may send it already.
// So the tests look at what was sent after a pass, not at a call they make themselves.
test('the alert: one failed notice a day per repository, once the rate is above the threshold and the minimum merges are in the window', async () => {
  const channel = fakeChannel();
  const t = await build({ REVERT_RATE_ALERT: '20', REVERT_RATE_MIN_MERGES: '2' }, new Notifier([channel], ['failed'], () => false, quiet, () => {}));
  seed(t, 27); seed(t, 28); seed(t, 29);
  mergedRevert(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  await t.dispatcher.tick();
  await wait();
  assert.equal(channel.sent.length, 1, 'one of three is 33.3 %, above 20 %: one notice');
  assert.equal(channel.sent[0].kind, 'failed');
  assert.match(channel.sent[0].subject, /\[hello\] revert rate 33\.3 % of the last 30 days/);
  await t.dispatcher.tick();
  await wait();
  assert.equal(await t.dispatcher.checkRevertRate(clock + 3600000), false, 'the same day: not again');
  assert.equal(channel.sent.length, 1);
  assert.equal(await t.dispatcher.checkRevertRate(clock + DAY), true, 'the next day it may alarm again');
  await wait();
  assert.equal(channel.sent.length, 2);
});

test('the alert waits for REVERT_RATE_MIN_MERGES, and a rate equal to the threshold is not above it', async () => {
  const run = async (extra) => {
    const channel = fakeChannel();
    const t = await build(extra, new Notifier([channel], ['failed'], () => false, quiet, () => {}));
    seed(t, 27); seed(t, 28);
    mergedRevert(40, 27);
    await t.dispatcher.closeMergedTickets(pushDefault());
    await t.dispatcher.tick();
    await wait();
    return channel.sent.length;
  };
  assert.equal(await run({ REVERT_RATE_ALERT: '20' }), 0, 'one revert of two merges does not alarm with the default minimum of 10');
  assert.equal(await run({ REVERT_RATE_ALERT: '20', REVERT_RATE_MIN_MERGES: '2' }), 1);
  assert.equal(await run({ REVERT_RATE_ALERT: '50', REVERT_RATE_MIN_MERGES: '2' }), 0, '50 % is not above 50 %');
});

test('the alert is off by default and at 0, however high the rate', async () => {
  const channel = fakeChannel();
  for (const extra of [{}, { REVERT_RATE_ALERT: '0', REVERT_RATE_MIN_MERGES: '0' }]) {
    const t = await build(extra, new Notifier([channel], ['failed'], () => false, quiet, () => {}));
    seed(t, 27);
    mergedRevert(40, 27);
    await t.dispatcher.closeMergedTickets(pushDefault());
    assert.equal(revertRate(t.jobs.merges, repo, clock).ratio, 1);
    assert.equal(await t.dispatcher.checkRevertRate(clock), false);
  }
  await wait();
  assert.equal(channel.sent.length, 0);
  assert.equal(loadConfig(env()).revertRateAlert, 0);
  assert.equal(loadConfig(env()).revertRateMinMerges, 10);
});

test('REVERT_RATE_ALERT is a percentage from 0 to 100, REVERT_RATE_MIN_MERGES a whole number; anything else stops the start', () => {
  assert.equal(loadConfig(env({ REVERT_RATE_ALERT: '0.5' })).revertRateAlert, 0.5);
  assert.equal(loadConfig(env({ REVERT_RATE_ALERT: '100' })).revertRateAlert, 100);
  for (const value of ['150', '-1', 'lots']) assert.throws(() => loadConfig(env({ REVERT_RATE_ALERT: value })), /REVERT_RATE_ALERT must be a percentage from 0 \(off\) to 100/);
  for (const value of ['-1', '1.5', 'ten']) assert.throws(() => loadConfig(env({ REVERT_RATE_MIN_MERGES: value })), /REVERT_RATE_MIN_MERGES must be an integer/);
});
