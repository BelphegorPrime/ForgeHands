import type { Issue } from "./types.ts";

export type IssueFilter = "all" | "active" | "waiting" | "human" | "closed";

export function matchesFilter(
  issue: Issue,
  filter: IssueFilter,
  waitingForHuman: Set<string>,
): boolean {
  if (filter === "closed") return !!issue.closed;
  if (filter === "human")
    return !issue.closed && waitingForHuman.has(issue.issue.toLowerCase());
  if (filter === "active")
    return (
      !issue.closed &&
      issue.runs.some(
        (run) => run.status === "running" || run.status === "queued",
      )
    );
  if (filter === "waiting")
    return (
      !issue.closed &&
      (issue.state.toLowerCase().includes("waiting") ||
        issue.state.toLowerCase().includes("human"))
    );
  return !issue.closed;
}
