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
    list: { issue: string; action: "restart" | "human"; restarts: number; run: string; since: string }[];
  };
  stuck_pull_requests: {
    count: number;
    blocks: Record<string, number>;
    list: { issue: string; pr: number; reason: string; since: string }[];
  };
  merge_decisions: {
    open: { issue: string; pr: number; reason: string; at: string }[];
    counts: { merged: number; not_merged: Record<string, number> };
  };
  handbacks: Record<string, number>;
  preflight: {
    results: Record<string, number>;
    rules: { rule: string; result: string; count: number }[];
    notes: { issue: string; notes: string[]; at: string }[];
  };
  epic_gaps: {
    count: number;
    actions: Record<string, number>;
    list: { issue: string; action: "replanned" | "handed"; replans: number; reason: string; since: string }[];
  };
  deleted_in_forge: number;
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

export interface DashboardStatus {
  generated: string;
  limits: {
    running: number;
    max_concurrent: number;
    max_rounds: number;
    max_runs_per_hour: number;
  };
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
    pr: number | null;
    since: string;
    reason: string;
  }[];
  factory: FactoryStatus;
  e2e: E2eStatus | null;
}
