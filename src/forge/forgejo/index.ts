import { metrics } from '../../metrics.ts';
import { DryLog, isDry, isWrite } from '../../dry.ts';
import { normalizeEvent } from '../../webhook/events.ts';
import { deliveryId, verifyForgejoSignature } from '../../webhook/security.ts';
import type { Config, Fetch, ForgejoAccess, Json } from '../../types.ts';
import type { AgentApi, BranchRef, ChangedFile, Comment, CommitStatus, Compare, FileAt, FileDelete, FileWrite, Forge, ForgeKind, Issue, Label, ListPullsOptions, MergeOptions, PullRequest, Review, ReviewVerdict, Transport, UpdateBranchResult } from '../../types/forge.ts';

export interface ForgejoConfig { forgejo?: ForgejoAccess | null; timeoutMs: number; dryRun: Config['dryRun']; dryRunRepos: Config['dryRunRepos'] }

// One call to the Forgejo API of a repository, as the Forgejo user whose token ForgeHands holds. Every Forgejo write of ForgeHands passes
// here, so this is where a dry run (DRY_RUN) stops it: the call is logged and answered with a stand-in, never sent. Reads are real.
// An empty repository name calls the API outside any repository (GET /user): only reads use it.
export async function forgejoCall(config: ForgejoConfig, send: Fetch, repository: string, method: string, path: string, body?: unknown, dry: DryLog = new DryLog()): Promise<Json> {
  if (isWrite(method) && isDry(config, repository)) {
    dry.record(repository, method, path, body);
    return { id: 0, dry_run: true };
  }
  const { url, token } = config.forgejo as ForgejoAccess;
  const response = await send(url + '/api/v1' + (repository ? '/repos/' + repository : '') + path, {
    method,
    headers: { authorization: 'token ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error'
  }).catch((error) => { metrics.apiError('forgejo', null); throw error; });
  // A missing workflow folder or branch is an ordinary answer of the contents and branches API, not an error worth counting.
  if (!response.ok) { if (!(response.status === 404 && (path.startsWith('/contents/') || path.startsWith('/branches/')))) metrics.apiError('forgejo', response.status); throw new Error(method + ' ' + path + ' -> HTTP ' + response.status); }
  return response.json().catch(() => null);
}

export function forgejoTransport(config: ForgejoConfig, send: Fetch, dry: DryLog = new DryLog()): Transport {
  return (repository, method, path, body) => forgejoCall(config, send, repository, method, path, body, dry);
}

// Where Forgejo looks for workflows (modules/actions/workflows.go ListWorkflows): the first of these folders that exists in the tree is the
// one it uses, whether or not it holds workflows. Gitea looks in the last two.
const WORKFLOW_DIRS = ['.forgejo/workflows', '.gitea/workflows', '.github/workflows'];

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
    pullComments: (number) => api + '/issues/' + number + '/comments',
    pull: (number) => api + '/pulls/' + number,
    pullDiff: (number) => api + '/pulls/' + number + '.diff',
    pullReviews: (number) => api + '/pulls/' + number + '/reviews',
    pulls: () => api + '/pulls?state=all',
    labels: () => api + '/labels',
    issueLabels: (number) => api + '/issues/' + number + '/labels',
    pullLabels: (number) => api + '/issues/' + number + '/labels',
    issueLabel: (number, id) => api + '/issues/' + number + '/labels/' + id,
    pullLabel: (number, id) => api + '/issues/' + number + '/labels/' + id,
    addLabelsBody: '{"labels":[<id>]}',
    addLabelsMethod: 'POST',
    removeLabelMethod: 'DELETE',
    closeBody: '{"state":"closed"}',
    closeMethod: 'PATCH'
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
  listPulls(repository: string, { state, limit, sort, page }: ListPullsOptions): Promise<PullRequest[]> {
    return this.call(repository, 'GET', '/pulls?state=' + state + (sort ? '&sort=' + sort : '') + '&limit=' + limit + (page ? '&page=' + page : ''));
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
  async closePull(repository: string, number: number): Promise<void> { await this.call(repository, 'PATCH', '/pulls/' + number, { state: 'closed' }); }
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
  // A 404 means the folder is absent. Any other failure, or an answer that is no folder listing, throws: "unknown" must never read as "no CI".
  async hasWorkflows(repository: string, sha: string): Promise<boolean> {
    for (const dir of WORKFLOW_DIRS) {
      let listing: Json;
      try { listing = await this.call(repository, 'GET', '/contents/' + dir + '?ref=' + encodeURIComponent(sha)); }
      catch (error) {
        if (/HTTP 404\b/.test(error.message)) continue;
        throw error;
      }
      if (!Array.isArray(listing)) throw new Error('GET /contents/' + dir + ' did not answer with a folder listing');
      return listing.some((entry: Json) => entry?.type === 'file' && /\.ya?ml$/i.test(String(entry.name || '')));
    }
    return false;
  }
  // A missing path is a 404 of the contents API; any other failure throws, so that the caller can tell "no" from "cannot say".
  async fileExists(repository: string, path: string, ref?: string): Promise<boolean> {
    const query = ref ? '?ref=' + encodeURIComponent(ref) : '';
    try {
      await this.call(repository, 'GET', '/contents/' + path.split('/').map(encodeURIComponent).join('/') + query);
      return true;
    } catch (error) {
      if (/HTTP 404\b/.test(error.message)) return false;
      throw error;
    }
  }

  async branchTip(repository: string, branch: string): Promise<string | null> {
    const head = await this.call(repository, 'GET', '/branches/' + encodeURIComponent(branch));
    return head?.commit?.id || null;
  }

  getIssue(repository: string, number: number): Promise<Issue> { return this.call(repository, 'GET', '/issues/' + number); }
  // The user of the token, read once. A failed read is not remembered, so the next check asks again.
  private login: string | null = null;
  async agentLogin(): Promise<string | null> {
    if (this.login) return this.login;
    const user = await this.call('', 'GET', '/user');
    this.login = String(user?.login || '').toLowerCase() || null;
    return this.login;
  }
  async closeIssue(repository: string, number: number): Promise<void> { await this.call(repository, 'PATCH', '/issues/' + number, { state: 'closed' }); }
  async reopenIssue(repository: string, number: number): Promise<void> { await this.call(repository, 'PATCH', '/issues/' + number, { state: 'open' }); }
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

  // The end-to-end suite's fixtures (see Forge): a test repository's tickets, branches and files.
  async getRepository(repository: string): Promise<{ default_branch: string }> {
    const info = await this.call(repository, 'GET', '');
    return { default_branch: String(info?.default_branch || '') };
  }
  createIssue(repository: string, title: string, body: string): Promise<Issue> { return this.call(repository, 'POST', '/issues', { title, body }); }
  // Pages of 50 until a short page; ten pages at most, which is far more branches than a test repository keeps.
  async listBranches(repository: string): Promise<BranchRef[]> {
    const branches: BranchRef[] = [];
    for (let page = 1; page <= 10; page++) {
      const list: Json = await this.call(repository, 'GET', '/branches?limit=50&page=' + page);
      const entries = Array.isArray(list) ? list : [];
      for (const entry of entries) branches.push({ name: String(entry?.name || ''), sha: String(entry?.commit?.id || '') });
      if (entries.length < 50) break;
    }
    return branches;
  }
  async deleteBranch(repository: string, branch: string): Promise<void> { await this.call(repository, 'DELETE', '/branches/' + encodeURIComponent(branch)); }
  // A missing file is an ordinary answer of the contents API (the 404 is not counted as an error). Something that exists but is not a
  // regular file (a symlink, a submodule, a folder) throws: read as "missing" it would be restored as a deletion, or left unexplained.
  // A file without content throws too: written back as "" it would destroy the file.
  async readFile(repository: string, path: string, ref: string): Promise<FileAt | null> {
    let entry: Json;
    try { entry = await this.call(repository, 'GET', '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(ref)); }
    catch (error) {
      if (/HTTP 404\b/.test(error.message)) return null;
      throw error;
    }
    if (!entry) return null;
    if (entry.type !== 'file') throw new Error('GET /contents/' + path + ' at ' + ref.slice(0, 8) + ': not a regular file (' + String(entry.type) + ')');
    if (typeof entry.content !== 'string' || typeof entry.sha !== 'string') throw new Error('GET /contents/' + path + ': no content in the answer');
    return { sha: entry.sha, content: entry.content };
  }
  // Create (POST) when there is no blob id, update (PUT) when there is one. The answer names the commit the write made.
  async writeFile(repository: string, path: string, { message, branch, content, sha }: FileWrite): Promise<string | null> {
    const body = { content, message, branch, ...(sha ? { sha } : {}) };
    return commitIdOf(await this.call(repository, sha ? 'PUT' : 'POST', '/contents/' + encodePath(path), body));
  }
  async deleteFile(repository: string, path: string, { message, branch, sha }: FileDelete): Promise<string | null> {
    return commitIdOf(await this.call(repository, 'DELETE', '/contents/' + encodePath(path), { message, branch, sha }));
  }
}

// Each segment of a repository path is encoded, the slashes between them are kept.
function encodePath(path: string): string { return path.split('/').map((segment) => encodeURIComponent(segment)).join('/'); }

// The commit a contents write answers with (`commit.sha`); null when the answer names none.
function commitIdOf(answer: Json): string | null {
  const sha = (answer as { commit?: { sha?: unknown } } | null)?.commit?.sha;
  return typeof sha === 'string' && sha ? sha : null;
}
