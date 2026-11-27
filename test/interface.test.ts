// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The public interface that the versioning promise covers (README, "Stability and versioning"). A test here fails when a change touches
// that interface: then the change is deliberate, the README and .env.example say so, and the release notes name it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEDGER_VERSION, JobStore } from '../src/store/jobs.ts';
import { createForge } from '../src/forge/index.ts';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';

// Every .ts file under src/.
function sources(dir = 'src') {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}
const code = sources().join('\n');
const readme = readFileSync('README.md', 'utf8');
const example = readFileSync('.env.example', 'utf8');

// Variables that are read only to warn that they were removed.
const REMOVED = new Set(['TIER_WEEKLY_BUDGETS']);

test('every environment variable ForgeHands reads is documented in the README and in .env.example', () => {
  const read = [...new Set([...code.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]))].filter((name) => !REMOVED.has(name));
  assert.ok(read.length > 50, 'the variables are found at all');
  const inReadme = read.filter((name) => !readme.includes('`' + name + '`'));
  assert.deepEqual(inReadme, [], 'not documented in a README table');
  const inExample = read.filter((name) => !new RegExp('\\b' + name + '\\b').test(example));
  assert.deepEqual(inExample, [], 'not in .env.example');
});

// The metric names are part of the interface: dashboards and alerts are built on them.
const METRICS = [
  'forgehands_blocks_total', 'forgehands_branch_conflicts_total', 'forgehands_branch_updates_total', 'forgehands_clone_breaker_state', 'forgehands_comment_ignored_total',
  'forgehands_comment_restarts_total', 'forgehands_conversations_deleted_total', 'forgehands_deleted_tickets_total', 'forgehands_dry_run_writes_total',
  'forgehands_epic_gaps_total', 'forgehands_epic_sweep_starts_total', 'forgehands_error_retries_total', 'forgehands_escalated_rounds_total',
  'forgehands_failure_escalations_total', 'forgehands_forgejo_api_errors_total', 'forgehands_handbacks_total', 'forgehands_idle_jobs', 'forgehands_jobs',
  'forgehands_jobs_waiting', 'forgehands_ledger_sync_closed_total', 'forgehands_merge_decisions_total', 'forgehands_merge_refusals_total',
  'forgehands_merges_reverted_ratio', 'forgehands_merges_reverted_total', 'forgehands_merges_total', 'forgehands_notifications_total', 'forgehands_nudges_total',
  'forgehands_openhands_api_errors_total', 'forgehands_plan_answer_restarts_total', 'forgehands_preflight_total', 'forgehands_queued_jobs',
  'forgehands_reminders_total', 'forgehands_resumes_total', 'forgehands_revert_retries_total', 'forgehands_reverts_needing_human_total',
  'forgehands_review_sweep_starts_total', 'forgehands_run_duration_seconds', 'forgehands_runs_finished_total', 'forgehands_runs_started_total',
  'forgehands_stalled_ticket_actions_total', 'forgehands_stalled_tickets', 'forgehands_stuck_pr_blocks_total', 'forgehands_stuck_pull_requests',
  'forgehands_tier_cooldown_active', 'forgehands_tier_runs_total', 'forgehands_tokens_total', 'forgehands_wait_cycles_broken_total',
  'forgehands_webhook_deliveries_total', 'forgehands_workspace_cleaned_total', 'forgehands_workspace_disk_free_bytes', 'forgehands_workspace_disk_used_percent'
];

test('the metric names are the ones the versioning promise lists: a new one is added here, a removed or renamed one is a breaking change', () => {
  const found = [...new Set([...code.matchAll(/\bforgehands_[a-z_]+\b/g)].map((match) => match[0]))].filter((name) => name !== 'forgehands_status').sort();
  assert.deepEqual(found, [...METRICS].sort());
});

test('the webhook paths and the ledger file version are the ones the versioning promise lists', () => {
  const call = async () => null;
  assert.deepEqual(['forgejo', 'gitea', 'gitlab'].map((forge) => createForge({ forge }, call).webhookPath), ['/webhooks/forgejo', '/webhooks/gitea', '/webhooks/gitlab']);
  // A new version needs a step in MIGRATIONS (src/store/jobs.ts) and an upgrade note; this line is changed with them.
  assert.equal(LEDGER_VERSION, 2);
});

// The clone breaker is exercised through the real status handler and a fixed clock: only state and timing may leave the ledger.
const BREAKER_NOW = Date.UTC(2026, 5, 30, 12);
const breakerRecord = (fields) => ({ state: 'closed', incident: 0, opened_at: null, retry_at: null, trial: null, notified: false, failures: [], ...fields });

async function serveBreaker(record) {
  const dir = await mkdtemp(join(tmpdir(), 'forgehands-breaker-'));
  const config = loadConfig({
    FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
    OPENHANDS_API_URL: 'http://openhands:8000/',
    OPENHANDS_API_KEY: 'k'.repeat(24),
    ALLOWED_REPOS: 'owner/hello',
    LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: '22222222-2222-4222-8222-222222222222', tier: 'free' } }),
    DATA_FILE: join(dir, 'deliveries.json'),
    STATUS_PUBLIC: '1'
  });
  const jobs = new JobStore(join(dir, 'jobs.json'));
  jobs.meta.clone_breaker = record;
  const dispatcher = new Dispatcher(config, jobs, async () => ({ ok: true, status: 200, json: async () => ({}) }), { error() {} }, () => BREAKER_NOW);
  const server = createApp(config, new DeliveryStore(config.dataFile), undefined, { error() {} }, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  };
}

async function breakerViews(base) {
  const json = await (await fetch(base + '/status.json')).text();
  const html = await (await fetch(base + '/status')).text();
  const metrics = await (await fetch(base + '/metrics')).text();
  return { json, body: JSON.parse(json), html, metrics };
}

test('a held clone breaker is published as state and timing, and the status views show no evidence', async () => {
  const openedAt = BREAKER_NOW - 2 * 60_000;
  const retryAt = BREAKER_NOW + 8 * 60_000;
  const server = await serveBreaker(breakerRecord({
    state: 'open', incident: 1, opened_at: openedAt, retry_at: retryAt, notified: true,
    failures: [{ class: 'auth_failed', repository: 'owner/hello', at: openedAt, conversation: 'conversation-secret-held' }]
  }));
  try {
    const { json, body, html, metrics } = await breakerViews(server.base);
    assert.deepEqual(body.clone_breaker, {
      state: 'open',
      since: new Date(openedAt).toISOString(),
      retry_at: new Date(retryAt).toISOString(),
      trial_until: null
    });
    assert.match(html, /Clone breaker/);
    assert.match(html, /Held since/);
    assert.ok(html.includes(new Date(retryAt).toISOString()), 'the next trial time is readable');
    assert.match(metrics, /^forgehands_clone_breaker_state 2$/m);
    for (const secret of ['conversation-secret-held', 'auth_failed', 'owner/hello#']) {
      assert.equal(json.includes(secret), false, 'the JSON leaks ' + secret);
      assert.equal(html.includes(secret), false, 'the HTML leaks ' + secret);
    }
  } finally {
    await server.close();
  }
});

test('a half-open trial is published with its deadline, and nothing about its owner or conversation', async () => {
  const deadline = BREAKER_NOW + 5 * 60_000;
  const server = await serveBreaker(breakerRecord({
    state: 'half_open', incident: 1, opened_at: BREAKER_NOW - 20 * 60_000, retry_at: BREAKER_NOW - 5 * 60_000, notified: true,
    trial: { owner: 'owner/hello#7', conversation: 'conversation-secret-trial', started: BREAKER_NOW - 60_000, deadline },
    failures: [{ class: 'clone_failed', repository: 'owner/hello', at: BREAKER_NOW - 20 * 60_000, conversation: 'conversation-secret-held' }]
  }));
  try {
    const { json, body, html, metrics } = await breakerViews(server.base);
    assert.equal(body.clone_breaker.state, 'half_open');
    assert.equal(body.clone_breaker.retry_at, new Date(BREAKER_NOW - 5 * 60_000).toISOString());
    assert.equal(body.clone_breaker.trial_until, new Date(deadline).toISOString());
    assert.match(html, /Half-open/);
    assert.match(html, /One trial is running/);
    assert.match(metrics, /^forgehands_clone_breaker_state 1$/m);
    for (const secret of ['owner/hello#7', 'conversation-secret-trial', 'conversation-secret-held', 'clone_failed']) {
      assert.equal(json.includes(secret), false, 'the JSON leaks ' + secret);
      assert.equal(html.includes(secret), false, 'the HTML leaks ' + secret);
    }
  } finally {
    await server.close();
  }
});

test('a recovered clone breaker publishes closed with no timing left, and the views say how it recovers', async () => {
  const server = await serveBreaker(breakerRecord({
    state: 'closed', incident: 1,
    failures: [{ class: 'clone_failed', repository: 'owner/hello', at: BREAKER_NOW - 60_000, conversation: 'conversation-secret-recovered' }]
  }));
  try {
    const { json, body, html, metrics } = await breakerViews(server.base);
    assert.deepEqual(body.clone_breaker, { state: 'closed', since: null, retry_at: null, trial_until: null });
    assert.match(html, /Recovered\./);
    assert.match(html, /positive checkout evidence/);
    assert.match(metrics, /^forgehands_clone_breaker_state 0$/m);
    assert.equal(json.includes('conversation-secret-recovered'), false);
    assert.equal(html.includes('conversation-secret-recovered'), false);
  } finally {
    await server.close();
  }
});
