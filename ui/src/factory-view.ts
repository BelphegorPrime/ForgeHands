import type { DashboardStatus, Issue, RevertRate } from "./types.ts";

// Plain functions for the factory health section: the wording of reasons, ages, the revert table and the ticket list rules. They are
// kept out of the components so that the test suite can run them without a DOM or JSX.

const REASON_LABELS: Record<string, string> = {
  stalled_ticket: "stalled ticket",
  stuck_rounds: "stuck: rounds used up",
  stuck_verdict: "stuck: NOT OK verdict",
  stuck_conflict: "stuck: conflict with the default branch",
  label: "blocked label",
};

// A reason the dashboard does not know yet (the server may add more) is shown as its words, so nothing is hidden.
export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

// "for 3 min", "for 2.5 h", "for 1.2 d": how long ago `since` was, measured from the snapshot time.
export function ageText(since: string, generated: string): string {
  const seconds = Math.max(0, (Date.parse(generated) - Date.parse(since)) / 1000);
  if (!Number.isFinite(seconds)) return "unknown time";
  if (seconds < 5400) return "for " + Math.round(seconds / 60) + " min";
  if (seconds < 172800) return "for " + Math.round(seconds / 360) / 10 + " h";
  return "for " + Math.round(seconds / 8640) / 10 + " d";
}

export function isDeletedInForge(issue: Issue): boolean {
  return issue.state === "deleted in the forge";
}

export function percent(ratio: number | null): string {
  return ratio === null ? "—" : Math.round(ratio * 1000) / 10 + " %";
}

// The revert alert fires on the 30-day rate only (REVERT_RATE_ALERT, a percentage), so the 7-day row never shows it.
export function revertAlert(rate: RevertRate, window: "7 days" | "30 days", alertPercent: number | null): boolean {
  return window === "30 days" && alertPercent !== null && rate.ratio !== null && rate.ratio * 100 > alertPercent;
}

export interface RevertRow {
  repository: string;
  window: "7 days" | "30 days";
  rate: RevertRate;
  alert: boolean;
}

// One row per repository and window, in the order of the summary (repositories sorted by name, 7 days before 30).
export function revertRows(status: DashboardStatus): RevertRow[] {
  const alertPercent = status.factory.revert_rate.alert_percent;
  return Object.entries(status.summary).flatMap(([repository, windows]) =>
    (["7 days", "30 days"] as const).map((window) => {
      const rate = window === "7 days" ? windows.last_7_days.revert_rate : windows.last_30_days.revert_rate;
      return { repository, window, rate, alert: revertAlert(rate, window, alertPercent) };
    }),
  );
}

// Counts of a record as rows with the non-zero ones first; an all-zero record gives no rows (the page then says "none").
export function countRows(counts: Record<string, number>, label: (key: string) => string = (key) => key): { key: string; label: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([key, count]) => ({ key, label: label(key), count }));
}

// The tickets of the main list: the ones deleted in the forge are only counted (status.factory.deleted_in_forge).
export function listedIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => !isDeletedInForge(issue));
}

// The state of a run of the end-to-end suite as the dashboard words it.
export function scenarioText(result: { ok: boolean; reason: string | null; cleanup: "ok" | "failed"; cleanup_reason: string | null }): string {
  const parts = [result.ok ? "ok" : "failed" + (result.reason ? ": " + reasonLabel(result.reason) : "")];
  parts.push(result.cleanup === "ok" ? "cleanup ok" : "cleanup failed" + (result.cleanup_reason ? ": " + result.cleanup_reason : ""));
  return parts.join(", ");
}
