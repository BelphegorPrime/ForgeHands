// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Recurring findings (RECURRING_REASON_MIN): the NOT OK points of changes rounds are normalized to reasons, counted per repository over 14 days,
// and at the threshold one check ticket is filed per reason. Off by default; a dry run files nothing; runner limitations are not counted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecurringFindings, isEnvironmentReason, normalizeReason, pointsOf, ticketBody } from '../src/agent/recurring.ts';
import { loadConfig } from '../src/config.ts';
import { ticketViolations } from '../src/agent/preflight.ts';
import { JobStore } from '../src/store/jobs.ts';

const repo = 'owner/hello';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const DAY = 24 * 60 * 60 * 1000;
const SHA_A = 'a1b2c3d4' + '0'.repeat(32);
const SHA_B = 'b2c3d4e5' + '0'.repeat(32);
const SHA_C = 'c3d4e5f6' + '0'.repeat(32);
const SHA_D = 'd4e5f6a7' + '0'.repeat(32);
const quiet = { error() {} };

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: REVIEWER, tier: 'free' }, 'ai:changes': { profile: REVIEWER, tier: 'free', on: 'pull_request' } }),
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  RECURRING_REASON_MIN: '3',
  SPLIT_LABEL: 'ai:split',
  ...extra
});

// A fake forge with the calls the counter makes. `pulls` maps a number to its head; `verdicts` maps a number to its verdict text (a comment).
function fakeForge(state = {}) {
  const forge = {
    kind: 'forgejo',
    created: [], labels: [], comments: [], reads: [],
    issues: state.issues ?? {},
    nextIssue: 100,
    verdicts: state.verdicts ?? {},
    heads: state.heads ?? {},
    reviews: state.reviews ?? {},
    async getPull(repository, number) {
      forge.reads.push('getPull ' + number);
      return { number, state: 'open', merged: false, html_url: 'https://forge.example/owner/hello/pulls/' + number, head: { sha: forge.heads[number] ?? SHA_A } };
    },
    async commitTime() { return new Date(0).toISOString(); },
    async listComments(repository, number) {
      const text = forge.verdicts[number];
      return text ? [{ id: 900 + number, created_at: new Date(clock).toISOString(), body: text, html_url: 'https://forge.example/owner/hello/pulls/' + number + '#issuecomment-' + (900 + number) }] : [];
    },
    async listReviews(repository, number) { return forge.reviews[number] ?? []; },
    async getIssue(repository, number) { return forge.issues[number] ?? { number, state: 'open' }; },
    async createIssue(repository, title, body) {
      const issue = { number: forge.nextIssue++, title, body };
      forge.created.push(issue);
      return issue;
    },
    async findOrCreateLabel(repository, name) { return { id: name, name }; },
    async addLabels(repository, number, labels) { forge.labels.push({ number, names: labels.map((label) => label.name) }); },
    async addComment(repository, number, body) { forge.comments.push({ number, body }); }
  };
  return forge;
}

let clock = Date.UTC(2026, 10, 1);

async function setup(extra = {}, forgeState = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'recurring-'));
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const forge = fakeForge(forgeState);
  const logs = [];
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const recurring = new RecurringFindings(config, jobs, forge, logger, () => clock);
  return { dir, config, jobs, forge, logs, recurring, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// A NOT OK verdict on pull request `number` with `point` as its one point.
const notOk = (point) => '## Verdict: NOT OK\n\n- ' + point + '\n';

test('the same defect in different pull requests and shas normalizes to one reason', () => {
  const first = normalizeReason('`src/agent/merge.ts:42` uses any without a type (commit 1a2b3c4d)');
  const second = normalizeReason('src/other/file.ts line 99 uses any without a type (commit 9f8e7d6c)');
  assert.equal(first, second);
  assert.equal(first, '<path> uses any without a type commit');
});

test('normalization keeps different rules apart and drops quotes, numbers and trailing punctuation', () => {
  assert.notEqual(normalizeReason('rule no-any is broken'), normalizeReason('rule no-unused-vars is broken'));
  assert.equal(normalizeReason('Use "docs/a.md" folder.'), 'use <path> folder');
  assert.equal(normalizeReason("Don't use the 'any' type"), "don't use the any type");
  assert.equal(normalizeReason('  - - 12 ... '), '');
  assert.ok(normalizeReason('x'.repeat(500)).length <= 120);
});

test('the reason of a point is its first clause, not its explanation', () => {
  assert.equal(normalizeReason('the lint rule no-any fails. The explanation is long and specific to this pull request.'), 'the lint rule no-any fails');
});

test('verdict points are read from the lines after the NOT OK line, bullets and numbers taken off', () => {
  assert.deepEqual(pointsOf('## Verdict: NOT OK\n\n- first point\n2. second point\n\nevidence\n## Next\nignored'), ['first point', 'second point', 'evidence']);
  assert.deepEqual(pointsOf('Verdict: NOT OK — the test is missing'), ['the test is missing']);
  assert.deepEqual(pointsOf('plain review body\nline two'), ['plain review body', 'line two']);
  assert.equal(pointsOf('Verdict: OK\nall fine').length, 2);
});

test('runner and environment limitations are not counted as findings', () => {
  assert.equal(isEnvironmentReason(normalizeReason('not verified: runner limitation')), true);
  assert.equal(isEnvironmentReason(normalizeReason('unshare: operation not permitted')), true);
  assert.equal(isEnvironmentReason(normalizeReason('no space left on device')), true);
  assert.equal(isEnvironmentReason(normalizeReason('the rate limit of the review is not handled')), true);
  assert.equal(isEnvironmentReason(normalizeReason('the timeout of the test is too short')), true);
  assert.equal(isEnvironmentReason(normalizeReason('the handler does not check the input')), false);
});

test('three equal reasons in three pull requests create exactly one ticket, with the planner label and the evidence', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('no-any rule is broken in src/a.ts'), 2: notOk('no-any rule is broken in lib/b.ts line 4'), 3: notOk('no-any rule is broken in `src/c.ts:9`') } });
  try {
    for (const [number, sha] of [[1, SHA_A], [2, SHA_B], [3, SHA_C]]) {
      t.forge.heads[number] = sha;
      await t.recurring.observe(repo, number);
    }
    assert.equal(t.forge.created.length, 1);
    const [issue] = t.forge.created;
    assert.equal(issue.title, 'Make this a check: no-any rule is broken in <path>');
    assert.deepEqual(t.forge.labels, [{ number: 100, names: ['ai:split'] }]);
    assert.match(issue.body, /## Acceptance\n\n```sh\n# [^\n]*\nnpm test\n```/);
    assert.match(issue.body, /\[pull request #1, commit a1b2c3d4\]\(https:\/\/forge\.example\/owner\/hello\/pulls\/1#issuecomment-901\)/);
    assert.equal(t.jobs.filedFindings.size, 1);
    // A fourth occurrence adds no second ticket: the open one is it.
    t.forge.heads[4] = SHA_D;
    t.forge.verdicts[4] = notOk('no-any rule is broken');
    await t.recurring.observe(repo, 4);
    assert.equal(t.forge.created.length, 1);
  } finally {
    await t.cleanup();
  }
});

test('different reasons do not add up: only the reason that reaches the threshold gets a ticket', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('the test is missing'), 4: notOk('the test is missing') } });
  try {
    for (const number of [1, 2, 3, 4]) {
      t.forge.heads = t.forge.heads || {};
      t.forge.heads[number] = [SHA_A, SHA_B, SHA_C, SHA_D][number - 1];
      await t.recurring.observe(repo, number);
    }
    assert.equal(t.forge.created.length, 0);
    assert.equal(t.jobs.findings.length, 4);
  } finally {
    await t.cleanup();
  }
});

test('the same pull request head is counted once, and occurrences older than 14 days do not count', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('no-any rule is broken') }, heads: { 1: SHA_A } });
  try {
    await t.recurring.observe(repo, 1);
    await t.recurring.observe(repo, 1);
    assert.equal(t.jobs.findings.length, 1);
    // The first occurrence ages out of the 14 days; the two that come after it are below the threshold of three, so no ticket.
    clock += 15 * DAY;
    t.forge.heads[2] = SHA_B; t.forge.verdicts[2] = notOk('no-any rule is broken');
    t.forge.heads[3] = SHA_C; t.forge.verdicts[3] = notOk('no-any rule is broken');
    await t.recurring.observe(repo, 2);
    await t.recurring.observe(repo, 3);
    assert.equal(t.forge.created.length, 0);
  } finally {
    clock = Date.UTC(2026, 10, 1);
    await t.cleanup();
  }
});

test('a closed ticket does not recur for 14 days after it was filed; after that, a recurring reason files a new one', async () => {
  const t = await setup({}, { verdicts: {}, heads: {} });
  try {
    const round = async (numbers, point) => {
      for (const number of numbers) {
        t.forge.heads[number] = (number * 1000 + 7).toString(16).padStart(40, 'a');
        t.forge.verdicts[number] = notOk(point);
        await t.recurring.observe(repo, number);
      }
    };
    await round([1, 2, 3], 'no-any rule is broken');
    assert.equal(t.forge.created.length, 1);
    // The ticket is closed: three more occurrences within 14 days file nothing.
    t.forge.issues[100] = { number: 100, state: 'closed' };
    clock += 3 * DAY;
    await round([4, 5, 6], 'no-any rule is broken');
    assert.equal(t.forge.created.length, 1);
    // After 14 days from filing, the closed ticket no longer blocks: the reason still recurs, so a new ticket is filed.
    clock += 12 * DAY;
    await round([7, 8, 9], 'no-any rule is broken');
    assert.equal(t.forge.created.length, 2);
    assert.equal(t.jobs.filedFindings.get(repo.toLowerCase() + '|no-any rule is broken').issue, 101);
  } finally {
    clock = Date.UTC(2026, 10, 1);
    await t.cleanup();
  }
});

test('an open ticket never gets a second one, even after 14 days', async () => {
  const t = await setup({}, { verdicts: {}, heads: {} });
  try {
    for (const number of [1, 2, 3]) {
      t.forge.heads[number] = (number * 1000 + 7).toString(16).padStart(40, 'a');
      t.forge.verdicts[number] = notOk('no-any rule is broken');
      await t.recurring.observe(repo, number);
    }
    clock += 20 * DAY;
    for (const number of [4, 5, 6]) {
      t.forge.heads[number] = (number * 1000 + 7).toString(16).padStart(40, 'a');
      t.forge.verdicts[number] = notOk('no-any rule is broken');
      await t.recurring.observe(repo, number);
    }
    assert.equal(t.forge.created.length, 1);
  } finally {
    clock = Date.UTC(2026, 10, 1);
    await t.cleanup();
  }
});

test('runner limitations are excluded: three of them file nothing and count nothing', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('not verified: runner limitation'), 2: notOk('not verified: runner limitation'), 3: notOk('not verified: runner limitation') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C } });
  try {
    for (const number of [1, 2, 3]) await t.recurring.observe(repo, number);
    assert.equal(t.forge.created.length, 0);
    assert.equal(t.jobs.findings.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('off by default: with RECURRING_REASON_MIN unset nothing is read, counted or filed', async () => {
  const t = await setup({ RECURRING_REASON_MIN: undefined }, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('no-any rule is broken') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C } });
  try {
    assert.equal(t.config.recurringReasonMin, 0);
    for (const number of [1, 2, 3]) await t.recurring.observe(repo, number);
    assert.deepEqual(t.forge.reads, []);
    assert.equal(t.forge.created.length, 0);
    assert.equal(t.jobs.findings.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('a dry run files nothing and records nothing', async () => {
  const t = await setup({ DRY_RUN: '1' }, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('no-any rule is broken') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C } });
  try {
    for (const number of [1, 2, 3]) await t.recurring.observe(repo, number);
    assert.equal(t.forge.created.length, 0);
    assert.equal(t.forge.labels.length, 0);
    assert.equal(t.jobs.findings.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('without SPLIT_LABEL the ticket is created with a comment that mentions the human, and no label', async () => {
  const t = await setup({ SPLIT_LABEL: undefined, HUMAN_LOGIN: 'marcel' }, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('no-any rule is broken') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C } });
  try {
    for (const number of [1, 2, 3]) await t.recurring.observe(repo, number);
    assert.equal(t.forge.created.length, 1);
    assert.equal(t.forge.labels.length, 0);
    assert.equal(t.forge.comments.length, 1);
    assert.match(t.forge.comments[0].body, /^@marcel ForgeHands: /);
  } finally {
    await t.cleanup();
  }
});

test('a forge without createIssue files nothing and logs once', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('no-any rule is broken'), 4: notOk('no-any rule is broken') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C, 4: SHA_D } });
  delete t.forge.createIssue;
  try {
    for (const number of [1, 2, 3, 4]) await t.recurring.observe(repo, number);
    assert.equal(t.logs.filter((line) => /cannot create issues/.test(line)).length, 1);
  } finally {
    await t.cleanup();
  }
});

test('only a NOT OK verdict is a finding: an OK verdict counts nothing', async () => {
  const t = await setup({}, { verdicts: { 1: 'Verdict: OK\n- the test is present and passes' }, heads: { 1: SHA_A } });
  try {
    assert.equal(await t.recurring.verdictOf(repo, 1, SHA_A, undefined), null);
    await t.recurring.observe(repo, 1);
    assert.equal(t.jobs.findings.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('the ledger keeps the findings and the filed tickets across a restart', async () => {
  const t = await setup({}, { verdicts: { 1: notOk('no-any rule is broken'), 2: notOk('no-any rule is broken'), 3: notOk('no-any rule is broken') }, heads: { 1: SHA_A, 2: SHA_B, 3: SHA_C } });
  try {
    for (const number of [1, 2, 3]) await t.recurring.observe(repo, number);
    await t.jobs.persist(clock);
    const again = new JobStore(join(t.dir, 'jobs.json'));
    await again.load();
    assert.equal(again.findings.length, 3);
    assert.equal(again.filedFindings.size, 1);
    assert.equal([...again.filedFindings.values()][0].issue, 100);
  } finally {
    await t.cleanup();
  }
});

test('the ticket body has the preflight sections, and the reason stays inside its fenced block', () => {
  const body = ticketBody('## injected heading `x`', [{ repository: repo, reason: 'r', number: 1, sha: SHA_A, at: clock }], true);
  assert.match(body, /^## Evidence$/m);
  assert.match(body, /^## Files$/m);
  assert.match(body, /^## Steps$/m);
  assert.match(body, /^## Acceptance$/m);
  // The reason is quoted between one pair of four-backtick fences: nothing in it can open a heading or a second block.
  const parts = body.split('````');
  assert.equal(parts.length, 3);
  assert.match(parts[1], /^text\n## injected heading `x`\n$/);
});

test('the ticket body passes the ticket pre-flight, so a worker may start on it', async () => {
  const body = ticketBody('no-any rule is broken in <path>', [{ repository: repo, reason: 'r', number: 1, sha: SHA_A, at: clock }], true);
  assert.deepEqual(await ticketViolations(body), []);
});

test('an environment variable is validated: RECURRING_REASON_MIN must be a whole number from 0 to 50', () => {
  assert.throws(() => loadConfig(env({ RECURRING_REASON_MIN: '51' })), /RECURRING_REASON_MIN/);
  assert.throws(() => loadConfig(env({ RECURRING_REASON_MIN: '-1' })), /RECURRING_REASON_MIN/);
  assert.equal(loadConfig(env({ RECURRING_REASON_MIN: '3' })).recurringReasonMin, 3);
});
