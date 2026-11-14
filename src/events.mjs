// Keep the bridge intentionally small. Agent execution and git writes belong in OpenHands.
// `labels` are the trigger labels in priority order; the first one that applies wins.
// With `labelEvents`, Forgejo's `issue_label` event (a label added to an existing issue) is accepted too. It carries the
// current labels but not which one was added, so the event is flagged and the dispatcher must not start a second run.
export function normalizeEvent(event, payload, allowedRepos, labels = ['ai:ready'], { labelEvents = false } = {}) {
  const isLabelEvent = labelEvents && event === 'issue_label';
  if ((event !== 'issues' && !isLabelEvent) || !payload || typeof payload !== 'object') return null;
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
      labels: present
    },
    sender: { login: payload.sender?.login || null }
  };
}
