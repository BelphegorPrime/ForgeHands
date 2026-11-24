// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// REVERT_RETRIES: a merged revert reopens the ticket of the original merge, quotes the cause once, and starts the worker again (or blocks it).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { isBotPull, pullBranch, isPullRef, REVERT_BRANCH } from '../src/agent/bot.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { redact } from '../src/utils/redact.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const REVERTER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const quiet = { error() {} };
const MINUTE = 60000;
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA2 = '0123456789abcdef0123456789abcdef01234567';
const PARENT = '7777777777777777777777777777777777777777'; // the first parent of every merge commit in these tests: green unless a test says otherwise
let dir; let clock; let world; let openhands; let counter = 0; let logs;
const logger = { error(...args) { logs.push(args.join(' ')); } };

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: WORKER, tier: 'free', on: 'pull_request' },
    'main:red': { profile: REVERTER, tier: 'free', on: 'main_red' }
  }),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };
// A fake Forgejo: the issue 26 (state and labels), pull requests by number, the closed list, commit statuses. Writes are recorded.
function freshWorld() {
  return {
    issue: { number: 26, title: 'Add the feature', body: 'Do the thing', state: 'closed', labels: [], html_url: 'https://forge.example/owner/hello/issues/26' },
    pulls: {},
    closed: [],
    statuses: { [PARENT]: { state: 'success', total_count: 1 } },
    writes: [],
    reopenFails: false,
    commentFails: false
  };
}
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') { openhands.push(JSON.parse(request.body)); return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) }; }
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: {} } }) };
  }
  const path = u.pathname.replace(API, '');
  const body = request.body ? JSON.parse(request.body) : undefined;
  if (request.method === 'POST' && path === '/issues/26/comments' && world.commentFails) return answer({ __status: 500 });
  if (request.method !== 'GET') world.writes.push({ method: request.method, path, body });
  if (request.method === 'GET') {
    if (path === '/pulls') return answer(world.closed);
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) return answer(world.pulls[one[1]] ?? { __status: 404 });
    if (/^\/git\/commits\/[0-9a-f]+$/.test(path)) return answer({ parents: [{ sha: PARENT }] });
    const status = /^\/commits\/([0-9a-f]+)\/status$/.exec(path);
    if (status) return answer(world.statuses[status[1]] || { state: 'failure', total_count: 2 });
    if (path === '/issues/26') return answer(world.issue);
    if (path === '/issues/26/dependencies' || path === '/issues/26/blocks') return answer([]);
    if (path === '/labels') return answer([{ id: 9, name: 'ai:blocked' }]);
    if (path.endsWith('/labels')) return answer([]);
  }
  if (request.method === 'PATCH' && path === '/issues/26') {
    if (world.reopenFails) return answer({ __status: 500 });
    world.issue.state = body.state;
    return answer({});
  }
  return answer({});
}
async function build(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher };
}
// The ledger before the red default branch: the worker's done run of ticket 26, and the merge of its pull request #27 (ai/issue-26).
function seed(t, { number = 27, branch = 'ai/issue-26', sha = SHA } = {}) {
  t.jobs.add({ key: repo + '#26:ai:ready', label: 'ai:ready', status: 'done', created: clock - 3600000, finished: clock - 3000000, attempts: 0,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 26, title: 'Add the feature', body: '', labels: [] }, sender: { login: 'marcel' } } });
  t.jobs.merges.push({ repository: repo, number, branch, sha, merged_at: clock - 10 * MINUTE, two_keys: false });
  world.pulls[number] = { number, state: 'closed', merged: true, title: 'Add the feature', head: { ref: branch, sha }, base: { ref: 'main' } };
}
const red = (sha = SHA) => ({ type: 'ci.main_failure', source: 'forgejo', action: 'action_run_failure', label: 'main:red', repository: { full_name: repo, default_branch: 'main' },
  issue: { number: 0, title: '', body: '', html_url: null, comments: 0, labels: [] }, ci: { run_id: 1, workflow: 'ci.yaml', commit_sha: sha, status: 'failure', html_url: null }, sender: { login: null } });
// The revert pull request ai/revert-<n> as merged (by ForgeHands or a human) and the original, both listed as closed.
function merged(revertNumber, original, { body = 'Step: lint. error TS2322: Type string is not assignable to number.', mergedBy = 'forgehands', sha = SHA } = {}) {
  const revert = { number: revertNumber, state: 'closed', merged: true, merged_at: new Date(clock).toISOString(), merged_by: { login: mergedBy }, title: 'WIP: Revert: Add the feature',
    body, head: { ref: 'ai/revert-' + original, sha: 'beef' + '0'.repeat(36) }, base: { ref: 'main', repo: { default_branch: 'main' } } };
  world.pulls[revertNumber] = revert;
  world.closed = [revert, { ...world.pulls[original], merged_at: new Date(clock).toISOString() }];
  return revert;
}
const pushDefault = () => ({ type: 'push.default', source: 'forgejo', repository: { full_name: repo, default_branch: 'main' }, sender: { login: 'forgehands' }, after: SHA });
const comments = () => world.writes.filter((write) => write.method === 'POST' && write.path === '/issues/26/comments').map((write) => write.body.body);
const reopens = () => world.writes.filter((write) => write.method === 'PATCH' && write.path === '/issues/26' && write.body.state === 'open');
const starts = () => openhands.filter((body) => body.agent_profile_id === WORKER);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-after-revert-')); clock = Date.parse('2026-11-18T12:00:00Z'); world = freshWorld(); openhands = []; logs = []; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a merged revert reopens the ticket, quotes the cause once, and starts the worker again with the new line', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  assert.equal(t.jobs.reverts.length, 1);
  assert.equal(t.jobs.reverts[0].issue, 26);
  merged(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(world.issue.state, 'open', 'the ticket is reopened');
  assert.equal(reopens().length, 1);
  const cause = comments().filter((text) => /turned the CI of main red/.test(text));
  assert.equal(cause.length, 1, 'one comment with the cause');
  assert.match(cause[0], /the merge of #27 turned the CI of main red \(commit abcdef01\); it was reverted by #40\. Fix the cause, do not repeat the change that broke it\. Cause as the revert run found it:/);
  assert.match(cause[0], /> Step: lint\. error TS2322/);
  const restarted = t.jobs.list().filter((job) => job.event.revert_retry);
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0].label, 'ai:ready');
  assert.equal(t.jobs.reverts[0].restarted, true);
  assert.equal(t.jobs.reverts[0].state, 'handled');
  await t.dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.match(starts()[0].initial_message.content[0].text, /You are started again because your earlier change broke the CI of the default branch and was reverted\. Read the comment on this issue with the cause first; do not repeat it\./);
  // the same event again (a second push, a duplicate delivery): nothing more
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
  assert.equal(reopens().length, 1);
});

test('the original ticket is not closed again by the push that follows, while the retry runs', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(world.issue.state, 'open');
  assert.equal(world.writes.filter((write) => write.method === 'PATCH' && write.body.state === 'closed').length, 0);
});

test('the second revert of the same ticket hits the limit: the ticket is blocked, the human is called, nothing restarts', async () => {
  const t = await build({ HUMAN_LOGIN: 'marcel' });
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  // the retried work merges again and breaks the CI again
  seed(t, { number: 29, sha: SHA2 });
  await t.dispatcher.enqueue(red(SHA2));
  merged(41, 29, { sha: SHA2, body: 'Step: test. error: expected 2 got 3' });
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1, 'no second restart');
  const block = world.writes.filter((write) => write.method === 'POST' && write.path === '/issues/26/labels');
  assert.equal(block.length, 1, 'ai:blocked is put on the ticket');
  const notice = comments().find((text) => /started again 1 times already \(REVERT_RETRIES=1\)/.test(text));
  assert.match(notice, /^@marcel ForgeHands: the merge of #29 turned the CI red again and was reverted by #41\./);
  assert.match(notice, /It is blocked \(ai:blocked\): a human has to look at it\./);
  assert.equal(t.jobs.reverts.find((entry) => entry.number === 29).blocked, true);
});

test('REVERT_RETRIES=0 does nothing new: no record, no reopen, no comment, no restart', async () => {
  const t = await build({ REVERT_RETRIES: '0' });
  seed(t);
  await t.dispatcher.enqueue(red());
  assert.equal(t.jobs.reverts.length, 0);
  merged(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(reopens().length, 0);
  assert.equal(comments().filter((text) => /turned the CI/.test(text)).length, 0);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 0);
  assert.equal(loadConfig(env({ REVERT_RETRIES: '0' })).revertRetries, 0);
  assert.equal(loadConfig(env()).revertRetries, 1);
  assert.throws(() => loadConfig(env({ REVERT_RETRIES: '6' })), /REVERT_RETRIES must be an integer between 0 and 5/);
});

test('a revert of a bot pull request or of a pull request without a ticket does nothing new', async () => {
  const t = await build();
  seed(t, { number: 30, branch: 'renovate/dep-1.x' });
  await t.dispatcher.enqueue(red());
  assert.equal(t.jobs.reverts.length, 0, 'no record for a bot pull request');
  merged(50, 30);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(reopens().length, 0);
  assert.equal(comments().filter((text) => /turned the CI/.test(text)).length, 0);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 0);
});

test('a revert merged by a human counts the same', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27, { mergedBy: 'marcel' });
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(reopens().length, 1);
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
});

test('a reopen that fails is logged and does not crash; the next push tries again and then does the rest once', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  world.reopenFails = true;
  assert.equal(await t.dispatcher.closeMergedTickets(pushDefault()), 0);
  assert.ok(logs.some((line) => /could not reopen #26 of owner\/hello after its revert #40/.test(line)));
  assert.equal(comments().filter((text) => /turned the CI/.test(text)).length, 0, 'no comment before the reopen worked');
  assert.equal(t.jobs.reverts[0].state, 'merged');
  world.reopenFails = false;
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(world.issue.state, 'open');
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
});

test('the revert record survives a restart: the ledger reloads it, and the duplicate after the restart does nothing', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  await t.jobs.persist(clock);
  const reloaded = new JobStore(join(dir, t.jobs.file.split('/').pop()));
  await reloaded.load();
  assert.equal(reloaded.reverts.length, 1);
  assert.equal(reloaded.reverts[0].restarted, true);
  const again = new Dispatcher(t.config, reloaded, send, logger, () => clock);
  await again.closeMergedTickets(pushDefault());
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
});

test('the restarted run message carries the line; a first run does not', () => {
  const config = loadConfig(env());
  const event = { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 26, title: 'T', body: 'B', labels: [] }, sender: { login: null } };
  assert.ok(!buildPrompt(event, config).includes('You are started again'));
  assert.match(buildPrompt({ ...event, revert_retry: true }, config), /You are started again because your earlier change broke the CI of the default branch and was reverted\. Read the comment on this issue with the cause first; do not repeat it\./);
});

test('the revert run ends with a comment that names the failing step, and writes it into the pull request body', () => {
  const config = loadConfig(env());
  const prompt = buildPrompt({ type: 'ci.main_failure', source: 'forgejo', action: 'main_red', label: 'main:red', repository: { full_name: repo, default_branch: 'main' },
    issue: { number: 27, title: 'Add', body: '', labels: [] }, ci: { commit_sha: SHA, workflow: 'ci.yaml' }, sender: { login: null } }, config);
  assert.match(prompt, /names the failing step \(the command or the check\) and the first lines of its error/);
  assert.match(prompt, /put the same text into the body of the revert pull request/);
});

test('secrets and tokens in the quoted cause are redacted; commit ids stay', () => {
  assert.equal(redact('token=abcdef12 and tok-secret-value here', ['tok-secret-value']), 'token=[redacted] and [redacted] here');
  assert.equal(redact('password: hunter22', []), 'password: [redacted]');
  assert.equal(redact('commit ' + SHA, []), 'commit ' + SHA);
  assert.equal(redact('key ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', []), 'key [redacted]');
});

test('a token in the revert pull request body never reaches the comment', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27, { body: 'failing: tok-secret-value leaked, token=zzz' });
  await t.dispatcher.closeMergedTickets(pushDefault());
  const cause = comments().find((text) => /turned the CI of main red/.test(text));
  assert.doesNotMatch(cause, /tok-secret-value/);
  assert.match(cause, /token=\[redacted\]/);
});

// Forgejo's shape of a merged pull request whose head branch was deleted: head.ref is refs/pull/<n>/head, head.label still names the branch.
function forgejoShape(number, label, { sha = SHA, title = 'Add the feature', body = '' } = {}) {
  return { number, state: 'closed', merged: true, merged_at: new Date(clock).toISOString(), title, body,
    head: { ref: 'refs/pull/' + number + '/head', label, sha }, base: { ref: 'main', repo: { default_branch: 'main' } } };
}
// Pull request 27 (ticket 26) and its revert 40 as Forgejo lists them after the merges: both branches are gone, both are listed as closed.
function mergedAsForgejo(revertNumber, original, { body = 'Step: lint. error TS2322: Type string is not assignable to number.' } = {}) {
  const revert = forgejoShape(revertNumber, 'ai/revert-' + original, { title: 'WIP: Revert: Add the feature', body, sha: 'beef' + '0'.repeat(36) });
  world.pulls[revertNumber] = revert;
  world.pulls[original] = forgejoShape(original, 'ai/issue-26');
  world.closed = [revert, world.pulls[original]];
  return revert;
}

test('the helper names the branch of a Forgejo pull request: head.ref when it is a branch, else head.label without the owner of a fork', () => {
  assert.equal(pullBranch({ head: { ref: 'ai/issue-26', label: 'ai/issue-26' } }), 'ai/issue-26');
  assert.equal(pullBranch({ head: { ref: 'refs/pull/27/head', label: 'ai/issue-26' } }), 'ai/issue-26');
  assert.equal(pullBranch({ head: { ref: 'refs/pull/30/head', label: 'ai/revert-29' } }), 'ai/revert-29');
  assert.equal(pullBranch({ head: { ref: 'refs/pull/27/head', label: 'forker:ai/issue-26' } }), 'ai/issue-26');
  assert.equal(pullBranch({ head: { ref: 'refs/pull/27/head', label: '' } }), '');
  assert.equal(pullBranch({}), '');
  assert.equal(pullBranch(null), '');
  assert.ok(isPullRef('refs/pull/27/head'));
  assert.ok(!isPullRef('ai/issue-26'));
  assert.ok(REVERT_BRANCH.test(pullBranch({ head: { ref: 'refs/pull/30/head', label: 'ai/revert-29' } })));
});

test('a revert of a bot or ticketless pull request is recognised by its label too: the bot path, a fork is not', () => {
  const rules = { authors: new Set(), prefixes: [] };
  const revert = { head: { ref: 'refs/pull/30/head', label: 'ai/revert-29', repo: { full_name: repo } }, user: { login: 'forgehands' } };
  assert.equal(isBotPull(rules, revert, repo), true);
  const fork = { head: { ref: 'refs/pull/30/head', label: 'forker:ai/revert-29', repo: { full_name: 'forker/hello' } }, user: { login: 'forker' } };
  assert.equal(isBotPull(rules, fork, repo), false);
  const agent = { head: { ref: 'refs/pull/27/head', label: 'ai/issue-26', repo: { full_name: repo } }, user: { login: 'forgehands' } };
  assert.equal(isBotPull(rules, agent, repo), false, 'an agent branch is never a bot pull request');
});

test('a merged revert whose pull request reports refs/pull/<n>/head is found by its label: reopened, commented once, started again once', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  assert.equal(t.jobs.reverts.length, 1);
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(world.issue.state, 'open', 'the ticket is reopened');
  assert.equal(reopens().length, 1);
  const cause = comments().filter((text) => /turned the CI of main red/.test(text));
  assert.equal(cause.length, 1);
  assert.match(cause[0], /the merge of #27 turned the CI of main red \(commit abcdef01\); it was reverted by #40\./);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
  assert.equal(t.jobs.reverts[0].restarted, true);
  assert.equal(t.jobs.reverts[0].state, 'handled');
  // the next push, while the forge still lists the same pull requests: nothing more
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(reopens().length, 1);
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
});

test('onMainFailure names the branch from the pull request when the ledger holds a pull request ref: the record is made, the revert is found', async () => {
  const t = await build();
  seed(t);
  t.jobs.merges[0].branch = 'refs/pull/27/head';
  world.pulls[27] = forgejoShape(27, 'ai/issue-26');
  assert.equal((await t.dispatcher.enqueue(red())).status, 'queued');
  assert.equal(t.jobs.reverts.length, 1);
  assert.equal(t.jobs.reverts[0].issue, 26);
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(reopens().length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
});

test('a red revert whose ledger holds a pull request ref is told as a revert, not as an agent merge', async () => {
  const t = await build();
  t.jobs.merges.push({ repository: repo, number: 40, branch: 'refs/pull/40/head', sha: SHA, merged_at: clock - MINUTE, two_keys: false });
  world.pulls[40] = forgejoShape(40, 'ai/revert-27', { title: 'WIP: Revert: Add the feature' });
  assert.equal((await t.dispatcher.enqueue(red())).status, 'revert_red_told');
  assert.equal(t.jobs.reverts.length, 0, 'no record for a revert of a revert');
  await t.dispatcher.tick();
  assert.equal(starts().length, 0);
});

test('a missing record of a merged revert is made again from the ledger: the ticket of its merge is reopened and started once', async () => {
  const t = await build();
  seed(t); // the merge of #27 is in the ledger; no red run was recorded, so there is no record
  assert.equal(t.jobs.reverts.length, 0);
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(t.jobs.reverts.length, 1, 'the record is made now');
  assert.equal(t.jobs.reverts[0].issue, 26);
  assert.equal(t.jobs.reverts[0].sha, SHA);
  assert.ok(logs.some((line) => /the record of its revert was missing, made again from the ledger \(ticket #26\)/.test(line)));
  assert.equal(reopens().length, 1);
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
  assert.equal(t.jobs.reverts[0].state, 'handled');
});

test('a missing record is made again even when the ledger kept the merge as a pull request ref: the branch comes from the pull request', async () => {
  const t = await build();
  seed(t);
  t.jobs.merges[0].branch = 'refs/pull/27/head';
  world.pulls[27] = forgejoShape(27, 'ai/issue-26');
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(t.jobs.reverts.length, 1);
  assert.equal(t.jobs.reverts[0].issue, 26);
  assert.equal(reopens().length, 1);
});

test('no record is made for a merged revert whose ledger merge is not an agent branch', async () => {
  const t = await build();
  seed(t, { number: 27, branch: 'renovate/dep-1.x' });
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(t.jobs.reverts.length, 0);
  assert.equal(reopens().length, 0);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 0);
});

test('a revert with no merge in the ledger at all is not recorded either', async () => {
  const t = await build();
  mergedAsForgejo(40, 27);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(t.jobs.reverts.length, 0);
  assert.equal(reopens().length, 0);
});

test('two pushes that see the same merged revert at once: one cause comment, one reopen, one restart', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  const [first, second] = await Promise.all([
    t.dispatcher.closeMergedTickets(pushDefault()),
    t.dispatcher.closeMergedTickets(pushDefault())
  ]);
  assert.equal(first + second, 1, 'one of the two does the work');
  assert.equal(reopens().length, 1, 'one reopen');
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1, 'one cause comment');
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1, 'one restart');
  assert.equal(t.jobs.reverts.length, 1, 'one record');
  assert.equal(t.jobs.reverts[0].restarted, true);
  assert.equal(t.jobs.reverts[0].state, 'handled');
});

test('two pushes that see a missing record at once: one record, one cause comment, one restart', async () => {
  const t = await build();
  seed(t); // no red run was recorded: the record is made from the ledger by recoverRevert
  t.jobs.merges[0].branch = 'refs/pull/27/head'; // its branch is read from the forge, which waits: both events reach recoverRevert
  world.pulls[27] = forgejoShape(27, 'ai/issue-26');
  mergedAsForgejo(40, 27);
  await Promise.all([
    t.dispatcher.closeMergedTickets(pushDefault()),
    t.dispatcher.closeMergedTickets(pushDefault())
  ]);
  assert.equal(t.jobs.reverts.length, 1, 'one record for the merge');
  assert.equal(reopens().length, 1);
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
});

test('the cause comment fails once: the next push comments once, and the restart happens then, not twice', async () => {
  const t = await build();
  seed(t);
  await t.dispatcher.enqueue(red());
  merged(40, 27);
  world.commentFails = true;
  assert.equal(await t.dispatcher.closeMergedTickets(pushDefault()), 0);
  assert.ok(logs.some((line) => /could not comment on #26 after its revert/.test(line)));
  assert.equal(comments().filter((text) => /turned the CI/.test(text)).length, 0);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 0, 'no restart before the comment');
  assert.equal(t.jobs.reverts[0].commented, undefined);
  world.commentFails = false;
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(t.jobs.list().filter((job) => job.event.revert_retry).length, 1);
  await t.dispatcher.closeMergedTickets(pushDefault());
  assert.equal(comments().filter((text) => /turned the CI of main red/.test(text)).length, 1);
  assert.equal(reopens().length, 1);
});
