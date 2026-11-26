// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Rate limits, used-up quotas and model outages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatus } from '../src/server/status.ts';
import { ctx, event, starts, ciEvent, issue, reviewJob, rateLimitError, buildQuota, verdict, pull } from './helpers/direct.ts';

test('a run that ends with a rate limit is queued again after the reset, the tier waits, nobody is called', async () => {
  const { dispatcher, jobs, forgejo } = await buildQuota([rateLimitError(7200)]);
  const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined });
  await dispatcher.tick();
  assert.equal(job.status, 'running');
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.status, 'queued');
  assert.equal(job.rate_limited, 1);
  assert.equal(job.next_try, ctx.clock + 7200 * 1000);
  assert.equal(job.conversation_id, undefined);
  assert.deepEqual(forgejo.wrote(), []);                  // no "ended without a verdict", no label, no mention
  assert.match(buildStatus(dispatcher.config, jobs, ctx.clock).issues[0].state, /^model quota used up, review tries again after \d\d:\d\d UTC$/);
  await dispatcher.tick();
  assert.equal(starts().length, 1);                       // still waiting
  // another job of the same tier does not start either while the quota is out
  jobs.add({ key: 'owner/hello#27:ci:success:11111111', label: 'ci:success', status: 'queued', created: ctx.clock, event: { ...ciEvent('success'), issue: { number: 27, title: 't', body: '', labels: [] } } });
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  ctx.clock += 7200 * 1000 + 1;
  await dispatcher.tick();
  assert.equal(starts().length, 3);                       // both start once the reset has passed
});

test('another failure, an unreadable error and too many retries end the run as before', async () => {
  for (const events of [[{ kind: 'ConversationErrorEvent', code: 'SomethingElse', classification: { kind: 'other' }, detail: 'boom' }], [], null]) {
    const { dispatcher, jobs, forgejo } = await buildQuota(events);
    const job = jobs.add({ ...reviewJob(), verdict_retry: 1, status: 'queued', conversation_id: undefined, started: undefined });
    await dispatcher.tick();
    ctx.states[job.conversation_id] = 'error';
    await dispatcher.tick();
    assert.equal(job.status, 'failed');
    assert.equal(job.result, 'error');
    assert.deepEqual(forgejo.wrote(), ['POST /issues/34/comments', 'POST /issues/34/labels']); // the pull request is marked as before
  }
  // the quota has been out for QUOTA_GIVE_UP_HOURS (24 by default): give up; a little less: wait once more, however often it waited
  for (const [hours, status] of [[25, 'failed'], [23, 'queued']]) {
    const { dispatcher, jobs } = await buildQuota([rateLimitError(60)]);
    const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: 40, rate_limited_since: ctx.clock - hours * 3600000, verdict_retry: 1 });
    await dispatcher.tick();
    ctx.states[job.conversation_id] = 'error';
    await dispatcher.tick();
    assert.equal(job.status, status, hours + 'h');
  }
});

test('a reset time given only in words is understood; a few seconds next to no credits is not a reset time', async () => {
  for (const [detail, expected] of [
    ['RateLimitError: [opencode-go/deepseek] usage limit (reset after 4h 12m 5s)', 4 * 3600 + 12 * 60 + 5],
    ['RateLimitError: rate limit (reset after 45m)', 45 * 60],
    ['RateLimitError: Monthly usage limit reached. Resets in 2 days', 8 * 3600],
    ['RateLimitError: You have no credits remaining. (reset after 3s) (HTTP 429)', 900]
  ]) {
    const { dispatcher, jobs } = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMRateLimitError', classification: { kind: 'rate_limit' }, detail }], 'words.json');
    for (const old of jobs.list()) jobs.remove(old.id);
    const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined });
    await dispatcher.tick();
    ctx.states[job.conversation_id] = 'error';
    await dispatcher.tick();
    assert.equal(job.next_try - ctx.clock, expected * 1000, detail);
  }
});

test('no model available (503, bad gateway, timeout) is treated like a used-up quota: the tier waits and the job tries again', async () => {
  for (const code of ['LLMServiceUnavailableError', 'BadGatewayError', 'LLMTimeoutError']) {
    const { dispatcher, jobs, forgejo } = await buildQuota([{ kind: 'ConversationErrorEvent', code, detail: 'dva/claude-fable-5-1-high: provider — [503]: not configured; openai/gpt-6-astra: no credits remaining' }], 'unavail-' + code + '.json');
    const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, verdict_retry: 1 });
    await dispatcher.tick();
    ctx.states[job.conversation_id] = 'error';
    await dispatcher.tick();
    assert.equal(job.status, 'queued', code);
    assert.equal(job.next_try - ctx.clock, 60 * 1000, code + ': the first wait is a minute');
    assert.equal(job.rate_limited, 1, code);
    assert.equal(job.error_retry, undefined, code + ': not an ordinary error retry');
    assert.deepEqual(forgejo.wrote(), [], code + ': nobody is called');
    assert.ok(dispatcher.cooldowns.get('strong') > ctx.clock, code + ': the tier waits');
  }
  // the pause grows: 1, 2, 4, 8, 16 and then 30 minutes
  for (const [waited, minutes] of [[1, 2], [3, 8], [5, 30], [20, 30]]) {
    const t = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMServiceUnavailableError', detail: '503' }], 'unavail-grow-' + waited + '.json');
    const grown = t.jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: waited, rate_limited_since: ctx.clock, verdict_retry: 1 });
    await t.dispatcher.tick();
    ctx.states[grown.conversation_id] = 'error';
    await t.dispatcher.tick();
    assert.equal(grown.next_try - ctx.clock, minutes * 60000, waited + ' waits so far');
  }
  // a rate limit without a time keeps its 15 minutes
  const limited = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMRateLimitError', classification: { kind: 'rate_limit' }, detail: 'no number' }], 'unavail-limit.json');
  const quota = limited.jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: 3, rate_limited_since: ctx.clock, verdict_retry: 1 });
  await limited.dispatcher.tick();
  ctx.states[quota.conversation_id] = 'error';
  await limited.dispatcher.tick();
  assert.equal(quota.next_try - ctx.clock, 900 * 1000);
  // gives up like a quota that stays out: after QUOTA_GIVE_UP_HOURS
  const { dispatcher, jobs } = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMServiceUnavailableError', detail: '503' }], 'unavail-giveup.json');
  const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: 90, rate_limited_since: ctx.clock - 25 * 3600000, verdict_retry: 1 });
  await dispatcher.tick();
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.status, 'failed');
  // an error that is not about availability (a bad request) is still an ordinary error
  const other = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMBadRequestError', detail: '400' }], 'unavail-other.json');
  other.dispatcher.config = { ...other.config, errorRetries: 1 };
  const retried = other.jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, verdict_retry: 1 });
  await other.dispatcher.tick();
  ctx.states[retried.conversation_id] = 'error';
  await other.dispatcher.tick();
  assert.equal(retried.error_retry, 1);
  assert.equal(retried.rate_limited, undefined);
});

test('a run that reached its iteration limit is not run again: it ends as max_iterations', async () => {
  const limit = { kind: 'ConversationErrorEvent', code: 'MaxIterationsReached', detail: 'Agent reached maximum iterations limit (150).' };
  const { dispatcher, jobs, config } = await buildQuota([limit]);
  dispatcher.config = { ...config, errorRetries: 1 };
  const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, verdict_retry: 1 });
  await dispatcher.tick();
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'max_iterations');
  assert.equal(job.error_retry, undefined, 'no error retry');
  const other = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMBadRequestError', detail: '400' }], 'other.json');
  other.dispatcher.config = { ...other.config, errorRetries: 1 };
  const retried = other.jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, verdict_retry: 1 });
  await other.dispatcher.tick();
  ctx.states[retried.conversation_id] = 'error';
  await other.dispatcher.tick();
  assert.equal(retried.error_retry, 1, 'another error is retried as before');
});

test('the wait is taken from the gateway, kept within sane bounds and has a default', async () => {
  for (const [seconds, expected] of [[7200, 7200], [5, 60], [18000, 18000], [999999, 8 * 3600]]) {
    const { dispatcher, jobs } = await buildQuota([rateLimitError(seconds)]);
    const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined });
    await dispatcher.tick();
    ctx.states[job.conversation_id] = 'error';
    await dispatcher.tick();
    assert.equal(job.next_try - ctx.clock, expected * 1000, String(seconds));
  }
  const { dispatcher, jobs } = await buildQuota([{ kind: 'ConversationErrorEvent', code: 'LLMRateLimitError', detail: 'no number in here' }]);
  const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined });
  await dispatcher.tick();
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.next_try - ctx.clock, 900 * 1000);
});

// ---- a restart clears what was held back for the model quota
test('a restart releases jobs that waited for the model quota, and only those', async () => {
  const { dispatcher, jobs } = await buildQuota([]);
  const held = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: 2, retry_at: ctx.clock + 7200000, next_try: ctx.clock + 7200000 });
  const failedStart = jobs.add({ key: 'owner/hello#27:ci:success:22222222', label: 'ci:success', status: 'queued', attempts: 1, next_try: ctx.clock + 120000, created: ctx.clock, event: { ...ciEvent('success'), issue: { number: 27, title: 't', body: '', labels: [] } } });
  const waiting = jobs.add({ key: 'owner/hello#28:ai:ready', label: 'ai:ready', status: 'waiting', waiting_for: [1], created: ctx.clock, event: event('ai:ready', 28) });
  assert.equal(dispatcher.clearQuotaHolds(), 1);
  assert.equal(held.next_try, undefined);
  assert.equal(held.retry_at, undefined);
  assert.equal(held.rate_limited, 2);                       // the counter stays: a model that is still out of quota cannot loop for ever
  assert.ok(failedStart.next_try > ctx.clock);                  // a wait for another reason is kept
  assert.equal(waiting.status, 'waiting');
  await dispatcher.start(60000);
  dispatcher.stop();
  assert.equal(held.status, 'running');
  assert.equal(failedStart.status, 'queued');               // its own wait still holds
});

test('after a restart a model that is still out of quota sets the hold again, within the retry cap', async () => {
  const { dispatcher, jobs } = await buildQuota([rateLimitError(600)]);
  const job = jobs.add({ ...reviewJob(), status: 'queued', conversation_id: undefined, started: undefined, rate_limited: 1, retry_at: ctx.clock + 7200000, next_try: ctx.clock + 7200000 });
  await dispatcher.start(60000);
  dispatcher.stop();
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.status, 'queued');
  assert.equal(job.rate_limited, 2);
  assert.equal(job.next_try, ctx.clock + 600 * 1000);
});
