export interface Summary {
  merged: number;
  merged_without_human: number;
  blocked: number;
  split: number;
  merge_seconds: { median: number | null; p90: number | null };
  rounds_per_merged: number | null;
  review_retries: number;
  error_retries: number;
  cost: number;
  /** Merges ForgeHands made in the window whose revert was merged; ratio 0 to 1, null without merges. */
  revert_rate: RevertRate;
}

export interface RevertRate {
  merges: number;
  reverted: number;
  needed_human: number;
  ratio: number | null;
}

export interface TierStats {
  started: number;
  finished: number;
  failed: Record<string, number>;
  split: number;
  fell_back: number;
  escalated: number;
  worker_runs_finished: number;
  worker_runs_merged: number;
  merged_share: number | null;
}

export interface Run {
  label: string;
  kind: string;
  status: string;
  result?: string;
  conversation: string | null;
  pr: number | null;
  started: string | null;
  finished: string | null;
  cost: number | null;
}

export interface Issue {
  issue: string;
  issue_url: string | null;
  title: string;
  pr: number | null;
  pr_url: string | null;
  rounds: number;
  state: string;
  /** The '#n' numbers of the state line mapped to their issue addresses (same repository). */
  state_links?: Record<string, string>;
  /** The blocked pull requests (their issue numbers) this ticket waits behind, directly or through other tickets. */
  blocked_by_stuck?: number[];
  blocked_by_epic_gaps?: number[];
  /** The last merge decision of an open pull request (a refusal; a merged one leaves the list). */
  merge_decision?: { reason: string; at: string };
  closed?: true;
  runs: Run[];
}

/** The factory health section of /status.json (see src/server/factory.ts). Counts by action, kind, reason or result count from `since`. */
export interface FactoryStatus {
  since: string;
  stalled_tickets: {
    count: number;
    actions: Record<string, number>;
    list: { issue: string; issue_url: string | null; action: "restart" | "human"; restarts: number; run: string; since: string }[];
  };
  stuck_pull_requests: {
    count: number;
    blocks: Record<string, number>;
    list: { issue: string; issue_url: string | null; pr: number; pr_url: string | null; reason: string; since: string }[];
  };
  merge_decisions: {
    open: { issue: string; issue_url: string | null; pr: number; pr_url: string | null; reason: string; at: string }[];
    counts: { merged: number; not_merged: Record<string, number> };
  };
  handbacks: Record<string, number>;
  preflight: {
    results: Record<string, number>;
    rules: { rule: string; result: string; count: number }[];
    notes: { issue: string; issue_url: string | null; notes: string[]; notes_links: Record<string, string>; at: string }[];
  };
  epic_gaps: {
    count: number;
    actions: Record<string, number>;
    list: { issue: string; issue_url: string | null; action: "replanned" | "handed"; replans: number; reason: string; reason_links: Record<string, string>; since: string }[];
  };
  epic_reviews: {
    count: number;
    list: { issue: string; issue_url: string | null; sub_issues: number; closed_since: string }[];
  };
  deleted_in_forge: number;
  operator_tickets: { count: number; list: { issue: string; issue_url: string | null; title: string; since: string }[] };
  revert_rate: { alert_percent: number | null };
}

/** The end-to-end suite (E2E_REPO), null while it is off. */
export interface E2eStatus {
  repository: string;
  on_start: boolean;
  scenarios: string[];
  version: string;
  running: { trigger: "start" | "manual"; since: string } | null;
  last: {
    version: string;
    trigger: "start" | "manual";
    at: string;
    error: string | null;
    results: {
      scenario: string;
      ok: boolean;
      reason: string | null;
      cleanup: "ok" | "failed";
      cleanup_reason: string | null;
      cleanup_note: string | null;
      notes: string | null;
      failed_step: number | null;
      at: string;
    }[];
  } | null;
}

/** The global clone breaker: open holds every new start, half_open admits one trial (see src/agent/clone-breaker.ts). Timing only, no evidence. */
export interface CloneBreakerStatus {
  state: "closed" | "open" | "half_open";
  since: string | null;
  retry_at: string | null;
  trial_until: string | null;
}

export interface DashboardStatus {
  generated: string;
  limits: {
    running: number;
    max_concurrent: number;
    max_rounds: number;
    max_runs_per_hour: number;
  };
  clone_breaker: CloneBreakerStatus;
  notify: { channels: string[]; immediate: string[]; digest: string | null };
  dry_run: { repositories: string[] | "all"; would_write: unknown[] } | null;
  summary: Record<
    string,
    {
      last_7_days: Summary;
      last_30_days: Summary;
      tiers: Record<
        string,
        { last_7_days: TierStats; last_30_days: TierStats }
      >;
    }
  >;
  issues: Issue[];
  waiting_for_human: {
    repository: string;
    issue: number;
    issue_url: string | null;
    pr: number | null;
    pr_url: string | null;
    since: string;
    reason: string;
    reason_links: Record<string, string>;
  }[];
  factory: FactoryStatus;
  e2e: E2eStatus | null;
}
