// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Replay tests: seeded random sequences of forge events, ended conversations, ticks and restarts are run against the real dispatcher in a tiny
// world (test/helpers/world.ts), and invariants are checked after every step. A failure prints its seed and steps; FUZZ_SEED=<n> replays one
// seed, FUZZ_SEEDS=<n> runs more of them.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { ACTIVE, JobStore } from '../src/store/jobs.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { createApp } from '../src/server/app.ts';
import { Notifier } from '../src/notify/index.ts';
import { prng } from './helpers/prng.ts';
import { createWorld, poster, REPO } from './helpers/world.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const CHANGES = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const SECURITY = '55555555-5555-4555-8555-555555555555';
const HOLD_MINUTES = 30;
// What an agent's push may change: plain code, a protected path that two keys may merge, or one that always needs the human.
const FILES = { plain: (n) => ['src/issue-' + n + '.ts'], twoKeys: (n) => ['src/issue-' + n + '.ts', 'infra/tests/' + n + '.yaml'], human: (n) => ['infra/deploy-' + n + '.yaml'] };
const DENY = (file) => file.startsWith('infra/');
const TWO_KEYS = (file) => file.startsWith('infra/tests/');
const SECURITY_LOGIN = 'security-bot';
const MINUTE = 60000;
// Issues 1 to 3 are tickets and may become epics; 4 to 6 are the sub-issues a planner creates.
const ISSUES = 6;
const TICKETS = 3;
const STEPS = 40;
const SECRET = 'forgejo-test-secret-long-enough';
const VERDICT = (ok) => (ok ? 'Verdict: OK\n' : 'Verdict: NOT OK\n') + 'Evidence: the criterion is checked at src/a.ts line 12, bash validate.sh exits 0. '.repeat(8);
const quiet = { error() {} };
let dir;

// Issue routes, rounds on the pull request, CI fix rounds and the review of a green commit, and merges of approved pull requests.
// Odd seeds run with native reviews as the verdict (VERDICT_SOURCE=review, a reviewer user of its own), even seeds with comments and labels.
const modeOf = (seed) => (Number(String(seed).replace(/\D/g, '')) % 2 === 1 ? 'review' : 'comment');
const REVIEWER_LOGIN = 'reviewer-bot';
const env = (file, mode = 'comment') => ({
  FORGE_WEBHOOK_SECRET: SECRET,
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: REPO,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' },
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', on: 'pull_request' },
    'ci:failure': { profile: CHANGES, tier: 'free', on: 'ci_failure' },
    'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success', ...(mode === 'review' ? { forgejo_token_secret: 'REVIEWER_TOKEN' } : {}) },
    'sensitive:review': { profile: SECURITY, tier: 'strong', on: 'sensitive_review', forgejo_token_secret: 'SECURITY_TOKEN' },
    'epic:done': { profile: REVIEWER, tier: 'strong', on: 'epic_done' },
    'main:red': { profile: CHANGES, tier: 'free', on: 'main_red' }
  }),
  // Two keys: infra/tests/** merges with the security review's OK, after a hold; any other infra file needs the human.
  MERGE_POLICY: JSON.stringify({ [REPO]: { deny: ['infra/**'], two_keys: ['infra/tests/**'] } }),
  SECURITY_REVIEWERS: SECURITY_LOGIN,
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,SECURITY_TOKEN' + (mode === 'review' ? ',REVIEWER_TOKEN' : ''),
  ...(mode === 'review' ? { VERDICT_SOURCE: 'review', REVIEWER_TOKEN: 'reviewer-token-value' } : {}),
  // Dependency bot pull requests: renovate's branches renovate/..., one fix round on a red commit.
  BOT_AUTHORS: 'renovate',
  BOT_BRANCH_PREFIXES: 'renovate/',
  BOT_FIX_ROUNDS: '1',
  SECURITY_TOKEN: 'security-token-value',
  TWO_KEYS_HOLD_MINUTES: String(HOLD_MINUTES),
  APPROVAL_GRACE_SECONDS: '0',
  REVIEW_SWEEP_MINUTES: '30',
  STUCK_PR_MINUTES: '120',
  MAX_CONCURRENT_PER_TIER: '1',
  ERROR_RETRIES: '1',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: file + '.deliveries.json'
});

// The seeds a run tries: FUZZ_SEED replays one, FUZZ_SEEDS sets how many (a handful by default, so that npm test stays fast), and FUZZ_OFFSET
// shifts them, so that the nightly run looks at other seeds each night.
function seeds() {
  if (process.env.FUZZ_SEED) return [Number(process.env.FUZZ_SEED)];
  const count = Number(process.env.FUZZ_SEEDS || 8);
  const offset = Number(process.env.FUZZ_OFFSET || 0);
  return Array.from({ length: count }, (_, index) => 1 + (index + offset) * 7919);
}

// One step of a sequence: what a human, an agent, CI or the forge does, a conversation that ends, time that passes, or (with restarts)
// ForgeHands restarting.
function steps(seed, restarts) {
  const random = prng(seed);
  const mode = modeOf(seed);
  const list = [];
  for (let index = 0; index < STEPS; index += 1) {
    const number = random.next() < 0.75 ? 1 + random.int(TICKETS) : 1 + TICKETS + random.int(ISSUES - TICKETS);
    const roll = random.next();
    if (roll < 0.14) list.push({ kind: 'label', number, label: random.pick(['ai:ready', 'ai:ready', 'ai:plan']) });
    else if (roll < 0.19) list.push({ kind: 'comment', number });
    else if (roll < 0.24) list.push({ kind: 'close', number, by: 'human' });
    else if (roll < 0.27) list.push({ kind: 'reopen', number });
    else if (roll < 0.35) list.push({ kind: 'push', number, files: random.pick(['plain', 'plain', 'twoKeys', 'twoKeys', 'human']) });
    else if (roll < 0.43) list.push({ kind: 'ci', number, outcome: random.pick(['success', 'success', 'failure']) });
    else if (roll < 0.48) list.push({ kind: 'verdict', number, ok: random.next() < 0.7 });
    else if (roll < 0.52) list.push({ kind: 'approve', number });
    else if (roll < 0.55) list.push({ kind: 'changes', number });
    else if (roll < 0.57) list.push({ kind: 'closePull', number });
    else if (roll < 0.6) list.push({ kind: 'ship', number, main: random.pick(['success', 'failure', 'none']) });
    else if (roll < 0.63) list.push({ kind: 'security', number, ok: random.next() < 0.8 });
    else if (roll < 0.65) list.push({ kind: 'hold', number, on: random.next() < 0.6 });
    else if (roll < 0.67) list.push({ kind: 'plan', number: 1 + random.int(TICKETS) });
    else if (roll < 0.69) list.push({ kind: 'epicVerdict', number: 1 + random.int(TICKETS), ok: random.next() < 0.6 });
    else if (roll < 0.71) list.push({ kind: 'mainCi', outcome: random.pick(['success', 'failure', 'failure']) });
    else if (roll < 0.73) list.push({ kind: 'revertPush' });
    else if (roll < 0.77) list.push({ kind: 'endReruns', green: random.next() < 0.4 });
    else if (roll < 0.79) list.push({ kind: 'botPush', k: 1 + random.int(2) });
    else if (roll < 0.81) list.push({ kind: 'botCi', k: 1 + random.int(2), outcome: random.pick(['success', 'success', 'failure']) });
    else if (roll < 0.82) list.push({ kind: 'botShip', k: 1 + random.int(2) });
    else if (mode === 'review' && roll < 0.85) list.push({ kind: 'review', number, approve: random.next() < 0.6 });
    else if (roll < 0.72) list.push({ kind: 'end', pick: random.int(1000), state: random.pick(['finished', 'finished', 'error', 'stuck', 'max_iterations']) });
    else if (restarts && roll < 0.78) list.push({ kind: 'restart' });
    else list.push({ kind: 'tick', minutes: random.pick([1, 5, 30, 240]) });
  }
  return list;
}

// A run of ForgeHands over one sequence. `clock` and the world live across restarts; the store, the dispatcher and the app are built again from
// the files. Events reach ForgeHands as signed webhooks through the real app, as Forgejo sends them.
async function harness(file, mode = 'comment') {
  const state = { clock: 1_700_000_000_000 };
  const world = createWorld(ISSUES, () => state.clock);
  const config = loadConfig(env(file, mode));
  const boot = async () => {
    if (state.server) await new Promise((resolve) => state.server.close(resolve));
    state.jobs = new JobStore(file, quiet);
    await state.jobs.load();
    const notifier = new Notifier([], [], () => false, quiet, () => {});
    state.dispatcher = new Dispatcher(config, state.jobs, world.send, quiet, () => state.clock, notifier);
    state.server = createApp(config, new DeliveryStore(config.dataFile), world.send, quiet, state.dispatcher);
    await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve));
    state.post = poster(world, 'http://127.0.0.1:' + state.server.address().port + '/webhooks/forgejo', SECRET);
  };
  await boot();
  const drain = async () => { while (state.dispatcher.current) await state.dispatcher.current.catch(() => {}); };
  const apply = async (step) => {
    const issue = world.issues[step.number];
    const pr = step.number ? world.pullOf(step.number) : undefined;
    if (step.kind === 'label') {
      issue.labels.add(step.label);
      if (issue.state === 'open') await state.post(world.labelHook(step.number));
    } else if (step.kind === 'comment') {
      if (issue.state !== 'open') return;
      world.comments += 1;
      const comment = { id: world.comments, created_at: new Date(state.clock).toISOString(), user: { login: 'marcel' }, body: 'please go on' };
      issue.comments.push(comment);
      await state.post(world.commentHook(step.number, comment));
    } else if (step.kind === 'close') {
      // A person closes tickets, not epics: an epic is closed by its review (epicVerdict), and at the end of a sequence.
      if (issue.state !== 'open' || (step.by === 'human' && world.deps[step.number]) || (world.deps[step.number] ?? []).some((n) => world.issues[n].state === 'open')) return;
      issue.state = 'closed';
      await state.post(world.closeHook(step.number));
    } else if (step.kind === 'reopen') {
      issue.state = 'open';
    } else if (step.kind === 'push') {
      // The agent of the issue pushes its branch: only while the issue is open, as an agent works on open tickets.
      if (issue.state === 'open') world.push(step.number, FILES[step.files ?? 'plain'](step.number));
    } else if (step.kind === 'ci') {
      if (!pr) return;
      world.statuses[pr.head] = step.outcome;
      await state.post(world.ciHook(pr, step.outcome));
    } else if (step.kind === 'verdict') {
      if (!pr) return;
      world.comments += 1;
      pr.comments.push({ id: world.comments, created_at: new Date(state.clock).toISOString(), user: { login: 'openhands' }, body: VERDICT(step.ok) });
    } else if (step.kind === 'approve' || step.kind === 'changes') {
      if (!pr) return;
      pr.labels.add(step.kind === 'approve' ? 'ai:approved' : 'ai:changes');
      await state.post(world.pullLabelHook(pr));
    } else if (step.kind === 'review') {
      // The reviewer user's native review of the head commit (review mode).
      const target = step.pr ? world.pulls[step.pr] : pr;
      if (!target || target.state !== 'open') return;
      await state.post(world.review(target, REVIEWER_LOGIN, step.approve, VERDICT(step.approve)));
    } else if (step.kind === 'botPush') {
      world.pushBot(step.k);
    } else if (step.kind === 'botCi' || step.kind === 'botShip') {
      const bot = Object.values(world.pulls).find((entry) => entry.branch === 'renovate/dep-' + step.k && entry.state === 'open');
      if (!bot) return;
      if (step.kind === 'botCi') { world.statuses[bot.head] = step.outcome; await state.post(world.ciHook(bot, step.outcome)); return; }
      // The happy path of a bot's pull request: green, an OK verdict, approved (by label, or by a native review in review mode).
      world.statuses[bot.head] = 'success';
      await state.post(world.ciHook(bot, 'success'));
      state.clock += MINUTE;
      world.comments += 1;
      bot.comments.push({ id: world.comments, created_at: new Date(state.clock).toISOString(), user: { login: 'openhands' }, body: VERDICT(true) });
      if (mode === 'review') await apply({ kind: 'review', pr: bot.number, approve: true });
      else { bot.labels.add('ai:approved'); await state.post(world.pullLabelHook(bot)); }
    } else if (step.kind === 'ship') {
      // The happy path in one step: CI turns the head green, the reviewer writes OK and approves.
      if (!pr) return;
      await apply({ kind: 'ci', number: step.number, outcome: 'success' });
      state.clock += MINUTE;
      await apply({ kind: 'verdict', number: step.number, ok: true });
      if (pr.files.some(DENY)) await apply({ kind: 'security', number: step.number, ok: true });
      if (mode === 'review') await apply({ kind: 'review', number: step.number, approve: true });
      else await apply({ kind: 'approve', number: step.number });
      // A merge is a push to the default branch, and CI runs on it.
      if (pr.merged && step.main && step.main !== 'none') { state.clock += MINUTE; await apply({ kind: 'mainCi', outcome: step.main }); }
    } else if (step.kind === 'security') {
      // The security reviewer's comment on the head commit (its own forge user, see SECURITY_REVIEWERS).
      if (!pr) return;
      world.comments += 1;
      pr.comments.push({ id: world.comments, created_at: new Date(state.clock).toISOString(), user: { login: SECURITY_LOGIN },
        body: '## Security review: ' + (step.ok ? 'OK' : 'CONCERNS') + '\nCommit ' + pr.head.slice(0, 8) + ': ' + 'the changed paths were read line by line. '.repeat(6) });
    } else if (step.kind === 'hold') {
      // The operator puts HOLD_LABEL on the pull request, or takes it off.
      if (!pr) return;
      if (step.on) pr.labels.add('ai:hold'); else pr.labels.delete('ai:hold');
      world.history.push({ at: state.clock, pr: pr.number, what: step.on ? 'hold' : 'unhold' });
      await state.post(world.pullLabelHook(pr));
    } else if (step.kind === 'plan') {
      // The planner of an open ticket labelled ai:plan creates its sub-issues: they depend-block the ticket (now an epic) and get ai:ready.
      if (issue.state !== 'open' || !issue.labels.has('ai:plan') || world.deps[step.number]) return;
      const free = [4, 5, 6].filter((n) => !Object.values(world.deps).some((list) => list.includes(n)) && world.issues[n].state === 'open');
      if (!free.length) return;
      world.deps[step.number] = free.slice(0, 2);
      for (const n of world.deps[step.number]) {
        world.issues[n].labels.add('ai:ready');
        await state.post(world.labelHook(n));
      }
    } else if (step.kind === 'epicVerdict') {
      // The epic review's one comment: every criterion met closes the epic (the forge refuses while a sub-issue is open), else it names the gap.
      if (issue.state !== 'open' || !world.deps[step.number]) return;
      world.comments += 1;
      issue.comments.push({ id: world.comments, created_at: new Date(state.clock).toISOString(), user: { login: 'openhands' }, body: step.ok ? 'All criteria are met.' : 'Missing: the second criterion.' });
      if (step.ok && world.deps[step.number].every((n) => world.issues[n].state === 'closed')) await apply({ kind: 'close', number: step.number });
    } else if (step.kind === 'mainCi') {
      // CI ran on the tip of the default branch.
      const sha = world.branches.main;
      world.statuses[sha] = step.outcome;
      await state.post(world.mainCiHook(sha, step.outcome));
    } else if (step.kind === 'revertPush') {
      // The revert agent pushes the revert of the newest merge, when a revert run is going.
      const reverting = state.jobs.list('running').some((job) => job.label === 'main:red');
      const merged = Object.values(world.pulls).filter((entry) => entry.merged && !entry.revertOf).at(-1);
      if (reverting && merged) world.pushRevert(merged);
    } else if (step.kind === 'endReruns') {
      for (const run of Object.values(world.runs)) if (run.status === 'running') { run.status = step.green ? 'success' : 'failure'; if (step.green) world.statuses[run.sha] = 'success'; }
    } else if (step.kind === 'closePull') {
      if (pr) pr.state = 'closed';
    } else if (step.kind === 'end') {
      const running = Object.keys(world.conversations).filter((id) => world.conversations[id] === 'running');
      if (!running.length) return;
      const id = running[step.pick % running.length];
      world.conversations[id] = step.state;
      // A revert run that finishes has pushed its revert of the merge on the red default branch.
      const job = state.jobs.list('running').find((entry) => entry.conversation_id === id);
      const merged = job?.label === 'main:red' && Object.values(world.pulls).find((entry) => entry.merged && entry.merge_sha === job.event.ci?.commit_sha);
      if (step.state === 'finished' && merged) world.pushRevert(merged);
    } else if (step.kind === 'tick') {
      state.clock += step.minutes * MINUTE;
      await state.dispatcher.tick();
      // The review sweep runs on a timer of its own (REVIEW_SWEEP_MINUTES) in real time; here it runs when that much fake time has passed.
      if (state.clock - (state.swept ?? 0) >= config.reviewSweepMinutes * MINUTE) {
        state.swept = state.clock;
        await state.dispatcher.sweep.run();
      }
    } else if (step.kind === 'restart') {
      // A pass a webhook started in the background finishes first: a process that is stopped does not write afterwards either.
      await drain();
      await state.jobs.persist(state.clock);
      await state.jobs.writes;
      await boot();
    }
    // What the forge sends because of what ForgeHands did (the push of a merge) arrives after the step.
    while (world.outbox.length) await state.post(world.outbox.shift());
  };
  const close = async () => { await drain(); await new Promise((resolve) => state.server.close(resolve)); };
  return { state, world, apply, drain, close, config, mode };
}

// What must hold after every step, whatever came before.
function checkInvariants(state, world, mode = 'comment') {
  const jobs = state.jobs.list();
  const active = jobs.filter((job) => ACTIVE.has(job.status));
  const keys = active.map((job) => job.key);
  assert.equal(new Set(keys).size, keys.length, 'at most one active job per key: ' + active.map((job) => job.key + ' ' + job.status + (job.result ? ' (' + job.result + ')' : '')).join(', '));
  for (const job of jobs.filter((entry) => entry.status === 'running')) {
    assert.ok(job.conversation_id && world.conversations[job.conversation_id], 'a running job has a conversation OpenHands knows: ' + job.key);
  }
  assert.deepEqual(world.botClosed ?? [], [], 'a merged bot pull request closes no ticket');
  const tiers = new Map();
  for (const job of jobs.filter((entry) => entry.status === 'running')) {
    const tier = state.dispatcher.tierOf(job) ?? state.dispatcher.config.routes.get(job.label)?.tier;
    tiers.set(tier, [...(tiers.get(tier) ?? []), job.key]);
  }
  for (const [tier, keys] of tiers) assert.ok(keys.length <= 1, 'tier ' + tier + ' never runs more than MAX_CONCURRENT_PER_TIER: ' + keys.join(', '));
  // A merge happens only for an approved pull request whose head is green, and never while HOLD_LABEL is on. A protected path merges only through two keys: every protected
  // file is a two-keys file, the security reviewer said OK on that very commit, the hold had run its time since then, and HOLD_LABEL was off.
  for (const pr of Object.values(world.pulls).filter((entry) => entry.merged)) {
    if (mode === 'review') {
      // Native reviews: an approval of a reviewer on exactly the merged commit, and no later request for changes on it.
      const onHead = (pr.reviews ?? []).filter((review) => review.commit_id === pr.head);
      assert.ok(onHead.some((review) => review.state === 'APPROVED'), 'review mode: a merged pull request has an approval of its commit: #' + pr.number);
      assert.notEqual(onHead.at(-1)?.state, 'REQUEST_CHANGES', 'review mode: the latest review of the merged commit is no request for changes: #' + pr.number);
    } else {
      assert.ok(pr.labels.has('ai:approved'), 'a merged pull request was approved: #' + pr.number);
    }
    assert.equal(world.statuses[pr.head], 'success', 'a merged pull request had a green head: #' + pr.number);
    const merge = world.history.find((entry) => entry.pr === pr.number && entry.what === 'merge');
    assert.ok(!merge.labels.includes('ai:hold'), 'nothing merges while HOLD_LABEL is on: #' + pr.number);
    const protectedFiles = pr.files.filter(DENY);
    if (!protectedFiles.length) continue;
    assert.ok(protectedFiles.every(TWO_KEYS), 'a deny file outside two_keys keeps the human: #' + pr.number + ' ' + pr.files.join(', '));
    const reviews = pr.comments.filter((comment) => comment.user.login === SECURITY_LOGIN && comment.body.includes('Commit ' + pr.head.slice(0, 8)));
    const last = reviews.at(-1);
    assert.ok(last && last.body.startsWith('## Security review: OK'), 'two keys need the security OK of the merged commit: #' + pr.number);
    const agreed = Date.parse(last.created_at);
    const unheld = world.history.filter((entry) => entry.pr === pr.number && entry.what === 'unhold' && entry.at <= merge.at).at(-1)?.at ?? 0;
    assert.ok(merge.at >= Math.max(agreed, unheld) + HOLD_MINUTES * MINUTE,
      'a two-keys merge waits TWO_KEYS_HOLD_MINUTES after both keys agreed and after the hold label came off: #' + pr.number);
  }
}

// After the sequence the world settles: every conversation ends, every issue closes, and time passes. Nothing may be left active or held.
async function settle(state, world, apply) {
  for (const id of Object.keys(world.conversations)) if (world.conversations[id] === 'running') world.conversations[id] = 'finished';
  for (const pr of Object.values(world.pulls)) if (pr.state === 'open') pr.state = 'closed';
  const passTime = async (rounds) => {
    for (let round = 0; round < rounds; round += 1) {
      for (const run of Object.values(world.runs)) if (run.status === 'running') run.status = 'failure';
      for (const id of Object.keys(world.conversations)) if (world.conversations[id] === 'running') await apply({ kind: 'end', pick: Object.keys(world.conversations).filter((key) => world.conversations[key] === 'running').indexOf(id), state: 'finished' });
      await apply({ kind: 'tick', minutes: 120 });
    }
  };
  // The tickets and sub-issues close first, and time passes: an epic's review then runs while the epic is still open, as it does when its
  // last sub-issue is closed by a merge. The epics close after that (the forge refuses while a sub-issue is open).
  const epics = new Set(Object.keys(world.deps).map(Number));
  for (const number of Object.keys(world.issues).map(Number).filter((n) => !epics.has(n))) await apply({ kind: 'close', number });
  await passTime(6);
  for (const number of epics) await apply({ kind: 'close', number });
  await passTime(12);
  const left = state.jobs.list().filter((job) => ACTIVE.has(job.status)).map((job) => job.key + ' ' + job.status);
  assert.deepEqual(left, [], 'no job is left active once every issue is closed');
  assert.equal(state.jobs.holds.size, 0, 'no merge hold is left');
  assert.equal(state.jobs.stuck.size, 0, 'no stuck record is left');
  assert.equal(state.jobs.stalled.size, 0, 'no stalled record is left');
  assert.equal(state.jobs.epicGaps.size, 0, 'no epic gap record is left once the epic is closed');
}

async function replay(seed, restarts, file, list = steps(seed, restarts)) {
  const mode = modeOf(seed);
  const { state, world, apply, close } = await harness(file, mode);
  let index = 0;
  try {
    for (; index < list.length; index += 1) {
      await apply(list[index]);
      checkInvariants(state, world, mode);
    }
    await settle(state, world, apply);
  } catch (error) {
    // The node test reporter prints the stack of an assertion, so the seed and the steps go into a new error of their own.
    const replayed = new Error(error.message + '\nseed ' + seed + ' (' + mode + ' mode' + (restarts ? ', with restarts' : '') + ')' + ', at step ' + index + ' of\n' +
      list.map((step, at) => at + ' ' + JSON.stringify(step)).join('\n'), { cause: error });
    replayed.stack = replayed.message;
    throw replayed;
  } finally {
    await close();
  }
  await state.jobs.persist(state.clock);
  await state.jobs.writes;
  return { state, world };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-replay-')); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('the seeded generator gives the same sequence for the same seed', () => {
  const first = prng(42); const second = prng(42);
  const a = Array.from({ length: 5 }, () => first.next());
  assert.deepEqual(a, Array.from({ length: 5 }, () => second.next()));
  assert.notDeepEqual(a, Array.from({ length: 5 }, () => prng(43).next()));
  assert.deepEqual(steps(7, true), steps(7, true));
});

test('random sequences of labels, comments, closes and ended runs keep one active job per key and leave nothing behind', async () => {
  let started = 0;
  for (const seed of seeds()) started += (await replay(seed, false, join(dir, 'plain-' + seed + '.json'))).world.started.length;
  assert.ok(started >= seeds().length, 'the sequences start runs at all (' + started + ' starts), or the invariants would hold for nothing');
});

test('the same sequences with ForgeHands restarting in between keep the invariants', async () => {
  for (const seed of seeds()) await replay(seed, true, join(dir, 'restart-' + seed + '.json'));
});

test('a restart in the middle of a sequence ends in the same ledger as the run without it', async () => {
  for (const seed of seeds()) {
    const plain = steps(seed, false);
    const random = prng(seed ^ 0x5bd1e995);
    const at = 1 + random.int(plain.length - 1);
    const fileA = join(dir, 'a-' + seed + '.json');
    const fileB = join(dir, 'b-' + seed + '.json');
    const a = await harness(fileA, modeOf(seed));
    const b = await harness(fileB, modeOf(seed));
    for (let index = 0; index < plain.length; index += 1) {
      if (index === at) await b.apply({ kind: 'restart' });
      // Both runs wait for the pass a webhook starts in the background, so that only the restart tells them apart.
      await a.apply(plain[index]); await a.drain();
      await b.apply(plain[index]); await b.drain();
    }
    await a.close(); await b.close();
    await a.state.jobs.persist(a.state.clock); await a.state.jobs.writes;
    await b.state.jobs.persist(b.state.clock); await b.state.jobs.writes;
    const ledger = async (file) => {
      let raw = await readFile(file, 'utf8');
      // Job ids are random per store: every mention of one (the job itself, a stalled record's run) becomes its key and creation time.
      for (const job of JSON.parse(raw).jobs) raw = raw.replaceAll(JSON.stringify(job.id), JSON.stringify(job.key + '@' + job.created));
      const content = JSON.parse(raw);
      // archived_view may differ on purpose: the closed-ticket sweep runs at start (see sweepClosed), so a restart can mark a closed ticket
      // earlier than a day later. Everything else must agree.
      content.jobs = content.jobs.map(({ archived_view, ...rest }) => rest).sort((x, y) => (x.key + x.created).localeCompare(y.key + y.created));
      return content;
    };
    assert.deepEqual(await ledger(fileB), await ledger(fileA), 'seed ' + seed + ', restart before step ' + at);
  }
});
