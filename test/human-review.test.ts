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
import { buildPrompt } from '../src/agent/prompt.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';

// HUMAN_REVIEW_ROUNDS: a formal review of HUMAN_LOGIN in comment mode starts the changes round (see README "Follow-up rounds and escalation").
const WORKER = '22222222-2222-4222-8222-222222222222';
const CHANGES = '44444444-4444-4444-8444-444444444444';
const ESCALATE = '33333333-3333-4333-8333-333333333333';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const HEAD = 'cafe0000cafe';
const LONG = 'Evidence: the request is in src/a.mjs line 3, the check bash validate.sh exit 0. '.repeat(4);
const quiet = { error() {} };
let dir; let clock; let openhands; let states; let appCount = 0;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  ALLOWED_SENDERS: 'marcel,forgehands,stranger',
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request', escalate_to: 'ai:escalate' },
    'ai:escalate': { profile: ESCALATE, tier: 'strong' }
  }),
  MAX_CONCURRENT_PER_TIER: '4',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries-' + (appCount++) + '.json'),
  ...extra
});

const ok = (value) => ({ ok: true, status: 200, json: async () => value });
const pull = (over = {}) => ({ state: 'open', merged: false, mergeable: true, title: 'Fix it', body: 'Closes #26', head: { ref: 'ai/issue-26', sha: HEAD }, labels: [], ...over });
const rev = (id, login, state, over = {}) => ({ id, user: { login }, state, body: LONG, commit_id: HEAD, submitted_at: '2026-11-15T11:0' + id + ':00Z', dismissed: false, stale: false, official: true, ...over });

// A fake Forgejo for the one pull request 34 of issue 26. `st` is the repository as the test sets it; DELETE of a label takes it off.
function forge(st) {
  const calls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    const path = u.pathname.replace(API, '');
    calls.push({ method: request.method, path });
    if (request.method === 'GET') {
      if (path === '/pulls/34') return ok(st.pr);
      if (path === '/pulls/34/reviews') return ok(st.reviews);
      if (path === '/issues/34/labels') return ok(st.labels);
      if (path === '/pulls/34/files') return ok([{ filename: 'README.md' }]);
      if (/^\/commits\/[0-9a-f]+\/status$/.test(path)) return ok({ state: 'success', total_count: 1 });
    }
    if (request.method === 'DELETE' && /^\/issues\/34\/labels\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      st.labels = st.labels.filter((label) => label.id !== id);
      return ok({});
    }
    if (request.method === 'POST' && path === '/pulls/34/merge') return ok({});
    return { ok: false, status: 404 };
  };
  const wrote = () => calls.filter((call) => call.method !== 'GET').map((call) => call.method + ' ' + call.path);
  return { calls, send, wrote };
}

// A fake OpenHands: every POST starts a conversation; the state of a conversation is set by the test (states[id]).
async function openhandsApi(url, request) {
  if (request.method === 'POST') {
    openhands.push(JSON.parse(request.body));
    return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) };
  }
  const id = new URL(url).pathname.split('/').pop();
  return ok({ execution_status: states[id] || 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } });
}

// The app with its webhook, a dispatcher and a fake forge; `st` is the state of the pull request (labels, reviews, head).
async function app(extra = {}, st = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (appCount++) + '.json'));
  await jobs.load();
  const state = { pr: pull(), reviews: [], labels: [], ...st };
  const forgejo = forge(state);
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : openhandsApi(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock);
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Posts a native review event (header name, payload) under a delivery id and returns the status the webhook answered with.
  const post = async (name, payload, id) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': name, 'x-forgejo-delivery': id, 'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') }, body: raw });
    return (await response.json()).status;
  };
  return { config, jobs, state, forgejo, dispatcher, post, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A review event as Forgejo sends it; `sender` is the reviewer, `review.id` the review (if the payload carries one).
const reviewPayload = (event, { sender = 'marcel', id = 1, branch = 'ai/issue-26', sha = HEAD } = {}) => ({
  action: 'reviewed', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  pull_request: { number: 34, state: 'open', merged: false, title: 'Fix it', body: 'Closes #26', head: { ref: branch, sha }, labels: [] },
  review: { id, type: event, content: 'x' }, sender: { login: sender }
});
const CHANGES_NAME = 'pull_request_rejected';
const APPROVED_NAME = 'pull_request_approved';
const COMMENT_NAME = 'pull_request_review_comment';

// A round an agent asked for (the changes label set by ForgeHands' own account): it is not the human, so it resets nothing.
const agentRound = (sender = 'forgehands') => ({
  type: 'pull_request.labeled', label: 'ai:changes', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number: 26, title: 'T', body: 'B', html_url: null, comments: 0, labels: ['ai:changes'] },
  pull_request: { number: 34, head_ref: 'ai/issue-26', html_url: null }, sender: { login: sender }
});
const finish = async (dispatcher, jobs) => { await dispatcher.tick(); states[jobs.list().at(-1).conversation_id] = 'finished'; await dispatcher.tick(); };
const changesJobs = (jobs) => jobs.list().filter((job) => job.key === 'owner/hello#26:ai:changes');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-human-review-')); clock = 1_000_000; openhands = []; states = {}; appCount = 0; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a formal request for changes of the operator in comment mode starts exactly one changes round', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES', { body: 'fix the tag' })] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'd-1'), 'queued');
    assert.equal(a.jobs.list().length, 1);
    assert.equal(a.jobs.list()[0].key, 'owner/hello#26:ai:changes');
    assert.equal(a.jobs.list()[0].event.review.human, true);
    assert.equal(a.jobs.list()[0].event.review.commit, HEAD);
    await a.dispatcher.tick();
    assert.equal(openhands.length, 1);
    assert.equal(openhands[0].agent_profile_id, CHANGES);
    const text = openhands[0].initial_message.content[0].text;
    assert.match(text, /A review asks for changes \(by marcel\)/);
    assert.match(text, /read every review of that reviewer that is newer than the last round, and all of its inline review comments/);
    assert.doesNotMatch(text, /remove the label/);
  } finally { await a.close(); }
});

test('the same review delivered twice starts one round, under the same or another delivery id', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'd-1'), 'queued');
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'd-1'), 'duplicate', 'the same delivery');
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'd-2'), 'duplicate_review', 'the same review, redelivered under a new id');
    assert.equal(changesJobs(a.jobs).length, 1);
  } finally { await a.close(); }
});

test('a review of anybody else is ignored in comment mode, even from an allowed sender', async () => {
  const a = await app({}, { reviews: [rev(1, 'stranger', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { sender: 'stranger' }), 'o-1'), 'ignored');
    assert.equal(await a.post(APPROVED_NAME, reviewPayload('pull_request_review_approved', { sender: 'stranger' }), 'o-2'), 'ignored');
    assert.equal(a.jobs.list().length, 0);
  } finally { await a.close(); }
});

test('HUMAN_REVIEW_ROUNDS=0 restores today\'s behaviour: the operator\'s review in comment mode is no event', async () => {
  const a = await app({ HUMAN_REVIEW_ROUNDS: '0' }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(a.config.humanReviewRounds, false);
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'z-1'), 'ignored');
    assert.equal(a.jobs.list().length, 0);
  } finally { await a.close(); }
});

test('HUMAN_REVIEW_ROUNDS is on by default with HUMAN_LOGIN, off without it (no error), and must be 0 or 1', async () => {
  assert.equal(loadConfig(env()).humanReviewRounds, true);
  assert.equal(loadConfig(env({ HUMAN_REVIEW_ROUNDS: '0' })).humanReviewRounds, false);
  assert.equal(loadConfig(env({ HUMAN_LOGIN: undefined })).humanReviewRounds, false);
  assert.throws(() => loadConfig(env({ HUMAN_REVIEW_ROUNDS: 'yes' })), /HUMAN_REVIEW_ROUNDS must be 0 or 1/);
  const a = await app({ HUMAN_LOGIN: undefined }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'n-1'), 'ignored');
    assert.equal(a.jobs.list().length, 0);
  } finally { await a.close(); }
});

test('a review on a branch that is not an agent branch is ignored', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { branch: 'feature/x' }), 'b-1'), 'ignored');
    assert.equal(a.jobs.list().length, 0);
  } finally { await a.close(); }
});

test('a request for changes on an outdated commit starts nothing', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES', { commit_id: 'beef1111beef' })] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { sha: 'beef1111beef' }), 'x-1'), 'ignored_review');
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'x-2'), 'ignored_review', 'the head has no request of the operator');
    assert.equal(a.jobs.list().length, 0);
  } finally { await a.close(); }
});

test('an approval or a comment of the operator starts nothing and merges nothing, even with the approval label', async () => {
  const config = { MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }) };
  const a = await app(config, { pr: pull({ labels: [{ id: 4, name: 'ai:approved' }] }), reviews: [rev(1, 'marcel', 'APPROVED')], labels: [{ id: 4, name: 'ai:approved' }] });
  try {
    assert.equal(await a.post(APPROVED_NAME, reviewPayload('pull_request_review_approved'), 'a-1'), 'human_review_no_round');
    assert.equal(await a.post(COMMENT_NAME, reviewPayload('pull_request_review_comment', { id: 2 }), 'a-2'), 'human_review_no_round');
    assert.equal(a.jobs.list().length, 0);
    assert.ok(!a.forgejo.wrote().some((call) => call.includes('/merge')), 'no merge');
    assert.deepEqual(a.state.labels, [{ id: 4, name: 'ai:approved' }], 'the approval label stays');
  } finally { await a.close(); }
});

test('a request for changes of the operator takes ai:approved off, lifts ai:blocked and starts the rounds again', async () => {
  const a = await app({ MAX_ROUNDS: '1' }, { labels: [{ id: 4, name: 'ai:approved' }, { id: 9, name: 'ai:blocked' }], reviews: [] });
  try {
    // the one allowed round of the agent is spent, so its next request is refused
    assert.equal((await a.dispatcher.enqueue(agentRound())).status, 'queued');
    await finish(a.dispatcher, a.jobs);
    assert.equal((await a.dispatcher.enqueue(agentRound())).status, 'rounds_exceeded');
    // the operator asks for changes: his action starts the rounds again, as a label of his would
    a.state.reviews = [rev(1, 'marcel', 'REQUEST_CHANGES')];
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'r-1'), 'queued');
    assert.ok(a.forgejo.wrote().includes('DELETE /issues/34/labels/4'), 'approval off');
    assert.ok(a.forgejo.wrote().includes('DELETE /issues/34/labels/9'), 'block lifted');
    assert.deepEqual(a.state.labels, [], 'both labels are gone');
    const spent = a.jobs.list().filter((job) => job.round_reset);
    assert.equal(spent.length, 1, 'the spent round no longer counts');
    assert.ok(['queued', 'running'].includes(a.jobs.list().at(-1).status), 'the round is under way');
    assert.equal(a.jobs.list().at(-1).event.review.human, true);
  } finally { await a.close(); }
});

test('a request for changes in comment mode without any approval label does not remove a label it does not need to', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')], labels: [] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'l-1'), 'queued');
    assert.ok(!a.forgejo.wrote().some((call) => call.startsWith('DELETE')), 'nothing to take off');
  } finally { await a.close(); }
});

test('a second request for changes on the same head while the round is queued starts nothing', async () => {
  const a = await app({}, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { id: 1 }), 'q-1'), 'queued');
    a.state.reviews = [rev(1, 'marcel', 'REQUEST_CHANGES'), rev(2, 'marcel', 'REQUEST_CHANGES', { body: LONG + ' again' })];
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { id: 2 }), 'q-2'), 'duplicate_job');
    assert.equal(changesJobs(a.jobs).length, 1);
  } finally { await a.close(); }
});

test('the round on the last allowed round escalates via escalate_to, a round the operator asks for counts like any other', async () => {
  const a = await app({ MAX_ROUNDS: '2' }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'e-1'), 'queued');
    await finish(a.dispatcher, a.jobs);
    assert.equal(openhands.at(-1).agent_profile_id, CHANGES, 'the first round runs on its own profile');
    // the agent's own label is the second round: the last allowed one, so it escalates
    assert.equal((await a.dispatcher.enqueue(agentRound())).status, 'queued');
    await a.dispatcher.tick();
    assert.equal(openhands.at(-1).agent_profile_id, ESCALATE, 'the last round runs on the escalation profile');
  } finally { await a.close(); }
});

test('VERDICT_SOURCE=both: one human review starts one round, however often it is delivered', async () => {
  const a = await app({ VERDICT_SOURCE: 'both', HUMAN_REVIEW_ROUNDS: '1' }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(a.config.humanReviewRounds, true);
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'both-1'), 'queued');
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'both-2'), 'duplicate_job');
    assert.equal(changesJobs(a.jobs).length, 1);
    assert.equal(changesJobs(a.jobs)[0].event.review.human, undefined, 'the review path of both mode handles it, not the human path');
  } finally { await a.close(); }
});

test('the request of the operator in review mode is handled by the review path, which is unchanged', async () => {
  const a = await app({ VERDICT_SOURCE: 'review', AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,REVIEWER_TOKEN', REVIEWER_TOKEN: 'tok-reviewer-one',
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' }, 'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
      'ci:success': { profile: WORKER, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER_TOKEN' } }) }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(a.config.humanReviewRounds, true);
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 'rv-1'), 'queued');
    assert.equal(changesJobs(a.jobs)[0].event.review.human, undefined);
  } finally { await a.close(); }
});

test('a comment review is no event in review mode', async () => {
  const review = await app({ VERDICT_SOURCE: 'review', AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,REVIEWER_TOKEN', REVIEWER_TOKEN: 'tok-reviewer-one',
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' }, 'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
      'ci:success': { profile: WORKER, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER_TOKEN' } }) }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await review.post(COMMENT_NAME, reviewPayload('pull_request_review_comment'), 'rc-1'), 'ignored');
    assert.equal(review.jobs.list().length, 0);
  } finally { await review.close(); }
});

test('the webhook events of the review routes are the ones named in the README (normalization only)', async () => {
  const options = { humanReviews: { human: 'marcel' } };
  const got = normalizeEvent(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), new Set([repo]), [], options);
  assert.equal(got.type, 'pull_request.review_rejected');
  assert.equal(got.review.human, true);
  assert.equal(got.review.id, '1');
  assert.equal(got.review.commit, HEAD);
  assert.equal(normalizeEvent(COMMENT_NAME, reviewPayload('pull_request_review_comment', { sender: 'marcel' }), new Set([repo]), [], options).type, 'pull_request.review_comment');
  assert.equal(normalizeEvent(COMMENT_NAME, reviewPayload('pull_request_review_comment'), new Set([repo]), [], { reviews: true }), null, 'a comment review is no verdict in review mode');
  assert.equal(normalizeEvent(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { sender: 'stranger' }), new Set([repo]), [], options), null);
  assert.equal(normalizeEvent(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), new Set([repo]), [], {}), null, 'off without the option');
  assert.equal(normalizeEvent(CHANGES_NAME, reviewPayload('pull_request_review_rejected', { id: 'x' }), new Set([repo]), [], options).review.id, undefined);
});

test('a human round that gets stuck is tried once more on the escalation profile (stage B), which counts as no round and no second round for his review', async () => {
  const a = await app({ RESUME_ATTEMPTS: '0' }, { reviews: [rev(1, 'marcel', 'REQUEST_CHANGES')] });
  try {
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 's-1'), 'queued');
    await a.dispatcher.tick();
    states[a.jobs.list()[0].conversation_id] = 'stuck';
    await a.dispatcher.tick();
    const stageB = a.jobs.list().filter((job) => job.failure_escalation);
    assert.equal(stageB.length, 1, 'one extra try for the stuck round');
    assert.equal(stageB[0].key, 'owner/hello#26:ai:changes:cafe0000');
    assert.equal(stageB[0].event.review.human, true, 'it carries the review of the operator');
    assert.equal(a.dispatcher.countsAsRound(stageB[0]), false, 'stage B does not count as a round');
    assert.equal(a.dispatcher.rounds(a.jobs.list()[0].event), 1, 'only the human round counts');
    await a.dispatcher.tick();
    assert.equal(openhands.at(-1).agent_profile_id, ESCALATE, 'the extra try runs on the escalation profile');
    // the same review again starts nothing, neither a round nor another extra try
    assert.equal(await a.post(CHANGES_NAME, reviewPayload('pull_request_review_rejected'), 's-2'), 'duplicate_review');
    assert.equal(a.jobs.list().length, 2);
  } finally { await a.close(); }
});
