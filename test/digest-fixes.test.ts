// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { collectFixes, isFixTitle } from '../src/notify/digest.ts';
import { digestMessage } from '../src/notify/texts.ts';

const repo = 'owner/hello';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const quiet = { error() {} };

// A pull request as the forge lists it (state closed, merged) and what a single read says about who merged it.
// `files` are what GET /pulls/{n}/files answers; `merger` is the login the single read reports (merged_by).
function pr(number, title, mergedAgo, branch, files, merger = 'openhands', extra = {}) {
  const at = new Date(NOW - mergedAgo).toISOString();
  return { number, title, state: 'closed', merged: true, merged_at: at, updated_at: at, html_url: 'https://forge.example/' + repo + '/pulls/' + number,
    head: { ref: branch }, user: { login: 'bot' }, files, merger, ...extra };
}

async function setup(pulls, { failFiles = [], failPulls = [], listError = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'forgehands-fix-'));
  const config = loadConfig({
    FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
    OPENHANDS_API_URL: 'http://openhands:8000/',
    OPENHANDS_API_KEY: 'k'.repeat(24),
    ALLOWED_REPOS: repo,
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: '22222222-2222-4222-8222-222222222222', tier: 'free' } }),
    FORGEJO_TOKEN: 'tok',
    FORGEJO_URL: 'https://forge.example',
    DATA_FILE: join(base, 'deliveries.json')
  });
  const jobs = new JobStore(join(base, 'jobs.json'));
  const logs = [];
  const logger = { error: (...args) => logs.push(args.join(' ')) };
  const forge = {
    async agentLogin() { return 'openhands'; },
    async listPulls(name, options) {
      if (listError) throw new Error('listing failed');
      return options.page === 1 ? pulls.map(({ files, merger, ...rest }) => rest) : [];
    },
    async getPull(name, number) {
      if (failPulls.includes(number)) throw new Error('HTTP 500');
      const found = pulls.find((entry) => entry.number === number);
      return { number, merged: true, merged_by: { login: found.merger } };
    },
    async pullFiles(name, number) {
      if (failFiles.includes(number)) throw new Error('HTTP 500');
      return pulls.find((entry) => entry.number === number).files.map((filename) => ({ filename }));
    }
  };
  return { base, config, jobs, forge, logs, logger };
}

test('isFixTitle reads the Conventional Commit type fix, with a scope or a breaking mark, and nothing else', () => {
  assert.ok(isFixTitle('fix: the thing'));
  assert.ok(isFixTitle('fix(ledger): the thing'));
  assert.ok(isFixTitle('WIP: fix(ledger)!: the thing'));
  assert.ok(!isFixTitle('feat: the thing'));
  assert.ok(!isFixTitle('prefix: fix the thing'));
  assert.ok(!isFixTitle('fixup: the thing'));
});

test('a fix pull request on the same file within 48 hours follows an automatic merge: 1 of 1', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']), pr(11, 'fix: a', 3 * DAY - 10 * HOUR, 'ai/issue-11', ['a.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.equal(quote.total, 1);
    assert.equal(quote.fixed, 1);
    assert.equal(quote.pairs[0].original.number, 10);
    assert.equal(quote.pairs[0].fix.number, 11);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a fix more than 48 hours after the merge does not count', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']), pr(11, 'fix: a', 3 * DAY - 49 * HOUR, 'ai/issue-11', ['a.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.deepEqual([quote.fixed, quote.total], [0, 1]);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a fix on other files does not count', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']), pr(11, 'fix: b', 3 * DAY - 2 * HOUR, 'ai/issue-11', ['b.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.deepEqual([quote.fixed, quote.total], [0, 1]);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a pull request whose type is not fix does not count', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']), pr(11, 'feat: change a', 3 * DAY - 2 * HOUR, 'ai/issue-11', ['a.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.deepEqual([quote.fixed, quote.total], [0, 1]);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a merge by a human is not an automatic merge: with none, the figure is skipped (null)', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go'], 'marcel'), pr(11, 'fix: a', 3 * DAY - 2 * HOUR, 'ai/issue-11', ['a.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    assert.equal(await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger), null);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a merge older than 7 days is outside the figure', async () => {
  const pulls = [pr(10, 'feat: add a', 8 * DAY, 'ai/issue-10', ['a.go']), pr(11, 'fix: a', 8 * DAY - 2 * HOUR, 'ai/issue-11', ['a.go'], 'marcel')];
  const t = await setup(pulls);
  try {
    assert.equal(await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger), null);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a failing read skips that pull request and says so in the log; the others still count', async () => {
  const pulls = [
    pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']),
    pr(11, 'fix: a', 3 * DAY - 2 * HOUR, 'ai/issue-11', ['a.go'], 'marcel'),
    pr(20, 'feat: add c', 2 * DAY, 'ai/issue-20', ['c.go']),
    pr(21, 'fix: c', 2 * DAY - 2 * HOUR, 'ai/issue-21', ['c.go'], 'marcel')
  ];
  const t = await setup(pulls, { failFiles: [11] });
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.deepEqual([quote.fixed, quote.total], [1, 2]);
    assert.equal(quote.pairs[0].original.number, 20);
    assert.ok(t.logs.some((line) => line.includes('owner/hello #11')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a failing single read leaves that pull request out of the count and is logged', async () => {
  const pulls = [pr(10, 'feat: add a', 3 * DAY, 'ai/issue-10', ['a.go']), pr(20, 'feat: add c', 2 * DAY, 'ai/issue-20', ['c.go'])];
  const t = await setup(pulls, { failPulls: [10] });
  try {
    const quote = await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger);
    assert.deepEqual([quote.fixed, quote.total], [0, 1]);
    assert.ok(t.logs.some((line) => line.includes('#10')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a failing listing skips the repository and the figure is skipped', async () => {
  const t = await setup([], { listError: true });
  try {
    assert.equal(await collectFixes(t.config, t.jobs, t.forge, NOW, t.logger), null);
    assert.ok(t.logs.some((line) => line.includes('listing failed')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

// The text of the block: one line, the links only for up to 5 pairs; a digest needs something for the human (here a waiting item).
const waiting = [{ repository: repo, number: 140, title: 'T', days: 1 }];
const quoteOf = (fixed, total, pairs = []) => ({ fixed, total, pairs });
const pair = (n) => ({ fix: { repository: repo, number: 100 + n, title: 'fix', url: 'https://forge.example/' + repo + '/pulls/' + (100 + n) }, original: { repository: repo, number: n, title: 'feat' } });

test('the digest shows the follow-up figure as one line in English, with the pairs as links up to 5', () => {
  const en = digestMessage('en', { waiting, blocked: [], failed: [], quota: [], merged: 0, fixes: quoteOf(1, 4, [pair(1)]) }, false);
  assert.match(en.text, /Follow-up fixes after automatic merges \(7 days\): 1 of 4 \(25 %\)/);
  assert.match(en.text, /owner\/hello #101 fixes owner\/hello #1/);
  assert.match(en.text, /https:\/\/forge\.example\/owner\/hello\/pulls\/101/);
  const many = digestMessage('en', { waiting, blocked: [], failed: [], quota: [], merged: 0, fixes: quoteOf(6, 10, [1, 2, 3, 4, 5, 6].map(pair)) }, false);
  assert.match(many.text, /Follow-up fixes after automatic merges \(7 days\): 6 of 10 \(60 %\)/);
  assert.doesNotMatch(many.text, /fixes owner\/hello #1\b/);
});

test('the digest shows the follow-up figure in German', () => {
  const de = digestMessage('de', { waiting, blocked: [], failed: [], quota: [], merged: 0, fixes: quoteOf(1, 4, [pair(1)]) }, false);
  assert.match(de.text, /Folgefixes nach automatischen Merges \(7 Tage\): 1 von 4 \(25 %\)/);
  assert.match(de.text, /owner\/hello #101 behebt owner\/hello #1/);
});

test('the figure is not a digest by itself and is left out when there is no automatic merge to count', () => {
  assert.equal(digestMessage('en', { waiting: [], blocked: [], failed: [], quota: [], merged: 3, fixes: quoteOf(1, 4, [pair(1)]) }, false), null);
  const none = digestMessage('en', { waiting, blocked: [], failed: [], quota: [], merged: 0, fixes: null }, false);
  assert.doesNotMatch(none.text, /Follow-up fixes/);
});
