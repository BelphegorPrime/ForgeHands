import { createHash, timingSafeEqual } from 'node:crypto';
import { metrics } from '../../metrics.ts';
import { DryLog, isDry, isWrite } from '../../dry.ts';
import { normalizeGitlabEvent } from './webhook.ts';
import type { Config, Fetch, ForgejoAccess, Json } from '../../types.ts';
import type { AgentApi, ChangedFile, Comment, CommitStatus, Compare, Forge, Issue, Label, ListPullsOptions, MergeOptions, PullRequest, Review, ReviewVerdict, Subject, Transport, UpdateBranchResult } from '../../types/forge.ts';

export interface GitlabConfig { forgejo?: ForgejoAccess | null; timeoutMs: number; dryRun: Config['dryRun']; dryRunRepos: Config['dryRunRepos'] }

// One call to the GitLab API (v4) for a project, addressed by its URL-encoded path ("group%2Fsub%2Fproject"), as the user whose personal,
// project or group access token ForgeHands holds (header PRIVATE-TOKEN). Like the Forgejo transport this is where a dry run stops writes
// and where API errors are counted (under the same `forgejo` metric name, which counts "the forge").
export async function gitlabCall(config: GitlabConfig, send: Fetch, repository: string, method: string, path: string, body?: unknown, dry: DryLog = new DryLog()): Promise<Json> {
  if (isWrite(method) && isDry(config, repository)) {
    dry.record(repository, method, path, body);
    return { id: 0, dry_run: true };
  }
  const { url, token } = config.forgejo as ForgejoAccess;
  const response = await send(url + '/api/v4/projects/' + encodeURIComponent(repository) + path, {
    method,
    headers: { 'private-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error'
  }).catch((error) => { metrics.apiError('forgejo', null); throw error; });
  if (!response.ok) { metrics.apiError('forgejo', response.status); throw new Error(method + ' ' + path + ' -> HTTP ' + response.status); }
  return response.json().catch(() => null);
}

export function gitlabTransport(config: GitlabConfig, send: Fetch, dry: DryLog = new DryLog()): Transport {
  return (repository, method, path, body) => gitlabCall(config, send, repository, method, path, body, dry);
}

// GitLab marks a draft merge request by a title prefix (the `draft` field of the API follows it). `WIP:` is not recognised any more.
export const GITLAB_DRAFT = /^\s*(?:\[Draft\]|\(Draft\)|Draft:)\s*/i;

// The paths an agent calls itself. The base is the agent's FORGEJO_URL secret (the neutral FORGE_URL reaches it under that name).
export function gitlabAgentApi(repository: string): AgentApi {
  const api = '$FORGEJO_URL/api/v4/projects/' + encodeURIComponent(repository);
  return {
    name: 'GitLab',
    workflows: '.gitlab-ci.yml (and the files it includes)',
    secrets: 'the FORGEJO_TOKEN and FORGEJO_URL secrets (FORGEJO_URL is the GitLab instance, the token goes in the PRIVATE-TOKEN header; the "pull requests" below are merge requests, their numbers are the iid)',
    issue: (number) => api + '/issues/' + number,
    issueComments: (number) => api + '/issues/' + number + '/notes',
    pullComments: (number) => api + '/merge_requests/' + number + '/notes',
    pull: (number) => api + '/merge_requests/' + number,
    pullDiff: (number) => api + '/merge_requests/' + number + '/diffs',
    // GitLab has no list of reviews: what a reviewer leaves are discussions (inline ones are the review comments), approvals are a state.
    pullReviews: (number) => api + '/merge_requests/' + number + '/discussions',
    // GitLab's REST API has no review object: the verdict is a note that begins with the verdict line and names the commit, and an
    // approval (pinned to the commit) when it says yes. ForgeHands reads both (see `listReviews`).
    reviewPost: (number, sha) => 'two steps. First POST ' + api + '/merge_requests/' + number + '/notes with a JSON body {"body": "<the review>"}; the review text ends with the line `Commit: ' + sha + '`. Then, only when you approve, POST ' + api + '/merge_requests/' + number + '/approve with {"sha": "' + sha + '"}. "REQUEST_CHANGES" below means the note alone, with `## Verdict: NOT OK`, and no approve call',
    pulls: () => api + '/merge_requests?state=all&per_page=100',
    labels: () => api + '/labels',
    issueLabels: (number) => api + '/issues/' + number,
    pullLabels: (number) => api + '/merge_requests/' + number,
    issueLabel: (number, id) => api + '/issues/' + number + '?remove_labels=' + id,
    pullLabel: (number, id) => api + '/merge_requests/' + number + '?remove_labels=' + id,
    // Labels are named, not numbered: the "id" of a label is its name.
    addLabelsBody: '{"add_labels":"<id>"}',
    addLabelsMethod: 'PUT',
    removeLabelMethod: 'PUT',
    closeBody: '{"state_event":"close"}',
    closeMethod: 'PUT'
  };
}

// Constant time and independent of the length: both sides are hashed first, so timingSafeEqual always compares 32 bytes.
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

const NOT_FINISHED = new Set(['created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'scheduled', 'manual']);
const IGNORED = new Set(['canceled', 'canceling', 'skipped']);

const labelsOfJson = (labels: unknown): Label[] => (Array.isArray(labels) ? labels : [])
  .map((entry: Json) => typeof entry === 'string' ? entry : entry?.name || entry?.title)
  .filter((name: unknown): name is string => typeof name === 'string')
  .map((name: string) => ({ id: name, name }));

// A merge request in the shape the core reads. `iid` is the number; `opened` is open, `merged` is closed and merged.
export function toPull(mr: Json, repository: string): PullRequest {
  const fork = mr.source_project_id && mr.target_project_id && mr.source_project_id !== mr.target_project_id;
  return {
    number: mr.iid,
    title: String(mr.title ?? ''),
    body: String(mr.description ?? ''),
    state: mr.state === 'opened' || mr.state === 'locked' ? 'open' : 'closed',
    merged: mr.state === 'merged',
    // `has_conflicts` is true only when GitLab computed a conflict; an unchecked merge request says nothing.
    mergeable: mr.has_conflicts === true || mr.detailed_merge_status === 'conflict' ? false : undefined,
    merge_base: mr.diff_refs?.base_sha || undefined,
    merged_at: mr.merged_at ?? null,
    updated_at: mr.updated_at,
    html_url: mr.web_url ?? null,
    user: { login: mr.author?.username, username: mr.author?.username },
    // The head of a fork is somebody else's code: it never carries the name of this project.
    head: { ref: mr.source_branch, sha: mr.sha || mr.diff_refs?.head_sha || '', repo: { full_name: fork ? 'fork:' + mr.source_project_id : repository } },
    base: { ref: mr.target_branch },
    labels: labelsOfJson(mr.labels)
  };
}

export function toIssue(issue: Json): Issue {
  return {
    number: issue.iid,
    title: String(issue.title ?? ''),
    body: String(issue.description ?? ''),
    state: issue.state === 'closed' ? 'closed' : 'open',
    html_url: issue.web_url ?? null,
    comments: issue.user_notes_count ?? 0,
    labels: labelsOfJson(issue.labels)
  };
}

export interface GitlabOptions {
  /** Waits between two looks at a rebase in progress (a test passes a fake). */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

const fileOf = (diff: Json): ChangedFile => ({ filename: diff.new_path, ...(diff.renamed_file && diff.old_path !== diff.new_path ? { previous_filename: diff.old_path } : {}) });
const commentOf = (note: Json): Comment => ({ created_at: note.created_at, body: note.body, user: { login: note.author?.username } });

// GitLab's API (v4) and its webhooks. Merge requests are the pull requests, with their iid as the number. Issues and merge requests
// are numbered apart, which is why comment and label calls take a `Subject`.
export class GitlabForge implements Forge {
  readonly kind = 'gitlab' as const;
  readonly webhookPath = '/webhooks/gitlab';
  call: Transport;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  maxPolls: number;
  projectIds = new Map<string, number>();

  constructor(call: Transport, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1000, maxPolls = 30 }: GitlabOptions = {}) {
    this.call = call;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.maxPolls = maxPolls;
  }

  agent(repository: string): AgentApi { return gitlabAgentApi(repository); }

  // `X-Gitlab-Token` is the secret itself, sent in clear: it proves the sender knows the secret, but unlike an HMAC it is not bound to
  // the body, so anybody who sees one delivery (a proxy log, a TLS-terminating hop) can replay it with another body. Keep the hop short.
  verifyWebhook(secret: string, _raw: Buffer, headers: Parameters<Forge['verifyWebhook']>[2]): boolean {
    const token = headers['x-gitlab-token'];
    return typeof token === 'string' && token.length > 0 && sameSecret(token, secret);
  }
  eventName(headers: Parameters<Forge['eventName']>[0]): unknown { return headers['x-gitlab-event']; }
  // `Idempotency-Key` stays the same across the retries of one delivery (`webhook-id` carries the same value).
  deliveryId(headers: Parameters<Forge['deliveryId']>[0], raw: Buffer, event: unknown): string {
    const candidate = headers['idempotency-key'] || headers['webhook-id'];
    if (typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(candidate)) return candidate;
    return createHash('sha256').update(event + ':').update(raw).digest('hex');
  }
  normalizeEvent(...args: Parameters<Forge['normalizeEvent']>): ReturnType<Forge['normalizeEvent']> { return normalizeGitlabEvent(...args); }

  async getPull(repository: string, number: number): Promise<PullRequest> { return toPull(await this.call(repository, 'GET', '/merge_requests/' + number), repository); }
  async listPulls(repository: string, { state, limit, sort }: ListPullsOptions): Promise<PullRequest[]> {
    const order = '&order_by=updated_at&sort=desc&per_page=' + Math.min(limit, 100);
    // Forgejo's "closed" includes merged ones, GitLab keeps them apart.
    const states = state === 'open' ? ['opened'] : state === 'closed' ? ['closed', 'merged'] : ['all'];
    const lists = await Promise.all(states.map((one) => this.call(repository, 'GET', '/merge_requests?state=' + one + order)));
    const all = lists.flatMap((list) => (Array.isArray(list) ? list : []) as Json[]);
    if (states.length > 1 || sort) all.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return all.slice(0, limit).map((mr) => toPull(mr, repository));
  }
  async pullFiles(repository: string, number: number, limit: number, page?: number): Promise<ChangedFile[]> {
    const diffs = await this.call(repository, 'GET', '/merge_requests/' + number + '/diffs?per_page=' + Math.min(limit, 100) + (page === undefined ? '' : '&page=' + page));
    return (Array.isArray(diffs) ? diffs : []).map(fileOf);
  }
  async compare(repository: string, base: string, head: string): Promise<Compare> {
    const result = await this.call(repository, 'GET', '/repository/compare?from=' + encodeURIComponent(base) + '&to=' + encodeURIComponent(head));
    return { total_commits: Array.isArray(result?.commits) ? result.commits.length : undefined, files: (Array.isArray(result?.diffs) ? result.diffs : []).map(fileOf) };
  }
  // The rebase is asynchronous: PUT .../rebase answers 202 and the work happens in the background. The merge request tells when it is
  // done (`rebase_in_progress`), and `merge_error` is set when the rebase failed, which is what a conflict looks like.
  async updateBranch(repository: string, number: number): Promise<UpdateBranchResult> {
    const started = await this.call(repository, 'PUT', '/merge_requests/' + number + '/rebase');
    if (started?.dry_run) return 'updated';
    for (let poll = 0; poll < this.maxPolls; poll++) {
      await this.sleep(this.pollMs);
      const mr = await this.call(repository, 'GET', '/merge_requests/' + number + '?include_rebase_in_progress=true');
      if (mr?.rebase_in_progress) continue;
      return mr?.merge_error ? 'conflict' : 'updated';
    }
    throw new Error('rebase of !' + number + ' still in progress after ' + this.maxPolls + ' looks');
  }
  // The merge method of GitLab (merge commit, semi-linear, fast-forward) is a setting of the project, not a parameter of the call; only
  // `squash` can be asked for. The `sha` makes GitLab refuse (409) when the branch moved since the checks.
  async mergePull(repository: string, number: number, { method, headSha, deleteBranch }: MergeOptions): Promise<void> {
    await this.call(repository, 'PUT', '/merge_requests/' + number + '/merge', { sha: headSha, squash: method === 'squash', should_remove_source_branch: deleteBranch });
  }
  isWip(title: string): boolean { return GITLAB_DRAFT.test(title); }
  stripWip(title: string): string { return title.replace(GITLAB_DRAFT, ''); }
  async closePull(repository: string, number: number): Promise<void> { await this.call(repository, 'PUT', '/merge_requests/' + number, { state_event: 'close' }); }
  async setPullTitle(repository: string, number: number, title: string): Promise<void> { await this.call(repository, 'PUT', '/merge_requests/' + number, { title }); }

  // What GitLab has instead of reviews. A review of ForgeHands is a note that begins with `## Verdict: OK` or `## Verdict: NOT OK` and
  // ends with `Commit: <sha>` (what `submitReview` and the agent prompt write), plus, for OK, an approval by the same user (listed
  // by the approvals API). The note gives the review its text and its commit, because an approval alone names neither and might survive
  // a push. An OK without that user's approval is no review at all; NOT OK is a request for changes. The newest such note per user wins.
  async listReviews(repository: string, number: number): Promise<Review[]> {
    const [approvals, notes] = await Promise.all([
      this.call(repository, 'GET', '/merge_requests/' + number + '/approvals'),
      this.call(repository, 'GET', '/merge_requests/' + number + '/notes?sort=asc&order_by=created_at&per_page=100')
    ]);
    const approvers = new Set((Array.isArray(approvals?.approved_by) ? approvals.approved_by : []).map((entry: Json) => String(entry.user?.username || '').toLowerCase()));
    const reviews: Review[] = [];
    for (const note of (Array.isArray(notes) ? notes : []) as Json[]) {
      const login = String(note.author?.username || '');
      const verdict = /^\s*#+\s*Verdict\s*:\s*(not\s+ok|ok)\b/i.exec(String(note.body || ''));
      const commit = /\bCommit\s*:\s*`?([0-9a-f]{40,64})\b/i.exec(String(note.body || ''));
      if (note.system || !login || !verdict || !commit) continue;
      const ok = !/^not/i.test(verdict[1]);
      if (ok && !approvers.has(login.toLowerCase())) continue;
      reviews.push({ id: note.id, state: ok ? 'APPROVED' : 'REQUEST_CHANGES', body: String(note.body), commit_id: commit[1], user: { login }, submitted_at: note.created_at });
    }
    return reviews;
  }
  // The inline comments (diff notes) of one reviewer. `reviewId` is the id of a review from `listReviews`; GitLab does not group inline
  // notes by review, so these are all the inline notes of the author of that review note.
  async listReviewComments(repository: string, number: number, reviewId: Review['id']): Promise<Comment[]> {
    const notes = await this.call(repository, 'GET', '/merge_requests/' + number + '/notes?sort=asc&order_by=created_at&per_page=100');
    const author = (Array.isArray(notes) ? notes : []).find((note: Json) => note.id === reviewId)?.author?.id;
    return (Array.isArray(notes) ? notes : []).filter((note: Json) => note.type === 'DiffNote' && !note.system && author !== undefined && note.author?.id === author).map(commentOf);
  }
  // Submit a review the way `listReviews` reads it: the note (with the commit named on its last line) and, for approve, the approval
  // pinned to the commit. GitLab's REST API has no "request changes": that verdict is the note alone, which should begin with
  // `## Verdict: NOT OK`. The note comes first, so that the approval event finds it.
  async submitReview(repository: string, number: number, verdict: ReviewVerdict, body: string, commitSha?: string): Promise<void> {
    const text = commitSha && !body.includes(commitSha) ? body + '\n\nCommit: ' + commitSha : body;
    if (text) await this.call(repository, 'POST', '/merge_requests/' + number + '/notes', { body: text });
    if (verdict === 'approve') await this.call(repository, 'POST', '/merge_requests/' + number + '/approve', commitSha ? { sha: commitSha } : {});
  }

  // The pipelines of a commit, folded into one answer. Of the pipelines that ran for the same ref and source (a rerun on the same commit)
  // only the newest counts. Cancelled and skipped ones say nothing; a pipeline waiting for a manual job is not finished.
  async commitStatus(repository: string, sha: string): Promise<CommitStatus> {
    const list = await this.call(repository, 'GET', '/pipelines?sha=' + encodeURIComponent(sha) + '&order_by=id&sort=desc&per_page=100');
    const newest = new Map<string, string>();
    for (const pipeline of (Array.isArray(list) ? list : []) as Json[]) {
      const key = pipeline.source + ' ' + pipeline.ref;
      if (!newest.has(key) && !IGNORED.has(pipeline.status)) newest.set(key, String(pipeline.status));
    }
    const states = [...newest.values()];
    const state = states.includes('failed') ? 'failure' : states.some((status) => NOT_FINISHED.has(status)) || !states.length ? 'pending' : 'success';
    return { state, total_count: states.length };
  }
  async commitTime(repository: string, sha: string): Promise<string | null> {
    const commit = await this.call(repository, 'GET', '/repository/commits/' + encodeURIComponent(sha));
    return commit?.created_at || commit?.committed_date || null;
  }
  async branchTip(repository: string, branch: string): Promise<string | null> {
    const head = await this.call(repository, 'GET', '/repository/branches/' + encodeURIComponent(branch));
    return head?.commit?.id || null;
  }

  async getIssue(repository: string, number: number): Promise<Issue> { return toIssue(await this.call(repository, 'GET', '/issues/' + number)); }
  async closeIssue(repository: string, number: number): Promise<void> { await this.call(repository, 'PUT', '/issues/' + number, { state_event: 'close' }); }
  dependencies(repository: string, number: number): Promise<Issue[]> { return this.links(repository, number, 'is_blocked_by'); }
  blocks(repository: string, number: number): Promise<Issue[]> { return this.links(repository, number, 'blocks'); }
  // Issue links of the type `blocks` / `is_blocked_by` need GitLab Premium. Without it (or without the right to see them) GitLab answers
  // 403 or 404, or lists no such link: then there are no dependencies and nothing is held back. Links into other projects are left out,
  // because a number here means an issue of this project.
  async links(repository: string, number: number, type: 'blocks' | 'is_blocked_by'): Promise<Issue[]> {
    let links: Json;
    try { links = await this.call(repository, 'GET', '/issues/' + number + '/links'); }
    catch (error) {
      if (/HTTP (402|403|404)\b/.test(error.message)) return [];
      throw error;
    }
    const own = (Array.isArray(links) ? links : []).filter((link: Json) => link.link_type === type);
    if (!own.length) return [];
    const project = await this.projectId(repository);
    return own.filter((link: Json) => link.project_id === project).map(toIssue);
  }
  async projectId(repository: string): Promise<number> {
    const known = this.projectIds.get(repository);
    if (known !== undefined) return known;
    const project = await this.call(repository, 'GET', '');
    this.projectIds.set(repository, project?.id);
    return project?.id;
  }

  // The notes of an issue or merge request, oldest first, without the system notes ("added label ...", "changed the description").
  async listComments(repository: string, number: number, limit: number, on: Subject = 'pull'): Promise<Comment[]> {
    const notes = await this.call(repository, 'GET', this.base(number, on) + '/notes?sort=asc&order_by=created_at&per_page=' + Math.min(limit, 100));
    return (Array.isArray(notes) ? notes : []).filter((note: Json) => !note.system).map(commentOf);
  }
  async addComment(repository: string, number: number, body: string, on: Subject = 'pull'): Promise<void> { await this.call(repository, 'POST', this.base(number, on) + '/notes', { body }); }
  // Labels are found by name. A name with `::` is a scoped label, which replaces its siblings; `ai:ready` has a single colon and is an
  // ordinary label.
  async findOrCreateLabel(repository: string, name: string, color: string): Promise<Label> {
    const known = await this.call(repository, 'GET', '/labels?per_page=100&search=' + encodeURIComponent(name));
    const found = (Array.isArray(known) ? known : []).find((entry: Json) => entry.name === name);
    if (!found) await this.call(repository, 'POST', '/labels', { name, color: color.startsWith('#') ? color : '#' + color });
    return { id: name, name };
  }
  async labelsOf(repository: string, number: number, on: Subject = 'pull'): Promise<Label[]> { return labelsOfJson((await this.call(repository, 'GET', this.base(number, on)))?.labels); }
  async addLabels(repository: string, number: number, labels: Label[], on: Subject = 'pull'): Promise<void> {
    await this.call(repository, 'PUT', this.base(number, on), { add_labels: labels.map((label) => label.name).join(',') });
  }
  async removeLabel(repository: string, number: number, label: Label, on: Subject = 'pull'): Promise<void> {
    await this.call(repository, 'PUT', this.base(number, on), { remove_labels: label.name });
  }

  base(number: number, on: Subject): string { return (on === 'issue' ? '/issues/' : '/merge_requests/') + number; }
}
