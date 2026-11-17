import type { IncomingHttpHeaders } from 'node:http';
import type { Json, NormalizedEvent } from '../types.ts';
import type { NormalizeOptions } from '../webhook/events.ts';

/** The forges ForgeHands can talk to. Each has its own implementation of `Forge` (Gitea shares Forgejo's). */
export type ForgeKind = 'forgejo' | 'gitea' | 'gitlab';

// The shapes below are what the core reads. A forge whose API looks different maps its answers into them (a GitLab merge request into a
// PullRequest, a pipeline into a CommitStatus), so that the dispatcher and the merger never branch on the forge.

export interface Label { id: number | string; name: string }

export interface PullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  merged: boolean;
  /** `false` only when the forge knows of a conflict; undefined when it does not say. */
  mergeable?: boolean;
  merge_base?: string;
  merged_at?: string | null;
  updated_at: string;
  html_url?: string | null;
  user?: { login?: string; username?: string };
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
  labels?: Label[];
}

export interface Issue {
  number: number;
  title?: string;
  body?: string;
  state: string;
  html_url?: string | null;
  comments?: number;
  labels?: Label[];
  /** Set when the "issue" is a pull request. */
  pull_request?: unknown;
}

export interface Comment { created_at: string; body: string; user?: { login?: string } }

/** The combined status of a commit: `state` is success, pending, failure or error; `total_count` is how many checks report. */
export interface CommitStatus { state: string; total_count: number }

export interface ChangedFile { filename: string; previous_filename?: string }

export interface Compare { total_commits?: number; files?: ChangedFile[] }

export interface Review {
  id: number | string; state: string; body?: string; commit_id?: string; user?: { login?: string }; submitted_at?: string;
  /** Forgejo: the review was dismissed, is stale (a push came after it), or counts for the branch protection (the reviewer may approve). */
  dismissed?: boolean; stale?: boolean; official?: boolean;
}

/** What a submitted review says. */
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/**
 * What a bare number refers to. Forgejo numbers issues and pull requests together, so for it the two are one resource; GitLab numbers
 * issues and merge requests apart (iid), so a comment or label call has to say which one it means. The default is the pull request.
 */
export type Subject = 'issue' | 'pull';

export interface ListPullsOptions { state: 'open' | 'closed' | 'all'; limit: number; sort?: 'recentupdate' }

export interface MergeOptions {
  /** One of MERGE_METHOD: merge, squash, rebase, rebase-merge, fast-forward-only. */
  method: string;
  /** The merge only happens when the head of the pull request still is this commit. */
  headSha: string;
  deleteBranch: boolean;
}

export type UpdateBranchResult = 'updated' | 'conflict';

/**
 * The API paths an agent calls itself (the prompts tell it where to read and write). Each method returns the full URL as the agent has
 * to write it, with the base taken from the agent's secrets, so the prompts contain no forge specific path.
 */
export interface AgentApi {
  /** What the forge is called in a prompt ("Forgejo"). */
  name: string;
  /** The secrets the agent gets (AGENT_SECRETS), as a phrase: "the FORGEJO_TOKEN and FORGEJO_URL secrets". */
  secrets: string;
  /** Where the repository keeps its CI workflow files, as a phrase for the fix prompt. */
  workflows: string;
  issue(number: number | string): string;
  issueComments(number: number | string): string;
  /** Comments and labels of a pull request: the same resource as an issue's on Forgejo, a different one on GitLab (own numbering). */
  pullComments(number: number | string): string;
  pull(number: number | string): string;
  pullDiff(number: number | string): string;
  pullReviews(number: number | string): string;
  /** How an agent submits a native review of a commit, as a phrase for the review prompt; absent: POST to `pullReviews` with an event, commit_id and body. */
  reviewPost?(number: number | string, sha: string): string;
  /** All pull requests of the repository, any state. */
  pulls(): string;
  labels(): string;
  issueLabels(number: number | string): string;
  pullLabels(number: number | string): string;
  /** One label on an issue or pull request, by the id `labels()` gave. */
  issueLabel(number: number | string, id: string): string;
  pullLabel(number: number | string, id: string): string;
  /** The body an agent sends to add labels to an issue or pull request, as JSON text, and the HTTP method it sends it with. */
  addLabelsBody: string;
  addLabelsMethod: string;
  /** The HTTP method that takes a label off (to the URL `issueLabel` / `pullLabel` gave). */
  removeLabelMethod: string;
  /** The body that closes an issue, as JSON text, and the HTTP method it goes with. */
  closeBody: string;
  closeMethod: string;
}

/**
 * Everything the core needs from a forge: webhooks in, operations out. One implementation per API family (Forgejo now; Gitea is a
 * variant of it, GitLab its own). The dry run gate and the API error metrics sit below it, in the transport every call passes through,
 * so an implementation cannot write around them. Operations are scoped to a repository by its full name ("owner/name"); a number is
 * the number of an issue or pull request (GitLab: the iid; see `Subject` where it matters).
 */
export interface Forge {
  readonly kind: ForgeKind;
  /** The API paths of this forge for the agent prompts. */
  agent(repository: string): AgentApi;

  // Webhooks in
  /** The path the forge posts its webhooks to. */
  readonly webhookPath: string;
  /** Does the delivery carry a valid signature or token for the secret? */
  verifyWebhook(secret: string, raw: Buffer, headers: IncomingHttpHeaders): boolean;
  /** The event name of the delivery (a header). */
  eventName(headers: IncomingHttpHeaders): unknown;
  /** An id that is the same when the forge redelivers. */
  deliveryId(headers: IncomingHttpHeaders, raw: Buffer, event: unknown): string;
  /** The delivery as a normalized event, or null when it is of no interest. */
  normalizeEvent(event: unknown, payload: Json, allowedRepos: Set<string>, labels: string[], options: NormalizeOptions): NormalizedEvent | null;

  // Pull requests
  getPull(repository: string, number: number): Promise<PullRequest>;
  listPulls(repository: string, options: ListPullsOptions): Promise<PullRequest[]>;
  /** One page (1-based) of the files a pull request changes; without a page the first `limit` files. */
  pullFiles(repository: string, number: number, limit: number, page?: number): Promise<ChangedFile[]>;
  /** The files that changed between two commits. */
  compare(repository: string, base: string, head: string): Promise<Compare>;
  /** Rebase the branch of a pull request onto its base. `conflict` when it does not apply cleanly. Other failures throw. */
  updateBranch(repository: string, number: number): Promise<UpdateBranchResult>;
  /** Merge; throws when the forge refuses (head moved, conflict, checks missing). */
  mergePull(repository: string, number: number, options: MergeOptions): Promise<void>;
  /** Is this title marked as work in progress (which the forge refuses to merge)? */
  isWip(title: string): boolean;
  /** The title without the work in progress marker. */
  stripWip(title: string): string;
  /** Close a pull request without merging; its branch stays. */
  closePull(repository: string, number: number): Promise<void>;
  setPullTitle(repository: string, number: number, title: string): Promise<void>;
  /** Native reviews of a pull request (ForgeHands reads the verdict comment today; this is for reviews as the verdict). */
  listReviews(repository: string, number: number): Promise<Review[]>;
  /** The inline comments of one review. */
  listReviewComments(repository: string, number: number, reviewId: Review['id']): Promise<Comment[]>;
  /** Submit a review as the ForgeHands user, optionally pinned to a commit. */
  submitReview(repository: string, number: number, verdict: ReviewVerdict, body: string, commitSha?: string): Promise<void>;

  // Commits and branches
  commitStatus(repository: string, sha: string): Promise<CommitStatus>;
  /** The creation time of a commit (ISO text), or null when the forge does not say. */
  commitTime(repository: string, sha: string): Promise<string | null>;
  /** The sha of the tip of a branch, or null. */
  branchTip(repository: string, branch: string): Promise<string | null>;

  // Issues
  getIssue(repository: string, number: number): Promise<Issue>;
  closeIssue(repository: string, number: number): Promise<void>;
  /** Issues `number` depends on. */
  dependencies(repository: string, number: number): Promise<Issue[]>;
  /** Issues that depend on `number`. */
  blocks(repository: string, number: number): Promise<Issue[]>;

  // Comments and labels (issues and pull requests alike)
  listComments(repository: string, number: number, limit: number, on?: Subject): Promise<Comment[]>;
  addComment(repository: string, number: number, body: string, on?: Subject): Promise<void>;
  /** The label of the repository with this name, created with this colour when it does not exist. */
  findOrCreateLabel(repository: string, name: string, color: string): Promise<Label>;
  labelsOf(repository: string, number: number, on?: Subject): Promise<Label[]>;
  addLabels(repository: string, number: number, labels: Label[], on?: Subject): Promise<void>;
  removeLabel(repository: string, number: number, label: Label, on?: Subject): Promise<void>;
}

/** One call to the forge's API: the lowest layer, where DRY_RUN stops writes and API errors are counted. */
export type Transport = (repository: string, method: string, path: string, body?: unknown) => Promise<Json>;
