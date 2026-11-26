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
const ISSUES = 3;
const STEPS = 40;
const SECRET = 'forgejo-test-secret-long-enough';
const VERDICT = (ok) => (ok ? 'Verdict: OK\n' : 'Verdict: NOT OK\n') + 'Evidence: the criterion is checked at src/a.ts line 12, bash validate.sh exits 0. '.repeat(8);
const quiet = { error() {} };
let dir;

// Issue routes, rounds on the pull request, CI fix rounds and the review of a green commit, and merges of approved pull requests.
const env = (file) => ({
  FORGEJO_WEBHOOK_SECRET: SECRET,
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
    'ci:success': { profile: REVIEWER, tier: 'strong', on: 'ci_success' },
    'sensitive:review': { profile: SECURITY, tier: 'strong', on: 'sensitive_review', forgejo_token_secret: 'SECURITY_TOKEN' }
  }),
  // Two keys: infra/tests/** merges with the security review's OK, after a hold; any other infra file needs the human.
  MERGE_POLICY: JSON.stringify({ [REPO]: { deny: ['infra/**'], two_keys: ['infra/tests/**'] } }),
  SECURITY_REVIEWERS: SECURITY_LOGIN,
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL,SECURITY_TOKEN',
  SECURITY_TOKEN: 'security-token-value',
  TWO_KEYS_HOLD_MINUTES: String(HOLD_MINUTES),
  APPROVAL_GRACE_SECONDS: '0',
  REVIEW_SWEEP_MINUTES: '30',
  STUCK_PR_MINUTES: '120',
  MAX_CONCURRENT_PER_TIER: '1',
  ERROR_RETRIES: '1',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: file + '.deliveries.json'
});

// The seeds a run tries: FUZZ_SEED replays one, FUZZ_SEEDS sets how many (a handful by default, so that npm test stays fast).
function seeds() {
  if (process.env.FUZZ_SEED) return [Number(process.env.FUZZ_SEED)];
  const count = Number(process.env.FUZZ_SEEDS || 8);
  return Array.from({ length: count }, (_, index) => 1 + index * 7919);
}

// One step of a sequence: what a human, an agent, CI or the forge does, a conversation that ends, time that passes, or (with restarts)
// ForgeHands restarting.
function steps(seed, restarts) {
  const random = prng(seed);
  const list = [];
  for (let index = 0; index < STEPS; index += 1) {
    const number = 1 + random.int(ISSUES);
    const roll = random.next();
    if (roll < 0.14) list.push({ kind: 'label', number, label: random.pick(['ai:ready', 'ai:ready', 'ai:plan']) });
    else if (roll < 0.19) list.push({ kind: 'comment', number });
    else if (roll < 0.24) list.push({ kind: 'close', number });
    else if (roll < 0.27) list.push({ kind: 'reopen', number });
    else if (roll < 0.35) list.push({ kind: 'push', number, files: random.pick(['plain', 'plain', 'twoKeys', 'twoKeys', 'human']) });
    else if (roll < 0.43) list.push({ kind: 'ci', number, outcome: random.pick(['success', 'success', 'failure']) });
    else if (roll < 0.48) list.push({ kind: 'verdict', number, ok: random.next() < 0.7 });
    else if (roll < 0.52) list.push({ kind: 'approve', number });
    else if (roll < 0.55) list.push({ kind: 'changes', number });
    else if (roll < 0.57) list.push({ kind: 'closePull', number });
    else if (roll < 0.6) list.push({ kind: 'ship', number });
    else if (roll < 0.63) list.push({ kind: 'security', number, ok: random.next() < 0.8 });
    else if (roll < 0.65) list.push({ kind: 'hold', number, on: random.next() < 0.6 });
    else if (roll < 0.72) list.push({ kind: 'end', pick: random.int(1000), state: random.pick(['finished', 'finished', 'error', 'stuck', 'max_iterations']) });
    else if (restarts && roll < 0.78) list.push({ kind: 'restart' });
    else list.push({ kind: 'tick', minutes: random.pick([1, 5, 30, 240]) });
  }
  return list;
}

// A run of ForgeHands over one sequence. `clock` and the world live across restarts; the store, the dispatcher and the app are built again from
// the files. Events reach ForgeHands as signed webhooks through the real app, as Forgejo sends them.
async function harness(file) {
  const state = { clock: 1_700_000_000_000 };
  const world = createWorld(ISSUES, () => state.clock);
  const config = loadConfig(env(file));
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
      if (issue.state !== 'open') return;
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
    } else if (step.kind === 'ship') {
      // The happy path in one step: CI turns the head green, the reviewer writes OK and approves.
      if (!pr) return;
      await apply({ kind: 'ci', number: step.number, outcome: 'success' });
      state.clock += MINUTE;
      await apply({ kind: 'verdict', number: step.number, ok: true });
      if (pr.files.some(DENY)) await apply({ kind: 'security', number: step.number, ok: true });
      await apply({ kind: 'approve', number: step.number });
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
    } else if (step.kind === 'closePull') {
      if (pr) pr.state = 'closed';
    } else if (step.kind === 'end') {
      const running = Object.keys(world.conversations).filter((id) => world.conversations[id] === 'running');
      if (running.length) world.conversations[running[step.pick % running.length]] = step.state;
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
  return { state, world, apply, drain, close, config };
}

// What must hold after every step, whatever came before.
function checkInvariants(state, world) {
  const jobs = state.jobs.list();
  const active = jobs.filter((job) => ACTIVE.has(job.status));
  const keys = active.map((job) => job.key);
  assert.equal(new Set(keys).size, keys.length, 'at most one active job per key: ' + active.map((job) => job.key + ' ' + job.status + (job.result ? ' (' + job.result + ')' : '')).join(', '));
  for (const job of jobs.filter((entry) => entry.status === 'running')) {
    assert.ok(job.conversation_id && world.conversations[job.conversation_id], 'a running job has a conversation OpenHands knows: ' + job.key);
  }
  const tiers = new Map();
  for (const job of jobs.filter((entry) => entry.status === 'running')) {
    const tier = state.dispatcher.tierOf(job) ?? state.dispatcher.config.routes.get(job.label)?.tier;
    tiers.set(tier, [...(tiers.get(tier) ?? []), job.key]);
  }
  for (const [tier, keys] of tiers) assert.ok(keys.length <= 1, 'tier ' + tier + ' never runs more than MAX_CONCURRENT_PER_TIER: ' + keys.join(', '));
  // A merge happens only for an approved pull request whose head is green, and never while HOLD_LABEL is on. A protected path merges only through two keys: every protected
  // file is a two-keys file, the security reviewer said OK on that very commit, the hold had run its time since then, and HOLD_LABEL was off.
  for (const pr of Object.values(world.pulls).filter((entry) => entry.merged)) {
    assert.ok(pr.labels.has('ai:approved'), 'a merged pull request was approved: #' + pr.number);
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
  for (const number of Object.keys(world.issues)) await apply({ kind: 'close', number: Number(number) });
  for (let round = 0; round < 12; round += 1) {
    for (const id of Object.keys(world.conversations)) if (world.conversations[id] === 'running') world.conversations[id] = 'finished';
    await apply({ kind: 'tick', minutes: 120 });
  }
  const left = state.jobs.list().filter((job) => ACTIVE.has(job.status)).map((job) => job.key + ' ' + job.status);
  assert.deepEqual(left, [], 'no job is left active once every issue is closed');
  assert.equal(state.jobs.holds.size, 0, 'no merge hold is left');
  assert.equal(state.jobs.stuck.size, 0, 'no stuck record is left');
  assert.equal(state.jobs.stalled.size, 0, 'no stalled record is left');
}

async function replay(seed, restarts, file, list = steps(seed, restarts)) {
  const { state, world, apply, close } = await harness(file);
  let index = 0;
  try {
    for (; index < list.length; index += 1) {
      await apply(list[index]);
      checkInvariants(state, world);
    }
    await settle(state, world, apply);
  } catch (error) {
    // The node test reporter prints the stack of an assertion, so the seed and the steps go into a new error of their own.
    const replayed = new Error(error.message + '\nseed ' + seed + (restarts ? ' (with restarts)' : '') + ', at step ' + index + ' of\n' +
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
    const a = await harness(fileA);
    const b = await harness(fileB);
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
