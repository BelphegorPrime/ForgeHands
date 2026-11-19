// Prometheus metrics, written by hand (text format 0.0.4, no dependency). Counters and histograms live in memory and start at zero with the
// process (Prometheus copes with that); the gauges are read from the ledger when /metrics is asked for (see gaugeSamples).
// Callers use one-liners: metrics.inc('forgehands_merges_total', { repository }). Label values are limited to known sets (a repository of
// ALLOWED_REPOS, a route kind, a tier, a fixed reason) and never carry issue or pull request numbers, so the number of series stays bounded.
import type { DirectConfig, IdleState } from './types.ts';
import type { JobStore } from './store/jobs.ts';
import { revertRate } from './agent/revert-rate.ts';

type Labels = Record<string, string>;
interface Sample { name: string; labels: Labels; value: number }

const COUNTERS: Record<string, string> = {
  forgehands_webhook_deliveries_total: 'Webhook deliveries by Forgejo event and result (accepted, ignored, duplicate, rejected_signature, failed).',
  forgehands_runs_started_total: 'Agent runs started, by route kind.',
  forgehands_runs_finished_total: 'Agent runs that ended, by route kind and end state (finished, error, stuck, paused, deleted, timeout).',
  forgehands_merges_total: 'Pull requests merged by ForgeHands, by repository.',
  forgehands_merge_refusals_total: 'Merges ForgeHands did not do, by reason (protected_paths, no_valid_review, ci_not_green, not_mergeable, blocked, merge_failed).',
  forgehands_blocks_total: 'Tickets handed to a human, by reason.',
  forgehands_error_retries_total: 'Runs started again after they ended in an error.',
  forgehands_branch_updates_total: 'Pull request branches brought up to date with the default branch.',
  forgehands_branch_conflicts_total: 'Pull request branches that conflicted with the default branch.',
  forgehands_openhands_api_errors_total: 'Failed OpenHands API calls, by class (network, 4xx, 5xx).',
  forgehands_forgejo_api_errors_total: 'Failed Forgejo API calls, by class (network, 4xx, 5xx).',
  forgehands_escalated_rounds_total: 'Follow-up rounds sent to the stronger profile of an escalate_to route.',
  forgehands_tier_runs_total: 'Agent runs that ended, by repository, the tier they really ran on (after fallback and escalation) and result (finished, max_iterations, error, stuck, timeout, no_delivery, other).',
  forgehands_reminders_total: 'Reminders to the human about a pull request that waits for him.',
  forgehands_workspace_cleaned_total: 'Clone directories of the workspace deleted by the cleanup (WORKSPACE_CLEANUP_DIR).',
  forgehands_notifications_total: 'Notifications to the human by channel, kind (handover, blocked, conflict, failed, reminder, digest, disk_full) and result (sent, failed, dry).',
  forgehands_dry_run_writes_total: 'Writes that a dry run only logged (DRY_RUN).',
  forgehands_revert_retries_total: 'Tickets started again after their change was reverted for turning the default branch red (REVERT_RETRIES).',
  forgehands_review_sweep_starts_total: 'Reviews started by the review sweep for a head that had none in the ledger (REVIEW_SWEEP_MINUTES).',
  forgehands_conversations_deleted_total: 'Conversations deleted in OpenHands after DELETE_AFTER_DAYS (the ledger keeps the runs).',
  forgehands_comment_restarts_total: 'Runs started again because HUMAN_LOGIN commented on the issue of a failed or handed-over run (COMMENT_RESTARTS).',
  forgehands_plan_answer_restarts_total: 'Planners started again because HUMAN_LOGIN answered a plan that finished without sub-issues (PLAN_ANSWER_RESTARTS).',
  forgehands_resumes_total: 'Runs that ended stuck, timed out or paused and were continued on their own conversation, by route kind and the state they stopped in (RESUME_ATTEMPTS, PAUSE_RESUMES).',
  forgehands_ledger_sync_closed_total: 'Tickets the ledger sync (LEDGER_SYNC_HOURS) found closed or merged in the forge and marked closed on the status page.',
  forgehands_tokens_total: 'Tokens of the agent runs, added up when the run ended, by repository, the tier it really ran on, route kind and type (prompt, completion, cache_read, reasoning).',
  forgehands_wait_cycles_broken_total: 'Same-files waits not taken, or dropped, because the older ticket already waits for this one (a cycle of waits).',
  forgehands_deleted_tickets_total: 'Tickets or pull requests found deleted in the forge (a 404 on their own read); their waiting and queued jobs are dropped.',
  forgehands_nudges_total: 'Worker runs that used much of their iteration limit without a pushed branch and were told to stop exploring and push (NUDGE_AT_PERCENT), by route kind.',
  forgehands_failure_escalations_total: 'Runs that ended stuck, timed out or out of iterations (rounds), or finished twice without a delivery (issues), and started once more on the profile of their escalate_to route (FAILURE_ESCALATE).',
  forgehands_handbacks_total: 'Worker runs on an issue that handed the ticket back by a comment instead of a pull request (HANDBACK_HANDLING), by what ForgeHands did: retry (nothing pushed, run once more), escalate (blocker, run on escalate_to), planner (back to SPLIT_LABEL), blocked (a human, no planner).',
  forgehands_stuck_pr_blocks_total: 'Agent pull requests the stuck-PR watchdog blocked for a human, by reason (stuck_rounds, stuck_verdict; STUCK_PR_MINUTES).',
  forgehands_epic_gaps_total: 'Epics the epic review found still open, by action: replanned (sent back to the planner, EPIC_GAP_REPLAN) or handed (the human was called).',
  forgehands_merges_reverted_total: 'Merges ForgeHands made whose revert pull request was merged, by repository (counted once per merge).',
  forgehands_reverts_needing_human_total: 'Merges after which a red default branch needed a human (no revert route, a revert that went red, a ticket blocked after its revert), by repository.'
};
const GAUGES: Record<string, string> = {
  forgehands_jobs: 'Jobs in the ledger (it keeps 30 days), by status and route kind.',
  forgehands_jobs_waiting: 'Jobs that wait for a dependency or for a running agent to finish.',
  forgehands_queued_jobs: 'Jobs waiting for a free slot, by repository.',
  forgehands_workspace_disk_used_percent: 'Used share of the filesystem of WORKSPACE_CLEANUP_DIR, in percent (absent while the cleanup is off).',
  forgehands_workspace_disk_free_bytes: 'Bytes available to ForgeHands on the filesystem of WORKSPACE_CLEANUP_DIR (absent while the cleanup is off).',
  forgehands_tier_cooldown_active: '1 while the model of a tier is out of quota and no run of it starts, by tier.',
  forgehands_idle_jobs: 'Queued and waiting jobs by what holds them back now (dependencies, files, quota, disk, hourly, concurrency, cycle, stuck); 0 while nothing waits.',
  forgehands_stuck_pull_requests: 'Agent pull requests blocked for a human (BLOCKED_LABEL) that tickets may wait behind, from the ledger at the scrape.',
  forgehands_e2e_scenario_ok: '1 when the steps of the scenario held in the last end-to-end run (E2E_REPO), 0 when a step failed; absent until a run.',
  forgehands_e2e_cleanup_ok: '1 when the cleanup of the scenario held in the last end-to-end run (E2E_REPO), 0 when it did not; absent until a run.',
  forgehands_merges_reverted_ratio: 'Share (0 to 1) of the merges ForgeHands made in the last 30 days whose revert was merged, by repository; absent without merges in the window.'
};
// The reasons of forgehands_idle_jobs (`could_start` is not one: it is a job that should have started).
const IDLE_REASONS = ['dependencies', 'files', 'quota', 'disk', 'hourly', 'concurrency', 'cycle', 'stuck'] as const;
const HISTOGRAM = { name: 'forgehands_run_duration_seconds', help: 'Time from the start to the end of an agent run, by route kind.', buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400] };

export const WEBHOOK_EVENTS = ['issues', 'issue_label', 'issue_comment', 'pull_request', 'push', 'action_run_failure', 'action_run_success', 'workflow_run',
  'pull_request_approved', 'pull_request_rejected', 'pull_request_review_approved', 'pull_request_review_rejected', 'pull_request_review_comment',
  'Issue Hook', 'Merge Request Hook', 'Pipeline Hook', 'Push Hook'];
const STATUSES = ['waiting', 'queued', 'running', 'done', 'failed', 'deleted'];
const KINDS = ['issue', 'pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict', 'sensitive_review', 'main_red'];

const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const series = (name: string, labels: Labels): string => {
  const pairs = Object.entries(labels).sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => key + '="' + escapeLabel(String(value)) + '"');
  return name + (pairs.length ? '{' + pairs.join(',') + '}' : '');
};
const number = (value: number): string => Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);

// A label value outside the known set becomes `other`, so that nothing a caller or a sender controls makes new series.
export const known = (value: unknown, set: Iterable<string>, fallback = 'other'): string => [...set].includes(String(value)) ? String(value) : fallback;

class Metrics {
  counters = new Map<string, number>(); // series -> value
  buckets = new Map<string, { counts: number[]; sum: number; count: number; labels: Labels }>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const key = series(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + by);
  }
  // Counts a merge refusal and passes the reason on: `return metrics.refused('ci_not_green')`.
  refused(reason: string): string {
    this.inc('forgehands_merge_refusals_total', { reason });
    return reason;
  }
  // A failed call to OpenHands or Forgejo: no status means the request itself failed (network, timeout). 404 of OpenHands is not counted:
  // a deleted conversation is an ordinary answer.
  apiError(service: 'openhands' | 'forgejo', status: number | null): void {
    if (service === 'openhands' && status === 404) return;
    this.inc('forgehands_' + service + '_api_errors_total', { class: status === null ? 'network' : status >= 500 ? '5xx' : '4xx' });
  }
  observe(labels: Labels, seconds: number): void {
    const key = series(HISTOGRAM.name, labels);
    const entry = this.buckets.get(key) || { counts: HISTOGRAM.buckets.map(() => 0), sum: 0, count: 0, labels };
    HISTOGRAM.buckets.forEach((limit, i) => { if (seconds <= limit) entry.counts[i] += 1; });
    entry.sum += seconds;
    entry.count += 1;
    this.buckets.set(key, entry);
  }
  reset(): void {
    this.counters.clear();
    this.buckets.clear();
  }

  // The whole page: HELP and TYPE of every metric (also those without a sample yet), the counters, the histogram, then the given gauges.
  render(gauges: Sample[] = []): string {
    const lines: string[] = [];
    const head = (name: string, help: string, type: string) => lines.push('# HELP ' + name + ' ' + escapeHelp(help), '# TYPE ' + name + ' ' + type);
    for (const [name, help] of Object.entries(COUNTERS)) {
      head(name, help, 'counter');
      const mine = [...this.counters].filter(([key]) => key === name || key.startsWith(name + '{')).sort(([a], [b]) => a < b ? -1 : 1);
      if (!mine.length && !Object.hasOwn(LABELLED, name)) lines.push(name + ' 0');
      for (const [key, value] of mine) lines.push(key + ' ' + number(value));
    }
    head(HISTOGRAM.name, HISTOGRAM.help, 'histogram');
    for (const [, entry] of [...this.buckets].sort(([a], [b]) => a < b ? -1 : 1)) {
      HISTOGRAM.buckets.forEach((limit, i) => lines.push(series(HISTOGRAM.name + '_bucket', { ...entry.labels, le: String(limit) }) + ' ' + entry.counts[i]));
      lines.push(series(HISTOGRAM.name + '_bucket', { ...entry.labels, le: '+Inf' }) + ' ' + entry.count);
      lines.push(series(HISTOGRAM.name + '_sum', entry.labels) + ' ' + number(entry.sum));
      lines.push(series(HISTOGRAM.name + '_count', entry.labels) + ' ' + entry.count);
    }
    for (const [name, help] of Object.entries(GAUGES)) {
      head(name, help, 'gauge');
      for (const sample of gauges.filter((entry) => entry.name === name)) lines.push(series(name, sample.labels) + ' ' + number(sample.value));
    }
    return lines.join('\n') + '\n';
  }
}
// Counters that always carry labels: without a sample they show no line (a bare `name 0` would be a series of its own).
const LABELLED: Record<string, true> = Object.fromEntries(['forgehands_webhook_deliveries_total', 'forgehands_runs_started_total', 'forgehands_runs_finished_total', 'forgehands_merges_total',
  'forgehands_merge_refusals_total', 'forgehands_blocks_total', 'forgehands_tier_runs_total', 'forgehands_openhands_api_errors_total', 'forgehands_forgejo_api_errors_total', 'forgehands_notifications_total', 'forgehands_resumes_total', 'forgehands_nudges_total', 'forgehands_tokens_total', 'forgehands_wait_cycles_broken_total', 'forgehands_stuck_pr_blocks_total', 'forgehands_epic_gaps_total', 'forgehands_merges_reverted_total', 'forgehands_reverts_needing_human_total'].map((name) => [name, true]));

export const metrics = new Metrics();

// The gauges, read from the ledger and the dispatcher's quota holds at the moment of the scrape. `disk` is the workspace's last reading
// (null while the cleanup is off, then no disk gauge is written).
export function gaugeSamples(config: DirectConfig, jobs: JobStore, cooldowns: Map<string, number>, now: number, disk: { usedPercent: number | null; freeBytes: number | null } | null = null,
  idle: IdleState | null = null): Sample[] {
  const samples: Sample[] = [];
  if (disk && disk.usedPercent !== null) samples.push({ name: 'forgehands_workspace_disk_used_percent', labels: {}, value: disk.usedPercent });
  if (disk && disk.freeBytes !== null) samples.push({ name: 'forgehands_workspace_disk_free_bytes', labels: {}, value: disk.freeBytes });
  const all = jobs.list();
  const kindOf = (label: string): string => config.routes.get(label)?.kind || 'issue';
  for (const status of STATUSES) {
    for (const kind of KINDS) samples.push({ name: 'forgehands_jobs', labels: { status, kind }, value: all.filter((job) => job.status === status && kindOf(job.label) === kind).length });
  }
  samples.push({ name: 'forgehands_jobs_waiting', labels: {}, value: all.filter((job) => job.status === 'waiting').length });
  for (const repo of [...config.allowedRepos].sort()) {
    samples.push({ name: 'forgehands_queued_jobs', labels: { repository: repo }, value: all.filter((job) => job.status === 'queued' && String(job.event?.repository?.full_name).toLowerCase() === repo).length });
  }
  for (const reason of IDLE_REASONS) samples.push({ name: 'forgehands_idle_jobs', labels: { reason }, value: idle?.reasons[reason] ?? 0 });
  samples.push({ name: 'forgehands_stuck_pull_requests', labels: {}, value: [...jobs.stuck.values()].filter((record) => record.blocked).length });
  for (const repo of [...config.allowedRepos].sort()) {
    const rate = revertRate(jobs.merges, repo, now).ratio;
    if (rate !== null) samples.push({ name: 'forgehands_merges_reverted_ratio', labels: { repository: repo }, value: rate });
  }
  for (const tier of [...new Set([...config.routes.values()].map((route) => route.tier))].sort()) {
    samples.push({ name: 'forgehands_tier_cooldown_active', labels: { tier }, value: (cooldowns.get(tier) || 0) > now ? 1 : 0 });
  }
  return samples;
}
