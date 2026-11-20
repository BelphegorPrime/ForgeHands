import { isBotPull } from '../../agent/bot.ts';
import type { ForgeEvent, Json, NormalizedEvent, PushEvent } from '../../types.ts';
import type { NormalizeOptions } from '../../webhook/events.ts';

// GitLab's webhooks, turned into the same normalized events the Forgejo ones become. The header `X-Gitlab-Event` names the kind:
// `Issue Hook`, `Merge Request Hook`, `Pipeline Hook` and `Push Hook`. Merge requests are the pull requests (`iid` is the number).

const names = (labels: unknown): string[] => (Array.isArray(labels) ? labels : [])
  .map((entry: Json) => typeof entry === 'string' ? entry : entry?.title ?? entry?.name)
  .filter((name: unknown): name is string => typeof name === 'string');

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function repositoryOf(payload: Json, allowedRepos: Set<string>): ForgeEvent['repository'] | null {
  const project = payload?.project;
  const fullName = project?.path_with_namespace;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  return { full_name: fullName, clone_url: project.git_http_url || null, html_url: project.web_url || null, default_branch: project.default_branch || null };
}

// The labels before and after a change (`changes.labels`), or null when the change does not touch labels.
function labelChange(payload: Json): { previous: string[]; current: string[] } | null {
  const change = payload?.changes?.labels;
  if (!change || typeof change !== 'object') return null;
  return { previous: names(change.previous), current: names(change.current) };
}

export function normalizeGitlabEvent(event: unknown, payload: Json, allowedRepos: Set<string>, labels: string[] = ['ai:ready'], { labelEvents = false, prLabels = [], ci = {}, approved = '', pushes = false, bots }: NormalizeOptions = {}): NormalizedEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  if (event === 'Push Hook') return pushes ? normalizePush(payload, allowedRepos) : null;
  if (event === 'Merge Request Hook') return normalizeMergeRequest(payload, allowedRepos, prLabels, approved, bots);
  if (event === 'Pipeline Hook') return normalizePipeline(payload, allowedRepos, ci, bots);
  if (event === 'Issue Hook' || event === 'Confidential Issue Hook') return normalizeIssue(payload, allowedRepos, labels, labelEvents);
  return null;
}

// An issue opened with a trigger label, or one whose labels changed. GitLab sends `update` with `changes.labels` (before and after) for a
// label change. As with Forgejo the label event is flagged when label events are on, so the dispatcher compares with the labels it saw;
// without them (webhook mode) the added trigger label, known here from the change, is the one that counts.
function normalizeIssue(payload: Json, allowedRepos: Set<string>, triggers: string[], labelEvents: boolean): ForgeEvent | null {
  const issue = payload.object_attributes;
  const repository = repositoryOf(payload, allowedRepos);
  if (!repository || !issue || !positive(issue.iid)) return null;
  // Tasks and other work item types are not tickets.
  if (issue.type && issue.type !== 'Issue') return null;
  const base = { source: 'gitlab' as const, repository, sender: { login: payload.user?.username || null } };
  const info = (present: string[]) => ({ number: issue.iid, title: String(issue.title || '').slice(0, 1000), body: String(issue.description || '').slice(0, 50000), html_url: issue.url || null, comments: 0, labels: present });
  if (issue.action === 'close') return { ...base, type: 'issues.closed', action: 'closed', issue: { ...info([]), body: '' } };
  const present = names(payload.labels ?? issue.labels);
  if (issue.action === 'open') {
    const matched = triggers.find((name) => present.includes(name));
    return matched ? { ...base, type: 'issues.opened', action: 'opened', label: matched, issue: info(present) } : null;
  }
  const change = issue.action === 'update' ? labelChange(payload) : null;
  if (!change) return null;
  const matched = labelEvents ? triggers.find((name) => change.current.includes(name)) : triggers.find((name) => change.current.includes(name) && !change.previous.includes(name));
  if (!matched) return null;
  return { ...base, type: 'issues.labeled', action: 'labeled', ...(labelEvents ? { label_event: true } : {}), label: matched, issue: info(present) };
}

// A label on the merge request of an agent issue (source branch ai/issue-<n>) starts a follow-up round or, for the approval label, the merge.
// The author of a merge request is not in this payload (only the user who acted), so a dependency bot's merge request is recognised from
// its pipeline events only; a label event on it is ignored.
function normalizeMergeRequest(payload: Json, allowedRepos: Set<string>, labels: string[], approved: string, _bots?: NormalizeOptions['bots']): ForgeEvent | null {
  const mr = payload.object_attributes;
  const repository = repositoryOf(payload, allowedRepos);
  if (repository && mr && (mr.action === 'approval' || mr.action === 'unapproval')) return normalizeReview(payload, mr, repository);
  if (!repository || !mr || (!labels.length && !approved) || mr.action !== 'update' || mr.state !== 'opened' || !positive(mr.iid)) return null;
  const change = labelChange(payload);
  const match = /^ai\/issue-(\d+)$/.exec(String(mr.source_branch || ''));
  if (!change || !match || !positive(Number(match[1]))) return null;
  const present = names(payload.labels ?? mr.labels);
  // Like Forgejo's `label_updated`, the dispatcher compares with the labels it saw before. The approval label counts when it is new in this change
  // (the approval merges, so it must not fire again for an unrelated change), and it comes first: a leftover round label must not hide it.
  let matched: string | undefined;
  let type = 'pull_request.labeled';
  if (approved && present.includes(approved) && !change.previous.includes(approved)) { matched = approved; type = 'pull_request.approved'; }
  else matched = labels.find((name) => present.includes(name));
  if (!matched) return null;
  return {
    type,
    source: 'gitlab',
    action: 'labeled',
    label_event: true,
    label: matched,
    repository,
    issue: { number: Number(match[1]), title: String(mr.title || '').slice(0, 1000), body: String(mr.description || '').slice(0, 50000), html_url: mr.url || null, comments: 0, labels: present },
    pull_request: { number: mr.iid, head_ref: mr.source_branch, html_url: mr.url || null },
    sender: { login: payload.user?.username || null }
  };
}

// A user approved (`approval`) or withdrew the approval (`unapproval`) of the merge request of an agent issue. Like Forgejo's review
// events this only triggers a look at the reviews as GitLab has them (Merger.reviewOf); the payload's word is never taken. `approved`
// (all rules met) is not used: it comes together with the last `approval`. The author is not in the payload, so a bot's merge request
// is not recognised here.
function normalizeReview(payload: Json, mr: Json, repository: ForgeEvent['repository']): ForgeEvent | null {
  const match = /^ai\/issue-(\d+)$/.exec(String(mr.source_branch || ''));
  if (mr.state !== 'opened' || !positive(mr.iid) || !match || !positive(Number(match[1]))) return null;
  return {
    type: mr.action === 'approval' ? 'pull_request.review_approved' : 'pull_request.review_rejected',
    source: 'gitlab',
    action: 'reviewed',
    repository,
    issue: { number: Number(match[1]), title: String(mr.title || '').slice(0, 1000), body: String(mr.description || '').slice(0, 50000), html_url: mr.url || null, comments: 0, labels: names(payload.labels ?? mr.labels) },
    pull_request: { number: mr.iid, head_ref: mr.source_branch, html_url: mr.url || null },
    sender: { login: payload.user?.username || null }
  };
}

// A finished pipeline of a merge request. GitLab sends one event per status change; only `failed` and `success` count (cancelled and
// skipped pipelines are not outcomes). The event names its merge request only for merge request pipelines (`merge_request` is null for a
// plain branch pipeline), and carries the commit of the pipeline: a merged results pipeline runs on a merge commit, which is not the head
// of the merge request and is dropped as stale downstream. `ci.failure` and `ci.success` are the route names for each outcome.
function normalizePipeline(payload: Json, allowedRepos: Set<string>, ci: { failure?: string; success?: string }, bots?: NormalizeOptions['bots']): ForgeEvent | null {
  const run = payload.object_attributes;
  const status = run?.status;
  if (status !== 'failed' && status !== 'success') return null;
  const label = status === 'failed' ? ci.failure : ci.success;
  const mr = payload.merge_request;
  const repository = repositoryOf(payload, allowedRepos);
  if (!label || !repository || !mr || typeof mr !== 'object' || !positive(mr.iid) || mr.state !== 'opened') return null;
  if (typeof run.sha !== 'string' || !run.sha) return null;
  const fork = mr.source_project_id && mr.target_project_id && mr.source_project_id !== mr.target_project_id;
  const pr = { user: { login: payload.user?.username }, head: { ref: mr.source_branch, repo: { full_name: fork ? 'fork:' + mr.source_project_id : repository.full_name } } };
  const match = /^ai\/issue-(\d+)$/.exec(String(mr.source_branch || ''));
  const bot = !match && !!bots && isBotPull(bots, pr, repository.full_name);
  if (bot && status === 'failed' && !bots!.fixRounds) return null;
  const issueNumber = bot ? mr.iid : match ? Number(match[1]) : 0;
  if (!positive(issueNumber)) return null;
  return {
    type: 'ci.' + (status === 'failed' ? 'failure' : 'success'),
    source: 'gitlab',
    action: 'pipeline_' + status,
    ...(bot ? { bot: true } : {}),
    label,
    repository,
    issue: { number: issueNumber, title: String(mr.title || '').slice(0, 1000), body: '', html_url: mr.url || null, comments: 0, labels: [] },
    pull_request: { number: mr.iid, head_ref: mr.source_branch, html_url: mr.url || null },
    ci: { run_id: run.id ?? null, workflow: String(run.name || run.source || 'pipeline'), commit_sha: run.sha, status: status === 'failed' ? 'failure' : 'success', html_url: run.url || null },
    sender: { login: payload.user?.username || null }
  };
}

// A push to the default branch: open merge requests may have fallen behind. Other branches and deletions do not count.
function normalizePush(payload: Json, allowedRepos: Set<string>): PushEvent | null {
  const repository = repositoryOf(payload, allowedRepos);
  const branch = payload.project?.default_branch;
  if (!repository || typeof branch !== 'string' || !branch || payload.ref !== 'refs/heads/' + branch) return null;
  if (typeof payload.after !== 'string' || !/^[0-9a-f]{7,64}$/i.test(payload.after) || /^0+$/.test(payload.after)) return null;
  return { type: 'push.default', source: 'gitlab', repository, after: payload.after, sender: { login: payload.user_username || null } };
}
