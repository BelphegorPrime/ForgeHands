// Shared shapes. The Forgejo and OpenHands payloads are untrusted JSON: they are read as `Json` and narrowed in the normalizers.
export type Json = any;

export type Fetch = typeof fetch;

export interface Logger {
  error: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

export type RouteKind = 'issue' | 'pull_request' | 'ci_failure' | 'ci_success' | 'epic_done' | 'conflict' | 'sensitive_review';

export interface Route {
  profile: string;
  tier: string;
  maxIterations: number;
  maxBudget: number | null;
  maxConcurrent: number | null;
  kind: RouteKind;
}

export interface ForgejoAccess {
  url: string;
  token: string;
}

interface BaseConfig {
  forgejoSecret: string;
  allowedRepos: Set<string>;
  allowedSenders: Set<string> | null;
  dataFile: string;
  port: number;
  host: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface WebhookConfig extends BaseConfig {
  mode: 'webhook';
  openhandsSecret: string;
  endpoint: string;
  routes: Map<string, { kind?: RouteKind }>;
}

export interface DirectConfig extends BaseConfig {
  mode: 'direct';
  tierBudgets: Map<string, number>;
  apiUrl: string;
  apiKey: string;
  routes: Map<string, Route>;
  mergePolicy: Map<string, { deny: RegExp[] }>;
  mergeMethod: string;
  changesLabel: string;
  agentSecrets: Record<string, string>;
  workspaceDir: string;
  maxConcurrent: number;
  maxConcurrentPerTier: number;
  maxRunsPerHour: number;
  maxRunMs: number;
  maxRounds: number;
  forgejo: ForgejoAccess | null;
  blockedLabel: string;
  updateBranches: boolean;
  branchUpdateDelayMs: number;
  branchUpdateMinIntervalMs: number;
  minReviewChars: number;
  approvalGraceMs: number;
  errorRetries: number;
  splitLabel: string | null;
  archiveAfterDays: number;
  humanLogin: string | null;
  approvedLabel: string;
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
  source: 'forgejo';
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
  epic?: { children: { number: number; title: string }[] };
  base_sha?: string;
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

export type JobStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed';

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
  verdict_retry?: number;
  round_reset?: boolean;
  archived?: boolean;
  error_retry?: number;
}

export type NewJob = Omit<Job, 'id' | 'attempts'> & { attempts?: number };
