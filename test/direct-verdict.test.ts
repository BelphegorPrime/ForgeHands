// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Review runs and their verdict, and when the human is mentioned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { ctx, repo, env, event, prEvent, withCi, ciEvent, withMerge, API, goodRoutes, mergerFor, approvedEvent, withEpic, issue, buildVerdict, reviewJob, prWith, commentsOf, verdict, pull } from './helpers/direct.ts';

test('every kind of run on a pull request clones into a directory of its own, and a leftover one is no obstacle', () => {
  const config = loadConfig(env(withCi()));
  const dirOf = (e) => buildPrompt(e, config).match(/at (\/projects\/\S+)/)[1];
  const review = dirOf(ciEvent('success'));
  const fix = dirOf(ciEvent('failure'));
  const worker = dirOf(event('ai:ready', 26));
  const roundA = dirOf({ ...prEvent(), delivery_id: 'aaaa1111-x' });
  const roundB = dirOf({ ...prEvent(), delivery_id: 'bbbb2222-y' });
  assert.equal(review, '/projects/owner-hello-issue-26-review-abcdef01');
  assert.equal(fix, '/projects/owner-hello-issue-26-fix-abcdef01');
  assert.equal(worker, '/projects/owner-hello-issue-26');
  assert.notEqual(roundA, roundB);
  assert.equal(new Set([review, fix, worker, roundA]).size, 4);
  for (const e of [ciEvent('success'), ciEvent('failure'), prEvent(), event('ai:ready', 26)]) assert.match(buildPrompt(e, config), /If that directory exists from an earlier run, delete it and clone again/);
});

test('a review run that ends without a verdict is run once more, then marked for a human', async () => {
  const { dispatcher, jobs, forgejo } = await buildVerdict(prWith([]));
  const job = jobs.add(reviewJob());
  await dispatcher.checkVerdict(job);
  assert.equal(job.status, 'queued');
  assert.equal(job.verdict_retry, 1);
  assert.equal(job.conversation_id, undefined);
  assert.deepEqual(forgejo.wrote(), []);
  await dispatcher.checkVerdict(job);
  assert.deepEqual(forgejo.wrote(), ['POST /issues/34/comments', 'POST /issues/34/labels']);
  assert.match(forgejo.calls.find((call) => call.path.endsWith('/comments')).body.body, /review of commit abcdef01 ended twice without a verdict/);
});

test('a review with a verdict, a moved pull request or another kind of run is left alone', async () => {
  for (const routes of [prWith(['ai:approved']), prWith(['ai:changes']), prWith(['ai:blocked']), prWith([], { merged: true }), prWith([], { state: 'closed' }), prWith([], { head: { sha: 'ffffffff00000000' } })]) {
    const { dispatcher, jobs, forgejo } = await buildVerdict(routes);
    jobs.add(reviewJob());
    ctx.states['conv-r'] = 'finished';
    await dispatcher.tick();
    assert.deepEqual(forgejo.wrote(), []);
  }
  const { dispatcher, jobs, forgejo } = await buildVerdict(prWith([]));
  jobs.add({ ...reviewJob(), key: 'owner/hello#26:ai:ready', label: 'ai:ready', event: event('ai:ready', 26) });
  ctx.states['conv-r'] = 'finished';
  await dispatcher.tick();
  assert.deepEqual(forgejo.wrote(), []);
});

test('a failing Forgejo call while checking the verdict is only logged', async () => {
  const { dispatcher, jobs } = await buildVerdict({});
  const job = jobs.add(reviewJob());
  ctx.states['conv-r'] = 'finished';
  await dispatcher.tick();
  assert.equal(job.status, 'done');
});

test('HUMAN_LOGIN is validated, an @ is allowed, empty means no mention', () => {
  assert.equal(loadConfig(env(withMerge({ HUMAN_LOGIN: ' @marcel ' }))).humanLogin, 'marcel');
  assert.equal(loadConfig(env(withMerge())).humanLogin, null);
  assert.equal(loadConfig(env(withMerge({ HUMAN_LOGIN: '' }))).humanLogin, null);
  assert.throws(() => loadConfig(env(withMerge({ HUMAN_LOGIN: 'bad login; drop' }))), /HUMAN_LOGIN must be a Forgejo login/);
});

test('a hand-over to a human mentions him: protected path, conflict, failed merge', async () => {
  const protectedPr = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }] }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await protectedPr.merger.handle(approvedEvent()), 'protected_paths');
  assert.match(commentsOf(protectedPr.forgejo)[0], /^@marcel ForgeHands: approved and green, but not merged automatically/);
  const conflict = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: false, title: 'Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] } }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await conflict.merger.handle(approvedEvent()), 'not_mergeable');
  assert.match(commentsOf(conflict.forgejo)[0], /^@marcel ForgeHands: .*does not merge cleanly/);
  const failed = await mergerFor(goodRoutes({ ['POST ' + API + '/pulls/34/merge']: undefined }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await failed.merger.handle(approvedEvent()), 'merge_failed');
  assert.match(commentsOf(failed.forgejo)[0], /^@marcel ForgeHands: approved and green, but the merge failed/);
});

test('a successful merge and a pull request that is not ready never mention him', async () => {
  const merged = await mergerFor(goodRoutes(), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await merged.merger.handle(approvedEvent()), 'merged');
  assert.deepEqual(commentsOf(merged.forgejo).filter((text) => text.includes('@marcel')), []);
  const red = await mergerFor(goodRoutes({ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'failure', total_count: 1 } }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await red.merger.handle(approvedEvent()), 'ci_not_green');
  assert.deepEqual(commentsOf(red.forgejo), []);
});

test('rounds used up and a review without verdict mention him; an epic with gaps does not (ForgeHands calls him, see epic-gaps.test.ts); without HUMAN_LOGIN nobody is mentioned', async () => {
  const blocked = await buildVerdict(prWith([]), { HUMAN_LOGIN: 'marcel' });
  blocked.jobs.add({ ...reviewJob(), verdict_retry: 1 });
  ctx.states['conv-r'] = 'finished';
  await blocked.dispatcher.tick();
  assert.match(commentsOf(blocked.forgejo)[0], /^@marcel ForgeHands: the review of commit abcdef01 ended twice without a verdict/);
  const plain = await buildVerdict(prWith([]));
  plain.jobs.add({ ...reviewJob(), verdict_retry: 1 });
  ctx.states['conv-r'] = 'finished';
  await plain.dispatcher.tick();
  assert.match(commentsOf(plain.forgejo)[0], /^ForgeHands: the review of commit abcdef01 ended twice/);
  const epic = { type: 'epic.done', repository: { full_name: repo }, issue: { number: 10, title: 'Epic', body: 'B', labels: [] }, epic: { children: [] }, sender: { login: 'marcel' } };
  // The reviewer of an epic mentions nobody: a gap goes back to the planner first, and ForgeHands calls the human when it is still open then.
  assert.doesNotMatch(buildPrompt(epic, loadConfig(env(withEpic({ HUMAN_LOGIN: 'marcel' })))), /@marcel/);
  assert.match(buildPrompt(epic, loadConfig(env(withEpic({ HUMAN_LOGIN: 'marcel' })))), /Do not mention anybody/);
  assert.doesNotMatch(buildPrompt(epic, loadConfig(env(withEpic()))), /@marcel|mention him/);
});
