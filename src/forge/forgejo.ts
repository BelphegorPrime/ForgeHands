import { metrics } from '../metrics.ts';
import { DryLog, isDry, isWrite } from '../dry.ts';
import { normalizeEvent } from '../webhook/events.ts';
import { deliveryId, verifyForgejoSignature } from '../webhook/security.ts';
import type { Config, Fetch, ForgejoAccess, Json } from '../types.ts';
import type { AgentApi, ChangedFile, Comment, CommitStatus, Compare, Forge, ForgeKind, Issue, Label, ListPullsOptions, MergeOptions, PullRequest, Review, ReviewVerdict, Transport, UpdateBranchResult } from './types.ts';

export interface ForgejoConfig { forgejo?: ForgejoAccess | null; timeoutMs: number; dryRun: Config['dryRun']; dryRunRepos: Config['dryRunRepos'] }

// One call to the Forgejo API of a repository, as the Forgejo user whose token ForgeHands holds. Every Forgejo write of ForgeHands passes
// here, so this is where a dry run (DRY_RUN) stops it: the call is logged and answered with a stand-in, never sent. Reads are real.
export async function forgejoCall(config: ForgejoConfig, send: Fetch, repository: string, method: string, path: string, body?: unknown, dry: DryLog = new DryLog()): Promise<Json> {
  if (isWrite(method) && isDry(config, repository)) {
    dry.record(repository, method, path, body);
    return { id: 0, dry_run: true };
  }
  const { url, token } = config.forgejo as ForgejoAccess;
  const response = await send(url + '/api/v1/repos/' + repository + path, {
    method,
    headers: { authorization: 'token ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error'
  }).catch((error) => { metrics.apiError('forgejo', null); throw error; });
  if (!response.ok) { metrics.apiError('forgejo', response.status); throw new Error(method + ' ' + path + ' -> HTTP ' + response.status); }
  return response.json().catch(() => null);
}

export function forgejoTransport(config: ForgejoConfig, send: Fetch, dry: DryLog = new DryLog()): Transport {
  return (repository, method, path, body) => forgejoCall(config, send, repository, method, path, body, dry);
}

export const FORGEJO_WIP = /^\s*(?:\[WIP\]|WIP:)\s*/i;

const REVIEW_EVENT: Record<ReviewVerdict, string> = { approve: 'APPROVED', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' };

// The API paths an agent calls itself: the same API as ForgeHands uses, with the base in the agent's FORGEJO_URL secret.
export function forgejoAgentApi(repository: string): AgentApi {
  const api = '$FORGEJO_URL/api/v1/repos/' + repository;
  return {
    name: 'Forgejo',
    workflows: '.forgejo/workflows or .github/workflows',
    secrets: 'the FORGEJO_TOKEN and FORGEJO_URL secrets',
    issue: (number) => api + '/issues/' + number,
    issueComments: (number) => api + '/issues/' + number + '/comments',
    pull: (number) => api + '/pulls/' + number,
    pullDiff: (number) => api + '/pulls/' + number + '.diff',
    pullReviews: (number) => api + '/pulls/' + number + '/reviews',
    pulls: () => api + '/pulls?state=all',
    labels: () => api + '/labels',
    issueLabels: (number) => api + '/issues/' + number + '/labels',
    issueLabel: (number, id) => api + '/issues/' + number + '/labels/' + id,
    addLabelsBody: '{"labels":[<id>]}',
    closeBody: '{"state":"closed"}'
  };
}

// Forgejo's API (v1) and its webhooks. Gitea's is nearly the same; a Gitea variant overrides what differs.
export class ForgejoForge implements Forge {
  readonly kind: ForgeKind = 'forgejo';
  readonly webhookPath: string = '/webhooks/forgejo';
  call: Transport;

  constructor(call: Transport) {
    this.call = call;
  }

  agent(repository: string): AgentApi { return forgejoAgentApi(repository); }

  verifyWebhook(secret: string, raw: Buffer, headers: Parameters<Forge['verifyWebhook']>[2]): boolean {
    return verifyForgejoSignature(secret, raw, headers['x-forgejo-signature']);
  }
  eventName(headers: Parameters<Forge['eventName']>[0]): unknown { return headers['x-forgejo-event']; }
  deliveryId(headers: Parameters<Forge['deliveryId']>[0], raw: Buffer, event: unknown): string { return deliveryId(headers, raw, event); }
  normalizeEvent(...args: Parameters<Forge['normalizeEvent']>): ReturnType<Forge['normalizeEvent']> { return normalizeEvent(...args); }

  getPull(repository: string, number: number): Promise<PullRequest> { return this.call(repository, 'GET', '/pulls/' + number); }
  listPulls(repository: string, { state, limit, sort }: ListPullsOptions): Promise<PullRequest[]> {
    return this.call(repository, 'GET', '/pulls?state=' + state + (sort ? '&sort=' + sort : '') + '&limit=' + limit);
  }
  pullFiles(repository: string, number: number, limit: number, page?: number): Promise<ChangedFile[]> {
    return this.call(repository, 'GET', '/pulls/' + number + '/files?limit=' + limit + (page === undefined ? '' : '&page=' + page));
  }
  compare(repository: string, base: string, head: string): Promise<Compare> { return this.call(repository, 'GET', '/compare/' + base + '...' + head); }
  // Forgejo answers 409 when the rebase does not apply.
  async updateBranch(repository: string, number: number): Promise<UpdateBranchResult> {
    try { await this.call(repository, 'POST', '/pulls/' + number + '/update?style=rebase'); }
    catch (error) {
      if (/HTTP 409\b/.test(error.message)) return 'conflict';
      throw error;
    }
    return 'updated';
  }
  async mergePull(repository: string, number: number, { method, headSha, deleteBranch }: MergeOptions): Promise<void> {
    await this.call(repository, 'POST', '/pulls/' + number + '/merge', { Do: method, head_commit_id: headSha, delete_branch_after_merge: deleteBranch });
  }
  isWip(title: string): boolean { return FORGEJO_WIP.test(title); }
  stripWip(title: string): string { return title.replace(FORGEJO_WIP, ''); }
  async setPullTitle(repository: string, number: number, title: string): Promise<void> { await this.call(repository, 'PATCH', '/pulls/' + number, { title }); }
  listReviews(repository: string, number: number): Promise<Review[]> { return this.call(repository, 'GET', '/pulls/' + number + '/reviews'); }
  listReviewComments(repository: string, number: number, reviewId: Review['id']): Promise<Comment[]> {
    return this.call(repository, 'GET', '/pulls/' + number + '/reviews/' + reviewId + '/comments');
  }
  async submitReview(repository: string, number: number, verdict: ReviewVerdict, body: string, commitSha?: string): Promise<void> {
    await this.call(repository, 'POST', '/pulls/' + number + '/reviews', { event: REVIEW_EVENT[verdict], body, ...(commitSha ? { commit_id: commitSha } : {}) });
  }

  commitStatus(repository: string, sha: string): Promise<CommitStatus> { return this.call(repository, 'GET', '/commits/' + encodeURIComponent(sha) + '/status'); }
  async commitTime(repository: string, sha: string): Promise<string | null> {
    const commit = await this.call(repository, 'GET', '/git/commits/' + encodeURIComponent(sha));
    return commit?.created || commit?.commit?.committer?.date || null;
  }
  async branchTip(repository: string, branch: string): Promise<string | null> {
    const head = await this.call(repository, 'GET', '/branches/' + encodeURIComponent(branch));
    return head?.commit?.id || null;
  }

  getIssue(repository: string, number: number): Promise<Issue> { return this.call(repository, 'GET', '/issues/' + number); }
  async closeIssue(repository: string, number: number): Promise<void> { await this.call(repository, 'PATCH', '/issues/' + number, { state: 'closed' }); }
  dependencies(repository: string, number: number): Promise<Issue[]> { return this.call(repository, 'GET', '/issues/' + number + '/dependencies'); }
  blocks(repository: string, number: number): Promise<Issue[]> { return this.call(repository, 'GET', '/issues/' + number + '/blocks'); }

  listComments(repository: string, number: number, limit: number): Promise<Comment[]> { return this.call(repository, 'GET', '/issues/' + number + '/comments?limit=' + limit); }
  async addComment(repository: string, number: number, body: string): Promise<void> { await this.call(repository, 'POST', '/issues/' + number + '/comments', { body }); }
  async findOrCreateLabel(repository: string, name: string, color: string): Promise<Label> {
    const known = await this.call(repository, 'GET', '/labels?limit=100');
    return (known || []).find((entry: Json) => entry.name === name) || await this.call(repository, 'POST', '/labels', { name, color });
  }
  labelsOf(repository: string, number: number): Promise<Label[]> { return this.call(repository, 'GET', '/issues/' + number + '/labels'); }
  async addLabels(repository: string, number: number, labels: Label[]): Promise<void> {
    await this.call(repository, 'POST', '/issues/' + number + '/labels', { labels: labels.map((label) => label.id) });
  }
  async removeLabel(repository: string, number: number, label: Label): Promise<void> { await this.call(repository, 'DELETE', '/issues/' + number + '/labels/' + label.id); }
}
