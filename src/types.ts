// Shared shapes. The Forgejo and OpenHands payloads are untrusted JSON: they are read as `Json` and narrowed in the normalizers.
export type Json = any;

import type { ForgeKind } from './types/forge.ts';

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

export type NotifyLanguage = 'en' | 'de';
export const NOTIFY_KINDS = ['handover', 'blocked', 'conflict', 'failed', 'reminder'] as const;

/** Notifications (SMTP_*, NOTIFY_*, HUMAN_MENTION): how the human hears of what needs him without the forge's mail. */
export interface NotifyConfig {
  smtp: { host: string; port: number; security: 'starttls' | 'tls' | 'none'; user: string | null; password: string | null; from: string; to: string[]; tlsVerify: boolean; ca: string | null } | null;
  webhook: { url: string; auth: string | null } | null;
  /** Kinds that are sent at once (NOTIFY_IMMEDIATE); empty: none. */
  immediate: string[];
  /** NOTIFY_DIGEST: HH:MM in `timezone`, or null for no digest. */
  digest: string | null;
  timezone: string;
  language: NotifyLanguage;
  /** HUMAN_MENTION: false writes the hand-over comments without the @login, so that the forge sends no mail. */
  humanMention: boolean;
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
  /** WORKSPACE_CLEANUP_DIR: where the workspace is mounted in this container; null switches the cleanup and the disk guard off. */
  workspaceCleanupDir: string | null;
  /** WORKSPACE_CLEANUP_DRY: the cleanup logs what it would delete and deletes nothing. */
  workspaceCleanupDry: boolean;
  /** WORKSPACE_KEEP_HOURS / WORKSPACE_KEEP_FAILED_HOURS: how long after its end a finished (failed) run keeps its directory. */
  workspaceKeepHours: number;
  workspaceKeepFailedHours: number;
  /** WORKSPACE_ORPHAN_HOURS: a directory that no ledger job names is deleted once its modification time is this old. */
  workspaceOrphanHours: number;
  /** DISK_WARN_PERCENT (0 = off) and DISK_MIN_FREE_GB (0 = off): the disk guard. */
  diskWarnPercent: number;
  diskMinFreeGb: number;
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
  /** REVIEW_WITHOUT_CI: a pull request in a repository without any workflow file is reviewed without waiting for a green CI run. */
  reviewWithoutCi: boolean;
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
  /** RESUME_ATTEMPTS: how often a run that ended stuck or timed out continues on its own conversation (one message, then run again); 0 switches it off. */
  resumeAttempts: number;
  /** PAUSE_RESUMES: how often a run that was paused (an interruption: an OpenHands restart, or a stop of the operator) continues on its own conversation.
   * Its own budget, apart from RESUME_ATTEMPTS; 0 switches the resume off (the run is then handed to the human, never split). */
  pauseResumes: number;
  /** FAILURE_ESCALATE: a round that is still stuck, timed out or out of iterations then starts once more on the profile of its escalate_to route (once per head commit); 0 switches it off. */
  failureEscalate: boolean;
  quotaHoldMaxMs: number;
  quotaGiveUpMs: number;
  splitLabel: string | null;
  archiveAfterDays: number;
  /** LEDGER_SYNC_HOURS: how often the ledger sync asks the forge about tickets it holds as open; 0 = off. */
  ledgerSyncHours: number;
  /** STATUS_HIDE_DAYS: closed tickets whose last activity is older than this many days are not on the status page (0 = hide nothing). */
  statusHideDays: number;
  remindAfterDays: number;
  remindMax: number;
  staleLabel: string | null;
  humanLogin: string | null;
  /** COMMENT_RESTARTS: how often a comment of HUMAN_LOGIN may start a failed or handed-over run again, per issue and label; 0 switches it off. */
  commentRestarts: number;
  /** HUMAN_REVIEW_ROUNDS (comment mode, needs HUMAN_LOGIN): a formal request for changes of HUMAN_LOGIN starts a follow-up round. */
  humanReviewRounds: boolean;
  notify: NotifyConfig;
  securityReviewers: Set<string> | null;
  approvedLabel: string;
  botAuthors: Set<string>;
  botBranchPrefixes: string[];
  botRepos: Set<string>;
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
  review?: { reviewer: string | null; human?: boolean; id?: string; commit?: string };
  /** The changed files that match the deny list of the merge policy (security review runs only). */
  protected_files?: string[];
  /** A comment of HUMAN_LOGIN that started this run again (COMMENT_RESTARTS): the comment's id and its author. */
  comment?: { id: string; login: string | null };
}

/** A push to the default branch. */
export interface PushEvent extends BaseEvent {
  type: 'push.default';
  after: string;
}

/** A commit on a branch that may be an agent's or a bot's pull request (REVIEW_WITHOUT_CI). `pull_request` is set when the event named the pull request itself. */
export interface BranchPushEvent extends BaseEvent {
  type: 'push.branch';
  branch: string;
  after: string;
  pull_request?: number;
}

export type NormalizedEvent = ForgeEvent | PushEvent | BranchPushEvent;

export const isPushEvent = (event: NormalizedEvent): event is PushEvent => event.type === 'push.default';
export const isBranchPush = (event: NormalizedEvent): event is BranchPushEvent => event.type === 'push.branch';

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
  /** Stage A (RESUME_ATTEMPTS): how often the run was continued on its conversation, the state it stopped in before the latest continuation, when that
   * continuation started, and whether its message is still to be sent to OpenHands (the run call failed or was not answered yet). */
  resumes?: number;
  resumed_from?: string;
  resumed_at?: number;
  resume_pending?: boolean;
  /** PAUSE_RESUMES: how often the run was continued after it was paused (its own budget, counted apart from `resumes`). */
  pause_resumes?: number;
  /** Stage B (FAILURE_ESCALATE): a fresh run of a round on the profile of its escalate_to route, started after `escalated_after` (the state the run stopped in).
   * It is not a follow-up round: it does not count against MAX_ROUNDS. */
  failure_escalation?: boolean;
  escalated_after?: string;
  /** Label of the fallback route whose profile and tier this run started with, because the tier of its own route was on a quota hold. */
  fell_back?: string;
  archived?: boolean;
  /** The issue of this job is closed in the forge: the status page lists it as closed, never as waiting or failed. */
  archived_view?: boolean;
  /** When the ledger sync (LEDGER_SYNC_HOURS) last asked the forge about this ticket; kept on every job of it, so the oldest-checked ticket goes first. */
  synced_at?: number;
  error_retry?: number;
  delivery_retry?: number;
  /** The run delivered as a comment of the agent on this issue, which the run's issue blocks (its parent). */
  delivered_on?: number;
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
