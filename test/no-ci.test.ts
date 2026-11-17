// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';

const REVIEWER = '55555555-5555-4555-8555-555555555555';
const SECURITY = '66666666-6666-4666-8666-666666666666';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA2 = '0123456789abcdef0123456789abcdef01234567';
let dir; let clock; let logs; let openhands; let world;
const logger = { error(...args) { logs.push(args.join(' ')); } };

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: REVIEWER, tier: 'free' },
    'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success' },
    'ci:failure': { profile: REVIEWER, tier: 'free', on: 'ci_failure' }
  }),
  MAX_CONCURRENT_PER_TIER: '4',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const pull = (over = {}) => ({ number: 34, state: 'open', merged: false, title: 'Fix it', body: 'Closes #26', user: { login: 'forgehands' },
  head: { ref: 'ai/issue-26', sha: SHA }, labels: [], ...over });

// A fake Forgejo and a fake OpenHands. `world` says what the repository looks like; a value { __status } answers with that HTTP status.
const freshWorld = () => ({ pulls: [pull()], status: { state: 'pending', total_count: 0 }, workflows: {}, files: [{ filename: 'README.md' }], calls: [] });
const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') { openhands.push(JSON.parse(request.body)); return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) }; }
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null }) };
  }
  const path = u.pathname.replace(API, '');
  world.calls.push(request.method + ' ' + path + u.search);
  if (request.method === 'GET') {
    if (path === '/pulls') return answer(world.pulls);
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) return answer(Array.isArray(world.pulls) ? world.pulls.find((entry) => entry.number === Number(one[1])) ?? { __status: 404 } : world.pulls);
    if (/^\/commits\/[0-9a-f]+\/status$/.test(path)) return answer(world.status);
    if (path.startsWith('/contents/')) return answer(world.workflows[path.slice('/contents/'.length)] ?? { __status: 404 });
    if (/^\/pulls\/\d+\/files$/.test(path)) return answer(world.files);
    if (path.endsWith('/labels')) return answer([]);
  }
  return answer({ __status: 404 });
}
const WORKFLOW = [{ type: 'file', name: 'ci.yaml' }];

async function build(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher };
}
const branchPush = (options = {}, payload = {}) => normalizeEvent('push', { ref: 'refs/heads/ai/issue-26', after: SHA, sender: { login: 'forgehands' },
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' }, ...payload }, new Set([repo]), [], { branchPushes: true, ...options });
const contentsCalls = () => world.calls.filter((call) => call.startsWith('GET /contents/'));
const reviews = () => openhands.filter((body) => body.agent_profile_id === REVIEWER);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-noci-')); clock = 1_000_000; logs = []; openhands = []; world = freshWorld(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a push to an agent branch in a repository without workflows starts the review once per commit', async () => {
  const { dispatcher, jobs } = await build();
  const event = branchPush();
  assert.equal(event.type, 'push.branch');
  assert.equal(event.branch, 'ai/issue-26');
  assert.equal(await dispatcher.onBranchPush(event), 'queued');
  await dispatcher.tick();
  assert.equal(reviews().length, 1);
  assert.equal(jobs.list()[0].key, 'owner/hello#26:ci:success:abcdef01');
  assert.equal(jobs.list()[0].event.ci.status, 'no_ci');
  assert.match(reviews()[0].initial_message.content[0].text, /Its CI is green/);
  assert.deepEqual(logs.filter((line) => /no CI in/.test(line)), ['owner/hello#34: no CI in owner/hello, reviewing abcdef0 without it']);
  // the same commit again, whether as a push or as a pull request event, starts nothing more
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'duplicate_job');
  const synchronized = normalizeEvent('pull_request', { action: 'synchronized', repository: { full_name: repo, default_branch: 'main' }, sender: { login: 'forgehands' },
    pull_request: pull() }, new Set([repo]), [], { branchPushes: true });
  assert.equal(synchronized.pull_request, 34);
  assert.equal(await dispatcher.onBranchPush(synchronized), 'duplicate_job');
  await dispatcher.tick();
  assert.equal(reviews().length, 1);
  assert.equal(logs.filter((line) => /no CI in/.test(line)).length, 1);
});

test('"no workflows" is remembered per commit in memory, "has workflows" never is', async () => {
  const { dispatcher } = await build();
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA), true);
  assert.equal(contentsCalls().length, 3, 'the three workflow folders are looked at once');
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA), true);
  assert.equal(contentsCalls().length, 3);
  // a commit that has workflows is asked again every time: they may be gone with the next commit
  world.workflows['.github/workflows'] = WORKFLOW;
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA2), false);
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA2), false);
  assert.equal(contentsCalls().length, 3 + 3 + 3);
  world.workflows = {};
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA2), true);
});

test('where Forgejo looks: the first workflow folder that exists decides, and only yaml files in it are workflows', async () => {
  const { dispatcher } = await build();
  world.workflows['.forgejo/workflows'] = WORKFLOW;
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA), false);
  assert.deepEqual(contentsCalls(), ['GET /contents/.forgejo/workflows?ref=' + SHA]);
  world.workflows = { '.gitea/workflows': WORKFLOW };
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA2), false);
  world.workflows = { '.github/workflows': [{ type: 'file', name: 'README.md' }, { type: 'dir', name: 'ci.yaml' }] };
  assert.equal(await dispatcher.merger.noWorkflows(repo, SHA2), true);
});

test('a repository with workflows that has not reported yet waits; its green run still starts the review as before', async () => {
  world.workflows['.forgejo/workflows'] = WORKFLOW;
  const { dispatcher } = await build();
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_expected');
  world.status = { state: 'pending', total_count: 1 };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_expected');
  await dispatcher.tick();
  assert.equal(reviews().length, 0);
  // the run turns green and Forgejo says so: the review starts through action_run_success
  world.status = { state: 'success', total_count: 1 };
  const run = normalizeEvent('action_run_success', { action: 'success', run: { id: 9, workflow_id: 'ci.yaml', commit_sha: SHA, event: 'pull_request', status: 'success',
    repository: { full_name: repo, default_branch: 'main' }, trigger_user: { login: 'forgehands' },
    event_payload: JSON.stringify({ pull_request: pull() }) } }, new Set([repo]), [], { ci: { success: 'ci:success', failure: 'ci:failure' } });
  assert.equal((await dispatcher.enqueue(run)).status, 'queued');
  await dispatcher.tick();
  assert.equal(reviews().length, 1);
});

test('a commit with a red status is never reviewed without CI, and the tree is not even looked at', async () => {
  const { dispatcher } = await build();
  world.status = { state: 'failure', total_count: 1 };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_expected');
  assert.equal(contentsCalls().length, 0);
  assert.equal(await dispatcher.merger.ciGreen(repo, SHA), false);
  assert.equal(reviews().length, 0);
});

test('REVIEW_WITHOUT_CI=0 restores the old behaviour: no event, no review, no extra calls', async () => {
  const { dispatcher, config } = await build({ REVIEW_WITHOUT_CI: '0' });
  assert.equal(config.reviewWithoutCi, false);
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'review_without_ci_off');
  assert.equal(world.calls.length, 0);
  assert.equal(await dispatcher.merger.ciGreen(repo, SHA), false);
  assert.equal(contentsCalls().length, 0);
  assert.throws(() => loadConfig(env({ REVIEW_WITHOUT_CI: 'yes' })), /REVIEW_WITHOUT_CI must be 0 or 1/);
  assert.equal(loadConfig(env({ REVIEW_WITHOUT_CI: '1' })).reviewWithoutCi, true);
  assert.equal(loadConfig(env()).reviewWithoutCi, true);
});

test('an unreadable Forgejo starts no review and the next event tries again', async () => {
  const { dispatcher } = await build();
  world.workflows['.forgejo/workflows'] = { __status: 500 };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_expected');
  assert.ok(logs.some((line) => /could not tell whether owner\/hello has workflows/.test(line)));
  // an answer that is no folder listing is as unknown as an error
  world.workflows['.forgejo/workflows'] = { type: 'file', name: 'workflows' };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_expected');
  const status = world.status;
  world.status = { __status: 503 };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'ci_unknown');
  world.status = status;
  const pulls = world.pulls;
  world.pulls = { __status: 502 };
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'pull_unreadable');
  world.pulls = pulls;
  await dispatcher.tick();
  assert.equal(reviews().length, 0);
  // Forgejo is back: the same commit is reviewed now
  world.workflows = {};
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'queued');
});

test('only the head of an open pull request of an agent or a bot counts, and only from a sender who may trigger', async () => {
  const { dispatcher } = await build({ ALLOWED_SENDERS: 'forgehands', BOT_AUTHORS: 'renovate', BOT_BRANCH_PREFIXES: 'renovate/' });
  world.pulls = [];
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'no_open_pull');
  world.pulls = [pull({ head: { ref: 'ai/issue-26', sha: SHA2 } })];
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'stale_push');
  world.pulls = [pull({ state: 'closed' })];
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'no_open_pull');
  world.pulls = [pull({ head: { ref: 'ai/issue-26', sha: SHA, repo: { full_name: 'fork/hello' } } })];
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'not_an_agent_branch');
  world.pulls = [pull()];
  assert.equal(await dispatcher.onBranchPush(branchPush({}, { sender: { login: 'mallory' } })), 'sender_not_allowed');
  // other branches are no event, nor are the default branch, a deletion, another repository or a switch that is off
  assert.equal(branchPush({}, { ref: 'refs/heads/feature/x' }), null);
  assert.equal(branchPush({}, { ref: 'refs/heads/main' }), null);
  assert.equal(branchPush({}, { after: '0'.repeat(40) }), null);
  assert.equal(branchPush({}, { repository: { full_name: 'other/repo', default_branch: 'main' } }), null);
  assert.equal(branchPush({ branchPushes: false }), null);
  assert.equal(reviews().length, 0);
});

test('the pull request of a dependency bot without CI is reviewed as a bot pull request, without a sender check', async () => {
  const { dispatcher, jobs } = await build({ ALLOWED_SENDERS: 'marcel', BOT_AUTHORS: 'renovate', BOT_BRANCH_PREFIXES: 'renovate/' });
  world.pulls = [pull({ number: 40, title: 'Update dep', user: { login: 'renovate' }, head: { ref: 'renovate/dep-1.x', sha: SHA2 } })];
  const bots = { authors: new Set(['renovate']), prefixes: ['renovate/'], fixRounds: 0 };
  const push = branchPush({ bots }, { ref: 'refs/heads/renovate/dep-1.x', after: SHA2, sender: { login: 'renovate' } });
  assert.equal(push.branch, 'renovate/dep-1.x');
  assert.equal(await dispatcher.onBranchPush(push), 'queued');
  const job = jobs.list()[0];
  assert.equal(job.key, 'owner/hello!pr40:ci:success:01234567');
  assert.equal(job.event.bot, true);
  assert.equal(job.event.issue.number, 40);
  assert.equal(branchPush({}, { ref: 'refs/heads/renovate/dep-1.x', after: SHA2 }), null, 'a bot branch needs BOT_AUTHORS');
  assert.equal(branchPush({ bots: { ...bots, prefixes: ['deps/'] } }, { ref: 'refs/heads/renovate/dep-1.x', after: SHA2 }), null);
  await dispatcher.tick();
  assert.equal(reviews().length, 1);
  // a pull request of somebody else on a branch with the bot's name is not a bot's
  world.pulls = [pull({ number: 41, user: { login: 'mallory' }, head: { ref: 'renovate/evil', sha: SHA2 } })];
  assert.equal(await dispatcher.onBranchPush(branchPush({ bots }, { ref: 'refs/heads/renovate/evil', after: SHA2 })), 'not_an_agent_branch');
  // a new head commit of the bot's pull request arrives as a pull request event
  world.pulls = [pull({ number: 40, user: { login: 'renovate' }, head: { ref: 'renovate/dep-1.x', sha: SHA } })];
  const updated = normalizeEvent('pull_request', { action: 'synchronized', repository: { full_name: repo, default_branch: 'main' }, sender: { login: 'renovate' }, pull_request: world.pulls[0] },
    new Set([repo]), [], { branchPushes: true, bots });
  assert.equal(await dispatcher.onBranchPush(updated), 'deferred', 'kept until the review of the earlier commit has ended, as for a CI outcome');
});

test('a protected path of a pull request without CI also gets the security review, once', async () => {
  world.files = [{ filename: 'compose.yaml' }];
  const { dispatcher, jobs } = await build({
    MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }),
    LABEL_ROUTES: JSON.stringify({ 'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success' }, 'ai:security': { profile: SECURITY, tier: 'strong', on: 'sensitive_review' } })
  });
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'queued');
  assert.deepEqual(jobs.list().map((job) => job.key).sort(), ['owner/hello#26:ai:security:abcdef01', 'owner/hello#26:ci:success:abcdef01']);
  assert.equal(await dispatcher.onBranchPush(branchPush()), 'duplicate_job');
  assert.equal(jobs.list().length, 2);
});

test('end to end: the push webhook of an agent branch starts the review, a stranger as sender does not', async () => {
  const hook = async (target, login, delivery) => {
    const raw = JSON.stringify({ ref: 'refs/heads/ai/issue-26', after: SHA, sender: { login }, repository: { full_name: repo, default_branch: 'main' } });
    const response = await fetch('http://127.0.0.1:' + target.address().port + '/webhooks/forgejo', { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': 'push', 'x-forgejo-delivery': delivery,
      'x-forgejo-signature': createHmac('sha256', loadConfig(env()).forgejoSecret).update(raw).digest('hex') } });
    return [response.status, (await response.json()).status];
  };
  const serve = async (extra) => {
    const { config, dispatcher } = await build(extra);
    const server = createApp(config, new DeliveryStore(config.dataFile), undefined, logger, dispatcher);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, dispatcher };
  };
  const on = await serve({ ALLOWED_SENDERS: 'forgehands' });
  try {
    assert.deepEqual(await hook(on.server, 'mallory', 'p1'), [202, 'sender_not_allowed']);
    assert.deepEqual(await hook(on.server, 'forgehands', 'p2'), [202, 'queued']);
    assert.deepEqual(await hook(on.server, 'forgehands', 'p3'), [202, 'duplicate_job']);
    await on.dispatcher.tick();
    assert.equal(reviews().length, 1);
  } finally {
    await new Promise((resolve) => on.server.close(resolve));
  }
  // switched off, the push is not even an event
  const off = await serve({ REVIEW_WITHOUT_CI: '0' });
  try {
    assert.deepEqual(await hook(off.server, 'forgehands', 'q1'), [202, 'ignored']);
  } finally {
    await new Promise((resolve) => off.server.close(resolve));
  }
});
