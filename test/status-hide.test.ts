// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildStatus, renderStatus } from '../src/server/status.ts';
import { createApp } from '../src/server/app.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const DAY = 86400000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

async function setup(extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'forgehands-hide-'));
  const config = loadConfig({
    FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
    OPENHANDS_API_URL: 'http://openhands:8000/',
    OPENHANDS_API_KEY: 'k'.repeat(24),
    ALLOWED_REPOS: repo,
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
    DATA_FILE: join(base, 'deliveries.json'),
    ...extra
  });
  const jobs = new JobStore(join(base, 'jobs.json'));
  // #1 closed and last active 20 days ago, #2 closed and active 2 days ago, #3 open and active 30 days ago, #4 closed 8 days ago.
  const add = (issue, ago, archived) => jobs.add({ key: repo + '#' + issue + ':ai:ready', label: 'ai:ready', status: 'done', created: NOW - ago, finished: NOW - ago + 1000,
    archived_view: archived, event: { repository: { full_name: repo }, issue: { number: issue, title: 'Ticket ' + issue } } });
  add(1, 20 * DAY, true);
  add(2, 2 * DAY, true);
  add(3, 30 * DAY, undefined);
  add(4, 8 * DAY, true);
  return { base, config, jobs };
}

test('closed tickets older than STATUS_HIDE_DAYS are left out of the status, recent and open ones stay, and the count says how many', async () => {
  const t = await setup();
  try {
    assert.equal(t.config.statusHideDays, 7);
    const status = buildStatus(t.config, t.jobs, NOW);
    assert.deepEqual(status.issues.map((issue) => issue.issue).sort(), [repo + '#2', repo + '#3'].sort());
    assert.equal(status.hidden, 2);
    const page = renderStatus(status);
    assert.match(page, /2 older closed ticket\(s\) hidden: show all/);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('?all=1 (buildStatus with all) lists everything, and STATUS_HIDE_DAYS=0 hides nothing', async () => {
  const t = await setup();
  try {
    const all = buildStatus(t.config, t.jobs, NOW, undefined, [], null, { all: true });
    assert.equal(all.issues.length, 4);
    assert.equal(all.hidden, 0);
    const off = await setup({ STATUS_HIDE_DAYS: '0' });
    try {
      const status = buildStatus(off.config, off.jobs, NOW);
      assert.equal(status.issues.length, 4);
      assert.equal(status.hidden, 0);
    } finally { await rm(off.base, { recursive: true, force: true }); }
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the summary counters are not affected by hiding', async () => {
  const t = await setup();
  try {
    const shown = buildStatus(t.config, t.jobs, NOW, undefined, [], null, { all: true });
    const hiding = buildStatus(t.config, t.jobs, NOW);
    assert.deepEqual(hiding.summary, shown.summary);
    assert.deepEqual(hiding.limits, shown.limits);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('/status.json returns the hidden count, and ?all=1 returns every ticket (the route compares the path, not the whole URL)', async () => {
  const t = await setup();
  const dispatcher = { jobs: t.jobs, dry: undefined, merger: { decisions: new Map() }, reminder: { waiting: new Map() }, workspace: { state: () => null, enabled: false }, cooldowns: new Map(), idleState: () => null };
  const server = createApp(t.config, { acquire: () => 'new', mark: async () => {}, release: () => {} }, fetch, { error() {} }, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const plain = await (await fetch(base + '/status.json')).json();
    assert.equal(plain.hidden, 2);
    assert.equal(plain.issues.length, 2);
    const all = await (await fetch(base + '/status.json?all=1')).json();
    assert.equal(all.hidden, 0);
    assert.equal(all.issues.length, 4);
    const page = await (await fetch(base + '/status?all=1')).text();
    assert.match(page, /<title>ForgeHands status<\/title>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(t.base, { recursive: true, force: true });
  }
});
