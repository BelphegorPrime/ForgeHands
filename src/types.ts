// Shared shapes. The Forgejo and OpenHands payloads are untrusted JSON: they are read as `Json` and narrowed in the normalizers.
export type Json = any;

import type { ForgeKind } from './forge/types.ts';

export type Fetch = typeof fetch;

export interface Logger {
  error: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

/** VERDICT_SOURCE: where the verdict of a review comes from. */
export type VerdictSource = 'comment' | 'review' | 'both';

export type RouteKind = 'issue' | 'pull_request' | 'ci_failure' | 'ci_success' | 'epic_done' | 'conflict' | 'sensitive_review';

export interface Route {
  profile: string;
  tier: string;
  maxIterations: number;
  maxBudget: number | null;
  maxConcurrent: number | null;
  kind: RouteKind;
  escalateTo: string | null;
  fallbackTo: string | null;
  /** "forgejo_token_secret": the AGENT_SECRETS entry that holds this route's own Forgejo token (the reviewer user); handed to this route's conversations as FORGEJO_TOKEN, to no other. */
  forgejoTokenSecret: string | null;
}

/** The deny list of a repository: a pattern (as written), its regular expression and why it needs a human (optional). */
export interface MergeRule {
  deny: RegExp[];
  patterns: string[];
  reasons: (string | null)[];
  /** Deny paths that may merge with an independent security review instead of a human (`two_keys`); empty by default. */
  twoKeys: RegExp[];
  twoKeyPatterns: string[];
}

export interface ForgejoAccess {
  url: string;
  token: string;
}

interface BaseConfig {
  /** FORGE: which forge ForgeHands talks to. */
  forge: ForgeKind;
  /** The webhook secret (FORGE_WEBHOOK_SECRET or FORGEJO_WEBHOOK_SECRET); the field keeps its first name. */
  forgejoSecret: string;
  allowedRepos: Set<string>;
  allowedSenders: Set<string> | null;
  statusToken: string | null;
  dataFile: string;
  port: number;
  host: string;
  timeoutMs: number;
  maxBodyBytes: number;
  /** DRY_RUN: receive and judge as usual, change nothing. With `dryRunRepos` only those repositories are dry. */
  dryRun: boolean;
  dryRunRepos: Set<string>;
}

export interface WebhookConfig extends BaseConfig {
  mode: 'webhook';
  openhandsSecret: string;
  endpoint: string;
  routes: Map<string, { kind?: RouteKind }>;
}

export interface DirectConfig extends BaseConfig {
  mode: 'direct';
  apiUrl: string;
  apiKey: string;
  routes: Map<string, Route>;
  mergePolicy: Map<string, MergeRule>;
  mergeMethod: string;
  changesLabel: string;
  agentSecrets: Record<string, string>;
  workspaceDir: string;
  maxConcurrent: number;
  maxConcurrentPerTier: number;
  maxRunsPerHour: number;
  repoWeights: Map<string, number>;
  maxRunMs: number;
  maxRounds: number;
  escalateFromRound: number;
  /** API access (FORGE_URL and FORGE_TOKEN, or FORGEJO_URL and FORGEJO_TOKEN); the field keeps its first name. */
  forgejo: ForgejoAccess | null;
  blockedLabel: string;
  updateBranches: boolean;
  waitForSameFiles: boolean;
  branchUpdateDelayMs: number;
  branchUpdateMinIntervalMs: number;
  minReviewChars: number;
  /** VERDICT_SOURCE: a `Verdict:` comment with the approval label (comment), native Forgejo reviews (review) or either (both). */
  verdictSource: VerdictSource;
  /** REQUIRED_APPROVALS: how many distinct reviewers must approve the head commit (review and both). */
  requiredApprovals: number;
  approvalGraceMs: number;
  errorRetries: number;
  quotaHoldMaxMs: number;
  quotaGiveUpMs: number;
  splitLabel: string | null;
  archiveAfterDays: number;
  remindAfterDays: number;
  remindMax: number;
  staleLabel: string | null;
  humanLogin: string | null;
  securityReviewers: Set<string> | null;
  approvedLabel: string;
  botAuthors: Set<string>;
  botBranchPrefixes: string[];
  botFixRounds: number;
  epicLabels: Set<string>;
  pollMs: number;
  jobsFile: string;
}

export type Config = WebhookConfig | DirectConfig;

export interface RepositoryInfo {
  full_name: string;
  clone_url: string | null;
  html_url: string | null;
  default_branch: string | null;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  html_url: string | null;
  comments: number;
  labels: string[];
}

export interface PullRequestRef {
  number: number;
  head_ref: string;
  html_url: string | null;
}

export interface CiInfo {
  run_id: number | string | null;
  workflow: string;
  commit_sha: string;
  status: string;
  html_url: string | null;
}

interface BaseEvent {
  type: string;
  source: ForgeKind;
  repository: RepositoryInfo;
  sender: { login: string | null };
  delivery_id?: string;
  /** Labels last seen on the issue or pull request (set by the webhook handler in direct mode). */
  previous_labels?: string[] | null;
}

/** A normalized event about an issue or a pull request of an issue. */
export interface ForgeEvent extends BaseEvent {
  action?: string;
  label?: string;
  label_event?: boolean;
  issue: IssueInfo;
  pull_request?: PullRequestRef;
  ci?: CiInfo;
  /** A pull request of a dependency bot (BOT_AUTHORS): there is no ticket, `issue` carries the pull request's own number, title and text. */
  bot?: boolean;
  epic?: { children: { number: number; title: string }[] };
  base_sha?: string;
  /** A native review (VERDICT_SOURCE review or both) that triggered this event: who wrote it. */
  review?: { reviewer: string | null };
  /** The changed files that match the deny list of the merge policy (security review runs only). */
  protected_files?: string[];
}

/** A push to the default branch. */
export interface PushEvent extends BaseEvent {
  type: 'push.default';
  after: string;
}

export type NormalizedEvent = ForgeEvent | PushEvent;

export const isPushEvent = (event: NormalizedEvent): event is PushEvent => event.type === 'push.default';

// `dry`: a dry run judged and scheduled this job but started nothing. Not active, it never holds a slot or blocks an issue.
export type JobStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'dry';

export interface Job {
  id: string;
  /** repo#issue:label[:commit] */
  key: string;
  label: string;
  event: ForgeEvent;
  status: JobStatus;
  created: number;
  attempts: number;
  waiting_for?: number[];
  /** The older issues whose files this one shares (WAIT_FOR_SAME_FILES); it starts when they are closed or their pull requests are gone. */
  waiting_for_files?: number[];
  waiting_for_run?: boolean;
  conversation_id?: string;
  started?: number;
  finished?: number;
  result?: string;
  error?: string;
  cost?: number;
  next_try?: number;
  retry_at?: number;
  rate_limited?: number;
  rate_limited_since?: number;
  verdict_retry?: number;
  round_reset?: boolean;
  escalated?: boolean;
  /** Label of the fallback route whose profile and tier this run started with, because the tier of its own route was on a quota hold. */
  fell_back?: string;
  archived?: boolean;
  error_retry?: number;
  delivery_retry?: number;
  /** Dry run: the first message the conversation would have started with. */
  dry_prompt?: string;
  /** When the pull request of the ticket was merged, and by whom: ForgeHands itself ('agent') or somebody else ('human'). Kept on the newest job of the ticket. */
  merged_at?: number;
  merged_by?: 'agent' | 'human';
  /** When the ticket was handed to a human (BLOCKED_LABEL), and when it was sent to the planner to be split (SPLIT_LABEL). */
  blocked_at?: number;
  split_at?: number;
}

export type NewJob = Omit<Job, 'id' | 'attempts'> & { attempts?: number };
