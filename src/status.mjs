// What ForgeHands knows about the work in flight, from its ledger: per issue the runs, their kind, state and cost.
// Read only, no event text beyond the issue title; it says nothing about Forgejo's side (the pull request itself).
const KIND_TEXT = {
  issue: 'worker', pull_request: 'follow-up round', ci_failure: 'fix after red CI', ci_success: 'review', epic_done: 'epic review'
};

// One line for the current state of an issue, from its newest relevant run.
function stateOf(runs, maxRounds, rounds) {
  const active = runs.find((run) => run.status === 'running' || run.status === 'queued');
  if (active && active.retry_at && active.status === 'queued') return 'model quota used up, ' + KIND_TEXT[active.kind] + ' tries again after ' + new Date(active.retry_at).toISOString().slice(11, 16) + ' UTC';
  if (active) return (active.status === 'queued' ? 'queued: ' : '') + KIND_TEXT[active.kind] + ' running';
  const waiting = runs.find((run) => run.status === 'waiting');
  if (waiting) return waiting.waiting_for_run ? 'CI result kept, waiting for the running agent to finish' : 'waiting for ' + (waiting.waiting_for || []).map((n) => '#' + n).join(', ');
  const last = runs[0];
  if (!last) return 'idle';
  if (last.status === 'failed') return KIND_TEXT[last.kind] + ' failed' + (last.result ? ' (' + last.result + ')' : '');
  if (rounds >= maxRounds) return 'rounds used up (' + rounds + '/' + maxRounds + ')';
  return KIND_TEXT[last.kind] + ' done, waiting for the next event';
}

export function buildStatus(config, jobs, now = Date.now()) {
  const byIssue = new Map();
  for (const job of jobs.list()) {
    const base = job.key.split(':')[0];
    const route = config.routes.get(job.label);
    const run = {
      label: job.label, kind: route?.kind || 'issue', status: job.status, result: job.result,
      conversation: job.conversation_id || null, pr: job.event?.pull_request?.number || null,
      started: job.started ? new Date(job.started).toISOString() : null,
      finished: job.finished ? new Date(job.finished).toISOString() : null,
      cost: typeof job.cost === 'number' ? Math.round(job.cost * 1000) / 1000 : null,
      retry_at: job.retry_at, waiting_for: job.waiting_for, waiting_for_run: job.waiting_for_run || undefined, created: job.created
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
      runs: entry.runs.map(({ created, ...run }) => run)
    };
  });
  issues.sort((a, b) => (b.runs[0]?.started || '').localeCompare(a.runs[0]?.started || ''));
  const running = jobs.list('running').length;
  return {
    generated: new Date(now).toISOString(),
    limits: { running, max_concurrent: config.maxConcurrent, max_rounds: config.maxRounds, max_runs_per_hour: config.maxRunsPerHour },
    issues
  };
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function renderStatus(status) {
  const rows = status.issues.map((issue) => '<tr><td>' + escape(issue.issue) + '</td><td>' + escape(issue.title) + '</td><td>' + (issue.pr ? '#' + issue.pr : '') + '</td><td>'
    + escape(issue.state) + '</td><td>' + issue.rounds + '/' + status.limits.max_rounds + '</td><td>' + escape(issue.runs.map((run) => run.label + ':' + run.status).join(', ')) + '</td></tr>').join('\n');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ForgeHands status</title>'
    + '<style>body{font:14px system-ui;margin:1.5rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;vertical-align:top}</style>'
    + '<h1>ForgeHands</h1><p>' + status.limits.running + ' of ' + status.limits.max_concurrent + ' runs active, generated ' + escape(status.generated) + '. <a href="/status.json">JSON</a></p>'
    + '<table><tr><th>Issue</th><th>Title</th><th>PR</th><th>State</th><th>Rounds</th><th>Runs</th></tr>\n' + rows + '</table>';
}
