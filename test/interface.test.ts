// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The public interface that the versioning promise covers (README, "Stability and versioning"). A test here fails when a change touches
// that interface: then the change is deliberate, the README and .env.example say so, and the release notes name it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_VERSION } from '../src/store/jobs.ts';
import { createForge } from '../src/forge/index.ts';

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
  'forgehands_blocks_total', 'forgehands_branch_conflicts_total', 'forgehands_branch_updates_total', 'forgehands_comment_ignored_total',
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
