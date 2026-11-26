// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The summary per tier, closed issues on the status page and the closed-ticket sweep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatus, renderStatus } from '../src/server/status.ts';
import { metrics as tierMetrics } from '../src/metrics.ts';
import { ctx, repo, build, event, API, issue, closedEvent, tierEnv, TIER_DAY, tierJob, closedSetup } from './helpers/direct.ts';

test('the summary counts runs per repository, tier, reason and window, on the tier a run really ran on', async () => {
  const { config, jobs } = await build(tierEnv());
  tierJob(jobs, 1, 'ai:ready', 'failed', { result: 'max_iterations' });
  tierJob(jobs, 2, 'ai:ready', 'failed', { result: 'error' });
  tierJob(jobs, 3, 'ai:ready', 'failed', { result: 'paused' });
  tierJob(jobs, 4, 'ai:ready', 'done', { result: 'finished', merged_at: ctx.clock });
  tierJob(jobs, 5, 'ai:ready', 'done', { result: 'finished' });
  tierJob(jobs, 6, 'ai:ready', 'failed', { result: 'stuck', started: ctx.clock - 10 * TIER_DAY, created: ctx.clock - 10 * TIER_DAY }); // only in the 30 day window
  tierJob(jobs, 7, 'ai:ready', 'done', { result: 'finished', fell_back: 'ai:strong' }); // ran on the strong tier
  tierJob(jobs, 8, 'ai:changes', 'done', { result: 'finished', escalated: true }); // a follow-up round, escalated to the strong tier
  tierJob(jobs, 9, 'ai:ready', 'failed', { result: 'timeout', split_at: ctx.clock });
  const { tiers } = buildStatus(config, jobs, ctx.clock).summary[repo];
  assert.deepEqual(Object.keys(tiers).sort(), ['cheap', 'strong']);
  const week = tiers.cheap.last_7_days;
  assert.equal(week.started, 6);
  assert.equal(week.finished, 2);
  assert.deepEqual(week.failed, { max_iterations: 1, error: 1, stuck: 0, timeout: 1, no_delivery: 0, other: 1 });
  assert.equal(week.split, 1);
  assert.equal(week.worker_runs_finished, 2);
  assert.equal(week.worker_runs_merged, 1);
  assert.equal(week.merged_share, 0.5);
  assert.equal(tiers.cheap.last_30_days.failed.stuck, 1);
  assert.equal(tiers.cheap.last_30_days.started, 7);
  assert.equal(tiers.strong.last_7_days.started, 2);
  assert.equal(tiers.strong.last_7_days.fell_back, 1);
  assert.equal(tiers.strong.last_7_days.escalated, 1);
  assert.equal(tiers.cheap.last_7_days.fell_back, 0);
  assert.equal(buildStatus(config, jobs, ctx.clock).summary[repo].last_7_days.merged, 1, 'the existing fields stay as they were');
});

test('the status page shows the tier table; an empty ledger shows none and breaks nothing', async () => {
  const { config, jobs } = await build(tierEnv());
  const empty = buildStatus(config, jobs, ctx.clock);
  assert.deepEqual(empty.summary[repo].tiers, {});
  assert.doesNotMatch(renderStatus(empty), /Runs per tier/);
  tierJob(jobs, 1, 'ai:ready', 'failed', { result: 'max_iterations' });
  tierJob(jobs, 2, 'ai:ready', 'done', { result: 'finished', merged_at: ctx.clock });
  const html = renderStatus(buildStatus(config, jobs, ctx.clock));
  assert.match(html, /<h2>Runs per tier<\/h2>/);
  assert.match(html, /<td>cheap<\/td><td>last 7 days<\/td><td>2<\/td><td>1<\/td><td>1<\/td>/);
  assert.match(html, /100% \(1\/1\)/);
});

test('forgehands_tier_runs_total counts ended runs per repository, tier and result', async () => {
  tierMetrics.reset();
  const { dispatcher, jobs } = await build(tierEnv());
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  ctx.states[jobs.list()[0].conversation_id] = 'error';
  ctx.clock += 1000;
  await dispatcher.tick();
  const text = tierMetrics.render();
  assert.match(text, /# TYPE forgehands_tier_runs_total counter/);
  assert.match(text, /^forgehands_tier_runs_total\{repository="owner\/hello",result="error",tier="cheap"\} 1$/m);
});

test('a closed event marks the issue; the page and the json show it as closed, never as waiting for a human or failed', async () => {
  const { config, jobs, dispatcher, add } = await closedSetup();
  add(1, 'ai:ready', 'failed', { result: 'error' });
  add(2, 'ai:ready', 'failed', { result: 'error' });
  const waitingEntry = (issue) => ({ repository: repo, issue, pr: 30 + issue, since: ctx.clock, reason: 'approved' });
  const before = buildStatus(config, jobs, ctx.clock, undefined, [waitingEntry(1), waitingEntry(2)]);
  assert.equal(before.waiting_for_human.length, 2);
  await dispatcher.onClosed(closedEvent(1));
  assert.equal(jobs.list().find((job) => job.key.startsWith('owner/hello#1:')).archived_view, true);
  const status = buildStatus(config, jobs, ctx.clock, undefined, [waitingEntry(1), waitingEntry(2)]);
  const one = status.issues.find((entry) => entry.issue === 'owner/hello#1');
  assert.equal(one.closed, true);
  assert.equal(one.state, 'closed');
  assert.equal(status.issues.find((entry) => entry.issue === 'owner/hello#2').closed, undefined);
  assert.deepEqual(status.waiting_for_human.map((entry) => entry.issue), [2]);
  const html = renderStatus(status);
  assert.match(html, /<details><summary>Closed \(1\)<\/summary>/);
  assert.match(html.split('<details>')[1], /owner\/hello#1/);
  assert.doesNotMatch(html.split('<details>')[0], /owner\/hello#1<\/td>/);
  assert.deepEqual(status.summary[repo].last_7_days, before.summary[repo].last_7_days, 'the counts for work do not change');
});

test('a running job keeps its issue open on the page when the issue is closed', async () => {
  const { config, jobs, dispatcher, add } = await closedSetup();
  add(1, 'ai:ready', 'running', { conversation_id: 'c1' });
  await dispatcher.onClosed(closedEvent(1));
  assert.equal(buildStatus(config, jobs, ctx.clock).issues[0].closed, undefined);
});

test('the sweep marks tickets the forge reports closed, leaves open ones, and a forge error changes nothing', async () => {
  const { jobs, dispatcher, add } = await closedSetup({
    ['GET ' + API + '/issues/1']: issue(1, 'closed'),
    ['GET ' + API + '/issues/2']: issue(2, 'open'),
    ['GET ' + API + '/issues/3']: { __status: 404 }, // the read fails
  });
  add(1, 'ai:ready', 'failed', { result: 'error' });
  add(2, 'ai:ready', 'failed', { result: 'max_iterations' });
  add(3, 'ai:ready', 'failed', { result: 'error' });
  add(4, 'ai:ready', 'done', { result: 'finished' }); // fine, not looked at
  assert.equal(await dispatcher.sweepClosed(ctx.clock), true);
  const marked = (number) => jobs.list().find((job) => job.key.startsWith('owner/hello#' + number + ':')).archived_view;
  assert.deepEqual([1, 2, 3, 4].map(marked), [true, undefined, undefined, undefined]);
  assert.equal(await dispatcher.sweepClosed(ctx.clock + 1000), false, 'once a day');
});

test('the sweep reads at most 20 issues per pass and the next pass goes on', async () => {
  const routes = {};
  for (let n = 1; n <= 25; n++) routes['GET ' + API + '/issues/' + n] = issue(n, 'closed');
  const { jobs, dispatcher, add } = await closedSetup(routes);
  for (let n = 1; n <= 25; n++) add(n, 'ai:ready', 'failed', { result: 'error' });
  await dispatcher.sweepClosed(ctx.clock);
  assert.equal(jobs.list().filter((job) => job.archived_view).length, 20);
  await dispatcher.sweepClosed(ctx.clock + 3600000);
  assert.equal(jobs.list().filter((job) => job.archived_view).length, 25);
});

test('the sweep runs with the pass at start and does nothing without forge access', async () => {
  const { jobs, dispatcher, add } = await closedSetup({ ['GET ' + API + '/issues/1']: issue(1, 'closed') });
  add(1, 'ai:ready', 'failed', { result: 'error' });
  await dispatcher.tick();
  assert.equal(jobs.list()[0].archived_view, true);
  const offline = await closedSetup();
  offline.dispatcher.config = { ...offline.config, forgejo: null };
  offline.add(1, 'ai:ready', 'failed', { result: 'error' });
  assert.equal(await offline.dispatcher.sweepClosed(ctx.clock), false);
});
