import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesFilter } from "../ui/src/ticket-filter.ts";
import type { Issue } from "../ui/src/types.ts";

const ticket: Issue = {
  issue: "owner/repo#12",
  issue_url: null,
  title: "Needs review",
  pr: 34,
  pr_url: null,
  rounds: 2,
  state: "rounds used up",
  runs: [],
};

test("the human filter uses the waiting list and excludes closed tickets", () => {
  const waitingForHuman = new Set(["owner/repo#12"]);
  assert.equal(matchesFilter(ticket, "human", waitingForHuman), true);
  assert.equal(
    matchesFilter({ ...ticket, issue: "owner/repo#13" }, "human", waitingForHuman),
    false,
  );
  assert.equal(
    matchesFilter({ ...ticket, closed: true }, "human", waitingForHuman),
    false,
  );
});
