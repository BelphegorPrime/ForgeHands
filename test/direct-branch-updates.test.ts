// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// A push to the default branch: closing merged tickets, branch updates and conflict rounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { ctx, WORKER, repo, quiet, env, event, starts, webhook, CHANGES, prEvent, API, fakeForgejo, issue, commentsOf, withBranches, TIP, OLD_BASE, pull, noReview, okReview, buildBranches, pushPayload, movedEvent, updates, afterDelay, filesRoutes, ticket } from './helpers/direct.ts';

test('after a push to the default branch the tickets of merged agent pull requests are closed, once, and only those', async () => {
  const config = loadConfig(env(withBranches({})));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo({
    ['GET ' + API + '/pulls']: [
      { number: 71, merged: true, head: { ref: 'ai/issue-53' }, base: { ref: 'main' } },
      { number: 72, merged: true, head: { ref: 'ai/issue-54' }, base: { ref: 'main' } },
      { number: 73, merged: false, head: { ref: 'ai/issue-55' }, base: { ref: 'main' } },
      { number: 74, merged: true, head: { ref: 'feature/x' }, base: { ref: 'main' } },
      { number: 75, merged: true, head: { ref: 'ai/issue-56' }, base: { ref: 'release' } }
    ],
    ['GET ' + API + '/issues/53']: { number: 53, state: 'open' },
    ['GET ' + API + '/issues/54']: { number: 54, state: 'closed' },
    ['POST ' + API + '/issues/53/comments']: {}, ['PATCH ' + API + '/issues/53']: {}
  });
  const dispatcher = new Dispatcher(config, jobs, forgejo.send, quiet, () => ctx.clock);
  assert.equal(await dispatcher.closeMergedTickets(movedEvent()), 1);
  assert.deepEqual(forgejo.wrote(), ['PATCH /issues/53', 'POST /issues/53/comments'], 'only the open ticket of a merged agent pull request into the default branch (closed first, then told)');
  const offline = new Dispatcher(config, jobs, forgejo.send, quiet, () => ctx.clock);
  offline.config = { ...config, forgejo: null };
  assert.equal(await offline.closeMergedTickets(movedEvent()), 0, 'without Forgejo access nothing happens');
});

test('a push to the default branch is an event; other branches, deletions, other repositories and a disabled feature are not', () => {
  const moved = movedEvent();
  assert.equal(moved.type, 'push.default');
  assert.equal(moved.after, TIP);
  assert.equal(moved.repository.default_branch, 'main');
  const norm = (payload, options = { pushes: true }) => normalizeEvent('push', payload, new Set([repo]), [], options);
  assert.equal(norm(pushPayload({ ref: 'refs/heads/ai/issue-3' })), null);
  assert.equal(norm(pushPayload({ after: '0'.repeat(40) })), null);
  assert.equal(norm(pushPayload({ after: 'nonsense' })), null);
  assert.equal(norm(pushPayload({ repository: { full_name: 'other/repo', default_branch: 'main' } })), null);
  assert.equal(norm(pushPayload(), { pushes: false }), null);
  assert.equal(loadConfig(env(withBranches())).updateBranches, true);
  assert.equal(loadConfig(env(withBranches({ UPDATE_BRANCHES: '0' }))).updateBranches, false);
  assert.equal(loadConfig(env(withBranches())).branchUpdateDelayMs, 60000);
  assert.throws(() => loadConfig(env(withBranches({ BRANCH_UPDATE_DELAY_SECONDS: '0' }))), /BRANCH_UPDATE_DELAY_SECONDS/);
  assert.equal(loadConfig(env(withBranches())).routes.get('pr:conflict').kind, 'conflict');
});

test('nothing is looked at before the default branch has been quiet; a newer push starts the wait again and brings the newest tip', async () => {
  const newer = 'c'.repeat(40);
  const { dispatcher, forgejo } = await buildBranches([pull(34, { merge_base: TIP })]);
  assert.equal(dispatcher.onMainMoved(movedEvent()), 'scheduled');
  ctx.clock += 30000;
  await dispatcher.tick();
  assert.deepEqual(forgejo.calls, []);
  dispatcher.onMainMoved(movedEvent(newer));
  ctx.clock += 40000;                                           // 70 s after the first push, 40 s after the second
  await dispatcher.tick();
  assert.deepEqual(forgejo.calls, []);
  ctx.clock += 25000;
  await dispatcher.tick();
  assert.equal(forgejo.calls.filter((call) => call.path === API + '/pulls').length, 1);
  assert.equal(updates(forgejo).length, 1);                // the pull request is based on TIP, the newest tip is `newer`: it is behind
});

test('a pull request that is behind, unapproved and unreviewed is brought up to date by Forgejo, nothing else is touched', async () => {
  const pulls = [
    pull(34),                                                                       // behind, nothing yet: updated
    pull(35, { merge_base: TIP }),                                                  // not behind
    pull(36, { labels: [{ name: 'ai:approved' }] }),                                // approved: merges as it is
    pull(37, { labels: [{ name: 'ai:blocked' }] }),                                 // waits for a human
    pull(38),                                                                       // has an OK review for its commit
    pull(39, { head: { ref: 'feature/x', sha: 'cafe390000', repo: { full_name: 'owner/hello' } } }),   // not an agent branch
    pull(40, { head: { ref: 'ai/issue-32', sha: 'cafe400000', repo: { full_name: 'someone/fork' } } })   // from a fork
  ];
  const routes = { ...noReview(34), ...noReview(35), ...noReview(36), ...okReview(38), ['POST ' + API + '/pulls/34/update']: {} };
  const { dispatcher, forgejo } = await buildBranches(pulls, routes);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['34']);
  assert.equal(forgejo.calls.find((call) => call.path.endsWith('/update')).search, '?style=rebase');
  assert.deepEqual(forgejo.wrote(), ['POST /pulls/34/update']);
});

test('a pull request with a NOT OK review is still brought up to date, one an agent works on is left alone', async () => {
  const notOk = '## Verdict: NOT OK\n' + 'evidence at src/a.mjs line 3. '.repeat(15);
  const routes = { ['GET ' + API + '/git/commits/cafe420000']: { created: '2026-11-15T10:00:00Z' },
    ['GET ' + API + '/issues/42/comments']: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: notOk }],
    ...noReview(34), ['POST ' + API + '/pulls/42/update']: {}, ['POST ' + API + '/pulls/34/update']: {} };
  const { dispatcher, jobs, forgejo } = await buildBranches([pull(42), pull(34)], routes);
  jobs.add({ key: 'owner/hello#26:ai:ready', label: 'ai:ready', status: 'running', started: ctx.clock, created: ctx.clock, conversation_id: 'c26', event: event('ai:ready', 26) });
  // pull(34) belongs to issue 26: its worker is running
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['42']);
});

test('a pull request whose files the default branch did not touch is left alone: no new commit, no cancelled CI', async () => {
  const routes = { ...noReview(34), ...filesRoutes(34, ['src/a.ts'], ['docs/b.md']), ['POST ' + API + '/pulls/34/update']: {} };
  const { dispatcher, forgejo } = await buildBranches([pull(34)], routes);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), []);
  // the same file (or a rename of it) on both sides: updated
  for (const mine of [['src/a.ts'], ['x/new.ts']]) {
    const main = mine[0] === 'x/new.ts' ? [{ filename: 'y.ts', previous_filename: 'x/new.ts' }] : [{ filename: 'src/a.ts' }];
    const overlap = await buildBranches([pull(34)], { ...noReview(34), ...filesRoutes(34, mine, []), ['GET ' + API + '/compare/' + OLD_BASE + '...' + TIP]: { total_commits: 1, files: main }, ['POST ' + API + '/pulls/34/update']: {} });
    overlap.dispatcher.onMainMoved(movedEvent());
    await afterDelay(overlap.dispatcher);
    assert.deepEqual(updates(overlap.forgejo), ['34'], mine[0]);
  }
});

test('when the files cannot be compared reliably the pull request is updated as before', async () => {
  for (const routes of [filesRoutes(34, ['src/a.ts'], [], 3), { ...filesRoutes(34, ['src/a.ts'], ['docs/b.md']), ['GET ' + API + '/pulls/34/files']: Array.from({ length: 100 }, (_, i) => ({ filename: 'f' + i })) }, {}]) {
    const { dispatcher, forgejo } = await buildBranches([pull(34)], { ...noReview(34), ...routes, ['POST ' + API + '/pulls/34/update']: {} });
    dispatcher.onMainMoved(movedEvent());
    await afterDelay(dispatcher);
    assert.deepEqual(updates(forgejo), ['34']);
  }
});

test('while CI runs on the head commit the update is postponed and tried again later', async () => {
  let state = 'pending';
  const routes = { ...noReview(34), ...filesRoutes(34, ['a'], ['a']), ['GET ' + API + '/commits/cafe340000/status']: () => ({ state, total_count: 1 }), ['POST ' + API + '/pulls/34/update']: {} };
  const { dispatcher, forgejo } = await buildBranches([pull(34)], routes);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), []);
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), []);                  // still running: looked at again, still postponed
  state = 'success';                                       // CI is done
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['34']);
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['34']);              // nothing left to look at
});

test('a pull request is updated at most once per BRANCH_UPDATE_MIN_INTERVAL_MINUTES, however often main moves', async () => {
  const routes = { ...noReview(34), ...filesRoutes(34, ['a'], ['a']), ['POST ' + API + '/pulls/34/update']: {} };
  const { dispatcher, forgejo, config } = await buildBranches([pull(34)], routes);
  assert.equal(config.branchUpdateMinIntervalMs, 30 * 60000);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['34']);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.deepEqual(updates(forgejo), ['34']);              // too soon
  ctx.clock += 30 * 60000;
  await dispatcher.tick();                                  // the postponed look happens by itself
  assert.deepEqual(updates(forgejo), ['34', '34']);
  assert.throws(() => loadConfig(env(withBranches({ BRANCH_UPDATE_MIN_INTERVAL_MINUTES: '0' }))), /BRANCH_UPDATE_MIN_INTERVAL_MINUTES/);
});

test('when a run on a pull request ends, a conflict with the default branch that arrived meanwhile becomes a conflict round', async () => {
  const { dispatcher, jobs, forgejo } = await buildBranches([], {
    ['GET ' + API + '/branches/main']: { commit: { id: TIP } },
    ['GET ' + API + '/pulls/34']: pull(34),
    ['GET ' + API + '/compare/' + OLD_BASE + '...' + TIP]: { total_commits: 1, files: [{ filename: 'a.txt' }] },
    ['GET ' + API + '/pulls/34/files']: [{ filename: 'a.txt' }],
    ['GET ' + API + '/commits/cafe340000/status']: { state: 'success', total_count: 1 },
    ['POST ' + API + '/pulls/34/update']: { __status: 409 },
    ...noReview(34)
  });
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  await dispatcher.tick();
  assert.deepEqual(updates(forgejo), [], 'while the run is active the pull request is left alone');
  ctx.states[jobs.list().at(-1).conversation_id] = 'finished';
  await dispatcher.tick();
  assert.deepEqual(updates(forgejo), ['34'], 'the run ended: the rebase was tried once');
  assert.ok(jobs.list().some((job) => job.label === 'pr:conflict'), 'and it conflicted, so a conflict round was queued');
  // a conflict round itself does not trigger another look
  const rounds = jobs.list().filter((job) => job.label === 'pr:conflict').length;
  const conflictJob = jobs.list().find((job) => job.label === 'pr:conflict');
  ctx.states[conflictJob.conversation_id || 'none'] = 'finished';
  await dispatcher.tick();
  assert.equal(jobs.list().filter((job) => job.label === 'pr:conflict').length, rounds);
});

test('an approved pull request that conflicts gets a conflict round; without a conflict, or still titled WIP, it is left alone', async () => {
  for (const [over, expected] of [
    [{ title: 'Fix 34', mergeable: false }, 1],
    [{ title: 'Fix 34', mergeable: true }, 0],
    [{ title: 'WIP: Fix 34', mergeable: false }, 0]
  ]) {
    const { dispatcher, jobs } = await buildBranches([pull(34, { labels: [{ name: 'ai:approved' }], ...over })], {}, {});
    for (const job of jobs.list()) jobs.remove(job.id); // (the ledger file is shared by the cases)
    dispatcher.onMainMoved(movedEvent());
    await afterDelay(dispatcher);
    assert.equal(jobs.list().filter((job) => job.label === 'pr:conflict').length, expected, JSON.stringify(over));
  }
});

test('a rebase that conflicts becomes a conflict round of the worker, once per moved default branch', async () => {
  const routes = { ...noReview(34), ['POST ' + API + '/pulls/34/update']: { __status: 409 }, ['GET ' + API + '/issues/34/labels']: [] };
  const { dispatcher, jobs, forgejo } = await buildBranches([pull(34)], routes);
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  const job = jobs.list().find((entry) => entry.label === 'pr:conflict');
  assert.equal(job.key, 'owner/hello#26:pr:conflict:aaaaaaaa');
  assert.equal(job.event.type, 'pull_request.conflict');
  await dispatcher.tick();
  const { body } = starts().at(-1);
  assert.equal(body.agent_profile_id, CHANGES);
  assert.equal(body.max_iterations, 90);
  assert.deepEqual(body.tags, { source: 'forgehands', issue: '26', pr: '34', conflict: 'default-branch' });
  const text = body.initial_message.content[0].text;
  assert.match(text, /Its branch conflicts with main \(which moved to aaaaaaaa\)/);
  assert.match(text, /git rebase origin\/main/);
  assert.match(text, /the one kind of run in which a rebase and a force push are allowed/);
  assert.match(text, /--force-with-lease origin ai\/issue-26/);
  assert.match(text, /never a plain `--force`/);
  assert.match(text, /-issue-26-conflict-aaaaaaaa/);
  // the same tip again: no second round; the status page names it
  jobs.list().forEach((entry) => { if (entry.label === 'pr:conflict') { entry.status = 'done'; entry.finished = ctx.clock; } });
  dispatcher.onMainMoved(movedEvent());
  await afterDelay(dispatcher);
  assert.equal(jobs.list().filter((entry) => entry.label === 'pr:conflict').length, 1);
  assert.deepEqual(forgejo.wrote().filter((entry) => entry.includes('/labels')), []);
});

test('a failing update that is not a conflict starts nothing; without a conflict route or with the rounds used up a human is called', async () => {
  const failing = await buildBranches([pull(34)], { ...noReview(34), ['POST ' + API + '/pulls/34/update']: { __status: 500 } });
  failing.dispatcher.onMainMoved(movedEvent());
  await afterDelay(failing.dispatcher);
  assert.equal(failing.jobs.list().length, 0);
  assert.deepEqual(failing.forgejo.wrote(), ['POST /pulls/34/update']);          // the attempt only: no comment, no label, no round
  const human = { ['GET ' + API + '/labels']: [{ id: 9, name: 'ai:blocked' }], ['POST ' + API + '/issues/34/labels']: {}, ['POST ' + API + '/issues/34/comments']: {} };
  const noRoute = await buildBranches([pull(34)], { ...noReview(34), ['POST ' + API + '/pulls/34/update']: { __status: 409 }, ...human },
    { LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }), HUMAN_LOGIN: 'marcel' });
  noRoute.dispatcher.onMainMoved(movedEvent());
  await afterDelay(noRoute.dispatcher);
  assert.equal(noRoute.jobs.list().length, 0);
  assert.match(commentsOf(noRoute.forgejo)[0], /^@marcel ForgeHands: the pull request conflicts with main and no conflict round is configured/);
  const used = await buildBranches([pull(34)], { ...noReview(34), ['POST ' + API + '/pulls/34/update']: { __status: 409 }, ['GET ' + API + '/issues/34/labels']: [], ...human }, { MAX_ROUNDS: '1' });
  used.jobs.add({ key: 'owner/hello#26:ai:changes', label: 'ai:changes', status: 'done', started: ctx.clock, created: ctx.clock - 1, event: prEvent() });
  used.dispatcher.onMainMoved(movedEvent());
  await afterDelay(used.dispatcher);
  assert.equal(used.jobs.list().filter((entry) => entry.label === 'pr:conflict').length, 0);
  assert.match(commentsOf(used.forgejo)[0], /1 follow-up rounds for issue #26 are used up/);
});

test('with UPDATE_BRANCHES=0 or without Forgejo access a push does nothing', async () => {
  const off = await buildBranches([pull(34)], noReview(34), { UPDATE_BRANCHES: '0' });
  assert.equal(off.dispatcher.onMainMoved(movedEvent()), 'branch_updates_off');
  await afterDelay(off.dispatcher);
  assert.deepEqual(off.forgejo.calls, []);
});

test('the webhook turns a push to the default branch into a scheduled look at the pull requests', async () => {
  const { config, dispatcher, forgejo } = await buildBranches([pull(34)], { ...noReview(34), ['POST ' + API + '/pulls/34/update']: {} });
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify(pushPayload()));
    const post = (id, payload = raw) => fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'push', 'x-forgejo-delivery': id,
        'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(payload).digest('hex') },
      body: payload
    });
    const response = await post('d-push-1');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'scheduled');
    await afterDelay(dispatcher);
    assert.deepEqual(updates(forgejo), ['34']);
    const branch = Buffer.from(JSON.stringify(pushPayload({ ref: 'refs/heads/ai/issue-26' })));
    assert.equal((await (await post('d-push-2', branch)).json()).status, 'ignored');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
