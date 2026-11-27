// Shared shapes. The Forgejo and OpenHands payloads are untrusted JSON: they are read as `Json` and narrowed in the normalizers.
export type Json = any;

import type { ForgeKind } from './types/forge.ts';
import type { ScenarioResult } from './e2e/runner.ts';

export type Fetch = typeof fetch;

export interface Logger {
  error: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

/** VERDICT_SOURCE: where the verdict of a review comes from. */
export type VerdictSource = 'comment' | 'review' | 'both';

export type RouteKind = 'issue' | 'pull_request' | 'ci_failure' | 'ci_success' | 'epic_done' | 'conflict' | 'sensitive_review' | 'main_red';

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
export const NOTIFY_KINDS = ['handover', 'blocked', 'conflict', 'failed', 'reminder', 'stalled', 'checks'] as const;

/** What holds the queued and waiting jobs back, counted per job (see Dispatcher.idleCounts). `could_start`: a job that could start and did not. */
export interface IdleCounts { dependencies: number; files: number; quota: number; disk: number; hourly: number; concurrency: number; could_start: number; /** waiting jobs of a dependency cycle (no way out by itself) */ cycle: number; /** waiting jobs that wait, directly or transitively, behind a blocked pull request (see stuck.ts) */ stuck: number }
/** The last pass in which something waited and nothing could start: since when, the counts, and the tiers whose quota holds the queued jobs. */
export interface IdleState { since: number; reasons: IdleCounts; tiers: string[]; /** the dependency cycles of the ledger, as text (see cycleText) */ cycles: string[] }

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
  /** The webhook secret (FORGE_WEBHOOK_SECRET); the field keeps its first name. */
  forgejoSecret: string;
  allowedRepos: Set<string>;
  allowedSenders: Set<string> | null;
  statusToken: string | null;
  /** STATUS_PUBLIC=1: without STATUS_TOKEN the status page and the metrics are open to everybody who can reach the port. Off by default. */
  statusPublic: boolean;
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
  /** OPERATOR_LABEL: a ticket with this label is work for an operator; no run starts on it (see agent/operator.ts). */
  operatorLabel: string;
  updateBranches: boolean;
  /** REVIEW_WITHOUT_CI: a pull request in a repository without any workflow file is reviewed without waiting for a green CI run. */
  reviewWithoutCi: boolean;
  /** CHECKS_FROM_CI: the forge's check result of the head is given to the reviewer as data, and a failed head never gets an OK verdict (see agent/checks.ts). */
  checksFromCi: boolean;
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
  /** FAILURE_ESCALATE: a round that is still stuck, timed out or out of iterations then starts once more on the profile of its escalate_to route (once per head commit); so does an issue run that finished twice without a delivery. 0 switches it off. */
  failureEscalate: boolean;
  quotaHoldMaxMs: number;
  quotaGiveUpMs: number;
  splitLabel: string | null;
  /** TICKET_PREFLIGHT (on by default, 0 = off): a worker's ticket that breaks a rule of src/agent/preflight.ts starts no run. */
  ticketPreflight: boolean;
  /** TICKET_PREFLIGHT_BLOCK: the rule numbers (1 to 4) whose findings reject a ticket; the other findings are advisory. Default [2, 3]. */
  ticketPreflightBlock: number[];
  archiveAfterDays: number;
  /** REVERT_RETRIES (0 = off, at most 5): how often a ticket whose change was reverted after a red default branch is started again. See Dispatcher.revertMerged. */
  revertRetries: number;
  /** REVIEW_SWEEP_MINUTES (0 = off): how often a head without a review in the ledger is looked for and reviewed. See ReviewSweep. */
  reviewSweepMinutes: number;
  /** STUCK_PR_MINUTES (0 = off, at most 10080): how long an agent pull request may sit with a NOT OK verdict and nothing running before the watchdog blocks it. See stuck.ts. */
  stuckPrMinutes: number;
  /** TICKET_STALL_MINUTES (0 = off, at most 10080): how long after its last run an open ticket with no pull request may sit without a delivery before the ticket watchdog acts. See review-sweep.ts. */
  ticketStallMinutes: number;
  /** EPIC_GAP_REPLAN (default 1, 0 = off, at most 5): how often an epic that the review found open goes back to the planner before a human is called. See epic-gaps.ts. */
  epicGapReplan: number;
  /** EPIC_GAP_STALL_MINUTES (default 180, 0 = off, at most 10080): how long after its replan run ended an epic without new open sub-issues waits before
   * ForgeHands decides (re-review or human). See epic-gaps.ts (sweep). */
  epicGapStallMinutes: number;
  /** DELETE_AFTER_DAYS (0 = off): an archived run that ended this long ago loses its conversation in OpenHands. See Dispatcher.deleteOld. */
  deleteAfterDays: number;
  /** The days after which a failed (or deleted) run's conversation goes: DELETE_FAILED_AFTER_DAYS, or DELETE_AFTER_DAYS when that is 0. */
  deleteFailedAfterDays: number;
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
  /** PLAN_ANSWER_RESTARTS: a planner that finished without sub-issues starts again on a comment of HUMAN_LOGIN (0: off). See Dispatcher.planAnswer. */
  planAnswerRestarts: number;
  /** STALL_ALERT_MINUTES: a notification when nothing has started for this long while work waits on a hold that is not a dependency (0 = off). */
  stallAlertMinutes: number;
  /** NUDGE_AT_PERCENT: the share of a worker run's iteration limit after which, without a branch ai/issue-<n>, the run is nudged (0 = off). */
  nudgeAtPercent: number;
  /** NUDGE_MESSAGE: the text of the nudge instead of the default (null: the default). */
  nudgeMessage: string | null;
  /** NUDGE_TIMEOUT_SECONDS in milliseconds: how long a nudge may take to be answered (a message to a running conversation waits for its agent step). */
  nudgeTimeoutMs: number;
  notify: NotifyConfig;
  securityReviewers: Set<string> | null;
  approvedLabel: string;
  /** TWO_KEYS_HOLD_MINUTES: a two-key merge waits this long after both keys approved (0: merges at once). See Merger.holdGate. */
  twoKeysHoldMinutes: number;
  /** HOLD_LABEL: while this label is on a pull request, its two-key merge waits. */
  holdLabel: string;
  /** TWO_KEYS_DAILY_LIMIT: merges through two keys per repository in 24 hours (0: no limit). See Merger.twoKeysToday. */
  twoKeysDailyLimit: number;
  /** REVERT_ON_RED: a CI run that fails on the default branch for a commit ForgeHands merged is answered (see Dispatcher.onMainFailure). */
  revertOnRed: boolean;
  /** REVERT_WINDOW_MINUTES: how long after a merge a red default branch still counts as this merge's doing. */
  revertWindowMinutes: number;
  /** REVERT_RATE_ALERT (percent, 0 = off): a repository whose revert rate of 30 days is above it gets one `failed` notice a day. See Dispatcher.checkRevertRate. */
  revertRateAlert: number;
  /** REVERT_RATE_MIN_MERGES: the revert rate alert waits until this many merges are in the 30-day window. */
  revertRateMinMerges: number;
  /** RERUN_TIMEOUT_MINUTES (0 = off, at most 1440): how long a rerun of a failed run may take before the red default branch is reverted. See Dispatcher.rerunBeforeRevert. */
  rerunTimeoutMinutes: number;
  botAuthors: Set<string>;
  botBranchPrefixes: string[];
  botRepos: Set<string>;
  botFixRounds: number;
  epicLabels: Set<string>;
  pollMs: number;
  jobsFile: string;
  /** The end-to-end suite (E2E_*): off unless `e2e.repository` names a test repository. See src/e2e. */
  e2e: E2eConfig;
  /** RECURRING_REASON_MIN (0 = off, at most 50): how many NOT OK points with the same normalized reason in 14 days file a ticket for a check. See src/agent/recurring.ts. */
  recurringReasonMin: number;
}

/** E2E_REPO, E2E_ON_START, E2E_SCENARIOS, E2E_TIMEOUT_MINUTES. A null repository switches the suite off. */
export interface E2eConfig {
  repository: string | null;
  /** E2E_ON_START=1: run the suite once after a start whose version differs from the last recorded e2e version. */
  onStart: boolean;
  /** E2E_SCENARIOS: the names to run; null means every scenario that is not experimental. */
  scenarios: string[] | null;
  /** E2E_TIMEOUT_MINUTES: the time one scenario may take, cleanup not included. A wait for a run counts it from the start of the run. */
  timeoutMinutes: number;
  /** E2E_QUEUE_MINUTES: how long a run of the suite's ticket may wait in the queue before the wait fails (queued_too_long). */
  queueMinutes: number;
}

export type Config = WebhookConfig | DirectConfig;

/** The state of the clone breaker (see agent/clone-breaker.ts): `closed` starts work, `open` holds every new start, `half_open` may admit one trial. */
export type CloneBreakerState = 'closed' | 'open' | 'half_open';

/** The normalized class of a confirmed clone failure. Raw clone output never gets here: only this class, the repository, the time and the conversation. */
export const CLONE_FAILURE_CLASSES = ['clone_failed', 'repository_not_found', 'host_misconfigured', 'auth_failed'] as const;
export type CloneFailureClass = (typeof CLONE_FAILURE_CLASSES)[number];

/** One confirmed clone failure, kept only while it can count toward the threshold (ten minutes). */
export interface CloneFailureRecord {
  class: CloneFailureClass;
  /** The repository's full name, lower case; never a clone URL with credentials. */
  repository: string;
  /** When the failure was confirmed (ms). */
  at: number;
  /** The conversation that reported it: one failure per conversation while it is eligible, so a replay cannot count again. */
  conversation: string;
}

/** The one half-open trial the breaker admits. The reservation is claimed before its conversation starts, and its claimant owns it. */
export interface CloneBreakerTrial {
  /** The job key (`repo#issue`) that claimed the trial. */
  owner: string;
  /** The conversation the start produced; null while the claim waits for the start. Only that conversation can settle the trial. */
  conversation: string | null;
  started: number;
  /** After this time without positive evidence the trial is inconclusive: the breaker reopens, it never closes on time alone. */
  deadline: number;
}

/** The durable clone breaker, kept in the ledger as `meta.clone_breaker` (see agent/clone-breaker.ts). A ledger without it starts closed. */
export interface CloneBreakerRecord {
  state: CloneBreakerState;
  /** Counts the incidents: the one notification claim and a reopen belong to the same incident. */
  incident: number;
  opened_at: number | null;
  /** When the hold ends and one half-open trial may be admitted. */
  retry_at: number | null;
  trial: CloneBreakerTrial | null;
  /** The incident's one notification was claimed; a reopen keeps it, a recovery clears it. */
  notified: boolean;
  failures: CloneFailureRecord[];
}

/** What the status views may publish: only the state and its timing, never the evidence. */
export interface CloneBreakerSnapshot {
  state: CloneBreakerState;
  /** When the current incident opened (ms); null while closed. */
  since: number | null;
  /** When the hold ends and one half-open trial may be admitted; null while closed. */
  retry_at: number | null;
  /** Until when the admitted trial may still give positive checkout evidence; null without a trial. */
  trial_until: number | null;
}

/** The last end-to-end run, kept in the ledger (meta.e2e): its ForgeHands version, what started it and the result of each scenario. */
export interface E2eRecord {
  version: string;
  trigger: 'start' | 'manual';
  started: number;
  finished: number;
  /** Set when the suite could not run at all (the scenarios are then not in `results`). */
  error: string | null;
  results: ScenarioResult[];
}

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
  /** A comment of HUMAN_LOGIN that started a planner again, because it had finished without sub-issues (PLAN_ANSWER_RESTARTS). */
  plan_answer?: boolean;
  /** A ticket started again because its change was reverted (REVERT_RETRIES): the message says so. */
  revert_retry?: boolean;
  /** A ticket started again by the ticket watchdog (TICKET_STALL_MINUTES): its last run ended without a delivery; the prompt says so. */
  stall_retry?: boolean;
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

/** Tokens of an LLM conversation, summed over its usage ids (default, condenser) and every LLM call (OpenHands' token_usages). */
export interface TokenTotals { prompt: number; completion: number; cache_read: number; cache_write: number; reasoning: number }

// `dry`: a dry run judged and scheduled this job but started nothing. Not active, it never holds a slot or blocks an issue.
// `deleted`: the ticket (or pull request) was deleted in the forge; its waiting and queued jobs end here, without a hand-over (see dropDeleted).
export type JobStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'dry' | 'deleted';

/** A merge ForgeHands made (the ledger, kept 30 days): the merge commit when Forgejo reports it (REVERT_ON_RED), and whether two keys merged it. */
export interface MergeRecord {
  repository: string;
  number: number;
  branch: string;
  sha: string | null;
  merged_at: number;
  two_keys: boolean;
  /** The number of the revert pull request (ai/revert-<n>) that was merged for this merge. Set once. See revert-rate.ts. */
  reverted_by?: number;
  /** A red default branch after this merge needed a human: no revert route, a revert that went red, or a ticket blocked after its revert. */
  needed_human?: boolean;
  /** The red default branch after this merge was already red on the commit before it (a pre-existing failure): not reverted, not a revert cause. */
  pre_existing?: boolean;
}

/** A rerun of the failed run of a red default branch that was green before the merge (RERUN_TIMEOUT_MINUTES), kept 30 days. Once per commit. */
export interface RerunRecord {
  repository: string;
  number: number;
  sha: string;
  run_id: number | string | null;
  at: number;
  /** running: the rerun was started; green or red: the run finished; timeout: it did not finish in time; unavailable: no rerun could be started. */
  state: 'running' | 'green' | 'red' | 'timeout' | 'unavailable';
  /** The event that found the red branch: a finished rerun resumes it (Dispatcher.checkReruns). */
  event: ForgeEvent;
}

/** A revert of a merge that turned the default branch red (REVERT_RETRIES): the original ticket, the merge, and where the revert got to. */
export interface RevertRecord {
  repository: string;
  /** The original pull request (its number is the one of the revert branch ai/revert-<n>). */
  number: number;
  /** The ticket of the original pull request (ai/issue-<m>). */
  issue: number;
  sha: string;
  /** started: the revert run runs; merged: the revert pull request is merged; handled: done (or given to the human). */
  state: 'started' | 'merged' | 'handled';
  at: number;
  revert?: number;
  reopened?: boolean;
  commented?: boolean;
  restarted?: boolean;
  blocked?: boolean;
}

/** A two-key merge on hold (TWO_KEYS_HOLD_MINUTES), kept in the ledger per pull request ("repo#pr<n>"). `merge_after` is null while HOLD_LABEL is on. */
export interface Hold {
  repository: string;
  number: number;
  sha: string;
  since: number;
  merge_after: number | null;
  /** When the hold is looked at again (the timer in the dispatch tick, see Merger.recheckHolds). */
  check_at: number;
}

/** An epic (EPIC_LABEL) that the epic review found still open, kept in the ledger per epic ("repo#n", lower case) until it is closed (see epic-gaps.ts).
 * `sha` is the default branch's head the last decision was taken at; `replans` counts the times the epic went back to the planner (EPIC_GAP_REPLAN);
 * `human` is true once the human was called (at `sha`), so the epic waits for him. `reason` is the first lines of the reviewer's comment. */
/** A ticket labelled OPERATOR_LABEL that ForgeHands has seen ("repo#n", lower case), kept until it is closed (see agent/operator.ts). `at` is when it was
 * first seen: the human is told once, and /status lists the ticket until it is closed. `title` is the ticket's title as the forge had it. */
export interface OperatorRecord {
  repository: string;
  issue: number;
  title: string;
  at: number;
}

export interface EpicGapRecord {
  repository: string;
  issue: number;
  sha: string | null;
  at: number;
  replans: number;
  human: boolean;
  reason: string;
  /** Set when the epic review was started once more after a replan run without new open sub-issues: the review that ends next decides with no
   * further replan (a human, when the epic is still open). `rereview_at` is when it was started. */
  rereview?: boolean;
  rereview_at?: number;
}

/** An epic the epic sweep (REVIEW_SWEEP_MINUTES, see src/agent/epic-sweep.ts) looked at, kept per epic ("repo#n", lower case) while it is open.
 * `open` are its sub-issues still open at the last look, `deps` how many it has, `last_closed` the latest close of them (ms; the look's time when
 * the forge does not say). `sha` is the default branch's head the sweep last started the epic review at (`started_at`): one start per head. */
export interface EpicSweepRecord {
  repository: string;
  issue: number;
  deps: number;
  open: number[];
  last_closed: number;
  checked_at: number;
  sha: string | null;
  started_at: number | null;
}

/** A blocked agent pull request, kept in the ledger per pull request ("repo#pr<n>") while it is blocked or a human may unblock it (see stuck.ts).
 * `why`: `label` (BLOCKED_LABEL was there when ForgeHands looked), `stuck_rounds` (rounds used up) or `stuck_verdict` (NOT OK, nothing moved on).
 * `blocked` is true while the label is on; `eligible_at` is when the watchdog may block it (for `stuck_*` reasons, after STUCK_PR_MINUTES). */
export interface StuckRecord {
  repository: string;
  issue: number;
  number: number;
  sha: string;
  why: string;
  blocked: boolean;
  eligible_at: number;
  blocked_at: number | null;
}

/** A ticket the ticket watchdog found stalled (kept in the ledger per ticket, "repo#n"): `restarts` is 1 once it was started once more, `human` is true
 * once the human was called (the ticket carries BLOCKED_LABEL). `run` is the id of the last run it acted on. See review-sweep.ts and stuck.ts. */
export interface StalledRecord {
  repository: string;
  issue: number;
  run: string;
  restarts: number;
  human: boolean;
  at: number;
}

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
  /** A planner run's dependencies when it started (sorted issue numbers). An answer to the plan counts the sub-issues created since (Dispatcher.planAnswer);
   * a job without it comes from before the snapshot existed. */
  deps_before?: number[];
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
  /** Stage B (FAILURE_ESCALATE): a fresh run of a round on the profile of its escalate_to route, started after `escalated_after` (the state the run stopped in,
   * `no_delivery` for an issue run that finished twice without a delivery, or `handback` for a worker that handed its ticket back by a comment). It is not a follow-up round: it does not count against MAX_ROUNDS. */
  failure_escalation?: boolean;
  escalated_after?: string;
  /** Label of the fallback route whose profile and tier this run started with, because the tier of its own route was on a quota hold. */
  fell_back?: string;
  archived?: boolean;
  /** DELETE_AFTER_DAYS: the conversation was deleted in OpenHands; the job and its numbers stay in the ledger. */
  conversation_deleted?: boolean;
  /** The issue of this job is closed in the forge: the status page lists it as closed, never as waiting or failed. */
  archived_view?: boolean;
  /** When the ledger sync (LEDGER_SYNC_HOURS) last asked the forge about this ticket; kept on every job of it, so the oldest-checked ticket goes first. */
  synced_at?: number;
  error_retry?: number;
  delivery_retry?: number;
  /** A hand-back: the run was made once more because it handed the ticket back with "done, but nothing pushed" (once per job); the next run is told to push. */
  handback_retry?: boolean;
  handback_push?: boolean;
  /** The run delivered as a comment of the agent on this issue, which the run's issue blocks (its parent). */
  delivered_on?: number;
  /** The tokens of the run's conversations so far, added up when each of them ended (see Dispatcher.countTokens). */
  tokens?: TokenTotals;
  /** The tokens of the current conversation that are in `tokens` already: a continued run adds only what came after. */
  tokens_seen?: TokenTotals;
  /** Nudge (NUDGE_AT_PERCENT): the actions the run had used when it was nudged, once per conversation; kept on the job so a restart does not repeat it. */
  nudged?: number;
  /** The branch ai/issue-<n> exists, so the run needs no nudge: no more counting for this conversation. */
  nudge_settled?: boolean;
  /** A nudge was sent and its answer is not known yet (a timeout): its marker is looked for in the events before any resend, `tries` counts the sends. */
  nudge_pending?: { marker: string; tries: number; used: number; max: number };
  /** The nudge was sent the maximum number of times without a trace in the events: no more nudges for this conversation. */
  nudge_gave_up?: boolean;
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

/** A NOT OK point of a reviewer verdict on a pull request head, normalized (RECURRING_REASON_MIN); kept 30 days. `url` links the verdict comment or review. */
export interface FindingRecord {
  repository: string;
  reason: string;
  number: number;
  sha: string;
  at: number;
  url?: string;
}

/** The ticket filed for a recurring reason ("repo|reason" in the ledger). Kept until it is needed no more: one per reason, see RecurringFindings. */
export interface FiledFinding {
  repository: string;
  reason: string;
  issue: number;
  filed_at: number;
}

export interface ReleaseFieldContext { source: 'RELEASE_REPOS'; repository: string; field: string }
export type ReleaseArtifact =
  | { kind: 'container'; image: string; tagForms?: string[] }
  | { kind: 'npm'; package: string; registry: string };
export interface ReleaseDeployment { repository: string; file: string; pinPattern: string }
