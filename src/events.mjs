// Keep the bridge intentionally small. Agent execution and git writes belong in OpenHands.
// `labels` are the trigger labels in priority order; the first one that applies wins.
// With `labelEvents`, a label change on an existing issue is accepted too. Forgejo reports it as an `issues` event with
// action `label_updated` (captured from a real instance; `issue_label` is accepted as well). It carries the current
// labels but not which one was added, so the event is flagged and the dispatcher must not start a second run.
export function normalizeEvent(event, payload, allowedRepos, labels = ['ai:ready'], { labelEvents = false, prLabels = [], ci = {}, approved = '' } = {}) {
  if (event === 'pull_request') return normalizePullRequest(payload, allowedRepos, prLabels, approved);
  if (event === 'action_run_failure' || event === 'action_run_success') return normalizeCiRun(event, payload, allowedRepos, ci);
  if ((event !== 'issues' && event !== 'issue_label') || !payload || typeof payload !== 'object') return null;
  const isLabelEvent = labelEvents && (event === 'issue_label' || payload.action === 'label_updated');
  if (event === 'issue_label' && !isLabelEvent) return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  const issue = payload.issue;
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0) return null;
  if (isLabelEvent ? payload.action !== 'label_updated' : (payload.action !== 'opened' && payload.action !== 'labeled')) return null;
  const present = Array.isArray(issue.labels)
    ? issue.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter((name) => typeof name === 'string')
    : [];
  const triggers = [...labels];
  let matched;
  if (isLabelEvent) {
    matched = triggers.find((name) => present.includes(name));
  } else if (payload.action === 'labeled') {
    // Only the addition of a trigger label may trigger a "labeled" event.
    const added = payload.label?.name;
    matched = triggers.includes(added) && present.includes(added) ? added : undefined;
  } else {
    matched = triggers.find((name) => present.includes(name));
  }
  if (!matched) return null;
  return {
    type: isLabelEvent ? 'issues.labeled' : 'issues.' + payload.action,
    source: 'forgejo',
    action: isLabelEvent ? 'labeled' : payload.action,
    ...(isLabelEvent ? { label_event: true } : {}),
    label: matched,
    repository: {
      full_name: fullName,
      clone_url: payload.repository.clone_url || null,
      html_url: payload.repository.html_url || null,
      default_branch: payload.repository.default_branch || null
    },
    issue: {
      number: issue.number,
      title: String(issue.title || '').slice(0, 1000),
      body: String(issue.body || '').slice(0, 50000),
      html_url: issue.html_url || null,
      comments: Number.isSafeInteger(issue.comments) && issue.comments > 0 ? issue.comments : 0,
      labels: present
    },
    sender: { login: payload.sender?.login || null }
  };
}

// A label on the pull request of an agent issue (branch ai/issue-<n>) starts a follow-up round for that issue. As with issues,
// Forgejo reports a label change as action `label_updated` with the current labels only, so the event is flagged and the
// dispatcher compares it with the labels it saw before. `labeled` (with the added label) is accepted as well.
function normalizePullRequest(payload, allowedRepos, labels, approved) {
  const pr = payload?.pull_request;
  if (!pr || typeof pr !== 'object' || (!labels.length && !approved)) return null;
  if (payload.action !== 'label_updated' && payload.action !== 'labeled') return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged) return null;
  const match = /^ai\/issue-(\d+)$/.exec(String(pr.head?.ref || ''));
  const issueNumber = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  const present = Array.isArray(pr.labels)
    ? pr.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter((name) => typeof name === 'string')
    : [];
  const isLabelEvent = payload.action === 'label_updated';
  let matched;
  if (isLabelEvent) matched = labels.find((name) => present.includes(name));
  else matched = labels.includes(payload.label?.name) && present.includes(payload.label.name) ? payload.label.name : undefined;
  // The approval label asks ForgeHands to merge (a round label takes precedence when both are there).
  let type = 'pull_request.labeled';
  if (!matched && approved) {
    if (isLabelEvent ? present.includes(approved) : payload.label?.name === approved && present.includes(approved)) { matched = approved; type = 'pull_request.approved'; }
  }
  if (!matched) return null;
  return {
    type,
    source: 'forgejo',
    action: 'labeled',
    ...(isLabelEvent ? { label_event: true } : {}),
    label: matched,
    repository: {
      full_name: fullName,
      clone_url: payload.repository.clone_url || null,
      html_url: payload.repository.html_url || null,
      default_branch: payload.repository.default_branch || null
    },
    // The issue the pull request belongs to; the title and body are those of the pull request.
    issue: {
      number: issueNumber,
      title: String(pr.title || '').slice(0, 1000),
      body: String(pr.body || '').slice(0, 50000),
      html_url: pr.html_url || null,
      comments: Number.isSafeInteger(pr.comments) && pr.comments > 0 ? pr.comments : 0,
      labels: present
    },
    pull_request: { number: pr.number, head_ref: pr.head.ref, html_url: pr.html_url || null },
    sender: { login: payload.sender?.login || null }
  };
}

// A finished Forgejo Actions run of a pull request of an agent issue. Forgejo sends one event per workflow run (header
// `action_run_failure` or `action_run_success`); `run.event_payload` is the pull request payload that started the run as a
// JSON string. `ci.failure` and `ci.success` are the route names that handle each outcome (absent: not handled).
function normalizeCiRun(event, payload, allowedRepos, ci) {
  const label = event === 'action_run_failure' ? ci.failure : ci.success;
  const run = payload?.run;
  if (!label || !run || typeof run !== 'object' || run.event !== 'pull_request' || typeof run.event_payload !== 'string') return null;
  // Forgejo also sends `action_run_failure` for a run that was cancelled (a newer push replaced it) or skipped: not a failure.
  if (run.status !== (event === 'action_run_failure' ? 'failure' : 'success')) return null;
  const fullName = run.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  let data;
  try { data = JSON.parse(run.event_payload); } catch { return null; }
  const pr = data?.pull_request;
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged) return null;
  const match = /^ai\/issue-(\d+)$/.exec(String(pr.head?.ref || ''));
  const issueNumber = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || typeof run.commit_sha !== 'string' || !run.commit_sha) return null;
  return {
    type: 'ci.' + (event === 'action_run_failure' ? 'failure' : 'success'),
    source: 'forgejo',
    action: event,
    label,
    repository: {
      full_name: fullName,
      clone_url: run.repository.clone_url || null,
      html_url: run.repository.html_url || null,
      default_branch: run.repository.default_branch || null
    },
    issue: {
      number: issueNumber,
      title: String(pr.title || '').slice(0, 1000),
      body: String(pr.body || '').slice(0, 50000),
      html_url: pr.html_url || null,
      comments: Number.isSafeInteger(pr.comments) && pr.comments > 0 ? pr.comments : 0,
      labels: []
    },
    pull_request: { number: pr.number, head_ref: pr.head.ref, html_url: pr.html_url || null },
    ci: { run_id: run.id ?? null, workflow: String(run.workflow_id || ''), commit_sha: run.commit_sha, status: String(run.status || ''), html_url: run.html_url || null },
    sender: { login: run.trigger_user?.login || null }
  };
}
