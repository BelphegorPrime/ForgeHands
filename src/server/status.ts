import { isDry } from '../dry.ts';
import type { DryLog, DryWrite } from '../dry.ts';
import type { DirectConfig } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';

interface Run {
  label: string; kind: string; status: string; result: string | undefined; conversation: string | null; pr: number | null;
  started: string | null; finished: string | null; cost: number | null; retry_at: number | undefined; waiting_for: number[] | undefined;
  waiting_for_run: true | undefined; escalated: string | undefined; fell_back: string | undefined; created: number;
}
export interface Status {
  generated: string;
  limits: { running: number; max_concurrent: number; max_rounds: number; max_runs_per_hour: number };
  dry_run: { repositories: string[] | 'all'; would_write: DryWrite[] } | null;
  issues: { issue: string; title: string; pr: number | null; rounds: number; state: string; runs: Omit<Run, 'created'>[] }[];
  // Pull requests that wait for the human (REMIND_AFTER_DAYS), as the last daily look found them.
  waiting_for_human: { repository: string; issue: number; pr: number; since: string; reason: string }[];
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
      retry_at: job.retry_at, waiting_for: job.waiting_for, waiting_for_run: job.waiting_for_run || undefined, escalated: job.escalated ? route?.escalateTo || undefined : undefined, fell_back: job.status === 'running' ? job.fell_back : undefined, created: job.created
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
  return {
    generated: new Date(now).toISOString(),
    dry_run: config.dryRun ? { repositories: config.dryRunRepos.size ? [...config.dryRunRepos] : 'all', would_write: dry?.writes.slice(-50) || [] } : null,
    limits: { running, max_concurrent: config.maxConcurrent, max_rounds: config.maxRounds, max_runs_per_hour: config.maxRunsPerHour },
    issues,
    waiting_for_human: waiting.map((entry) => ({ repository: entry.repository, issue: entry.issue, pr: entry.pr, since: new Date(entry.since).toISOString().slice(0, 10), reason: entry.reason }))
  };
}

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

export function renderStatus(status: Status): string {
  const rows = status.issues.map((issue) => '<tr><td>' + escape(issue.issue) + '</td><td>' + escape(issue.title) + '</td><td>' + (issue.pr ? '#' + issue.pr : '') + '</td><td>'
    + escape(issue.state) + '</td><td>' + issue.rounds + '/' + status.limits.max_rounds + '</td><td>' + escape(issue.runs.map((run) => run.label + ':' + run.status).join(', ')) + '</td></tr>').join('\n');
  const waiting = status.waiting_for_human.length ? '<h2>Waiting for a human</h2><ul>' + status.waiting_for_human.map((entry) => '<li>' + escape(entry.repository) + ' #' + entry.pr
    + ' (issue #' + entry.issue + '): waiting for a human since ' + escape(entry.since) + ', ' + escape(entry.reason) + '</li>').join('') + '</ul>' : '';
  const banner = status.dry_run ? '<p style="background:#fd0;color:#000;padding:.6rem;font-weight:bold">DRY RUN (' + (status.dry_run.repositories === 'all' ? 'all repositories' : escape(status.dry_run.repositories.join(', '))) + '): nothing is written to Forgejo or OpenHands, runs are only judged. Would-be writes: <a href="/status.json">JSON</a>.</p>' : '';
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ForgeHands status</title>'
    + '<style>body{font:14px system-ui;margin:1.5rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;vertical-align:top}</style>'
    + '<h1>ForgeHands</h1>' + banner + '<p>' + status.limits.running + ' of ' + status.limits.max_concurrent + ' runs active, generated ' + escape(status.generated) + '. <a href="/status.json">JSON</a></p>' + waiting
    + '<table><tr><th>Issue</th><th>Title</th><th>PR</th><th>State</th><th>Rounds</th><th>Runs</th></tr>\n' + rows + '</table>';
}
