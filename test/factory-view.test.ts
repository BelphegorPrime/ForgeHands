import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ageText,
  countRows,
  isDeletedInForge,
  linkParts,
  listedIssues,
  operatorRows,
  percent,
  reasonLabel,
  revertAlert,
  revertRows,
  scenarioText,
} from "../ui/src/factory-view.ts";
import type { DashboardStatus, Issue, RevertRate } from "../ui/src/types.ts";

const GENERATED = "2026-06-30T12:00:00.000Z";
const rate = (merges: number, reverted: number, needed_human = 0): RevertRate => ({
  merges,
  reverted,
  needed_human,
  ratio: merges ? reverted / merges : null,
});

test("known reasons have words, unknown ones are shown as their words", () => {
  assert.equal(reasonLabel("stuck_verdict"), "stuck: NOT OK verdict");
  assert.equal(reasonLabel("stalled_ticket"), "stalled ticket");
  assert.equal(reasonLabel("operator_prerequisite"), "operator prerequisite");
  assert.equal(reasonLabel("some_future_reason"), "some future reason");
});

test("ages are minutes, hours or days from the snapshot time", () => {
  assert.equal(ageText("2026-06-30T11:50:00.000Z", GENERATED), "for 10 min");
  assert.equal(ageText("2026-06-30T09:30:00.000Z", GENERATED), "for 2.5 h");
  assert.equal(ageText("2026-06-27T12:00:00.000Z", GENERATED), "for 3 d");
  assert.equal(ageText("not a date", GENERATED), "unknown time");
});

test("the revert alert fires on the 30-day ratio only, and only above a configured threshold", () => {
  assert.equal(revertAlert(rate(10, 3), "30 days", 20), true);
  assert.equal(revertAlert(rate(10, 2), "30 days", 20), false);
  assert.equal(revertAlert(rate(10, 9), "7 days", 20), false);
  assert.equal(revertAlert(rate(10, 9), "30 days", null), false);
  assert.equal(revertAlert(rate(0, 0), "30 days", 20), false);
  assert.equal(percent(null), "—");
  assert.equal(percent(1 / 3), "33.3 %");
});

test("revert rows give each repository for 7 and 30 days, with the alert on the 30-day row", () => {
  const window = (merges: number, reverted: number) => ({
    merged: merges, merged_without_human: 0, blocked: 0, split: 0, merge_seconds: { median: null, p90: null },
    rounds_per_merged: null, review_retries: 0, error_retries: 0, cost: 0, revert_rate: rate(merges, reverted),
  });
  const status = {
    summary: { "owner/hello": { last_7_days: window(2, 0), last_30_days: window(10, 3), tiers: {} } },
    factory: { revert_rate: { alert_percent: 20 } },
  } as unknown as DashboardStatus;
  const rows = revertRows(status);
  assert.deepEqual(rows.map((row) => [row.repository, row.window, row.alert]), [
    ["owner/hello", "7 days", false],
    ["owner/hello", "30 days", true],
  ]);
});

test("counts list only the non-zero keys, largest first, with their labels", () => {
  assert.deepEqual(countRows({ stuck_rounds: 0, stuck_verdict: 2, label: 2 }, reasonLabel), [
    { key: "label", label: "blocked label", count: 2 },
    { key: "stuck_verdict", label: "stuck: NOT OK verdict", count: 2 },
  ].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)));
  assert.deepEqual(countRows({ retry: 0 }), []);
});

test("tickets deleted in the forge are left out of the main list", () => {
  const ticket = (issue: string, state: string): Issue => ({
    issue, issue_url: null, title: "", pr: null, pr_url: null, rounds: 0, state, runs: [],
  });
  const issues = [ticket("owner/hello#1", "waiting for #2"), ticket("owner/hello#2", "deleted in the forge")];
  assert.equal(isDeletedInForge(issues[1]), true);
  assert.deepEqual(listedIssues(issues).map((issue) => issue.issue), ["owner/hello#1"]);
});

test("a scenario reads as ok or failed with its cleanup", () => {
  assert.equal(
    scenarioText({ ok: true, reason: null, cleanup: "ok", cleanup_reason: null }),
    "ok, cleanup ok",
  );
  assert.equal(
    scenarioText({ ok: false, reason: "merge_timeout", cleanup: "failed", cleanup_reason: "branch kept" }),
    "failed: merge timeout, cleanup failed: branch kept",
  );
});

test("a state line links its '#n' numbers that have a forge address and keeps the rest as text", () => {
  const links = { "54": "https://forge.example/owner/hello/issues/54" };
  assert.deepEqual(linkParts("waiting for #54, #55", links), [
    { text: "waiting for " },
    { text: "#54", href: "https://forge.example/owner/hello/issues/54" },
    { text: ", " },
    { text: "#55" },
  ]);
  assert.deepEqual(linkParts("delivered as a comment on #54"), [{ text: "delivered as a comment on " }, { text: "#54" }]);
  assert.deepEqual(linkParts("idle"), [{ text: "idle" }]);
  // Only whole numbers are references: "#5a" stays text, "#123" links.
  assert.deepEqual(linkParts("#5a and #123", { "5": "x", "123": "y" }), [
    { text: "#5a and " },
    { text: "#123", href: "y" },
  ]);
});

test("the operator card rows give number, title, link, repository and age; an empty list gives no rows", () => {
  const rows = operatorRows(
    [{ issue: "owner/hello#7", issue_url: "https://forge.example/owner/hello/issues/7", title: "Set up the backup", since: "2026-06-30T09:00:00.000Z" }, { issue: "owner/other#3", issue_url: null, title: "", since: "2026-06-30T11:50:00.000Z" }],
    GENERATED,
  );
  assert.deepEqual(rows, [
    { key: "owner/hello#7", repository: "owner/hello", number: 7, title: "Set up the backup", href: "https://forge.example/owner/hello/issues/7", age: "for 3 h" },
    { key: "owner/other#3", repository: "owner/other", number: 3, title: "", href: null, age: "for 10 min" },
  ]);
  assert.deepEqual(operatorRows([], GENERATED), []);
});
