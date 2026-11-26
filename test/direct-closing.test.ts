// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Closing the original pull request for the planner, a security reviewer user, refused closes and BOT_REPOS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { ctx, WORKER, repo, quiet, env, fakeApi, event, starts, withCi, ciEvent, withMerge, API, fakeForgejo, issue, withBranches, pull, movedEvent, BOT, BOT_RULES, botEvent, twoKeyRoutes, ticket, agentPull, buildSplit } from './helpers/direct.ts';

test('a ticket labelled for the planner closes its open agent pull request with a comment and drops its other queued jobs', async () => {
  const { jobs, dispatcher, forgejo } = await buildSplit({ ['GET ' + API + '/pulls']: [agentPull(50, 5), agentPull(51, 6)] });
  const queued = jobs.add({ key: repo + '#5:ai:ready', label: 'ai:ready', event: ticket('ai:ready', 5, 'B'), status: 'queued', created: ctx.clock });
  const running = jobs.add({ key: repo + '#5:ai:changes', label: 'ai:changes', event: ticket('ai:ready', 5, 'B'), status: 'running', created: ctx.clock });
  const other = jobs.add({ key: repo + '#6:ai:ready', label: 'ai:ready', event: ticket('ai:ready', 6, 'B'), status: 'queued', created: ctx.clock });
  await dispatcher.enqueue(ticket('ai:plan', 5, 'B'));
  assert.deepEqual(forgejo.wrote(), ['POST /issues/50/comments', 'PATCH /pulls/50']);
  const [comment, close] = forgejo.calls.filter((call) => call.method !== 'GET');
  assert.match(comment.body.body, /^ForgeHands: the ticket was sent to the planner to be split; this pull request is closed/);
  assert.deepEqual(close.body, { state: 'closed' });
  const keys = jobs.list(true).map((job) => job.key);
  assert.ok(!keys.includes(queued.key));
  assert.ok(keys.includes(running.key), 'a running worker is left alone');
  assert.ok(keys.includes(other.key), 'another issue is untouched');
  assert.ok(keys.includes(repo + '#5:ai:plan'), 'the planner job stays');
});

test('a planner label on an issue without a pull request, or a non-epic label on one with a pull request, changes nothing', async () => {
  const { jobs, dispatcher, forgejo } = await buildSplit({ ['GET ' + API + '/pulls']: [agentPull(50, 5)] });
  const queued = jobs.add({ key: repo + '#7:ai:ready', label: 'ai:ready', event: ticket('ai:ready', 7, 'B'), status: 'queued', created: ctx.clock });
  await dispatcher.enqueue(ticket('ai:plan', 7, 'B'));
  assert.deepEqual(forgejo.wrote(), []);
  assert.ok(jobs.list(true).some((job) => job.id === queued.id));
  await dispatcher.enqueue(ticket('ai:escalate', 5, 'B'));
  assert.deepEqual(forgejo.wrote(), []);
});

test('a dry run only logs the closing of the original pull request', async () => {
  const { jobs, dispatcher, forgejo } = await buildSplit({ ['GET ' + API + '/pulls']: [agentPull(50, 5)] }, { DRY_RUN: '1' });
  const queued = jobs.add({ key: repo + '#5:ai:ready', label: 'ai:ready', event: ticket('ai:ready', 5, 'B'), status: 'queued', created: ctx.clock });
  await dispatcher.enqueue(ticket('ai:plan', 5, 'B'));
  assert.deepEqual(forgejo.wrote(), []);
  assert.ok(jobs.list(true).some((job) => job.id === queued.id));
});

test('a security review route may have a Forgejo user of its own: its token goes to that route only, as FORGEJO_TOKEN', async () => {
  const config = loadConfig(env(withMerge({ LABEL_ROUTES: twoKeyRoutes(), AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL,SECURITY_TOKEN', SECURITY_TOKEN: 'security-token-value' })));
  assert.equal(config.routes.get('sensitive:review').forgejoTokenSecret, 'SECURITY_TOKEN');
  // a route that is neither a review nor a security review still may not have one
  assert.throws(() => loadConfig(env(withMerge({ LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free', forgejo_token_secret: 'SECURITY_TOKEN' } }), AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL,SECURITY_TOKEN', SECURITY_TOKEN: 'security-token-value' }))), /only applies to a review route/);
  const jobs = new JobStore(join(ctx.dir, 'sec-token.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock);
  jobs.add({ key: repo + '#26:sensitive:review:abcdef01', label: 'sensitive:review', status: 'queued', created: ctx.clock, event: { ...ciEvent('success'), type: 'ci.sensitive', label: 'sensitive:review', protected_files: ['compose.yaml'] } });
  jobs.add({ key: repo + '#27:ai:ready', label: 'ai:ready', status: 'queued', created: ctx.clock + 1, event: event('ai:ready', 27) });
  await dispatcher.tick();
  const secretsOf = (profile) => starts().find((call) => call.body.agent_profile_id === profile).body.secrets;
  const security = secretsOf(config.routes.get('sensitive:review').profile);
  assert.equal(security.FORGEJO_TOKEN.value, 'security-token-value', 'the security reviewer acts as its own user');
  assert.ok(!('SECURITY_TOKEN' in security));
  const worker = secretsOf(WORKER);
  assert.notEqual(worker.FORGEJO_TOKEN.value, 'security-token-value', 'the worker never gets it');
  assert.ok(!('SECURITY_TOKEN' in worker));
});

test('a ticket the forge refuses to close does not stop the others, and is not tried or commented on again for six hours', async () => {
  const config = loadConfig(env(withBranches({})));
  const jobs = new JobStore(join(ctx.dir, 'refused.json'));
  await jobs.load();
  let refuse = true;
  const forgejo = fakeForgejo({
    ['GET ' + API + '/pulls']: [
      { number: 71, merged: true, head: { ref: 'ai/issue-53' }, base: { ref: 'main' } },
      { number: 72, merged: true, head: { ref: 'ai/issue-54' }, base: { ref: 'main' } }
    ],
    ['GET ' + API + '/issues/53']: { number: 53, state: 'open' },
    ['GET ' + API + '/issues/54']: { number: 54, state: 'open' },
    ['PATCH ' + API + '/issues/53']: () => refuse ? { __status: 412 } : {},
    ['PATCH ' + API + '/issues/54']: {},
    ['POST ' + API + '/issues/53/comments']: {}, ['POST ' + API + '/issues/54/comments']: {}
  });
  const dispatcher = new Dispatcher(config, jobs, forgejo.send, quiet, () => ctx.clock);
  assert.equal(await dispatcher.closeMergedTickets(movedEvent()), 1, 'the second ticket is closed although the first was refused');
  assert.deepEqual(forgejo.wrote(), ['PATCH /issues/53', 'PATCH /issues/54', 'POST /issues/54/comments'], 'no comment on the refused ticket');
  const before = forgejo.wrote().length;
  await dispatcher.closeMergedTickets(movedEvent());
  assert.ok(!forgejo.wrote().slice(before).includes('PATCH /issues/53'), 'not tried again at the next push');
  refuse = false;
  ctx.clock += 7 * 3600000;
  await dispatcher.closeMergedTickets(movedEvent());
  assert.ok(forgejo.wrote().slice(before).includes('PATCH /issues/53'), 'tried again after six hours');
});

test('BOT_REPOS limits the bot pull requests to some repositories; it must name allowed ones', () => {
  const all = loadConfig(env(withCi({ ...BOT })));
  assert.equal(all.botRepos.size, 0, 'empty: every allowed repository');
  const some = loadConfig(env(withCi({ ...BOT, ALLOWED_REPOS: repo + ',owner/other', BOT_REPOS: 'Owner/Other' })));
  assert.deepEqual([...some.botRepos], ['owner/other']);
  assert.throws(() => loadConfig(env(withCi({ ...BOT, BOT_REPOS: 'owner/elsewhere' }))), /BOT_REPOS: owner\/elsewhere is not in ALLOWED_REPOS/);
  // the pull request of an allowed repository that is not in BOT_REPOS is not a bot pull request (the operator merges it himself)
  assert.equal(botEvent('success', {}, { ...BOT_RULES, repos: new Set(['owner/other']) }), null);
  assert.equal(botEvent('success', {}, { ...BOT_RULES, repos: new Set([repo]) }).bot, true);
  assert.equal(botEvent('success', {}, { ...BOT_RULES, repos: new Set() }).bot, true, 'an empty set limits nothing');
});
