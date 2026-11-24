// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// REVERT_ON_RED compares the red check with the commit before the merge: a failure that was already there is not reverted.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';

const REVERTER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const quiet = { error() {} };
const MINUTE = 60000;
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const PARENT = '7777777777777777777777777777777777777777';
const CHECK = 'image / image (push)';
const red = (sha = SHA) => ({ type: 'ci.main_failure', source: 'forgejo', action: 'action_run_failure', label: 'main:red', repository: { full_name: repo, default_branch: 'main' },
  issue: { number: 0, title: '', body: '', html_url: null, comments: 0, labels: [] }, ci: { run_id: 1, workflow: 'image.yaml', commit_sha: sha, status: 'failure', html_url: null }, sender: { login: null } });
// A combined status as Forgejo answers it: `state` and the per-check list.
const combined = (state, checks) => ({ state, total_count: checks.length, statuses: checks.map((status) => ({ context: CHECK, status })) });
let dir; let clock; let world; let logs; let counter = 0;

const env = () => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'main:red': { profile: REVERTER, tier: 'free', on: 'main_red' } }),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
});

const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };
// The fake Forgejo: the merged pull request #27, the commit statuses (a list of answers per sha: the last one sticks), the first parent of the
// merge commit (or none). Writes are recorded.
function freshWorld() {
  return {
    pulls: { 27: { number: 27, state: 'closed', merged: true, title: 'Change', head: { ref: 'ai/issue-26', sha: 'beef' }, base: { ref: 'main' } } },
    statuses: { [SHA]: [combined('failure', ['failure'])], [PARENT]: [combined('success', ['success'])] },
    parents: { [SHA]: [PARENT] },
    reads: {},
    writes: []
  };
}
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-1' }) };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: {} } }) };
  }
  const path = u.pathname.replace(API, '');
  if (request.method !== 'GET') { world.writes.push({ method: request.method, path, body: request.body ? JSON.parse(request.body) : undefined }); return answer({}); }
  const one = /^\/pulls\/(\d+)$/.exec(path);
  if (one) return answer(world.pulls[one[1]] ?? { __status: 404 });
  const status = /^\/commits\/([0-9a-f]+)\/status$/.exec(path);
  if (status) {
    const sha = status[1];
    const answers = world.statuses[sha] ?? [combined('failure', ['failure'])];
    const index = world.reads[sha] = (world.reads[sha] ?? 0) + 1;
    return answer(answers[Math.min(index, answers.length) - 1]);
  }
  const git = /^\/git\/commits\/([0-9a-f]+)$/.exec(path);
  if (git) {
    if (world.parents[git[1]] === null) return { ok: false, status: 503 };
    return answer({ parents: (world.parents[git[1]] ?? []).map((sha) => ({ sha })) });
  }
  if (path.endsWith('/dependencies') || path.endsWith('/blocks') || path.endsWith('/labels')) return answer([]);
  return answer({});
}
async function build() {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  jobs.merges.push({ repository: repo, number: 27, branch: 'ai/issue-26', sha: SHA, merged_at: clock - 10 * MINUTE, two_keys: false });
  return { config, jobs, dispatcher };
}
const comments = () => world.writes.filter((write) => write.method === 'POST' && /\/comments$/.test(write.path)).map((write) => write.body.body);
const revertRuns = (t) => t.jobs.list().filter((job) => job.label === 'main:red');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-first-parent-')); clock = Date.parse('2026-11-18T12:00:00Z'); world = freshWorld(); logs = []; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('pre-existing red: the check was already red on the first parent, so no revert is started, one comment says so, and a second run of the commit adds none', async () => {
  world.statuses[PARENT] = [combined('failure', ['failure'])];
  const t = await build();
  assert.equal((await t.dispatcher.enqueue(red())).status, 'pre_existing');
  assert.equal(revertRuns(t).length, 0, 'no revert run');
  assert.equal(t.jobs.reverts.length, 0, 'no revert record');
  assert.equal(t.jobs.merges[0].pre_existing, true, 'the merge is counted as pre-existing');
  assert.equal(t.jobs.merges[0].reverted_by, undefined, 'the revert-rate metric does not see a revert');
  assert.equal(t.jobs.merges[0].needed_human, undefined);
  assert.equal(comments().length, 1);
  assert.match(comments()[0], /already failed on the commit before it \(77777777\)/);
  assert.match(comments()[0], /A pre-existing failure: no revert is started\./);
  assert.equal((await t.dispatcher.enqueue(red())).status, 'duplicate');
  assert.equal(comments().length, 1, 'one comment');
});

test('green before, red after: the check was green on the first parent and is red on the merge, so the merge is reverted', async () => {
  const t = await build();
  assert.equal((await t.dispatcher.enqueue(red())).status, 'queued');
  assert.equal(revertRuns(t).length, 1, 'one revert run');
  assert.equal(t.jobs.merges[0].pre_existing, undefined);
  assert.equal(comments().length, 1);
  assert.match(comments()[0], /A revert is started\./);
});

test('red once, green on the rerun: a check that passes on the second read is not reverted and nothing is commented', async () => {
  world.statuses[SHA] = [combined('failure', ['failure']), combined('success', ['success'])];
  const t = await build();
  assert.equal((await t.dispatcher.enqueue(red())).status, 'ci_not_red');
  assert.equal(revertRuns(t).length, 0);
  assert.equal(comments().length, 0);
  assert.equal(t.jobs.merges[0].pre_existing, undefined);
});

test('a first parent that cannot be read: nothing is reverted, and the human is called on the merged pull request', async () => {
  world.parents[SHA] = null;
  const t = await build();
  assert.equal((await t.dispatcher.enqueue(red())).status, 'unknown_cause');
  assert.equal(revertRuns(t).length, 0);
  assert.equal(t.jobs.merges[0].needed_human, true);
  assert.match(comments()[0], /could not be read, so it is not known whether this merge caused it\. No revert is started\./);
});
