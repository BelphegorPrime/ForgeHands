// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { LedgerSync, LEDGER_SYNC_BUDGET } from '../src/agent/ledger-sync.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const quiet = { error() {} };

// A ledger with the given tickets (key "repo#n:label" or "repo!pr<n>:label") and a fake forge that answers from `state`.
async function setup(tickets, state = {}, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'forgehands-sync-'));
  const config = loadConfig({
    FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
    OPENHANDS_API_URL: 'http://openhands:8000/',
    OPENHANDS_API_KEY: 'k'.repeat(24),
    ALLOWED_REPOS: repo,
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
    FORGE_TOKEN: 'tok',
    FORGE_URL: 'https://forge.example',
    DATA_FILE: join(base, 'deliveries.json'),
    ...extra
  });
  const jobs = new JobStore(join(base, 'jobs.json'));
  for (const [ticket, status = 'done', created = NOW - 86400000] of tickets) {
    const pull = ticket.includes('!');
    jobs.add({ key: ticket + ':ai:ready', label: 'ai:ready', status, created, finished: created,
      event: { repository: { full_name: repo }, ...(pull ? { pull_request: { number: Number(ticket.split('!pr')[1]) } } : { issue: { number: Number(ticket.split('#')[1]) } }) } });
  }
  const reads = [];
  const forge = {
    async getIssue(r, number) { reads.push('#' + number); const s = state['#' + number]; if (s instanceof Error) throw s; return s || { state: 'open' }; },
    async getPull(r, number) { reads.push('!pr' + number); const s = state['!pr' + number]; if (s instanceof Error) throw s; return s || { state: 'open', merged: false }; }
  };
  const closed = [];
  const sync = new LedgerSync(config, jobs, forge, quiet, async (ticket) => {
    closed.push(ticket);
    jobs.markClosed(ticket);
    return true;
  }, () => NOW);
  return { base, config, jobs, sync, reads, closed };
}

test('the ledger sync marks a closed issue and a merged pull request closed, and leaves an open one', async () => {
  const t = await setup([[repo + '#1'], [repo + '#2'], [repo + '!pr3']], { '#1': { state: 'closed' }, '!pr3': { state: 'closed', merged: true } });
  try {
    assert.equal(await t.sync.run(), 2);
    assert.deepEqual(t.closed.sort(), [repo + '!pr3', repo + '#1'].sort());
    assert.equal(t.jobs.list().find((job) => job.key.startsWith(repo + '#2:')).archived_view, undefined);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the ledger sync leaves a ticket whose read fails as it is, and counts the read', async () => {
  const t = await setup([[repo + '#1']], { '#1': new Error('HTTP 500') });
  try {
    assert.equal(await t.sync.run(), 0);
    assert.deepEqual(t.closed, []);
    assert.equal(t.jobs.list()[0].archived_view, undefined);
    assert.equal(t.jobs.list()[0].synced_at, NOW);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the ledger sync reads at most 60 tickets per pass, the ones checked longest ago first', async () => {
  const tickets = [];
  for (let n = 1; n <= 70; n++) tickets.push([repo + '#' + n]);
  const t = await setup(tickets);
  try {
    // Tickets 1 to 10 were checked recently; the others never.
    for (const job of t.jobs.list()) { const n = Number(job.key.split('#')[1].split(':')[0]); if (n <= 10) job.synced_at = NOW - 3600000 * n; }
    await t.sync.run();
    assert.equal(t.reads.length, LEDGER_SYNC_BUDGET);
    assert.equal(LEDGER_SYNC_BUDGET, 60);
    // The 60 never checked (11 to 70) are read; the recently checked 1 to 10 wait for the next pass.
    const read = new Set(t.reads);
    for (let n = 11; n <= 70; n++) assert.ok(read.has('#' + n), 'ticket ' + n + ' is read');
    for (let n = 1; n <= 10; n++) assert.ok(!read.has('#' + n), 'ticket ' + n + ' waits');
    // The next pass starts with the oldest check (ticket 10, checked 10 hours ago) and reads the budget again.
    t.reads.length = 0;
    await t.sync.run();
    assert.equal(t.reads.length, LEDGER_SYNC_BUDGET);
    assert.equal(t.reads[0], '#10');
    assert.ok(t.reads.includes('#1'));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the ledger sync skips running tickets, other repositories and dry runs, and reads waiting and queued ones; LEDGER_SYNC_HOURS=0 is off', async () => {
  const t = await setup([[repo + '#1', 'running'], [repo + '#2', 'queued'], [repo + '#4', 'waiting'], ['other/repo#3']]);
  try {
    await t.sync.run();
    assert.deepEqual(t.reads.sort(), ['#2', '#4']);
    const off = await setup([[repo + '#1']], { '#1': { state: 'closed' } }, { LEDGER_SYNC_HOURS: '0' });
    try {
      assert.equal(off.sync.enabled, false);
      assert.equal(await off.sync.run(), 0);
      assert.deepEqual(off.reads, []);
    } finally { await rm(off.base, { recursive: true, force: true }); }
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the ledger sync never throws: a failing forge ends the pass and is logged', async () => {
  const t = await setup([[repo + '#1']]);
  try {
    t.sync.forge.getIssue = async () => { throw new Error('boom'); };
    const logs = [];
    t.sync.logger = { error: (...args) => logs.push(args.join(' ')) };
    assert.equal(await t.sync.run(), 0);
    assert.ok(logs.some((line) => line.includes('boom')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

const notFound = () => new Error('GET /api/v1/repos/owner/hello/issues/1 -> HTTP 404');
const captured = (t) => { const lines = []; t.sync.logger = { error: (...args) => lines.push(args.join(' ')) }; return lines; };

test('an issue the forge answers 404 for on two passes is marked deleted once: one log line, out of the open list, and not read again', async () => {
  const state = { '#1': notFound() };
  const t = await setup([[repo + '#1']], state);
  const lines = captured(t);
  try {
    await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), false, 'one 404 is not a deletion');
    assert.equal(t.jobs.list()[0].archived_view, undefined);
    await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), true);
    assert.equal(t.jobs.list()[0].archived_view, true, 'the ticket leaves the open list of the status page');
    assert.deepEqual(lines, [repo + '#1: deleted in the forge, removed from the status page']);
    const reads = t.reads.length;
    await t.sync.run();
    await t.sync.run();
    assert.equal(t.reads.length, reads, 'a deleted ticket is not read again');
    assert.equal(lines.length, 1, 'still one line');
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a 404 once, then a read that finds the issue, is not a deletion; the count starts again', async () => {
  const state = { '#1': notFound() };
  const t = await setup([[repo + '#1']], state);
  const lines = captured(t);
  try {
    await t.sync.run();
    state['#1'] = { state: 'open' };
    await t.sync.run();
    assert.equal(t.jobs.goneChecks.has(repo + '#1'), false, 'the count is forgotten');
    state['#1'] = notFound();
    await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), false);
    assert.deepEqual(lines, []);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a 500 is unknown: the ticket is not counted, not marked deleted, and its jobs stay as they are', async () => {
  const t = await setup([[repo + '#1', 'waiting']], { '#1': new Error('GET /issues/1 -> HTTP 500') });
  const lines = captured(t);
  try {
    for (let pass = 0; pass < 3; pass++) await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), false);
    assert.equal(t.jobs.goneChecks.size, 0);
    assert.equal(t.jobs.list()[0].status, 'waiting');
    assert.ok(lines.every((line) => !line.includes('deleted in the forge')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('the 404 is confirmed by ticketGone: a look that finds the issue does not count, and a failed look changes nothing', async () => {
  const t = await setup([[repo + '#1']], { '#1': notFound() });
  const lines = captured(t);
  let answer = async () => false;
  t.sync.gone = (...args) => answer(...args);
  try {
    await t.sync.run();
    await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), false, 'ticketGone found the issue: not gone');
    answer = async () => { throw new Error('GET /issues/1 -> HTTP 503'); };
    await t.sync.run();
    await t.sync.run();
    assert.equal(t.jobs.isDeletedInForge(repo + '#1'), false, 'a failed look is unknown');
    assert.ok(lines.some((line) => line.includes('could not read')));
    assert.ok(lines.every((line) => !line.includes('deleted in the forge')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a deleted issue is remembered in the ledger file: a restart finds it deleted and does not read it', async () => {
  const t = await setup([[repo + '#1']], { '#1': notFound() });
  try {
    await t.sync.run();
    await t.sync.run();
    const again = new JobStore(join(t.base, 'jobs.json'));
    await again.load();
    assert.equal(again.isDeletedInForge(repo + '#1'), true);
    assert.equal(again.list()[0].archived_view, true);
    assert.equal(again.goneChecks.size, 0);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('a pull request answering 404 is not marked deleted in the forge (its queued jobs go at once, through the deleted callback)', async () => {
  const t = await setup([[repo + '!pr3', 'queued']], { '!pr3': notFound() });
  const lines = captured(t);
  const dropped = [];
  t.sync.deleted = async (ticket) => { dropped.push(ticket); return false; };
  try {
    await t.sync.run();
    await t.sync.run();
    assert.deepEqual(dropped, [repo + '!pr3', repo + '!pr3']);
    assert.equal(t.jobs.isDeletedInForge(repo + '!pr3'), false);
    assert.ok(lines.every((line) => !line.includes('deleted in the forge')));
  } finally { await rm(t.base, { recursive: true, force: true }); }
});
