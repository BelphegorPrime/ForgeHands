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
import { Notifier } from '../src/notify/index.ts';
import { prng } from './helpers/prng.ts';
import { createWorld, REPO } from './helpers/world.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60000;
const ISSUES = 3;
const STEPS = 40;
const quiet = { error() {} };
let dir;

const env = () => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: REPO,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({ 'ai:plan': { profile: PLANNER, tier: 'strong' }, 'ai:ready': { profile: WORKER, tier: 'free' } }),
  MAX_CONCURRENT_PER_TIER: '1',
  ERROR_RETRIES: '1',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json')
});

// The seeds a run tries: FUZZ_SEED replays one, FUZZ_SEEDS sets how many (a handful by default, so that npm test stays fast).
function seeds() {
  if (process.env.FUZZ_SEED) return [Number(process.env.FUZZ_SEED)];
  const count = Number(process.env.FUZZ_SEEDS || 8);
  return Array.from({ length: count }, (_, index) => 1 + index * 7919);
}

// One step of a sequence: what a human or the forge does, a conversation that ends, time that passes, or (with restarts) ForgeHands restarting.
function steps(seed, restarts) {
  const random = prng(seed);
  const list = [];
  for (let index = 0; index < STEPS; index += 1) {
    const number = 1 + random.int(ISSUES);
    const roll = random.next();
    if (roll < 0.25) list.push({ kind: 'label', number, label: random.pick(['ai:ready', 'ai:ready', 'ai:plan']) });
    else if (roll < 0.35) list.push({ kind: 'comment', number });
    else if (roll < 0.45) list.push({ kind: 'close', number });
    else if (roll < 0.5) list.push({ kind: 'reopen', number });
    else if (roll < 0.7) list.push({ kind: 'end', pick: random.int(1000), state: random.pick(['finished', 'finished', 'error', 'stuck', 'max_iterations']) });
    else if (restarts && roll < 0.78) list.push({ kind: 'restart' });
    else list.push({ kind: 'tick', minutes: random.pick([1, 5, 30, 240]) });
  }
  return list;
}

// A run of ForgeHands over one sequence. `clock` and the world live across restarts; the store and the dispatcher are built again from the file.
async function harness(file) {
  const state = { clock: 1_700_000_000_000, comments: 0 };
  const world = createWorld(ISSUES, () => state.clock);
  const config = loadConfig(env());
  const boot = async () => {
    state.jobs = new JobStore(file);
    await state.jobs.load();
    const notifier = new Notifier([], [], () => false, quiet, () => {});
    state.dispatcher = new Dispatcher(config, state.jobs, world.send, quiet, () => state.clock, notifier);
  };
  await boot();
  const drain = async () => { while (state.dispatcher.current) await state.dispatcher.current.catch(() => {}); };
  const apply = async (step) => {
    const issue = world.issues[step.number];
    if (step.kind === 'label') {
      issue.labels.add(step.label);
      if (issue.state === 'open') await state.dispatcher.enqueue(world.event('issues.labeled', step.number, { label: step.label, action: 'labeled' }));
    } else if (step.kind === 'comment') {
      if (issue.state !== 'open') return;
      state.comments += 1;
      issue.comments.push({ id: state.comments, created_at: new Date(state.clock).toISOString(), user: { login: 'marcel' }, body: 'please go on' });
      await state.dispatcher.onComment(world.event('issues.commented', step.number, { action: 'created', comment: { id: String(state.comments), login: 'marcel' } }));
    } else if (step.kind === 'close') {
      if (issue.state !== 'open') return;
      issue.state = 'closed';
      await state.dispatcher.onClosed(world.event('issues.closed', step.number, { action: 'closed' }));
    } else if (step.kind === 'reopen') {
      issue.state = 'open';
    } else if (step.kind === 'end') {
      const running = Object.keys(world.conversations).filter((id) => world.conversations[id] === 'running');
      if (running.length) world.conversations[running[step.pick % running.length]] = step.state;
    } else if (step.kind === 'tick') {
      state.clock += step.minutes * MINUTE;
      await state.dispatcher.tick();
    } else if (step.kind === 'restart') {
      // A pass a webhook started in the background finishes first: a process that is stopped does not write afterwards either.
      await drain();
      await state.jobs.persist(state.clock);
      await state.jobs.writes;
      await boot();
    }
  };
  return { state, world, apply, drain };
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
  const running = jobs.filter((job) => job.status === 'running');
  assert.ok(running.filter((job) => job.label === 'ai:ready').length <= 1 && running.filter((job) => job.label === 'ai:plan').length <= 1,
    'a tier never runs more than MAX_CONCURRENT_PER_TIER: ' + running.map((job) => job.key).join(', '));
}

// After the sequence the world settles: every conversation ends, every issue closes, and time passes. Nothing may be left active or held.
async function settle(state, world, apply) {
  for (const id of Object.keys(world.conversations)) if (world.conversations[id] === 'running') world.conversations[id] = 'finished';
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

async function replay(seed, restarts, file) {
  const list = steps(seed, restarts);
  const { state, world, apply } = await harness(file);
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
    await a.state.jobs.persist(a.state.clock); await a.state.jobs.writes;
    await b.state.jobs.persist(b.state.clock); await b.state.jobs.writes;
    const ledger = async (file) => {
      const content = JSON.parse(await readFile(file, 'utf8'));
      // Job ids are random per store. archived_view may differ on purpose: the closed-ticket sweep runs at start (see sweepClosed), so a
      // restart can mark a closed ticket earlier than a day later. Everything else must agree.
      content.jobs = content.jobs.map(({ id, archived_view, ...rest }) => rest).sort((x, y) => (x.key + x.created).localeCompare(y.key + y.created));
      return content;
    };
    assert.deepEqual(await ledger(fileB), await ledger(fileA), 'seed ' + seed + ', restart before step ' + at);
  }
});

// Seeds that found a bug, kept as named tests so that they run on every npm test.
test('a label set again while a pass checks an ended run for delivery does not start a second run on the ticket (seed 760225, #148)', async () => {
  await replay(760225, false, join(dir, 'regression-760225.json'));
});
