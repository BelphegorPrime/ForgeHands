// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Safety nets for merges without a human: the hold of two-key merges (TWO_KEYS_HOLD_MINUTES, HOLD_LABEL), the daily limit and revert on red.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { holdKey } from '../src/agent/merge.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { normalizeEvent } from '../src/webhook/events.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const SECURITY = '77777777-7777-4777-8777-777777777777';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const quiet = { error() {} };
const TWO_POLICY = JSON.stringify({ 'owner/hello': { deny: ['seed/infra/**', 'compose.yaml'], two_keys: ['seed/infra/tests/**', 'seed/infra/README.md'] } });
const VERDICT_OK = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.mjs line 12, check bash validate.sh exit 0. '.repeat(8);
const SECURITY_OK = (sha = 'cafe0000') => ({ created_at: '2026-11-15T11:01:00Z', user: { login: 'security-bot' }, body: '## Security review: OK\nCommit ' + sha + ': ' + 'evidence '.repeat(40) });
const HOUR = 3600000;
const MINUTE = 60000;
let dir; let clock;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: WORKER, tier: 'free', on: 'pull_request' },
    'ci:success': { profile: REVIEWER, tier: 'strong', max_iterations: 60, on: 'ci_success' },
    'sensitive:review': { profile: SECURITY, tier: 'strong', max_iterations: 60, on: 'sensitive_review', forgejo_token_secret: 'SECURITY_TOKEN' }
  }),
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL,SECURITY_TOKEN',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  SECURITY_TOKEN: 'security-token-value',
  SECURITY_REVIEWERS: 'security-bot',
  HUMAN_LOGIN: 'marcel',
  APPROVAL_GRACE_SECONDS: '0',
  MERGE_POLICY: TWO_POLICY,
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// A fake Forgejo for one pull request (#34 of owner/hello, branch ai/issue-26). `pr` and `comments` change between the calls of a test.
const MAIN_SHA = 'feed0000feed0000feed0000feed0000feed0000';
function forge(state) {
  const calls = [];
  const starts = [];
  const routes = {
    ['GET ' + API + '/pulls/34']: () => ({ state: 'open', merged: false, mergeable: true, title: 'Fix it', head: { ref: state.ref || 'ai/issue-26', sha: state.pr.head.sha }, labels: state.pr.labels.map((name) => ({ name })), merge_commit_sha: state.mergeSha || null }),
    ['GET ' + API + '/commits/' + MAIN_SHA + '/status']: () => state.mainCi || { state: 'failure', total_count: 2 },
    ['GET ' + API + '/commits/cafe0000cafe/status']: () => state.ci,
    ['GET ' + API + '/commits/beef0000beef/status']: { state: 'success', total_count: 2 },
    ['GET ' + API + '/pulls/34/files']: state.files.map((filename) => ({ filename })),
    ['GET ' + API + '/git/commits/cafe0000cafe']: { created: '2026-11-15T10:00:00Z' },
    ['GET ' + API + '/git/commits/beef0000beef']: { created: '2026-11-15T12:00:00Z' },
    ['GET ' + API + '/issues/34/comments']: () => state.comments,
    ['PATCH ' + API + '/pulls/34']: {}, ['POST ' + API + '/pulls/34/merge']: {}, ['POST ' + API + '/issues/34/comments']: {}, ['PATCH ' + API + '/issues/26']: {},
    ['GET ' + API + '/labels']: [{ id: 9, name: 'ai:hold' }], ['POST ' + API + '/labels']: { id: 10, name: 'ai:hold' }
  };
  const send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    // OpenHands (any other host): the conversations started are recorded, every call answers as a running conversation.
    if (u.origin !== 'https://forge.example') {
      if (request.method === 'POST') starts.push({ path: u.pathname, body });
      if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + starts.length }) };
      return { ok: true, status: 200, json: async () => ({ execution_status: 'running', stats: { usage_to_metrics: {} } }) };
    }
    calls.push({ method: request.method, path: u.pathname, body });
    const route = routes[request.method + ' ' + u.pathname];
    if (route === undefined) return { ok: false, status: 404 };
    const value = typeof route === 'function' ? route(u, body) : route;
    return { ok: true, status: 200, json: async () => value };
  };
  const wrote = () => calls.filter((call) => call.method !== 'GET').map((call) => call.method + ' ' + call.path.replace(API, ''));
  const comments = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/issues/34/comments')).map((call) => call.body.body);
  return { calls, send, wrote, comments, starts };
}

function harness(extra = {}, { files = ['seed/infra/tests/a.test.ts'], security = true, labels = ['ai:approved'] } = {}) {
  const state = {
    pr: { head: { sha: 'cafe0000cafe' }, labels },
    files,
    ci: { state: 'success', total_count: 2 },
    mergeSha: null,
    ref: 'ai/issue-26',
    comments: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: VERDICT_OK }, ...(security ? [SECURITY_OK()] : [])]
  };
  const fake = forge(state);
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const dispatcher = new Dispatcher(config, jobs, fake.send, quiet, () => clock);
  return { config, jobs, dispatcher, state, ...fake };
}
const approved = () => ({ type: 'pull_request.approved', repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 }, sender: { login: 'openhands' } });
const merged = (h) => h.wrote().includes('POST /pulls/34/merge');
const holdComments = (h) => h.comments().filter((text) => /approved by both keys/.test(text));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-safety-')); clock = Date.parse('2026-11-18T12:00:00Z'); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('hold: both keys agreed, the merge waits for TWO_KEYS_HOLD_MINUTES, is commented once and then merges', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'held');
  assert.equal(merged(h), false, 'no merge at approval time');
  assert.equal(holdComments(h).length, 1);
  assert.match(holdComments(h)[0], /approved by both keys\. It merges at \d\d:\d\d UTC unless the label `ai:hold` is put on this pull request or a new commit arrives\./);
  assert.match(holdComments(h)[0], /^@marcel /, 'HUMAN_MENTION applies, as for the other comments to the human');
  const stored = h.jobs.holds.get(holdKey(repo, 34));
  assert.equal(stored.merge_after, clock + 30 * MINUTE);
  clock += 20 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), false, 'still held after 20 of 30 minutes');
  assert.equal(holdComments(h).length, 1, 'the comment is not repeated');
  clock += 11 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), true, 'merged when the hold has ended');
  assert.match(h.comments().at(-1), /merged: approved by the reviewer and the security review/);
  assert.equal(h.jobs.holds.size, 0);
});

test('hold: the hold ends with a full re-evaluation; a red CI at the end means no merge', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '10' });
  await h.dispatcher.merger.handle(approved());
  h.state.ci = { state: 'failure', total_count: 2 };
  clock += 11 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), false, 'the commit went red during the hold');
  assert.equal(h.jobs.holds.size, 0, 'a hold whose time has run out is over, merged or not');
});

test('hold: HOLD_LABEL stops the merge for as long as it is on; taking it off starts a full hold period again', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' }, { labels: ['ai:approved', 'ai:hold'] });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'held_label');
  assert.equal(holdComments(h).length, 0, 'no hold comment while the label is on');
  clock += 2 * HOUR;
  await h.dispatcher.tick();
  assert.equal(merged(h), false, 'the label holds the merge, however long it is on');
  // the label comes off: the full time starts now, not at the old end of a hold
  h.state.pr.labels = ['ai:approved'];
  clock += 6 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(holdComments(h).length, 1, 'a new hold period starts with its comment');
  assert.equal(h.jobs.holds.get(holdKey(repo, 34)).merge_after, clock + 30 * MINUTE);
  clock += 29 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), false, 'not before the full 30 minutes');
  clock += 2 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), true);
});

test('hold: a new commit clears the hold; the review of the new commit starts over', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' });
  await h.dispatcher.merger.handle(approved());
  assert.equal(h.jobs.holds.size, 1);
  h.state.pr.head.sha = 'beef0000beef';
  clock += 5 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(h.jobs.holds.size, 0, 'the hold of the old commit is gone');
  clock += 40 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), false, 'the old hold does not merge the new commit');
  assert.equal(holdComments(h).length, 1);
});

test('hold: the hold survives a restart: the ledger keeps the time, the timer merges after it', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' });
  await h.dispatcher.merger.handle(approved());
  const until = h.jobs.holds.get(holdKey(repo, 34)).merge_after;
  await h.jobs.persist(clock);
  const reloaded = new JobStore(join(dir, 'jobs.json'));
  await reloaded.load();
  assert.equal(reloaded.holds.get(holdKey(repo, 34)).merge_after, until, 'the end of the hold comes back unchanged');
  const dispatcher = new Dispatcher(h.config, reloaded, h.send, quiet, () => clock);
  clock += 10 * MINUTE;
  await dispatcher.tick();
  assert.equal(merged(h), false, 'a restart does not shorten the hold');
  clock = until + MINUTE;
  await dispatcher.tick();
  assert.equal(merged(h), true);
});

test('hold: TWO_KEYS_HOLD_MINUTES=0 merges at once, as before', async () => {
  const h = harness();
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged');
  assert.equal(holdComments(h).length, 0);
  assert.equal(h.jobs.holds.size, 0);
});

test('hold: a pull request that is not on the two-key path is not held', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' }, { files: ['src/a.mjs'], security: false });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged');
  assert.equal(h.jobs.holds.size, 0);
});

test('hold: a protected path that is not covered by two keys is handed to the human, never held', async () => {
  const h = harness({ TWO_KEYS_HOLD_MINUTES: '30' }, { files: ['compose.yaml'], security: true });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'protected_paths');
  assert.equal(h.jobs.holds.size, 0);
});

// ---- daily limit: TWO_KEYS_DAILY_LIMIT, merges through two keys per repository in the last 24 hours
const earlier = (h, hoursAgo, { two = true, repository = repo } = {}) => h.jobs.merges.push({ repository: repository.toLowerCase(), number: 90, branch: 'ai/issue-9', sha: null, merged_at: clock - hoursAgo * HOUR, two_keys: two });

test('daily limit: the merge over the limit of 24 hours is handed to the human with the reason; older merges fall out of the window', async () => {
  const h = harness({ TWO_KEYS_DAILY_LIMIT: '2' });
  earlier(h, 23);
  earlier(h, 1);
  assert.equal(await h.dispatcher.merger.handle(approved()), 'daily_limit');
  assert.equal(merged(h), false);
  const text = h.comments().at(-1);
  assert.match(text, /daily limit of 2 merges through two keys reached/);
  assert.match(text, /ready for a human to merge|A human has to merge it/);
  assert.match(text, /^@marcel /, 'the human is called as for any protected path');
  clock += 2 * HOUR;
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged', 'the merge 25 hours ago no longer counts');
  assert.equal(merged(h), true);
});

test('daily limit: only merges through two keys count, and 0 switches the limit off', async () => {
  const plain = harness({ TWO_KEYS_DAILY_LIMIT: '1' }, { files: ['src/a.mjs'], security: false });
  earlier(plain, 1, { two: false });
  assert.equal(await plain.dispatcher.merger.handle(approved()), 'merged', 'a merge without two keys does not count');
  const off = harness({ TWO_KEYS_DAILY_LIMIT: '0' });
  for (let i = 0; i < 5; i++) earlier(off, 1);
  assert.equal(await off.dispatcher.merger.handle(approved()), 'merged');
});

test('daily limit: a merge of another repository does not count', async () => {
  const h = harness({ TWO_KEYS_DAILY_LIMIT: '1' });
  earlier(h, 1, { repository: 'other/repo' });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged');
});

test('daily limit: reached during a hold, the hold ends with a hand-over and no merge', async () => {
  const h = harness({ TWO_KEYS_DAILY_LIMIT: '1', TWO_KEYS_HOLD_MINUTES: '30' });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'held');
  earlier(h, 0.5);
  clock += 31 * MINUTE;
  await h.dispatcher.tick();
  assert.equal(merged(h), false);
  assert.match(h.comments().at(-1), /daily limit of 1 merges through two keys reached/);
  assert.equal(h.jobs.holds.size, 0);
});

test('daily limit: a merge is recorded with its commit (read after the merge) and survives a restart', async () => {
  const h = harness({ TWO_KEYS_DAILY_LIMIT: '5' });
  h.state.mergeSha = 'feed0000feed';
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged');
  const [record] = h.jobs.merges;
  assert.deepEqual({ ...record, merged_at: 0 }, { repository: repo.toLowerCase(), number: 34, branch: 'ai/issue-26', sha: 'feed0000feed', merged_at: 0, two_keys: true });
  await h.jobs.persist(clock);
  const reloaded = new JobStore(join(dir, 'jobs.json'));
  await reloaded.load();
  assert.equal(reloaded.merges.length, 1);
  const dispatcher = new Dispatcher(h.config, reloaded, h.send, quiet, () => clock);
  assert.equal(dispatcher.merger.twoKeysToday(repo), 1);
});

test('daily limit: merges older than 30 days are pruned from the ledger', async () => {
  const h = harness({});
  earlier(h, 24 * 31);
  earlier(h, 2);
  await h.jobs.persist(clock);
  assert.equal(h.jobs.merges.length, 1);
});

// ---- revert on red: REVERT_ON_RED, REVERT_WINDOW_MINUTES, the main_red route and the revert pull request
const REVERTER = '55555555-5555-4555-8555-555555555555';
const revertRoutes = () => JSON.stringify({ ...JSON.parse(env().LABEL_ROUTES), 'main:red': { profile: REVERTER, tier: 'free', max_iterations: 60, on: 'main_red' } });
const mainRun = (sha = MAIN_SHA, { ref = 'refs/heads/main', status = 'failure', event = 'push' } = {}) => ({
  action: status, run: { id: 77, workflow_id: 'ci.yaml', commit_sha: sha, event, status, html_url: 'https://forge.example/owner/hello/actions/runs/77',
    repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', html_url: 'https://forge.example/owner/hello', default_branch: 'main' },
    trigger_user: { login: 'forgehands' }, event_payload: JSON.stringify({ ref, after: sha, repository: { full_name: repo } }) }
});
const mainFailure = (extra = {}, payload = mainRun()) => normalizeEvent('action_run_failure', payload, new Set([repo]), [],
  { ci: { failure: 'ci:failure', success: 'ci:success', mainRed: 'main:red', revertOnRed: extra.revertOnRed ?? true } });
// The merge ForgeHands made of pull request #34 (the ledger knows it); `branch` names the revert when the merge was one.
function merged34(h, { ago = 10, branch = 'ai/issue-26', sha = MAIN_SHA } = {}) {
  h.jobs.merges.push({ repository: repo.toLowerCase(), number: 34, branch, sha, merged_at: clock - ago * MINUTE, two_keys: false });
}
function withNotifier(h) {
  h.notices = [];
  h.dispatcher.notifier = { wants: () => true, notify: (message) => h.notices.push(message) };
  return h;
}

test('revert on red: a failed run on the default branch for a merge of ForgeHands comments, tells the human and starts one revert run', async () => {
  const h = withNotifier(harness({ LABEL_ROUTES: revertRoutes() }));
  merged34(h);
  const event = mainFailure();
  assert.equal(event.type, 'ci.main_failure');
  assert.equal((await h.dispatcher.enqueue(event)).status, 'queued');
  assert.equal(h.comments().length, 1);
  assert.match(h.comments()[0], /^ForgeHands: CI failed on main after this merge \(commit feed0000\)\. A revert is started\.$/);
  assert.equal(h.notices.length, 1, 'the human is told at once');
  await h.dispatcher.tick();
  assert.equal(h.starts.length, 1);
  const prompt = h.starts[0].body.initial_message.content[0].text;
  assert.equal(h.starts[0].body.agent_profile_id, REVERTER);
  assert.match(prompt, new RegExp('Commit ' + MAIN_SHA + ' \\(the merge of pull request #34\\) on main broke the CI'));
  assert.match(prompt, /Create the branch `ai\/revert-34` from main and revert that merge commit with `git revert -m 1 feed0000/);
  assert.match(prompt, /Do not fix forward/);
  assert.match(prompt, /titled `WIP: Revert: /);
  // the same commit again (a second failed workflow): nothing more
  assert.equal((await h.dispatcher.enqueue(mainFailure())).status, 'duplicate');
  assert.equal(h.comments().length, 1);
  assert.equal(h.notices.length, 1);
  await h.dispatcher.tick();
  assert.equal(h.starts.length, 1, 'at most one run per merge commit');
});

test('revert on red: without a main_red route the human is called on the pull request and no run starts', async () => {
  const h = withNotifier(harness());
  merged34(h);
  assert.equal((await h.dispatcher.enqueue(mainFailure())).status, 'handed_to_human');
  assert.match(h.comments()[0], /@marcel ForgeHands: CI failed on main after this merge \(commit feed0000\)\. A human has to look at it\./);
  assert.equal(h.notices.length, 1);
  await h.dispatcher.tick();
  assert.equal(h.starts.length, 0);
});

test('revert on red: a failed run outside REVERT_WINDOW_MINUTES, or for a commit ForgeHands did not merge, does nothing', async () => {
  const h = withNotifier(harness({ LABEL_ROUTES: revertRoutes() }));
  merged34(h, { ago: 121 });
  assert.equal((await h.dispatcher.enqueue(mainFailure())).status, 'outside_window');
  const window = withNotifier(harness({ LABEL_ROUTES: revertRoutes(), REVERT_WINDOW_MINUTES: '240' }));
  merged34(window, { ago: 121 });
  assert.equal((await window.dispatcher.enqueue(mainFailure())).status, 'queued', 'the window is configurable');
  const other = withNotifier(harness({ LABEL_ROUTES: revertRoutes() }));
  merged34(other, { sha: 'beef0000beef0000beef0000beef0000beef000000' });
  assert.equal((await other.dispatcher.enqueue(mainFailure())).status, 'not_our_merge');
  assert.equal(other.notices.length + other.comments().length, 0);
  assert.equal(h.starts.length + other.starts.length, 0);
});

test('revert on red: a red revert only tells the human; a recovered commit and REVERT_ON_RED=0 do nothing', async () => {
  const h = withNotifier(harness({ LABEL_ROUTES: revertRoutes() }));
  merged34(h, { branch: 'ai/revert-34' });
  assert.equal((await h.dispatcher.enqueue(mainFailure())).status, 'revert_red_told');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, /after a revert of ForgeHands/);
  assert.equal(h.comments().length, 0, 'no comment on the revert');
  await h.dispatcher.tick();
  assert.equal(h.starts.length, 0, 'no revert of a revert');
  const green = withNotifier(harness({ LABEL_ROUTES: revertRoutes() }));
  merged34(green);
  green.state.mainCi = { state: 'success', total_count: 2 };
  assert.equal((await green.dispatcher.enqueue(mainFailure())).status, 'ci_not_red');
  const off = withNotifier(harness({ LABEL_ROUTES: revertRoutes(), REVERT_ON_RED: '0' }));
  merged34(off);
  assert.equal((await off.dispatcher.enqueue(mainFailure())).status, 'revert_off');
  assert.equal(off.notices.length + off.comments().length, 0);
});

test('revert on red: only a failed run of the default branch is an event at all', () => {
  assert.equal(mainFailure({}, mainRun(MAIN_SHA, { ref: 'refs/heads/feature/x' })), null);
  assert.equal(mainFailure({}, mainRun(MAIN_SHA, { status: 'success' })), null);
  assert.equal(mainFailure({ revertOnRed: false }), null);
  assert.equal(mainFailure({}, mainRun('not-a-sha')), null);
  // the pull request run of the same workflow is unchanged
  const pullRun = { action: 'failure', run: { id: 5, workflow_id: 'ci.yaml', commit_sha: 'abcdef0123456789abcdef0123456789abcdef01', event: 'pull_request', status: 'failure',
    repository: { full_name: repo, default_branch: 'main' }, event_payload: JSON.stringify({ pull_request: { number: 34, state: 'open', head: { ref: 'ai/issue-26' } } }) } };
  assert.equal(normalizeEvent('action_run_failure', pullRun, new Set([repo]), [], { ci: { failure: 'ci:failure', mainRed: 'main:red', revertOnRed: true } }).type, 'ci.failure');
});

test('revert on red: the route kind main_red validates in LABEL_ROUTES; it is optional', () => {
  const config = loadConfig(env({ LABEL_ROUTES: revertRoutes() }));
  assert.equal(config.routes.get('main:red').kind, 'main_red');
  assert.throws(() => loadConfig(env({ REVERT_ON_RED: 'yes' })), /REVERT_ON_RED must be 0 or 1/);
  assert.throws(() => loadConfig(env({ REVERT_WINDOW_MINUTES: '0' })), /REVERT_WINDOW_MINUTES must be an integer between 1 and 10080/);
  assert.equal(loadConfig(env()).revertOnRed, true);
  assert.equal(loadConfig(env()).revertWindowMinutes, 120);
});

test('revert on red: the revert pull request is an agent pull request: approved and green it merges, skips the hold and the daily limit, closes no ticket', async () => {
  const h = harness({ LABEL_ROUTES: revertRoutes(), TWO_KEYS_HOLD_MINUTES: '30', TWO_KEYS_DAILY_LIMIT: '1' }, { files: ['seed/infra/tests/a.test.ts'] });
  h.state.ref = 'ai/revert-34';
  merged34(h, { ago: 300 });
  h.jobs.merges.push({ repository: repo.toLowerCase(), number: 40, branch: 'ai/issue-30', sha: 'a'.repeat(40), merged_at: clock - MINUTE, two_keys: true });
  assert.equal(await h.dispatcher.merger.handle(approved()), 'merged');
  assert.ok(h.wrote().includes('POST /pulls/34/merge'));
  assert.ok(!h.wrote().some((line) => line.startsWith('PATCH /issues/')), 'no ticket is closed for a revert');
  assert.equal(h.jobs.holds.size, 0);
  assert.equal(h.jobs.merges.at(-1).branch, 'ai/revert-34');
});
