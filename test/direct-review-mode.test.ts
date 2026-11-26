// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Review mode: native reviews as the verdict (VERDICT_SOURCE, REQUIRED_APPROVALS).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { normalizeGiteaEvent } from '../src/forge/gitea/webhook.ts';
import { ctx, WORKER, repo, quiet, env, fakeApi, event, starts, webhook, CHANGES, REVIEWER, ciEvent, withMerge, API, fakeForgejo, goodRoutes, mergerFor, approvedEvent, issue, buildVerdict, reviewJob, prWith, verdict, pull, BOT_RULES, botEvent, RV2, HEAD, reviewEnv, rev, reviewsRoute, unlabelled, reviewMerger, reviewPayload, reviewHook, reviewApp } from './helpers/direct.ts';

test('review mode config: VERDICT_SOURCE, REQUIRED_APPROVALS and the reviewer token of a route are validated', () => {
  assert.equal(loadConfig(env(withMerge())).verdictSource, 'comment');
  assert.equal(loadConfig(env(withMerge())).requiredApprovals, 1);
  const on = loadConfig(env(reviewEnv({ REQUIRED_APPROVALS: '2' })));
  assert.equal(on.verdictSource, 'review');
  assert.equal(on.requiredApprovals, 2);
  assert.equal(on.routes.get('ci:success').forgejoTokenSecret, 'REVIEWER_TOKEN');
  assert.throws(() => loadConfig(env(withMerge({ VERDICT_SOURCE: 'votes' }))), /VERDICT_SOURCE must be comment, review or both/);
  assert.throws(() => loadConfig(env(withMerge({ REQUIRED_APPROVALS: '2' }))), /REQUIRED_APPROVALS above 1 needs VERDICT_SOURCE/);
  assert.throws(() => loadConfig(env(reviewEnv({ REQUIRED_APPROVALS: '0' }))), /REQUIRED_APPROVALS/);
  assert.throws(() => loadConfig(env(withMerge({ VERDICT_SOURCE: 'review' }))), /needs "forgejo_token_secret" on every review route/);
  assert.equal(loadConfig(env(withMerge({ VERDICT_SOURCE: 'both' }))).verdictSource, 'both');
  const routes = (route) => JSON.stringify({ 'ai:ready': { profile: WORKER }, 'ci:success': { profile: REVIEWER, on: 'ci_success', ...route } });
  assert.throws(() => loadConfig(env(reviewEnv({ LABEL_ROUTES: routes({ forgejo_token_secret: 'NOPE_TOKEN' }) }))), /must name an extra entry of AGENT_SECRETS/);
  assert.throws(() => loadConfig(env(reviewEnv({ LABEL_ROUTES: routes({ forgejo_token_secret: 'FORGEJO_TOKEN' }) }))), /must name an extra entry of AGENT_SECRETS/);
  assert.throws(() => loadConfig(env(reviewEnv({ REVIEWER_TOKEN: 'tok-secret-value', LABEL_ROUTES: routes({ forgejo_token_secret: 'REVIEWER_TOKEN' }) }))), /author of a pull request cannot approve it/);
  assert.throws(() => loadConfig(env(reviewEnv({ LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, forgejo_token_secret: 'REVIEWER_TOKEN' } }) }))), /only applies to a review route/);
});

test('review mode: an approval of the head commit by a reviewer lets the merge through, without any label', async () => {
  const { merger, forgejo } = await reviewMerger([rev(1, 'reviewer', 'APPROVED')]);
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.ok(forgejo.wrote().includes('POST /pulls/34/merge'));
});

test('review mode: an approval of an older commit, a stale one and a dismissed one do not count', async () => {
  for (const [name, review] of Object.entries({
    'older sha': rev(1, 'reviewer', 'APPROVED', { commit_id: 'beef1111beef' }),
    stale: rev(1, 'reviewer', 'APPROVED', { stale: true }),
    dismissed: rev(1, 'reviewer', 'APPROVED', { dismissed: true }),
    'not official (reviewer may not approve)': rev(1, 'stranger', 'APPROVED', { official: false }),
    'body without evidence': rev(1, 'reviewer', 'APPROVED', { body: 'LGTM' }),
    'only a comment review': rev(1, 'reviewer', 'COMMENT')
  })) {
    const { merger, forgejo } = await reviewMerger([review]);
    assert.notEqual(await merger.handle(approvedEvent()), 'merged', name);
    assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'), name);
  }
});

test('review mode: a request for changes of the same reviewer after an approval wins, an approval after it lets it through again', async () => {
  const stopped = await reviewMerger([rev(1, 'reviewer', 'APPROVED'), rev(2, 'reviewer', 'REQUEST_CHANGES', { body: 'no' })]);
  assert.equal(await stopped.merger.handle(approvedEvent()), 'changes_requested');
  assert.deepEqual(await stopped.merger.reviewOf(repo, 34, HEAD), { ok: false, reason: 'changes_requested' });
  const fixed = await reviewMerger([rev(1, 'reviewer', 'REQUEST_CHANGES'), rev(2, 'reviewer', 'APPROVED')]);
  assert.equal(await fixed.merger.handle(approvedEvent()), 'merged');
  const other = await reviewMerger([rev(1, 'reviewer', 'APPROVED'), rev(2, 'second', 'REQUEST_CHANGES')]);
  assert.equal((await other.merger.reviewOf(repo, 34, HEAD)).reason, 'changes_requested');
  const dismissed = await reviewMerger([rev(1, 'reviewer', 'APPROVED'), rev(2, 'second', 'REQUEST_CHANGES', { dismissed: true })]);
  assert.equal((await dismissed.merger.reviewOf(repo, 34, HEAD)).ok, true);
});

test('REQUIRED_APPROVALS counts distinct users: two approvals of one user are not enough', async () => {
  const one = await reviewMerger([rev(1, 'reviewer', 'APPROVED'), rev(2, 'Reviewer', 'APPROVED')], { REQUIRED_APPROVALS: '2' });
  assert.deepEqual(await one.merger.reviewOf(repo, 34, HEAD), { ok: false, reason: 'not_enough' });
  assert.equal(await one.merger.handle(approvedEvent()), 'awaiting_approvals');
  assert.deepEqual(one.forgejo.wrote(), []);
  const two = await reviewMerger([rev(1, 'reviewer', 'APPROVED'), rev(2, 'second', 'APPROVED')], { REQUIRED_APPROVALS: '2' });
  assert.equal(await two.merger.handle(approvedEvent()), 'merged');
});

test('both mode: a verdict comment with the label or a native review each lets it through, a request for changes beats the comment', async () => {
  const both = { VERDICT_SOURCE: 'both' };
  const commentOnly = await mergerFor(goodRoutes(), both);
  assert.equal(await commentOnly.merger.handle(approvedEvent()), 'merged');
  const reviewOnly = await reviewMerger([rev(1, 'reviewer', 'APPROVED')], both, { ['GET ' + API + '/issues/34/comments']: [] });
  assert.equal(await reviewOnly.merger.handle(approvedEvent()), 'merged');
  const blocked = await reviewMerger([rev(1, 'second', 'REQUEST_CHANGES')], both);
  assert.equal(await blocked.merger.handle(approvedEvent()), 'changes_requested');
  const nothing = await reviewMerger([], both, { ['GET ' + API + '/issues/34/comments']: [] });
  assert.equal(await nothing.merger.handle(approvedEvent()), 'not_approved');
  const comment = await mergerFor(goodRoutes({ ...unlabelled, ...reviewsRoute([rev(1, 'reviewer', 'APPROVED')]) }));
  assert.equal(await comment.merger.handle(approvedEvent()), 'not_approved');
});

test('review mode: a bot pull request merges on an approval too', async () => {
  const bot = { BOT_AUTHORS: 'renovate', BOT_BRANCH_PREFIXES: 'renovate/' };
  const pr = { state: 'open', merged: false, mergeable: true, title: 'Update lodash', head: { ref: 'renovate/lodash', sha: HEAD }, user: { login: 'renovate' }, labels: [] };
  const { merger, forgejo } = await reviewMerger([rev(1, 'reviewer', 'APPROVED')], bot, { ['GET ' + API + '/pulls/34']: pr });
  assert.equal(await merger.handle({ repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'renovate/lodash' }, issue: { number: 34 }, bot: true }), 'merged');
  assert.ok(forgejo.wrote().includes('POST /pulls/34/merge'));
  assert.ok(!forgejo.wrote().some((call) => call.startsWith('PATCH /issues')));
});

test('review webhook events are normalized (both header spellings), only when reviews are the verdict', () => {
  for (const name of ['pull_request_review_approved', 'pull_request_approved']) {
    const e = reviewHook(name);
    assert.equal(e.type, 'pull_request.review_approved');
    assert.equal(e.pull_request.number, 34);
    assert.equal(e.issue.number, 26);
    assert.equal(e.review.reviewer, 'forgehands-reviewer');
  }
  assert.equal(reviewHook('pull_request_review_rejected').type, 'pull_request.review_rejected');
  assert.equal(reviewHook('pull_request_rejected').type, 'pull_request.review_rejected');
  assert.equal(reviewHook('pull_request_review_comment'), null);
  assert.equal(normalizeEvent('pull_request_review_approved', reviewPayload('pull_request_review_approved'), new Set([repo]), [], {}), null);
  assert.equal(reviewHook('pull_request_review_approved', { repository: { full_name: 'x/y' } }), null);
  assert.equal(reviewHook('pull_request_review_approved', { pull_request: { number: 34, state: 'open', head: { ref: 'main' } } }), null);
  assert.equal(reviewHook('pull_request_review_approved', { pull_request: { number: 34, state: 'closed', head: { ref: 'ai/issue-26' } } }), null);
  const bot = normalizeEvent('pull_request_review_rejected', { action: 'reviewed', repository: { full_name: repo }, pull_request: { number: 7, state: 'open', title: 't', user: { login: 'renovate' }, head: { ref: 'renovate/x', repo: { full_name: repo } } }, sender: { login: 'r' } },
    new Set([repo]), [], { reviews: true, bots: BOT_RULES });
  assert.equal(bot.bot, true);
  assert.equal(bot.issue.number, 7);
});

test('an approving review (event) merges, even from a sender outside ALLOWED_SENDERS, because the merger reads the reviews', async () => {
  const app = await reviewApp({}, {}, [rev(1, 'reviewer', 'APPROVED')]);
  try {
    assert.equal(await app.post('pull_request_approved', reviewPayload('pull_request_review_approved'), 'r-1'), 'merged');
    assert.ok(app.forgejo.wrote().includes('POST /pulls/34/merge'));
  } finally { await app.close(); }
  const weak = await reviewApp({}, {}, []);
  try {
    assert.equal(await weak.post('pull_request_review_approved', reviewPayload('pull_request_review_approved'), 'r-2'), 'not_approved');
    assert.ok(!weak.forgejo.wrote().includes('POST /pulls/34/merge'));
  } finally { await weak.close(); }
});

test('a rejecting review starts the next round when it stands on the head commit; the same event again, or one nobody may make, does not', async () => {
  const app = await reviewApp({ ALLOWED_SENDERS: 'marcel,forgehands-reviewer' }, {}, [rev(1, 'forgehands-reviewer', 'REQUEST_CHANGES', { body: 'Fix the test in src/a.mjs line 3.' })]);
  try {
    assert.equal(await app.post('pull_request_rejected', reviewPayload('pull_request_review_rejected'), 'r-3'), 'queued');
    assert.equal(app.jobs.list()[0].key, 'owner/hello#26:ai:changes');
    await app.dispatcher.tick();
    const text = starts()[0].body.initial_message.content[0].text;
    assert.match(text, /A review asks for changes \(by forgehands-reviewer\)/);
    assert.doesNotMatch(text, /remove the label/);
    assert.equal(await app.post('pull_request_rejected', reviewPayload('pull_request_review_rejected'), 'r-3'), 'duplicate');
  } finally { await app.close(); }
  const closed = await reviewApp({}, {}, [rev(1, 'forgehands-reviewer', 'REQUEST_CHANGES')]);
  try {
    assert.equal(await closed.post('pull_request_rejected', reviewPayload('pull_request_review_rejected'), 'r-4'), 'ignored');
  } finally { await closed.close(); }
  const stale = await reviewApp({ ALLOWED_SENDERS: 'marcel,forgehands-reviewer' }, {}, [rev(1, 'forgehands-reviewer', 'REQUEST_CHANGES', { stale: true })]);
  try {
    assert.equal(await stale.post('pull_request_rejected', reviewPayload('pull_request_review_rejected'), 'r-5'), 'ignored_review');
    assert.equal(stale.jobs.list().length, 0);
  } finally { await stale.close(); }
});

test('review events are not events at all in comment mode', async () => {
  const config = loadConfig(env(withMerge()));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify(reviewPayload('pull_request_review_approved')));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'pull_request_approved', 'x-forgejo-delivery': 'c-1', 'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') }, body: raw });
    assert.equal((await response.json()).status, 'ignored');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('the reviewer prompt in review mode submits a review pinned to the commit, with the evidence rules, and sets no label', () => {
  const config = loadConfig(env(reviewEnv()));
  const text = buildPrompt({ ...ciEvent('success'), label: 'ci:success' }, config);
  assert.match(text, /submit ONE review of commit abcdef0123456789/);
  assert.match(text, /pulls\/34\/reviews/);
  assert.match(text, /"commit_id": "abcdef0123456789"/);
  assert.match(text, /"APPROVED" or "REQUEST_CHANGES"/);
  assert.match(text, /per acceptance criterion met or not, with file and line/);
  assert.match(text, /Set NO label/);
  assert.doesNotMatch(text, /add the label ai:approved/);
  const bot = buildPrompt({ ...botEvent('success'), label: 'ci:success' }, config);
  assert.match(bot, /submit ONE review of commit abcdef0123456789/);
  assert.match(bot, /changelog or release notes/);
  const both = loadConfig(env(withMerge({ VERDICT_SOURCE: 'both' })));
  assert.match(buildPrompt({ ...ciEvent('success'), label: 'ci:success' }, both), /add the label ai:approved/);
  assert.match(buildPrompt({ ...ciEvent('success'), label: 'ci:success' }, loadConfig(env(withMerge()))), /add the label ai:approved/);
});

test('a reviewer route hands its own Forgejo token to its conversation as FORGEJO_TOKEN, and to no other', async () => {
  const config = loadConfig(env(reviewEnv({ AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL,REVIEWER_TOKEN', MAX_CONCURRENT: '5', MAX_CONCURRENT_PER_TIER: '5' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock);
  jobs.add({ key: 'owner/hello#26:ci:success:abcdef01', label: 'ci:success', status: 'queued', created: ctx.clock, event: { ...ciEvent('success'), label: 'ci:success' } });
  jobs.add({ key: 'owner/hello#27:ai:ready', label: 'ai:ready', status: 'queued', created: ctx.clock, event: event('ai:ready', 27) });
  await dispatcher.tick();
  const [review, worker] = starts().map((call) => call.body.secrets);
  assert.equal(review.FORGEJO_TOKEN.value, 'tok-reviewer-one');
  assert.equal(review.FORGEJO_URL.value, 'https://forge.example');
  assert.ok(!('REVIEWER_TOKEN' in review));
  assert.equal(worker.FORGEJO_TOKEN.value, 'tok-secret-value');
  assert.ok(!JSON.stringify(worker).includes('tok-reviewer'));
});

test('a second reviewer is a second route on ci_success: each starts once per commit, with its own token', async () => {
  const routes = JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
    'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER_TOKEN' },
    'ci:success-2': { profile: RV2, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER2_TOKEN' }
  });
  const config = loadConfig(env(reviewEnv({ LABEL_ROUTES: routes, MAX_CONCURRENT: '5', MAX_CONCURRENT_PER_TIER: '5' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo(goodRoutes({ ...unlabelled, ['GET ' + API + '/pulls/34']: { ...unlabelled['GET ' + API + '/pulls/34'], head: { ref: 'ai/issue-26', sha: 'abcdef0123456789' } }, ['GET ' + API + '/commits/abcdef0123456789/status']: { state: 'success', total_count: 1 } }));
  const api = fakeApi();
  const dispatcher = new Dispatcher(config, jobs, (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request), quiet, () => ctx.clock);
  assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'queued');
  assert.deepEqual(jobs.list().map((job) => job.key).sort(), ['owner/hello#26:ci:success-2:abcdef01', 'owner/hello#26:ci:success:abcdef01']);
  assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'duplicate_job');
  assert.equal(jobs.list().length, 2);
  await dispatcher.tick();
  const bodies = starts().map((call) => call.body);
  assert.deepEqual(bodies.map((body) => body.agent_profile_id).sort(), [REVIEWER, RV2].sort());
  assert.deepEqual(bodies.map((body) => body.secrets.FORGEJO_TOKEN.value).sort(), ['tok-reviewer-one', 'tok-reviewer-two']);
});

test('a review run that ends with a review on the head commit has a verdict; without one it is run once more', async () => {
  const withReview = await buildVerdict({ ...prWith([]), ...reviewsRoute([rev(1, 'reviewer', 'APPROVED', { commit_id: 'abcdef0123456789' })]) }, reviewEnv());
  const job = withReview.jobs.add({ ...reviewJob(), event: { ...ciEvent('success'), label: 'ci:success' } });
  await withReview.dispatcher.checkVerdict(job);
  assert.equal(job.status, 'running');
  const without = await buildVerdict({ ...prWith([]), ...reviewsRoute([]) }, reviewEnv());
  const second = without.jobs.add({ ...reviewJob(), event: { ...ciEvent('success'), label: 'ci:success' } });
  await without.dispatcher.checkVerdict(second);
  assert.equal(second.status, 'queued');
  assert.equal(second.verdict_retry, 1);
});

test('dry run: review mode reads the reviews but merges nothing', async () => {
  const { merger, forgejo } = await reviewMerger([rev(1, 'reviewer', 'APPROVED')], { DRY_RUN: '1' });
  await merger.handle(approvedEvent());
  assert.deepEqual(forgejo.wrote(), []);
  assert.ok(forgejo.calls.some((call) => call.path.endsWith('/pulls/34/reviews')));
});

test("Gitea review events go through the same normalizer and carry the forge as source", () => {
  const e = normalizeGiteaEvent("pull_request_approved", reviewPayload("pull_request_review_approved"), new Set([repo]), [], { reviews: true });
  assert.equal(e.type, "pull_request.review_approved");
  assert.equal(e.source, "gitea");
});
