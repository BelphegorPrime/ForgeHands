import { isBotPull, type BotRules } from '../forge/bot.ts';
import type { BranchPushEvent, ForgeEvent, Json, NormalizedEvent, PushEvent } from '../types.ts';

export interface NormalizeOptions {
  labelEvents?: boolean;
  prLabels?: string[];
  ci?: { failure?: string; success?: string };
  approved?: string;
  pushes?: boolean;
  /** REVIEW_WITHOUT_CI: a commit on an agent's or a bot's branch (a push, or a pull request opened or updated) is an event, to look for a repository without CI. */
  branchPushes?: boolean;
  /** VERDICT_SOURCE review or both: a native review (approved / rejected) is an event. */
  reviews?: boolean;
  /** Dependency bots (BOT_AUTHORS): their pull requests count like agent pull requests. `fixRounds` 0: a red commit and a round label start nothing. */
  bots?: BotRules & { fixRounds: number };
  /** COMMENT_RESTARTS and HUMAN_LOGIN: a comment of this login on an issue is an event (see normalizeComment). Absent: comments are ignored. */
  comments?: { human: string };
}

// Keep the bridge intentionally small. Agent execution and git writes belong in OpenHands.
// `labels` are the trigger labels in priority order; the first one that applies wins.
// With `labelEvents`, a label change on an existing issue is accepted too. Forgejo reports it as an `issues` event with
// action `label_updated` (captured from a real instance; `issue_label` is accepted as well). It carries the current
// labels but not which one was added, so the event is flagged and the dispatcher must not start a second run.
export function normalizeEvent(event: unknown, payload: Json, allowedRepos: Set<string>, labels: string[] = ['ai:ready'], { labelEvents = false, prLabels = [], ci = {}, approved = '', pushes = false, branchPushes = false, reviews = false, bots, comments }: NormalizeOptions = {}): NormalizedEvent | null {
  if (event === 'push') return (pushes ? normalizePush(payload, allowedRepos) : null) ?? (branchPushes ? normalizeBranchPush(payload, allowedRepos, bots) : null);
  if (event === 'issue_comment') return comments ? normalizeComment(payload, allowedRepos, comments.human) : null;
  if (event === 'pull_request' && branchPushes && HEAD_ACTIONS.has(String(payload?.action))) return normalizeBranchPull(payload, allowedRepos, bots);
  if (reviews && REVIEW_EVENTS[String(event)]) return normalizeReview(String(event), payload, allowedRepos, bots);
  if (event === 'pull_request') return normalizePullRequest(payload, allowedRepos, prLabels, approved, bots);
  if (event === 'issues' && payload?.action === 'closed') return normalizeClosed(payload, allowedRepos);
  if (event === 'action_run_failure' || event === 'action_run_success') return normalizeCiRun(event, payload, allowedRepos, ci, bots);
  if ((event !== 'issues' && event !== 'issue_label') || !payload || typeof payload !== 'object') return null;
  const isLabelEvent = labelEvents && (event === 'issue_label' || payload.action === 'label_updated');
  if (event === 'issue_label' && !isLabelEvent) return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  const issue = payload.issue;
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0) return null;
  if (isLabelEvent ? payload.action !== 'label_updated' : (payload.action !== 'opened' && payload.action !== 'labeled')) return null;
  const present = Array.isArray(issue.labels)
    ? issue.labels.map((entry: Json) => typeof entry === 'string' ? entry : entry?.name).filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const triggers = [...labels];
  let matched: string | undefined;
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

// Forgejo sends a review as an event of its own. Its code (modules/webhook/type.go) names the types pull_request_review_approved and
// pull_request_review_rejected (what the payload's `review.type` carries); the delivery header may carry the mapped names
// pull_request_approved / pull_request_rejected instead (HookEventType.Event()), so both spellings are accepted.
const REVIEW_EVENTS: Record<string, 'approved' | 'rejected'> = {
  pull_request_review_approved: 'approved', pull_request_approved: 'approved',
  pull_request_review_rejected: 'rejected', pull_request_rejected: 'rejected'
};

// A native review of the pull request of an agent issue (or of a bot). The event is only a trigger: what it says is checked against the
// reviews as Forgejo has them (Merger.reviewOf), never taken from the payload.
function normalizeReview(event: string, payload: Json, allowedRepos: Set<string>, bots?: NormalizeOptions['bots']): ForgeEvent | null {
  const pr = payload?.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged) return null;
  const match = /^ai\/issue-(\d+)$/.exec(String(pr.head?.ref || ''));
  const bot = !match && !!bots && isBotPull(bots, pr, fullName);
  const issueNumber = bot ? pr.number : match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  const present = Array.isArray(pr.labels)
    ? pr.labels.map((entry: Json) => typeof entry === 'string' ? entry : entry?.name).filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const verdict = REVIEW_EVENTS[event];
  return {
    type: 'pull_request.review_' + verdict,
    source: 'forgejo',
    action: 'reviewed',
    ...(bot ? { bot: true } : {}),
    repository: {
      full_name: fullName,
      clone_url: payload.repository.clone_url || null,
      html_url: payload.repository.html_url || null,
      default_branch: payload.repository.default_branch || null
    },
    issue: {
      number: issueNumber,
      title: String(pr.title || '').slice(0, 1000),
      body: String(pr.body || '').slice(0, 50000),
      html_url: pr.html_url || null,
      comments: Number.isSafeInteger(pr.comments) && pr.comments > 0 ? pr.comments : 0,
      labels: present
    },
    pull_request: { number: pr.number, head_ref: pr.head.ref, html_url: pr.html_url || null },
    review: { reviewer: payload.sender?.login || null },
    sender: { login: payload.sender?.login || null }
  };
}

// A label on the pull request of an agent issue (branch ai/issue-<n>) starts a follow-up round for that issue. As with issues,
// Forgejo reports a label change as action `label_updated` with the current labels only, so the event is flagged and the
// dispatcher compares it with the labels it saw before. `labeled` (with the added label) is accepted as well.
function normalizePullRequest(payload: Json, allowedRepos: Set<string>, labels: string[], approved: string, bots?: NormalizeOptions['bots']): ForgeEvent | null {
  const pr = payload?.pull_request;
  if (!pr || typeof pr !== 'object' || (!labels.length && !approved)) return null;
  if (payload.action !== 'label_updated' && payload.action !== 'labeled') return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged) return null;
  const match = /^ai\/issue-(\d+)$/.exec(String(pr.head?.ref || ''));
  // A dependency bot's pull request has no ticket: it stands for itself. It takes part in rounds only when BOT_FIX_ROUNDS allows them.
  const bot = !match && !!bots && isBotPull(bots, pr, fullName);
  const issueNumber = bot ? pr.number : match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  if (bot && !bots!.fixRounds) labels = [];
  const present = Array.isArray(pr.labels)
    ? pr.labels.map((entry: Json) => typeof entry === 'string' ? entry : entry?.name).filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const isLabelEvent = payload.action === 'label_updated';
  let matched: string | undefined;
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
    ...(bot ? { bot: true } : {}),
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
function normalizeCiRun(event: string, payload: Json, allowedRepos: Set<string>, ci: { failure?: string; success?: string }, bots?: NormalizeOptions['bots']): ForgeEvent | null {
  const label = event === 'action_run_failure' ? ci.failure : ci.success;
  const run = payload?.run;
  if (!label || !run || typeof run !== 'object' || run.event !== 'pull_request' || typeof run.event_payload !== 'string') return null;
  // Forgejo also sends `action_run_failure` for a run that was cancelled (a newer push replaced it) or skipped: not a failure.
  if (run.status !== (event === 'action_run_failure' ? 'failure' : 'success')) return null;
  const fullName = run.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  let data: Json;
  try { data = JSON.parse(run.event_payload); } catch { return null; }
  const pr = data?.pull_request;
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged) return null;
  const match = /^ai\/issue-(\d+)$/.exec(String(pr.head?.ref || ''));
  const bot = !match && !!bots && isBotPull(bots, pr, fullName);
  // A red commit of a bot's pull request is only worth a fix round when BOT_FIX_ROUNDS asks for it.
  if (bot && event === 'action_run_failure' && !bots!.fixRounds) return null;
  const issueNumber = bot ? pr.number : match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || typeof run.commit_sha !== 'string' || !run.commit_sha) return null;
  return {
    type: 'ci.' + (event === 'action_run_failure' ? 'failure' : 'success'),
    source: 'forgejo',
    action: event,
    ...(bot ? { bot: true } : {}),
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

// A comment written on an issue (Forgejo's `issue_comment`, action `created`). Only the comments of HUMAN_LOGIN count: one of them may start the
// last run of its issue again (Dispatcher.onComment). Comments on pull requests, edited or deleted comments and those of anybody else are ignored.
// The payload is read for the author (`comment.user.login`, else the sender), the comment id and the issue; the dispatcher reads the issue from the forge.
function normalizeComment(payload: Json, allowedRepos: Set<string>, human: string): ForgeEvent | null {
  if (payload?.action !== 'created') return null;
  const fullName = payload.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  const issue = payload.issue;
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0) return null;
  // A pull request is an issue too: Forgejo marks it with a `pull_request` object (Gitea adds `is_pull`). Those comments are not handled here.
  if (issue.pull_request || payload.is_pull === true) return null;
  const comment = payload.comment;
  const author = String(comment?.user?.login || payload.sender?.login || '');
  if (!author || author.toLowerCase() !== human.toLowerCase()) return null;
  if (!/^\d{1,18}$/.test(String(comment?.id ?? ''))) return null;
  const present = Array.isArray(issue.labels)
    ? issue.labels.map((entry: Json) => typeof entry === 'string' ? entry : entry?.name).filter((name: unknown): name is string => typeof name === 'string')
    : [];
  return {
    type: 'issues.commented',
    source: 'forgejo',
    action: 'created',
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
    comment: { id: String(comment.id), login: author },
    sender: { login: author }
  };
}

// A closed issue: the issues that depend on it may be ready now (see the dispatcher).
function normalizeClosed(payload: Json, allowedRepos: Set<string>): ForgeEvent | null {
  const fullName = payload.repository?.full_name;
  const issue = payload.issue;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0) return null;
  return {
    type: 'issues.closed',
    source: 'forgejo',
    action: 'closed',
    repository: { full_name: fullName, clone_url: payload.repository.clone_url || null, html_url: payload.repository.html_url || null, default_branch: payload.repository.default_branch || null },
    issue: { number: issue.number, title: String(issue.title || '').slice(0, 1000), body: '', html_url: issue.html_url || null, comments: 0, labels: [] },
    sender: { login: payload.sender?.login || null }
  };
}

// A push to the default branch: the open pull requests may have fallen behind (see the dispatcher). Other branches and deletions do not count.
function normalizePush(payload: Json, allowedRepos: Set<string>): PushEvent | null {
  const fullName = payload?.repository?.full_name;
  const branch = payload?.repository?.default_branch;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase()) || typeof branch !== 'string' || !branch) return null;
  if (payload.ref !== 'refs/heads/' + branch) return null;
  if (typeof payload.after !== 'string' || !/^[0-9a-f]{7,64}$/i.test(payload.after) || /^0+$/.test(payload.after)) return null;
  return {
    type: 'push.default',
    source: 'forgejo',
    repository: { full_name: fullName, clone_url: payload.repository.clone_url || null, html_url: payload.repository.html_url || null, default_branch: branch },
    after: payload.after,
    sender: { login: payload.sender?.login || null }
  };
}

// Could a branch of this name carry a pull request ForgeHands reviews: an agent branch, or one a listed bot may use? The dispatcher checks
// the pull request itself (author, state, head) against the forge; this only keeps pushes of every other branch from costing an API call.
function reviewableBranch(branch: unknown, bots?: NormalizeOptions['bots']): branch is string {
  if (typeof branch !== 'string' || !branch) return false;
  if (/^ai\/issue-\d+$/.test(branch)) return true;
  return !!bots && bots.authors.size > 0 && (!bots.prefixes.length || bots.prefixes.some((prefix) => branch.startsWith(prefix)));
}

// The actions of a pull request event that put a commit on it: it was opened or reopened, or its branch got a new head.
const HEAD_ACTIONS = new Set(['opened', 'reopened', 'synchronized', 'synchronize']);

const SHA = /^[0-9a-f]{7,64}$/i;

// A push to a branch that is not the default one. Whether a pull request of an agent or bot stands on it is for the dispatcher to read.
function normalizeBranchPush(payload: Json, allowedRepos: Set<string>, bots?: NormalizeOptions['bots']): BranchPushEvent | null {
  const fullName = payload?.repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase()) || typeof payload.ref !== 'string' || !payload.ref.startsWith('refs/heads/')) return null;
  const branch = payload.ref.slice('refs/heads/'.length);
  if (branch === payload.repository.default_branch || !reviewableBranch(branch, bots)) return null;
  if (typeof payload.after !== 'string' || !SHA.test(payload.after) || /^0+$/.test(payload.after)) return null;
  return {
    type: 'push.branch',
    source: 'forgejo',
    repository: { full_name: fullName, clone_url: payload.repository.clone_url || null, html_url: payload.repository.html_url || null, default_branch: payload.repository.default_branch || null },
    branch,
    after: payload.after,
    sender: { login: payload.sender?.login || null }
  };
}

// A pull request opened or updated: the same trigger as a push, with the pull request already named. This covers the pull request that is
// opened after the branch was pushed (the push found none) and a forge that reports a new head only as a pull request event.
function normalizeBranchPull(payload: Json, allowedRepos: Set<string>, bots?: NormalizeOptions['bots']): BranchPushEvent | null {
  const pr = payload?.pull_request;
  const fullName = payload?.repository?.full_name;
  if (!pr || typeof pr !== 'object' || typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== 'open' || pr.merged || !reviewableBranch(pr.head?.ref, bots)) return null;
  if (typeof pr.head?.sha !== 'string' || !SHA.test(pr.head.sha)) return null;
  return {
    type: 'push.branch',
    source: 'forgejo',
    repository: { full_name: fullName, clone_url: payload.repository.clone_url || null, html_url: payload.repository.html_url || null, default_branch: payload.repository.default_branch || null },
    branch: pr.head.ref,
    after: pr.head.sha,
    pull_request: pr.number,
    sender: { login: payload.sender?.login || null }
  };
}
