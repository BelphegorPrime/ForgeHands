import { isDry } from '../dry.ts';
import type { DryLog, DryWrite } from '../dry.ts';
import type { DirectConfig, Job } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';

interface Run {
  label: string; kind: string; status: string; result: string | undefined; conversation: string | null; pr: number | null;
  started: string | null; finished: string | null; cost: number | null; retry_at: number | undefined; waiting_for: number[] | undefined; waiting_for_files: number[] | undefined;
  waiting_for_run: true | undefined; escalated: string | undefined; fell_back: string | undefined; created: number;
}
export interface Summary {
  merged: number; merged_without_human: number; blocked: number; split: number;
  merge_seconds: { median: number | null; p90: number | null };
  rounds_per_merged: number | null; review_retries: number; error_retries: number; cost: number;
}
export interface Status {
  generated: string;
  limits: { running: number; max_concurrent: number; max_rounds: number; max_runs_per_hour: number };
  dry_run: { repositories: string[] | 'all'; would_write: DryWrite[] } | null;
  summary: Record<string, { last_7_days: Summary; last_30_days: Summary }>;
  issues: { issue: string; title: string; pr: number | null; rounds: number; state: string; runs: Omit<Run, 'created'>[] }[];
  // Pull requests that wait for the human (REMIND_AFTER_DAYS), as the last daily look found them.
  waiting_for_human: { repository: string; issue: number; pr: number; since: string; reason: string }[];
}

const DAY_MS = 24 * 3600 * 1000;
const ROUND_KINDS = new Set<string | undefined>(['pull_request', 'ci_failure', 'conflict']);

// Nearest rank percentile of a sorted list; null for an empty one.
const percentile = (sorted: number[], p: number): number | null => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;

// What the ledger (30 days) says about the work of the last `days` days, per repository and over the tickets (repo#issue) of its jobs.
// A ticket counts as merged when ForgeHands merged its pull request or saw it merged (`merged_at`), as merged without a human when ForgeHands
// merged it and it was never handed to a human (BLOCKED_LABEL). Time to merge runs from the first run of the ticket (its trigger label).
// Retries and cost add up over the runs created in the window.
function summarize(config: DirectConfig, jobs: Job[], days: number, now: number): Record<string, Summary> {
  const since = now - days * DAY_MS;
  const repos = new Map<string, Job[]>([...config.allowedRepos].map((repo): [string, Job[]] => [repo, []]));
  for (const job of jobs) {
    const repo = String(job.event?.repository?.full_name || job.key.split('#')[0]).toLowerCase();
    repos.set(repo, [...(repos.get(repo) || []), job]);
  }
  const result: Record<string, Summary> = {};
  for (const [repo, list] of repos) {
    const tickets = new Map<string, Job[]>();
    for (const job of list) tickets.set(job.key.split(':')[0], [...(tickets.get(job.key.split(':')[0]) || []), job]);
    const fresh = list.filter((job) => job.created >= since);
    const times: number[] = [];
    let merged = 0; let free = 0; let blocked = 0; let split = 0; let rounds = 0;
    for (const ticket of tickets.values()) {
      const mergedAt = Math.max(0, ...ticket.map((job) => job.merged_at || 0));
      const at = (field: 'blocked_at' | 'split_at') => Math.max(0, ...ticket.map((job) => job[field] || 0));
      if (at('blocked_at') >= since) blocked += 1;
      if (at('split_at') >= since) split += 1;
      if (!mergedAt || mergedAt < since) continue;
      merged += 1;
      if (ticket.some((job) => job.merged_at === mergedAt && job.merged_by === 'agent') && !at('blocked_at')) free += 1;
      times.push(Math.max(0, Math.round((mergedAt - Math.min(...ticket.map((job) => job.created))) / 1000)));
      rounds += ticket.filter((job) => ROUND_KINDS.has(config.routes.get(job.label)?.kind) && (job.started || job.status !== 'failed')).length;
    }
    times.sort((a, b) => a - b);
    result[repo] = {
      merged, merged_without_human: free, blocked, split,
      merge_seconds: { median: percentile(times, 0.5), p90: percentile(times, 0.9) },
      rounds_per_merged: merged ? Math.round(rounds / merged * 100) / 100 : null,
      review_retries: fresh.reduce((sum, job) => sum + (job.verdict_retry || 0), 0),
      error_retries: fresh.reduce((sum, job) => sum + (job.error_retry || 0), 0),
      cost: Math.round(fresh.reduce((sum, job) => sum + (job.cost || 0), 0) * 1000) / 1000
    };
  }
  return result;
}

// What ForgeHands knows about the work in flight, from its ledger: per issue the runs, their kind, state and cost.
// Read only, no event text beyond the issue title; it says nothing about Forgejo's side (the pull request itself).
const KIND_TEXT: Record<string, string> = {
  issue: 'worker', pull_request: 'follow-up round', ci_failure: 'fix after red CI', ci_success: 'review', epic_done: 'epic review', conflict: 'conflict round', sensitive_review: 'security review'
};

// One line for the current state of an issue, from its newest relevant run.
function stateOf(runs: Run[], maxRounds: number, rounds: number): string {
  const active = runs.find((run) => run.status === 'running' || run.status === 'queued');
  if (active && active.retry_at && active.status === 'queued') return 'model quota used up, ' + KIND_TEXT[active.kind] + ' tries again after ' + new Date(active.retry_at).toISOString().slice(11, 16) + ' UTC';
  if (active) return (active.status === 'queued' ? 'queued: ' : '') + KIND_TEXT[active.kind] + ' running' + (active.escalated ? ' (escalated to ' + active.escalated + ')' : '') + (active.fell_back ? ' (fallback to ' + active.fell_back + ')' : '');
  const waiting = runs.find((run) => run.status === 'waiting');
  if (waiting?.waiting_for_files?.length && !waiting.waiting_for?.length) return 'waiting for ' + waiting.waiting_for_files.map((n: number) => '#' + n).join(', ') + ' (same files)';
  if (waiting) return waiting.waiting_for_run ? 'CI result kept, waiting for the running agent to finish' : 'waiting for ' + (waiting.waiting_for || []).map((n: number) => '#' + n).join(', ');
  const last = runs[0];
  if (!last) return 'idle';
  if (last.status === 'dry') return KIND_TEXT[last.kind] + ' would start (dry run)';
  if (last.status === 'failed') return KIND_TEXT[last.kind] + ' failed' + (last.result ? ' (' + last.result + ')' : '');
  if (rounds >= maxRounds) return 'rounds used up (' + rounds + '/' + maxRounds + ')';
  return KIND_TEXT[last.kind] + ' done, waiting for the next event';
}

export function buildStatus(config: DirectConfig, jobs: JobStore, now = Date.now(), dry?: DryLog, waiting: { repository: string; issue: number; pr: number; since: number; reason: string }[] = []): Status {
  const byIssue = new Map<string, { key: string; title: string; runs: Run[] }>();
  for (const job of jobs.list()) {
    const base = job.key.split(':')[0];
    const route = config.routes.get(job.label);
    const run: Run = {
      label: job.label, kind: route?.kind || 'issue', status: job.status, result: job.result,
      conversation: job.conversation_id || null, pr: job.event?.pull_request?.number || null,
      started: job.started ? new Date(job.started).toISOString() : null,
      finished: job.finished ? new Date(job.finished).toISOString() : null,
      cost: typeof job.cost === 'number' ? Math.round(job.cost * 1000) / 1000 : null,
      retry_at: job.retry_at, waiting_for: job.waiting_for, waiting_for_files: job.waiting_for_files, waiting_for_run: job.waiting_for_run || undefined, escalated: job.escalated ? route?.escalateTo || undefined : undefined, fell_back: job.status === 'running' ? job.fell_back : undefined, created: job.created
    };
    const entry = byIssue.get(base) || { key: base, title: String(job.event?.issue?.title || '').slice(0, 80), runs: [] };
    entry.runs.push(run);
    byIssue.set(base, entry);
  }
  const issues = [...byIssue.values()].map((entry) => {
    entry.runs.sort((a, b) => b.created - a.created);
    const rounds = entry.runs.filter((run) => (run.kind === 'pull_request' || run.kind === 'ci_failure') && (run.started || run.status !== 'failed')).length;
    const pr = entry.runs.find((run) => run.pr)?.pr || null;
    return {
      issue: entry.key, title: entry.title, pr, rounds, state: stateOf(entry.runs, config.maxRounds, rounds),
      runs: entry.runs.map(({ created: _created, ...run }) => run)
    };
  });
  issues.sort((a, b) => (b.runs[0]?.started || '').localeCompare(a.runs[0]?.started || ''));
  const running = jobs.list('running').length;
  // A dry run starts nothing: its would-be jobs say nothing about merges or cost.
  const all = jobs.list().filter((job) => job.status !== 'dry');
  const week = summarize(config, all, 7, now);
  const month = summarize(config, all, 30, now);
  return {
    generated: new Date(now).toISOString(),
    dry_run: config.dryRun ? { repositories: config.dryRunRepos.size ? [...config.dryRunRepos] : 'all', would_write: dry?.writes.slice(-50) || [] } : null,
    limits: { running, max_concurrent: config.maxConcurrent, max_rounds: config.maxRounds, max_runs_per_hour: config.maxRunsPerHour },
    summary: Object.fromEntries(Object.keys(month).sort().map((repo) => [repo, { last_7_days: week[repo], last_30_days: month[repo] }])),
    issues,
    waiting_for_human: waiting.map((entry) => ({ repository: entry.repository, issue: entry.issue, pr: entry.pr, since: new Date(entry.since).toISOString().slice(0, 10), reason: entry.reason }))
  };
}

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const duration = (seconds: number | null): string => seconds === null ? '-' : seconds < 5400 ? Math.round(seconds / 60) + ' min' : seconds < 172800 ? Math.round(seconds / 360) / 10 + ' h' : Math.round(seconds / 8640) / 10 + ' d';

// Per repository and window: tickets merged (without a human), blocked, split; median and p90 time to merge; rounds, retries, cost.
function renderSummary(status: Status): string {
  const rows = Object.entries(status.summary).flatMap(([repo, windows]) => [['last 7 days', windows.last_7_days], ['last 30 days', windows.last_30_days]].map(([name, s]) => {
    const sum = s as Summary;
    return '<tr><td>' + escape(repo) + '</td><td>' + name + '</td><td>' + sum.merged + ' (' + sum.merged_without_human + ')</td><td>' + sum.blocked + '</td><td>' + sum.split + '</td><td>'
      + duration(sum.merge_seconds.median) + ' / ' + duration(sum.merge_seconds.p90) + '</td><td>' + (sum.rounds_per_merged ?? '-') + '</td><td>' + sum.review_retries + ' / ' + sum.error_retries
      + '</td><td>$' + sum.cost.toFixed(2) + '</td></tr>';
  }));
  return '<table><tr><th>Repository</th><th>Window</th><th>Merged (no human)</th><th>Blocked</th><th>Split</th><th>Median / p90 to merge</th><th>Rounds per merged</th><th>Review / error retries</th><th>Cost</th></tr>\n' + rows.join('\n') + '</table>';
}

export function renderStatus(status: Status): string {
  const rows = status.issues.map((issue) => '<tr><td>' + escape(issue.issue) + '</td><td>' + escape(issue.title) + '</td><td>' + (issue.pr ? '#' + issue.pr : '') + '</td><td>'
    + escape(issue.state) + '</td><td>' + issue.rounds + '/' + status.limits.max_rounds + '</td><td>' + escape(issue.runs.map((run) => run.label + ':' + run.status).join(', ')) + '</td></tr>').join('\n');
  const waiting = status.waiting_for_human.length ? '<h2>Waiting for a human</h2><ul>' + status.waiting_for_human.map((entry) => '<li>' + escape(entry.repository) + ' #' + entry.pr
    + ' (issue #' + entry.issue + '): waiting for a human since ' + escape(entry.since) + ', ' + escape(entry.reason) + '</li>').join('') + '</ul>' : '';
  const banner = status.dry_run ? '<p style="background:#fd0;color:#000;padding:.6rem;font-weight:bold">DRY RUN (' + (status.dry_run.repositories === 'all' ? 'all repositories' : escape(status.dry_run.repositories.join(', '))) + '): nothing is written to Forgejo or OpenHands, runs are only judged. Would-be writes: <a href="/status.json">JSON</a>.</p>' : '';
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>ForgeHands status</title>'
    + '<style>body{font:14px system-ui;margin:1.5rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;vertical-align:top}</style>'
    + '<h1>ForgeHands</h1>' + banner + '<p>' + status.limits.running + ' of ' + status.limits.max_concurrent + ' runs active, generated ' + escape(status.generated) + '. <a href="/status.json">JSON</a></p>' + waiting
    + renderSummary(status) + '<h2>Tickets</h2>'
    + '<table><tr><th>Issue</th><th>Title</th><th>PR</th><th>State</th><th>Rounds</th><th>Runs</th></tr>\n' + rows + '</table>';
}
