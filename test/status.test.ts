// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createApp } from "../src/server/app.ts";
import { buildStatus, renderStatus } from "../src/server/status.ts";
import {
  hasStatusSession,
  hasToken,
  statusSessionCookie,
} from "../src/server/auth.ts";
import { DeliveryStore } from "../src/store/deliveries.ts";
import { JobStore } from "../src/store/jobs.ts";
import { Dispatcher } from "../src/agent/dispatch.ts";
import { loadConfig } from "../src/config.ts";

const WORKER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "status-token-long-enough";
const repo = "owner/hello";
const quiet = { error() {} };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 5, 30, 12);
let dir;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: "forgejo-test-secret-long-enough",
  OPENHANDS_API_URL: "http://openhands:8000/",
  OPENHANDS_API_KEY: "k".repeat(24),
  ALLOWED_REPOS: repo + ",owner/quiet",
  LABEL_ROUTES: JSON.stringify({
    "ai:ready": { profile: WORKER, tier: "free" },
    "ai:changes": { profile: WORKER, tier: "free", on: "pull_request" },
  }),
  DATA_FILE: join(dir, "deliveries.json"),
  ...extra,
});
const basic = (user, password) =>
  "Basic " + Buffer.from(user + ":" + password).toString("base64");

// A fixed ledger. Tickets of owner/hello, by days before NOW:
//  #1 created 5d ago, merged by ForgeHands after 2h, one round, cost 1
//  #2 created 10d ago, merged by ForgeHands after 4h, but it was blocked on the way, two rounds, one review retry, cost 2
//  #3 created 20d ago, merged by a human after 6h, cost 3
//  #4 created 3d ago, split after 1h, one error retry, cost 0.5
//  #5 created 2d ago, blocked, cost 0.25
//  #6 created 40d ago, merged: outside both windows
function ledger() {
  const jobs = new JobStore(join(dir, "jobs.json"));
  const add = (issue, label, ago, fields = {}, repository = repo) =>
    jobs.add({
      key: repository + "#" + issue + ":" + label,
      label,
      status: "done",
      created: NOW - ago,
      event: {
        repository: { full_name: repository },
        issue: { number: issue, title: "Ticket " + issue },
        ...(label === "ai:changes"
          ? { pull_request: { number: 100 + issue } }
          : {}),
      },
      ...fields,
    });
  add(1, "ai:ready", 5 * DAY, { cost: 1 });
  add(1, "ai:changes", 5 * DAY - HOUR, {
    started: 1,
    merged_at: NOW - 5 * DAY + 2 * HOUR,
    merged_by: "agent",
  });
  add(2, "ai:ready", 10 * DAY, { cost: 2, verdict_retry: 1 });
  add(2, "ai:changes", 10 * DAY - HOUR, {
    started: 1,
    blocked_at: NOW - 10 * DAY + HOUR,
  });
  add(2, "ai:changes", 10 * DAY - 2 * HOUR + 1, {
    started: 1,
    merged_at: NOW - 10 * DAY + 4 * HOUR,
    merged_by: "agent",
  });
  add(3, "ai:ready", 20 * DAY, {
    cost: 3,
    merged_at: NOW - 20 * DAY + 6 * HOUR,
    merged_by: "human",
  });
  add(4, "ai:ready", 3 * DAY, {
    cost: 0.5,
    error_retry: 1,
    split_at: NOW - 3 * DAY + HOUR,
  });
  add(5, "ai:ready", 2 * DAY, {
    cost: 0.25,
    blocked_at: NOW - 2 * DAY + HOUR,
    status: "failed",
  });
  add(6, "ai:ready", 40 * DAY, {
    cost: 9,
    merged_at: NOW - 40 * DAY + HOUR,
    merged_by: "agent",
  });
  return jobs;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forgehands-status-"));
});
afterEach(() =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
);

test("the summary counts a fixed ledger per repository for 7 and 30 days", () => {
  const { summary } = buildStatus(loadConfig(env()), ledger(), NOW);
  const week = summary[repo].last_7_days;
  assert.deepEqual(week, {
    merged: 1,
    merged_without_human: 1,
    blocked: 1,
    split: 1,
    revert_rate: { merges: 0, reverted: 0, needed_human: 0, ratio: null },
    merge_seconds: { median: 7200, p90: 7200 },
    rounds_per_merged: 1,
    review_retries: 0,
    error_retries: 1,
    cost: 1.75,
  });
  const month = summary[repo].last_30_days;
  assert.equal(month.merged, 3);
  assert.equal(month.merged_without_human, 1); // #2 was blocked, #3 merged by a human
  assert.equal(month.blocked, 2);
  assert.equal(month.split, 1);
  assert.deepEqual(month.merge_seconds, { median: 4 * 3600, p90: 6 * 3600 });
  assert.equal(month.rounds_per_merged, 1); // (1 + 2 + 0) / 3
  assert.equal(month.review_retries, 1);
  assert.equal(month.error_retries, 1);
  assert.equal(month.cost, 6.75); // #6 is older than 30 days
});

test("a repository without work shows zeros and no times", () => {
  const { summary } = buildStatus(loadConfig(env()), ledger(), NOW);
  assert.deepEqual(summary["owner/quiet"].last_30_days, {
    merged: 0,
    merged_without_human: 0,
    blocked: 0,
    split: 0,
    revert_rate: { merges: 0, reverted: 0, needed_human: 0, ratio: null },
    merge_seconds: { median: null, p90: null },
    rounds_per_merged: null,
    review_retries: 0,
    error_retries: 0,
    cost: 0,
  });
});

test("dashboard tickets link to issues and pull requests using safe forge URLs", () => {
  const config = loadConfig({
    ...env({ FORGE_URL: "https://forge.example", FORGE_TOKEN: "forge-token" }),
  });
  const jobs = new JobStore(join(dir, "links.json"));
  jobs.add({
    key: repo + "#7:ai:ready",
    label: "ai:ready",
    status: "done",
    created: NOW,
    event: {
      repository: { full_name: repo },
      issue: {
        number: 7,
        title: "Ticket 7",
        html_url: "javascript:alert(1)",
      },
      pull_request: { number: 77, html_url: "javascript:alert(1)" },
    },
  });

  const ticket = buildStatus(config, jobs, NOW).issues[0];
  assert.equal(ticket.issue_url, "https://forge.example/owner/hello/issues/7");
  assert.equal(ticket.pr_url, "https://forge.example/owner/hello/pulls/77");
});

test("the page refreshes itself, shows the summary and escapes titles", () => {
  const jobs = ledger();
  jobs.add({
    key: repo + "#7:ai:ready",
    label: "ai:ready",
    status: "queued",
    created: NOW,
    event: {
      repository: { full_name: repo },
      issue: { number: 7, title: '<script>alert(1)</script> & "x"' },
    },
  });
  const html = renderStatus(buildStatus(loadConfig(env()), jobs, NOW));
  assert.match(html, /<meta http-equiv="refresh" content="\d+">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(
    html,
    /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/,
  );
  assert.match(html, /owner\/hello/);
  assert.match(html, /last 7 days/);
  assert.match(html, /last 30 days/);
});

test("hasToken accepts bearer and basic, nothing else", () => {
  assert.equal(hasToken("Bearer " + TOKEN, TOKEN), true);
  assert.equal(hasToken("bearer " + TOKEN, TOKEN), true);
  assert.equal(hasToken(basic("anyone", TOKEN), TOKEN), true);
  assert.equal(hasToken(basic("", TOKEN), TOKEN), true);
  assert.equal(hasToken("Bearer wrong", TOKEN), false);
  assert.equal(hasToken("Bearer " + TOKEN + "x", TOKEN), false);
  assert.equal(hasToken(basic("user", "wrong"), TOKEN), false);
  assert.equal(hasToken(basic(TOKEN, ""), TOKEN), false); // the token is the password, not the user
  assert.equal(hasToken("Bearer ", TOKEN), false);
  assert.equal(hasToken(TOKEN, TOKEN), false);
  assert.equal(hasToken(undefined, TOKEN), false);
});

test("STATUS_TOKEN must be long enough", () => {
  assert.throws(
    () => loadConfig(env({ STATUS_TOKEN: "short" })),
    /STATUS_TOKEN/,
  );
  assert.equal(loadConfig(env()).statusToken, null);
});

async function serve(extra) {
  const config = loadConfig(env(extra));
  const jobs = ledger();
  const dispatcher = new Dispatcher(
    config,
    jobs,
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
    quiet,
    () => NOW,
  );
  const server = createApp(
    config,
    new DeliveryStore(config.dataFile),
    undefined,
    quiet,
    dispatcher,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function upgradeStatus(base, cookie = "", origin = base) {
  const target = new URL(base);
  const socket = connect(Number(target.port), target.hostname);
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket handshake timed out"));
    }, 2000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () =>
      socket.write(
        "GET /dashboard/ws HTTP/1.1\r\nHost: " +
          target.host +
          "\r\nOrigin: " +
          origin +
          "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
          (cookie ? "Cookie: " + cookie + "\r\n" : "") +
          "\r\n",
      ),
    );
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      const status = response
        .subarray(0, end)
        .toString("utf8")
        .split("\r\n")[0];
      socket.destroy();
      resolve(status);
    });
  });
}

test("without STATUS_TOKEN the status stays open", async () => {
  const { base, close } = await serve();
  try {
    assert.equal((await fetch(base + "/status")).status, 200);
    const body = await (await fetch(base + "/status.json")).json();
    assert.ok(body.summary[repo]);
  } finally {
    await close();
  }
});

test("with STATUS_TOKEN the status needs the token, healthz does not", async () => {
  const { base, close } = await serve({ STATUS_TOKEN: TOKEN });
  try {
    for (const path of ["/status", "/status.json"]) {
      const refused = await fetch(base + path);
      assert.equal(refused.status, 401);
      assert.match(refused.headers.get("www-authenticate"), /^Basic realm=/);
      assert.equal(
        (
          await fetch(base + path, {
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(base + path, {
            headers: { authorization: basic("u", "wrong") },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(base + path, {
            headers: { authorization: "Bearer " + TOKEN },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(base + path, {
            headers: { authorization: basic("browser", TOKEN) },
          })
        ).status,
        200,
      );
    }
    const refused = await (await fetch(base + "/status.json")).text();
    assert.doesNotMatch(refused, /Ticket|owner\/hello/);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  } finally {
    await close();
  }
});

test("dashboard API returns status and websocket sends a live snapshot", async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(base + "/api/dashboard");
    assert.equal(response.status, 200);
    assert.ok((await response.json()).summary[repo]);
    const socket = new WebSocket(base.replace(/^http/, "ws") + "/dashboard/ws");
    const snapshot = await new Promise((resolve, reject) => {
      socket.addEventListener(
        "message",
        (event) => resolve(JSON.parse(String(event.data))),
        { once: true },
      );
      socket.addEventListener("error", reject, { once: true });
    });
    assert.ok(snapshot.summary[repo]);
    await new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      socket.close();
    });
  } finally {
    await close();
  }
});

test("root serves the built dashboard and its Vite assets", async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(base + "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /ForgeHands Operations/);
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script);
    const asset = await fetch(base + script);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.match(await asset.text(), /Agent activity/);
  } finally {
    await close();
  }
});

test("dashboard session cookies protect its API and WebSocket without exposing the status token", async () => {
  const { base, close } = await serve({ STATUS_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(base + "/")).status, 401);
    assert.equal(await upgradeStatus(base), "HTTP/1.1 401 Unauthorized");
    assert.equal(
      await upgradeStatus(base, "", "http://attacker.example"),
      "HTTP/1.1 403 Forbidden",
    );
    const page = await fetch(base + "/", {
      headers: { authorization: basic("browser", TOKEN) },
    });
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, new RegExp(TOKEN));
    const cookie = setCookie.split(";")[0];
    assert.equal(
      (await fetch(base + "/api/dashboard", { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      await upgradeStatus(base, cookie),
      "HTTP/1.1 101 Switching Protocols",
    );
  } finally {
    await close();
  }
});

test("dashboard session cookies expire and reject tampering", () => {
  const cookie = statusSessionCookie(TOKEN, NOW);
  assert.equal(hasStatusSession(cookie, TOKEN, NOW + 1000), true);
  assert.equal(hasStatusSession(cookie, TOKEN, NOW + 9 * HOUR), false);
  assert.equal(
    hasStatusSession(cookie.replace(/[A-Za-z0-9_-](?=;)/, "x"), TOKEN, NOW),
    false,
  );
  assert.equal(
    hasStatusSession(cookie, "another-long-status-token", NOW),
    false,
  );
});

test("dry-run jobs stay out of the summary, a bot pull request counts as a ticket", () => {
  const config = loadConfig(env());
  const jobs = ledger();
  const before = buildStatus(config, jobs, NOW).summary[repo].last_7_days;
  jobs.add({
    key: repo + "#8:ai:ready",
    label: "ai:ready",
    status: "dry",
    created: NOW - HOUR,
    cost: 50,
    merged_at: NOW,
    merged_by: "agent",
    event: {
      repository: { full_name: repo },
      issue: { number: 8, title: "dry" },
    },
  });
  assert.deepEqual(
    buildStatus(config, jobs, NOW).summary[repo].last_7_days,
    before,
  );
  jobs.add({
    key: repo + "!pr9:ai:ready",
    label: "ai:ready",
    status: "done",
    created: NOW - 3 * HOUR,
    cost: 0.5,
    event: {
      repository: { full_name: repo },
      issue: { number: 9, title: "bump" },
      pull_request: { number: 9 },
    },
  });
  assert.equal(
    jobs.noteTicket(repo + "!pr9", {
      merged_at: NOW - HOUR,
      merged_by: "agent",
    }),
    true,
  );
  const week = buildStatus(config, jobs, NOW).summary[repo].last_7_days;
  assert.deepEqual(
    [week.merged, week.merged_without_human, week.cost],
    [2, 2, 2.25],
  );
});

test("ForgeHands notes merges, blocks and splits on the ticket; a human merge does not overwrite its own", () => {
  const config = loadConfig(env());
  const jobs = ledger();
  const dispatcher = new Dispatcher(
    config,
    jobs,
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
    quiet,
    () => NOW,
  );
  dispatcher.merger.note(repo + "#5", "merged");
  const five = jobs
    .list()
    .filter((job) => job.key.startsWith(repo + "#5:"))
    .at(-1);
  assert.deepEqual(
    [five.merged_at, five.merged_by, five.blocked_at],
    [NOW, "agent", NOW - 2 * DAY + HOUR],
  );
  dispatcher.noteTicket(repo + "#5", { merged_at: 1, merged_by: "human" });
  assert.equal(five.merged_by, "agent");
  assert.equal(jobs.noteTicket(repo + "#99", { split_at: NOW }), false);
  const week = buildStatus(config, jobs, NOW).summary[repo].last_7_days;
  assert.deepEqual([week.merged, week.merged_without_human], [2, 1]); // #5 was blocked on the way
});

test("status.json gives the forge addresses of tickets, pull requests and the numbers in state lines (Forgejo and GitLab)", () => {
  const forgejo = loadConfig(env({ FORGE_URL: "https://forge.example/", FORGE_TOKEN: "forge-token" }));
  const gitlab = loadConfig(env({ FORGE: "gitlab", FORGE_URL: "https://gitlab.example/", FORGE_TOKEN: "glpat-token" }));
  const jobs = new JobStore(join(dir, "addresses.json"));
  jobs.add({
    key: repo + "#7:ai:ready",
    label: "ai:ready",
    status: "waiting",
    waiting_for: [54, 55],
    created: NOW,
    event: { repository: { full_name: repo }, issue: { number: 7, title: "Ticket 7" } },
  });
  jobs.add({
    key: repo + "#8:ai:ready",
    label: "ai:ready",
    status: "done",
    delivered_on: 8,
    created: NOW,
    event: { repository: { full_name: repo }, issue: { number: 8, title: "Ticket 8" }, pull_request: { number: 80 } },
  });
  jobs.stuck.set(repo + "#pr80", { repository: repo, issue: 8, number: 80, sha: "a".repeat(40), why: "stuck_verdict", blocked: true, eligible_at: NOW - HOUR, blocked_at: NOW - HOUR });

  for (const [config, base, issues, pulls] of [
    [forgejo, "https://forge.example/owner/hello", "/issues/", "/pulls/"],
    [gitlab, "https://gitlab.example/owner/hello", "/-/issues/", "/-/merge_requests/"],
  ]) {
    const status = buildStatus(config, jobs, NOW, undefined, [{ repository: repo, issue: 7, pr: 70, since: NOW - HOUR, reason: "label" }]);
    const ticket = status.issues.find((row) => row.issue === repo + "#7");
    assert.equal(ticket.state, "waiting for #54, #55");
    assert.deepEqual(ticket.state_links, { 54: base + issues + "54", 55: base + issues + "55" });
    assert.equal(ticket.issue_url, base + issues + "7");
    assert.equal(ticket.pr_url, null);

    const waiting = status.waiting_for_human[0];
    assert.equal(waiting.issue_url, base + issues + "7");
    assert.equal(waiting.pr_url, base + pulls + "70");
    assert.deepEqual(waiting.reason_links, {});

    const stuck = status.factory.stuck_pull_requests.list[0];
    assert.deepEqual([stuck.issue_url, stuck.pr_url], [base + issues + "8", base + pulls + "80"]);
    assert.equal(status.factory.merge_decisions.open.length, 0);
  }
});

test("without a forge the status gives no addresses, and a state keeps its plain numbers", () => {
  const jobs = new JobStore(join(dir, "no-forge.json"));
  jobs.add({
    key: repo + "#7:ai:ready",
    label: "ai:ready",
    status: "waiting",
    waiting_for: [54],
    created: NOW,
    event: { repository: { full_name: repo }, issue: { number: 7, title: "Ticket 7" } },
  });
  const status = buildStatus(loadConfig(env()), jobs, NOW, undefined, [{ repository: repo, issue: 7, pr: 70, since: NOW - HOUR, reason: "epic stays open after its review: #9 open" }]);
  const ticket = status.issues[0];
  assert.equal(ticket.state, "waiting for #54");
  assert.equal(ticket.issue_url, null);
  assert.deepEqual(ticket.state_links, {});
  assert.equal(status.waiting_for_human[0].pr_url, null);
  assert.equal(status.waiting_for_human[0].issue_url, null);
});
