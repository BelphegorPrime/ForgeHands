// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Pull requests of dependency bots (BOT_AUTHORS, BOT_BRANCH_PREFIXES, BOT_FIX_ROUNDS).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { buildStatus } from '../src/server/status.ts';
import { ctx, repo, quiet, env, event, starts, webhook, prPayload, withCi, ciEvent, buildCi, API, goodRoutes, mergerFor, issue, buildVerdict, reviewJob, prWith, verdict, pull, updates, BOT, botRun, BOT_RULES, botEvent, botPull, botMerge, botApproved, ticket } from './helpers/direct.ts';

test('BOT_AUTHORS, BOT_BRANCH_PREFIXES and BOT_FIX_ROUNDS are read and validated', () => {
  const on = loadConfig(env(withCi({ ...BOT, BOT_FIX_ROUNDS: '2' })));
  assert.deepEqual([...on.botAuthors], ['renovate', 'dependabot']);
  assert.deepEqual(on.botBranchPrefixes, ['renovate/']);
  assert.equal(on.botFixRounds, 2);
  const off = loadConfig(env(withCi()));
  assert.equal(off.botAuthors.size, 0);
  assert.equal(off.botFixRounds, 0);
  assert.throws(() => loadConfig(env(withCi({ BOT_FIX_ROUNDS: 'x' }))), /BOT_FIX_ROUNDS/);
});

test('a bot pull request qualifies by author and prefix; every other foreign pull request is still ignored', () => {
  const e = botEvent('success');
  assert.equal(e.bot, true);
  assert.equal(e.issue.number, 34);
  assert.equal(e.pull_request.number, 34);
  assert.equal(e.label, 'ci:success');
  assert.equal(botEvent('success', { login: 'RENOVATE' }).bot, true);
  assert.equal(botEvent('success', { login: 'mallory' }), null);          // not a listed author
  assert.equal(botEvent('success', { ref: 'feature/x' }), null);          // listed author, other branch
  assert.equal(botEvent('success', { headRepo: 'evil/fork' }), null);     // a fork is somebody else's code
  assert.equal(botEvent('success', {}, { authors: new Set(), prefixes: [], fixRounds: 0 }), null);
  assert.equal(botEvent('success', { ref: 'feature/x' }, { ...BOT_RULES, prefixes: [] }).bot, true); // no prefix set: the author is enough
  assert.equal(ciEvent('success', { ref: 'feature/x' }), null);          // no bot rules at all
  const agent = botEvent('success', { ref: 'ai/issue-26' });              // an agent branch stays an agent pull request
  assert.equal(agent.bot, undefined);
  assert.equal(agent.issue.number, 26);
});

test('a red commit of a bot pull request starts nothing unless BOT_FIX_ROUNDS is set', () => {
  assert.equal(botEvent('failure'), null);
  const e = botEvent('failure', {}, { ...BOT_RULES, fixRounds: 1 });
  assert.equal(e.type, 'ci.failure');
  assert.equal(e.bot, true);
});

test('a green bot commit starts the review once per commit, with a prompt for dependency updates; the ledger key is per pull request', async () => {
  const { dispatcher, jobs } = await buildCi({ state: 'success', total_count: 2 }, BOT);
  const e = botEvent('success');
  assert.equal((await dispatcher.enqueue(e)).status, 'queued');
  assert.equal((await dispatcher.enqueue(e)).status, 'duplicate_job');
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.equal(jobs.list()[0].key, 'owner/hello!pr34:ci:success:abcdef01');
  const { body } = starts()[0];
  assert.deepEqual(body.tags, { source: 'forgehands', bot: 'dependency', pr: '34', ci: 'success' });
  const text = body.initial_message.content[0].text;
  assert.match(text, /a dependency update by a bot \(there is no ticket\)/);
  assert.match(text, /changelog or release notes of every version between the old and the new one/);
  assert.match(text, /breaking changes/);
  assert.match(text, /against how this repository uses the dependency/);
  assert.match(text, /untrusted text from the internet/);
  assert.match(text, /add the label ai:blocked instead/);                 // no worker: a NOT OK blocks
  assert.doesNotMatch(text, /acceptance criteria of the issue/);
  assert.match(text, /Title: Update dependency lodash/);
  assert.match(text, /\/projects\/owner-hello-pr-34-review-abcdef01/);
  // the same commit is not reviewed twice, a new commit is (once the run is over)
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(botEvent('success', { sha: 'ffffff0123456789' }))).status, 'queued');
  assert.equal(dispatcher.rounds(e), 0);
});

test('a bot pull request that is not green gets no review, and the status shows it per pull request', async () => {
  const red = await buildCi({ state: 'pending', total_count: 2 }, BOT);
  assert.equal((await red.dispatcher.enqueue(botEvent('success'))).status, 'ci_not_green');
  assert.equal(starts().length, 0);
  const { dispatcher, jobs, config } = await buildCi({ state: 'success', total_count: 1 }, BOT);
  await dispatcher.enqueue(botEvent('success'));
  const status = buildStatus(config, jobs, ctx.clock);
  assert.equal(status.issues[0].issue, 'owner/hello!pr34');
  assert.equal(status.issues[0].pr, 34);
  assert.match(status.issues[0].title, /Update dependency lodash/);
});

test('BOT_FIX_ROUNDS: a red bot commit starts a fix round, counted per pull request; the round after the last one is refused', async () => {
  const bots = { ...BOT_RULES, fixRounds: 1 };
  const { dispatcher, jobs } = await buildCi({}, { ...BOT, BOT_FIX_ROUNDS: '1' });
  assert.equal((await dispatcher.enqueue(botEvent('failure', { sha: '1111111100' }, bots))).status, 'queued');
  await dispatcher.tick();
  const text = starts()[0].body.initial_message.content[0].text;
  assert.match(text, /Its CI failed/);
  assert.match(text, /dependency update by a bot/);
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(botEvent('failure', { sha: '2222222200' }, bots))).status, 'rounds_exceeded');
});

test('a review of a bot pull request that asks for changes is handed to a human when no worker fixes it', async () => {
  const asked = await buildVerdict(prWith(['ai:changes']), BOT);
  const job = asked.jobs.add({ ...reviewJob(), key: 'owner/hello!pr34:ci:success:abcdef01', event: botEvent('success') });
  await asked.dispatcher.checkVerdict(job);
  assert.deepEqual(asked.forgejo.wrote(), ['POST /issues/34/comments', 'POST /issues/34/labels']);
  assert.match(asked.forgejo.calls.find((call) => call.path.endsWith('/comments')).body.body, /asks for changes to this dependency update/);
  // with BOT_FIX_ROUNDS the changes label is the reviewer's way to ask for a round: nothing to do here
  const fixed = await buildVerdict(prWith(['ai:changes']), { ...BOT, BOT_FIX_ROUNDS: '1' });
  await fixed.dispatcher.checkVerdict(fixed.jobs.add({ ...reviewJob(), event: botEvent('success', {}, { ...BOT_RULES, fixRounds: 1 }) }));
  assert.deepEqual(fixed.forgejo.wrote(), []);
});

test('ForgeHands does not update the branch of a bot pull request', async () => {
  const { dispatcher, jobs, forgejo } = await buildVerdict({}, BOT);
  await dispatcher.checkBranchAfterRun(jobs.add({ ...reviewJob(), status: 'done', event: botEvent('success') }));
  assert.deepEqual(forgejo.calls, []);
  const pr = { number: 34, state: 'open', merged: false, merge_base: 'old', head: { ref: 'renovate/lodash-4.x', sha: 'cafe' }, labels: [] };
  const outcome = await dispatcher.refreshPull({ repository: { full_name: repo }, sender: {} }, pr, 'new');
  assert.deepEqual(outcome, { changed: false, deferred: false });
  assert.deepEqual(forgejo.calls, []);
});

test('merge of an approved bot pull request: same checks, no issue closed', async () => {
  const { merger, forgejo } = await mergerFor(botMerge(), BOT);
  assert.equal(await merger.handle(botApproved()), 'merged');
  assert.deepEqual(forgejo.wrote(), ['POST /pulls/34/merge', 'POST /issues/34/comments']);   // no PATCH /issues/<n>
  assert.deepEqual(forgejo.calls.find((call) => call.path.endsWith('/merge')).body, { Do: 'merge', head_commit_id: 'cafe0000cafe', delete_branch_after_merge: true });
});

test('merge of a bot pull request: the deny list, the verdict and the green status still decide', async () => {
  const protectedFiles = await mergerFor(botMerge({}, [{ filename: 'package.json' }, { filename: 'compose.yaml' }]), BOT);
  assert.equal(await protectedFiles.merger.handle(botApproved()), 'protected_paths');
  assert.deepEqual(protectedFiles.forgejo.wrote(), ['POST /issues/34/comments']);
  const bare = goodRoutes({ ['GET ' + API + '/pulls/34']: botPull(), ['GET ' + API + '/issues/34/comments']: [] });
  assert.equal(await (await mergerFor(bare, BOT)).merger.handle(botApproved()), 'no_valid_review');
  const red = goodRoutes({ ['GET ' + API + '/pulls/34']: botPull(), ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'failure', total_count: 2 } });
  assert.equal(await (await mergerFor(red, BOT)).merger.handle(botApproved()), 'ci_not_green');
});

test('merge: a pull request that is not an agent branch and not from a listed bot is never merged', async () => {
  const strangers = [botPull({ user: { login: 'mallory' } }), botPull({ head: { ref: 'feature/x', sha: 'cafe0000cafe' } }), botPull({ head: { ref: 'renovate/x', sha: 'cafe0000cafe', repo: { full_name: 'evil/fork' } } })];
  for (const pr of strangers) {
    const { merger, forgejo } = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34']: pr }), BOT);
    assert.equal(await merger.handle(botApproved()), 'not_an_agent_branch');
    assert.deepEqual(forgejo.wrote(), []);
  }
  // without BOT_AUTHORS the same pull request of renovate is not a bot pull request
  const off = await mergerFor(botMerge(), {});
  assert.equal(await off.merger.handle(botApproved()), 'not_an_agent_branch');
});

test('the approval label on a bot pull request becomes a merge event; round labels need BOT_FIX_ROUNDS', () => {
  const base = prPayload([], { ref: 'renovate/lodash-4.x' });
  const payload = (labels, user = { login: 'renovate' }) => ({ ...base, pull_request: { ...base.pull_request, user, labels: labels.map((name) => ({ name })) } });
  const norm = (labels, fixRounds, user) => normalizeEvent('pull_request', payload(labels, user), new Set([repo]), [], { labelEvents: true, approved: 'ai:approved', prLabels: ['ai:changes'],
    bots: { ...BOT_RULES, fixRounds } });
  const approved = norm(['ai:approved'], 0);
  assert.equal(approved.type, 'pull_request.approved');
  assert.equal(approved.bot, true);
  assert.equal(norm(['ai:changes'], 0), null);
  assert.equal(norm(['ai:changes'], 1).bot, true);
  assert.equal(norm(['ai:approved'], 0, { login: 'mallory' }), null);
});

test('the webhook lets a bot CI outcome in even when its sender is not in ALLOWED_SENDERS, and still ignores a stranger', async () => {
  const { config, jobs, dispatcher } = await buildCi({ state: 'success', total_count: 1 }, { ...BOT, ALLOWED_SENDERS: 'marcel' });
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const send = async (payload, id) => {
      const raw = Buffer.from(JSON.stringify(payload));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forgejo-event': 'action_run_success', 'x-forgejo-delivery': id, 'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') }, body: raw });
      return (await response.json()).status;
    };
    const bot = botRun('success');
    bot.run.trigger_user = { login: 'renovate' };
    assert.equal(await send(bot, 'd-bot-1'), 'queued');
    assert.equal(jobs.list()[0].key, 'owner/hello!pr34:ci:success:abcdef01');
    assert.equal(await send(botRun('success', { login: 'mallory', sha: 'bbbbbb0123456789' }), 'd-bot-2'), 'ignored');
    assert.equal(jobs.list().length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
