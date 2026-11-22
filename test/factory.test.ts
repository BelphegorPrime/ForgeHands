// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus } from "../src/server/status.ts";
import { JobStore } from "../src/store/jobs.ts";
import { TicketPreflight } from "../src/agent/preflight.ts";
import { metrics } from "../src/metrics.ts";
import { loadConfig } from "../src/config.ts";

const repo = "owner/hello";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 5, 30, 12);
const quiet = { error() {} };
let dir;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: "forgejo-test-secret-long-enough",
  OPENHANDS_API_URL: "http://openhands:8000/",
  OPENHANDS_API_KEY: "k".repeat(24),
  ALLOWED_REPOS: repo + ",owner/quiet",
  LABEL_ROUTES: JSON.stringify({
    "ai:ready": { profile: "22222222-2222-4222-8222-222222222222", tier: "free" },
    "ai:changes": { profile: "22222222-2222-4222-8222-222222222222", tier: "free", on: "pull_request" },
  }),
  DATA_FILE: join(dir, "deliveries.json"),
  ...extra,
});

// A ledger with one open ticket that has an agent pull request (#10, refused for CI), one deleted ticket, one closed ticket.
function ledger() {
  const jobs = new JobStore(join(dir, "jobs.json"));
  jobs.add({
    key: repo + "#1:ai:changes",
    label: "ai:changes",
    status: "done",
    created: NOW - HOUR,
    event: { repository: { full_name: repo }, issue: { number: 1, title: "Open ticket" }, pull_request: { number: 10 } },
  });
  jobs.add({
    key: repo + "#7:ai:ready",
    label: "ai:ready",
    status: "done",
    created: NOW - DAY,
    event: { repository: { full_name: repo }, issue: { number: 7, title: "Gone" } },
  });
  jobs.deletedInForge.set(repo + "#7", NOW - HOUR);
  jobs.add({
    key: "owner/quiet#5:ai:ready",
    label: "ai:ready",
    status: "done",
    created: NOW - DAY,
    archived_view: true,
    event: { repository: { full_name: "owner/quiet" }, issue: { number: 5, title: "Closed" } },
  });
  jobs.stalled.set(repo + "#1", { repository: repo, issue: 1, run: "run-a", restarts: 1, human: false, at: NOW - HOUR });
  jobs.stalled.set(repo + "#2", { repository: repo, issue: 2, run: "run-b", restarts: 1, human: true, at: NOW - 3 * HOUR });
  jobs.stalled.set("owner/quiet#5", { repository: "owner/quiet", issue: 5, run: "run-c", restarts: 1, human: true, at: NOW - HOUR });
  jobs.stuck.set(repo + "#pr10", { repository: repo, issue: 1, number: 10, sha: "abc", why: "stuck_verdict", blocked: true, eligible_at: NOW - HOUR, blocked_at: NOW - 2 * HOUR });
  jobs.stuck.set(repo + "#pr11", { repository: repo, issue: 3, number: 11, sha: "def", why: "stuck_rounds", blocked: false, eligible_at: NOW, blocked_at: null });
  jobs.epicGaps.set(repo + "#9", { repository: repo, issue: 9, sha: null, at: NOW - DAY, replans: 1, human: true, reason: "The criteria of sub-issue 4 are missing" });
  return jobs;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forgehands-factory-"));
  metrics.reset();
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test("factory health lists the stalled, stuck and epic records that are still open, with what was done", () => {
  metrics.inc("forgehands_stalled_ticket_actions_total", { action: "restart" });
  metrics.inc("forgehands_stalled_ticket_actions_total", { action: "human" });
  metrics.inc("forgehands_stuck_pr_blocks_total", { reason: "stuck_verdict" });
  metrics.inc("forgehands_epic_gaps_total", { action: "handed" });
  const jobs = ledger();
  const { factory } = buildStatus(loadConfig(env()), jobs, NOW);

  assert.equal(factory.since, metrics.startedAt);
  assert.equal(factory.stalled_tickets.count, 1); // #2 is handed to the human; #5 is closed and left out
  assert.deepEqual(factory.stalled_tickets.actions, { restart: 1, human: 1 });
  assert.deepEqual(factory.stalled_tickets.list, [
    { issue: repo + "#2", action: "human", restarts: 1, run: "run-b", since: new Date(NOW - 3 * HOUR).toISOString() },
    { issue: repo + "#1", action: "restart", restarts: 1, run: "run-a", since: new Date(NOW - HOUR).toISOString() },
  ]);

  assert.equal(factory.stuck_pull_requests.count, 1); // pr 11 is not blocked
  assert.deepEqual(factory.stuck_pull_requests.blocks, { stuck_verdict: 1 });
  assert.deepEqual(factory.stuck_pull_requests.list, [
    { issue: repo + "#1", pr: 10, reason: "stuck_verdict", since: new Date(NOW - 2 * HOUR).toISOString() },
  ]);

  assert.equal(factory.epic_gaps.count, 1);
  assert.deepEqual(factory.epic_gaps.actions, { replanned: 0, handed: 1 });
  assert.deepEqual(factory.epic_gaps.list, [
    { issue: repo + "#9", action: "handed", replans: 1, reason: "The criteria of sub-issue 4 are missing", since: new Date(NOW - DAY).toISOString() },
  ]);
});

test("merge decisions give the last refusal of each open ticket's pull request and the counts since start", () => {
  metrics.inc("forgehands_merge_decisions_total", { result: "not_merged", reason: "ci_not_green" });
  metrics.inc("forgehands_merge_decisions_total", { result: "not_merged", reason: "ci_not_green" });
  metrics.inc("forgehands_merge_decisions_total", { result: "merged", reason: "merged" });
  const decisions = new Map([[repo + "#10", { reason: "ci_not_green", at: NOW - HOUR }]]);
  const { factory } = buildStatus(loadConfig(env()), ledger(), NOW, undefined, [], null, { decisions });

  assert.deepEqual(factory.merge_decisions.open, [
    { issue: repo + "#1", pr: 10, reason: "ci_not_green", at: new Date(NOW - HOUR).toISOString() },
  ]);
  assert.deepEqual(factory.merge_decisions.counts, { merged: 1, not_merged: { ci_not_green: 2 } });
});

test("hand-backs, pre-flight results, advisory notes and deleted tickets are counted or listed", () => {
  metrics.inc("forgehands_handbacks_total", { kind: "retry" });
  metrics.inc("forgehands_preflight_total", { result: "ok", rule: "none" });
  metrics.inc("forgehands_preflight_total", { result: "ok", rule: "none" });
  metrics.inc("forgehands_preflight_total", { result: "advised", rule: "4" });
  const jobs = ledger();
  const preflight = new TicketPreflight({ config: loadConfig(env()), jobs, forge: {}, logger: quiet, now: () => NOW, tell() {} });
  preflight.noteAdvisories(repo + "#2", [{ rule: 4, blockable: false, text: "x", note: "the Files list is empty" }]);
  preflight.noteAdvisories("owner/quiet#5", [{ rule: 4, blockable: false, text: "x", note: "closed ticket" }]);
  const { factory } = buildStatus(loadConfig(env()), jobs, NOW, undefined, [], null, { preflight });

  assert.equal(factory.handbacks.retry, 1);
  assert.equal(factory.handbacks.blocked, 0);
  assert.deepEqual(factory.preflight.results, { ok: 2, rejected: 0, advised: 1, skipped: 0 });
  assert.deepEqual(factory.preflight.rules.filter((entry) => entry.rule === "4"), [{ rule: "4", result: "advised", count: 1 }]);
  assert.deepEqual(factory.preflight.notes, [{ issue: repo + "#2", notes: ["the Files list is empty"], at: new Date(NOW).toISOString() }]);
  assert.equal(factory.deleted_in_forge, 1);
  assert.equal(factory.revert_rate.alert_percent, null);
});

test("the revert alert threshold is in the factory section when REVERT_RATE_ALERT is set", () => {
  const { factory } = buildStatus(loadConfig(env({ REVERT_RATE_ALERT: "20" })), ledger(), NOW);
  assert.equal(factory.revert_rate.alert_percent, 20);
});

test("with nothing recorded every list is empty and every count is zero", () => {
  const jobs = new JobStore(join(dir, "empty.json"));
  const { factory } = buildStatus(loadConfig(env()), jobs, NOW);
  assert.deepEqual(factory.stalled_tickets, { count: 0, actions: { restart: 0, human: 0 }, list: [] });
  assert.deepEqual(factory.stuck_pull_requests, { count: 0, blocks: {}, list: [] });
  assert.deepEqual(factory.merge_decisions, { open: [], counts: { merged: 0, not_merged: {} } });
  assert.deepEqual(factory.handbacks, { retry: 0, escalate: 0, planner: 0, blocked: 0 });
  assert.deepEqual(factory.preflight, { results: { ok: 0, rejected: 0, advised: 0, skipped: 0 }, rules: [], notes: [] });
  assert.deepEqual(factory.epic_gaps, { count: 0, actions: { replanned: 0, handed: 0 }, list: [] });
  assert.equal(factory.deleted_in_forge, 0);
});
