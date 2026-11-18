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
  title: string;
  pr: number | null;
  rounds: number;
  state: string;
  closed?: true;
  runs: Run[];
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
    pr: number;
    since: string;
    reason: string;
  }[];
}
