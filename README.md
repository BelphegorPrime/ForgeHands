# ForgeHands

ForgeHands connects **Forgejo** to **OpenHands**. In **direct mode** it runs the whole loop from a labelled ticket to a merged pull request: it starts OpenHands conversations with the agent profile that belongs to a label, follows the pull request through CI, review, follow-up rounds and merge, keeps branches current, orders tickets by their dependencies and calls a human only when one is needed. In **webhook mode** (the original, simpler use) it only verifies, filters and re-signs Forgejo issue events for an OpenHands Automation custom webhook.

A small Node.js 26 service written in TypeScript (run by type stripping, no build step, no runtime dependencies).

> Status: in daily use, released as `v0.3.x`. Do not expose it to the public Internet without TLS, network controls and monitoring.

## Contents

- [How the loop works](#how-the-loop-works-direct-mode)
- [Run it](#run-it)
- [Forgejo setup](#forgejo-setup)
- [OpenHands setup](#openhands-setup)
- [Configuration](#configuration)
- [Behaviour in detail](#behaviour-in-detail)
- [Security and limitations](#security-and-limitations)
- [Development](#development)

## How the loop works (direct mode)

1. A label on an issue starts a run with the agent profile of that label: `ai:plan` a **planner** (splits the ticket into sub-issues and sets their dependencies), `ai:ready` a **worker**, `ai:escalate` a worker on a stronger model. The names are yours; they are the keys of `LABEL_ROUTES`.
2. The worker opens a draft pull request from the branch `ai/issue-<n>` (title starts with `WIP:`).
3. Forgejo reports every finished CI run. A **red** commit starts a **fix round**; a **green** commit (all workflows) starts the **review**, and on protected paths also an advisory **security review**.
4. The reviewer writes one comment with `Verdict: OK` or `Verdict: NOT OK` and evidence, and sets `ai:approved` or `ai:changes`. `ai:changes` starts the next **round** of the worker on the same branch.
5. `ai:approved` merges the pull request when the commit is green and **no changed file matches the repository's deny list** (`MERGE_POLICY`). Otherwise the pull request is handed to a human.
6. After `MAX_ROUNDS` rounds the pull request gets `ai:blocked` and a comment that mentions the human.
7. When the last dependency of an epic closes, the epic is reviewed against the default branch and closed if its criteria are met.

Everything outside step 1 needs `FORGEJO_URL` and `FORGEJO_TOKEN`. A route per label, the limits and the policy live in ForgeHands' environment, never in the repository: an agent's pull request cannot loosen the rules it is held to.

## Run it

Prerequisites: Docker with the Compose plugin, or Node.js 26+.

GitHub Actions tests every push and pull request and publishes multi-platform images (`linux/amd64`, `linux/arm64`) to `ghcr.io/belphegorprime/forgehands` with the tags `latest` (the `master` branch), `vX.Y.Z` (a Git tag) and `sha-<full commit sha>`. Pin a version tag in production. The workflow is [`.github/workflows/ghcr.yml`](.github/workflows/ghcr.yml); it publishes with the scoped `GITHUB_TOKEN`, no personal access token is needed. A new package may start private: switch it to public in GitHub, Packages, ForgeHands, Package settings, or log in to the registry with a token that has `read:packages`.

```sh
cp .env.example .env          # webhook mode; direct mode needs the variables of "Configuration"
docker compose up -d          # pulls the published image, does not build
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
```

`compose.yaml` binds the port to `127.0.0.1`. To accept Forgejo webhooks from another host, use a secured reverse proxy and an explicit network policy. To run without Docker: `npm start`. To build a local image: `docker build -t forgehands:local .` and `FORGEHANDS_IMAGE=forgehands:local docker compose up -d`. Keep registry and webhook secrets out of committed files.

Endpoints: `POST /webhooks/forgejo` (the webhook), `GET /healthz`, and in direct mode `GET /status` (page) and `GET /status.json`.

## Forgejo setup

Create a **Forgejo** webhook per allowed repository (Settings, Webhooks):

- URL `https://YOUR-HOST/webhooks/forgejo`, content type `application/json`, secret = the exact `FORGEJO_WEBHOOK_SECRET` (never an empty one).
- Events. Webhook mode: **Issues**. Direct mode: **Issues** (including label changes and closed), **Pull request label**, **Actions run failure** and **success** (`action_run_failure`, `action_run_success`) and **Push**.
- Forgejo may not deliver to an HTTPS URL whose certificate comes from a private CA; a plain internal `http://` URL works (the payload is HMAC-signed).

Direct mode also needs the labels you route (for example `ai:plan`, `ai:ready`, `ai:escalate`, `ai:review`, `ai:changes`, `ai:approved`; `ai:blocked` is created when missing) and, for a clean division of rights, a Forgejo user of its own for the agents and ForgeHands (a token for it as `FORGEJO_TOKEN`, write access to the allowed repositories, not an administrator).

## OpenHands setup

**Direct mode.** Set `OPENHANDS_API_URL` (for example `http://openhands:8000`) and `OPENHANDS_API_KEY` (the backend key, `LOCAL_BACKEND_API_KEY` of Agent Canvas, not a model provider key). `LABEL_ROUTES` refers to agent profiles by their UUID (`GET /api/agent-profiles`).

**Webhook mode.** ForgeHands targets the **OpenHands Automation custom webhook** API of the Agent Canvas image (it bundles Canvas, Agent Server and Automation Server). Check that the API exists (401/403 means yes, 404 the wrong image or version): `curl -i http://127.0.0.1:8000/api/automation/v1/webhooks`. Register a source, ideally from the Canvas UI (Automate, Events) or a locally generated request so that secrets stay out of the shell history:

```sh
curl -X POST "$OPENHANDS_HOST/api/automation/v1/webhooks" \
  -H "X-Session-API-Key: $OPENHANDS_SESSION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "ForgeHands Forgejo Issues", "source": "forgehands", "event_key_expr": "type",
       "signature_header": "X-Signature-256", "signature_scheme": "hmac_sha256_hex",
       "event_id_header": "X-ForgeHands-Delivery", "webhook_secret": "REPLACE_WITH_OPENHANDS_WEBHOOK_SECRET"}'
```

For OpenHands Cloud use `Authorization: Bearer $OPENHANDS_API_KEY`. Use the returned `webhook_url` as `OPENHANDS_WEBHOOK_URL` and configure an event automation for source `forgehands` and the keys `issues.labeled` and/or `issues.opened`. The agent prompts should treat issue text as untrusted input. In webhook mode ForgeHands holds no Forgejo or LLM credentials and only the label `ai:ready` triggers a run; the outgoing payload is:

```json
{
  "type": "issues.labeled", "source": "forgejo", "action": "labeled",
  "repository": { "full_name": "team/app", "clone_url": "https://git.example/team/app.git", "html_url": null, "default_branch": "main" },
  "issue": { "number": 42, "title": "Add tests", "body": "Implement unit tests.", "html_url": null, "labels": ["ai:ready"] },
  "sender": { "login": "developer" },
  "delivery_id": "webhook-delivery-id"
}
```

Webhook mode verifies `X-Forgejo-Signature` (HMAC SHA-256 over the raw body), allows only listed repositories, signs the outgoing body with a distinct secret in `X-Signature-256`, keeps processed delivery IDs for seven days and fails closed on a wrong signature, invalid JSON, an oversized payload or an unlisted repository.

## Configuration

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `FORGEJO_WEBHOOK_SECRET` | yes | Incoming Forgejo webhook secret (at least 16 characters). |
| `ALLOWED_REPOS` | yes | Comma separated full names, for example `team/app,team/api`. |
| `OPENHANDS_WEBHOOK_SECRET`, `OPENHANDS_WEBHOOK_URL` | webhook mode | Independent secret (at least 16 characters) and complete URL of the OpenHands custom webhook. |
| `OPENHANDS_API_URL`, `OPENHANDS_API_KEY` | direct mode | Switch to direct mode and reach the OpenHands backend. |
| `FORGEJO_URL`, `FORGEJO_TOKEN` | direct mode, for most features | Forgejo API access: merge, round limits, status checks, dependencies, branch updates. Without them ForgeHands only logs what it would tell Forgejo. |
| `DATA_FILE`, `JOBS_FILE` | no | Delivery store (`./data/deliveries.json`) and issue ledger (`jobs.json` next to it). |
| `PORT`, `HOST` | no | Listening port (`8080`) and address (`0.0.0.0`). |
| `DRY_RUN`, `DRY_RUN_REPOS` | no | `DRY_RUN=1`: events are received and judged as usual, but every write is only logged: no OpenHands conversation (the job ends as `dry`, its first message kept in the ledger as `dry_prompt`), no Forgejo comment, label, merge, branch update or close, no webhook-mode forward. Reads stay real. `DRY_RUN_REPOS=owner/repo,...` (must be in `ALLOWED_REPOS`) limits it to those repositories. `/status` shows a banner and `/status.json` the latest would-be writes. |

### Direct mode: routes, who may trigger, limits

| Variable | Meaning |
| --- | --- |
| `LABEL_ROUTES` | JSON, route name to route: `{"ai:plan": {"profile": "<agent profile uuid>", "tier": "strong", "max_iterations": 80, "max_budget": 1.5}, "ai:ready": {"profile": "<uuid>", "tier": "free"}}`. Optional per route: `max_concurrent`, `on` (below), `escalate_to` (a round route only, see Follow-up rounds). The first label listed wins when an issue is opened with several. |
| `ALLOWED_SENDERS` | Optional comma separated Forgejo logins that may trigger runs and steer agents through comments (else the sender of the label). |
| `MAX_CONCURRENT`, `MAX_CONCURRENT_PER_TIER`, `MAX_RUNS_PER_HOUR` | Runs at once in total (default 4) and per `tier` (default 2), and started runs per hour (default 30, a guard against runaway fan-out). The rest waits in the queue. |
| `REPO_WEIGHTS` | JSON, repository to weight, for example `{"owner/a": 2, "owner/b": 1}`; default weight 1. See [Scheduling](#scheduling). |
| `MAX_RUN_MINUTES` | After this long a run stops holding its slot (default 120); the conversation itself is not touched. |
| `AGENT_SECRETS` | Comma separated names of environment variables (for example `FORGEJO_TOKEN,FORGEJO_URL`) whose values are handed to every started conversation as secrets. OpenHands gives its saved secrets only to callers that pass them in the start request. The values stay in ForgeHands' environment, never in the ledger. |
| `WORKSPACE_DIR` | Working directory of the conversations (default `/projects`). |

Route kinds, set by `"on"` (a route without it fires for a label on an issue):

| `"on"` | Fires for |
| --- | --- |
| `pull_request` | a label on the pull request of an agent issue: a follow-up **round** |
| `ci_failure` / `ci_success` | a red / green commit of such a pull request: **fix round** / **review** (no label, name them freely) |
| `conflict` | a pull request whose branch conflicts with the default branch: **conflict round** |
| `epic_done` | the last dependency of an epic closed: **epic review** |
| `sensitive_review` | a green commit that touches a protected path: advisory **security review** |

### Merge, review and rounds

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERGE_POLICY`, `MERGE_METHOD` | none, `merge` | Per repository deny lists for automatic merge, and the merge method. A repository without an entry is never merged automatically. |
| `APPROVED_LABEL`, `BLOCKED_LABEL` | `ai:approved`, `ai:blocked` | The reviewer's approval and the hand-over to a human. The label for changes is the first `"on": "pull_request"` route. |
| `MIN_REVIEW_CHARS` | 300 | A review comment must be at least this long to count as evidence. |
| `APPROVAL_GRACE_SECONDS` | 90 | An approval label without a verdict comment is looked at once more after this long before it is taken off; `0` takes it off at once. |
| `MAX_ROUNDS` | 3 | Follow-up rounds per issue. |
| `ESCALATE_FROM_ROUND` | `MAX_ROUNDS` | From this round on, a round route with `escalate_to` runs with the profile and tier of that route. At most `MAX_ROUNDS`. |
| `EPIC_LABEL` | `ai:plan,ai:close` | Labels that mark an epic. |

### Humans, failures, housekeeping

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUMAN_LOGIN` | none | Forgejo login mentioned in comments that hand something to a human. |
| `ERROR_RETRIES` | 1 | Restarts of a run that ended in `error`; `0` switches it off. |
| `QUOTA_HOLD_MAX_HOURS`, `QUOTA_GIVE_UP_HOURS` | 8, 24 | Out of quota: hold a tier back at most this long at a time, and give a job up once its quota has been out this long. |
| `SPLIT_LABEL` | none | Label (for example `ai:plan`) that sends a ticket whose worker ran out of iterations or time to the planner. |
| `UPDATE_BRANCHES`, `BRANCH_UPDATE_DELAY_SECONDS`, `BRANCH_UPDATE_MIN_INTERVAL_MINUTES` | on, 60, 30 | Keep open agent pull requests current, see below. |
| `ARCHIVE_AFTER_DAYS` | 7 | Archive finished OpenHands conversations after this many days; `0` = off. |
| `REMIND_AFTER_DAYS`, `REMIND_MAX`, `STALE_LABEL` | off, 3, none | Once a day, remind `HUMAN_LOGIN` (needs `FORGEJO_*`) of agent pull requests that wait for him: marked `BLOCKED_LABEL`, approved and green on a protected path, or untouched with no run for that many days. At most one reminder per that many days and `REMIND_MAX` per pull request (a comment of the human starts the count again); `STALE_LABEL` is added after the last. A dependency bot pull request is reminded only when marked `BLOCKED_LABEL`. Waiting jobs whose dependencies are all closed are started. `/status` lists what waits for a human. |
| `BOT_AUTHORS`, `BOT_BRANCH_PREFIXES`, `BOT_FIX_ROUNDS` | none, none, 0 | Dependency bot pull requests, see below: Forgejo logins of the bots (for example `renovate`), optional head branch prefixes (for example `renovate/`), and fix rounds per pull request after a red commit. |

**Dependency bot pull requests.** A pull request qualifies when its author is in `BOT_AUTHORS`, its head branch starts with one of `BOT_BRANCH_PREFIXES` (if set) and the branch lives in the repository itself (not a fork). It then follows the review and merge policy of agent pull requests, without a worker: a **green** commit starts the review once per commit (the reviewer reads the changelogs between the old and the new version and checks breaking changes against the repository's usage), `Verdict: OK` plus `APPROVED_LABEL` merges through `MERGE_POLICY` (deny list unchanged, no issue is closed), and a review that finds a problem sets `BLOCKED_LABEL` with a mention. A **red** commit starts nothing unless `BOT_FIX_ROUNDS` is set. ForgeHands never updates a bot's branch (Renovate rebases itself). The ledger and `/status` list it as `owner/repo!pr<n>`. Titles, descriptions and changelogs of these pull requests are untrusted text, like issue text. Their CI outcomes are let in by `BOT_AUTHORS`, not by `ALLOWED_SENDERS`.

## Behaviour in detail

### Labels and re-labelling

A label added to an existing issue arrives from Forgejo as an `issues` event with action `label_updated` that lists the current labels but not the added one. ForgeHands remembers the labels it last saw per issue (in the ledger, 30 days) and starts a run for a trigger label that is **new** compared with that. So `ai:escalate` works next to `ai:ready`, an issue can be run again by removing and re-adding its label, and unrelated labels are ignored. For an issue it has not seen it starts the first trigger label that never ran. The ledger keeps `repo#issue:label` to conversation id; the same label on an issue that still has a queued or running run starts no second one.

### Comments and earlier work

The issue text goes into the first message between markers and is marked as untrusted. The message tells the agent to read the comments of the issue first (Forgejo does not send their text; the event carries their count) and to look for a pull request from the branch `ai/issue-<n>`: an open one is continued on the same branch (reviews, review comments and the conversation are read and answered, no second pull request), a branch without a pull request is reused, a closed or merged one ends the run with a comment. Only `ALLOWED_SENDERS` (else the sender of the label) may steer the agent through comments and reviews; anyone else is context only. Every run has a clone directory of its own (`<workspace>/<owner>-<repo>-issue-<n>`, plus `-review-<sha8>`, `-fix-<sha8>`, `-round-<delivery>`, `-security-<sha8>`), so a review never clones into the worker's checkout.

### Follow-up rounds

A route with `"on": "pull_request"` (for example `"ai:changes": {"profile": "<worker uuid>", "tier": "free", "max_iterations": 120, "on": "pull_request"}`) fires when its label is put on the pull request of an agent issue (head branch `ai/issue-<n>`; others are ignored). The run belongs to issue `<n>`: it checks out the branch, reads reviews, the conversation and the issue comments, fixes, pushes to the **same** branch, comments and removes the label so that the next round can be asked for with it. Labels of a pull request are kept apart from those of the issue with the same number. The verdict is a label because Forgejo refuses a formal review of one's own pull request when agent and human share an account.

**Escalation.** A round route (`pull_request`, `ci_failure`, `conflict`) may name `"escalate_to": "<another route>"`, for example `"ai:changes": {"profile": "...", "on": "pull_request", "escalate_to": "ai:escalate"}`. The last round (the `MAX_ROUNDS`-th, or from `ESCALATE_FROM_ROUND` on) then starts with the profile and tier of the target route, so a stronger model gets the last try before a human is called. Everything else stays: branch, kind, prompt, the iteration and budget limits of the own route, and it counts as a round. The tier limits and cooldowns apply to the target's tier. The job records `escalated` and `/status` shows it. A human action that resets the rounds resets the escalation. Without `escalate_to` nothing changes. The target's profile is the operator's choice in `LABEL_ROUTES`; the label itself is not needed, so no one can trigger it from an issue.

`MAX_ROUNDS` limits rounds per issue (fix rounds and conflict rounds count, reviews do not). When used up, ForgeHands starts nothing, comments and adds `BLOCKED_LABEL`. Whatever the human (`HUMAN_LOGIN`) does on such a pull request, setting a label or pushing a commit (its CI run names him), starts the rounds again and takes `BLOCKED_LABEL` off, whatever caused the block; agents' events never reset it. Stopping a run with `POST /api/conversations/<id>/pause` frees its slot at the next poll (the job ends as `failed` with result `paused`).

### CI events: fix round and review

Forgejo sends one event per finished Actions run. A commit starts at most one run per kind, however many workflows it has. A **red** commit starts a fix round (reproduce, fix, push to the same branch, comment). A **green** commit starts the **review**, only when the **combined commit status** is green, so a pending or failed second workflow holds it back. A CI outcome starts nothing when the run was cancelled or skipped (Forgejo reports a replaced run as a failure; only `status: failure` counts), when its commit is no longer the head of the pull request, or when the commit has recovered meanwhile. While an agent still works on the issue the outcome is **kept, not dropped** (shown as "CI result kept") and judged when that run ends; a kept outcome older than `MAX_RUN_MINUTES` is dropped.

### The review

The reviewer reads the issue and the diff, checks against the issue's criteria and, for anything that talks to a system outside the repository, against reality (the counterpart's own description, a real read-only call), writes **one** comment with the evidence and adds `APPROVED_LABEL` or the changes label. It neither pushes nor merges. A new round or review takes `APPROVED_LABEL` off first, so an approval never covers commits it has not seen.

**A label is not a review.** Before a merge the pull request must carry a review comment for its current commit: written after that commit, at least `MIN_REVIEW_CHARS` long, with `Verdict: OK` or `Verdict: NOT OK` within its first 300 characters; the latest such comment decides, one from the reviewer or a human counts. Without one, or with a NOT OK latest, nothing is merged: the approval is taken off, the pull request gets `BLOCKED_LABEL` and a comment that mentions the human. A label that arrives a moment before its comment is looked at again after `APPROVAL_GRACE_SECONDS`. A review run that ends without a verdict is run once more (not a round); a second miss blocks the pull request.

### Auto-merge

`MERGE_POLICY` (JSON, per repository) lets ForgeHands merge the pull request of an agent issue once `APPROVED_LABEL` is on it: `{"owner/repo": {"deny": ["stacks/**", "compose.yaml"]}}`. It merges only when the pull request is open, from `ai/issue-<n>`, not blocked, mergeable, the combined status of its head commit is green and **none of its changed files (renames count with both names) matches a deny pattern**. Patterns: `*` within a folder, `**` across folders, a plain name is an exact path. The merge uses `MERGE_METHOD`, is bound to the checked head commit, deletes the branch and closes the issue. A pull request on a protected path is left to a human, with **one** comment that mentions him and says what is done (commit approved, CI green), why a human (each matching pattern with its reason, see below, and the files), what the security review found and whether Forgejo reports a conflict. When a security review of that commit is still under way, the hand-over waits for it and is written when that run ends. Approved and green ends the work in progress, so the `WIP:` marker is removed first, because Forgejo would not let the human merge it. A reason per pattern is optional: `{"owner/repo": {"deny": ["infra/**"], "reasons": {"infra/**": "decides what is reachable from the internet"}}}`. The policy lives in ForgeHands' environment on purpose: a policy file in the repository could be changed by the very pull request it should restrain.

**A merged agent pull request closes its ticket.** After every push to the default branch ForgeHands closes the tickets whose agent pull request was merged into it (also by someone else, with a comment); the usual closed event then starts what waits for it.

### Security review for protected paths (advisory)

A route with `"on": "sensitive_review"` starts a second, security-minded review when a commit is green and a changed file matches the deny list of the repository's `MERGE_POLICY`: once per commit, next to the normal review, never a round. The run is read-only and posts one comment starting `## Security review: OK` or `## Security review: CONCERNS` that names the commit. It sets no label, approves and merges nothing. A run without that comment is started once more, then only logged; a failed run never blocks. The comment that hands a protected-path pull request to the human ends with what the security review found for that commit. Without the route nothing changes.

### Keeping pull requests current

With `UPDATE_BRANCHES` (the webhook needs `push`) ForgeHands looks, after the default branch has been quiet for `BRANCH_UPDATE_DELAY_SECONDS`, at open pull requests from `ai/issue-<n>` that fell behind. An update changes the head commit, cancels the CI run in progress and throws a review away, so it acts only when it is cheap and needed: the pull request has neither an approval nor an OK review for its current commit, is not blocked, has no agent running on its issue, the default branch changed a file the pull request changes too (through `/compare` and `/pulls/<n>/files`; a rename counts, an unclear case counts as "touches"), CI is not running on its head, and the last update was more than `BRANCH_UPDATE_MIN_INTERVAL_MINUTES` ago. Then Forgejo rebases it (`POST /pulls/<n>/update?style=rebase`, no agent involved). An approved or reviewed pull request is not brought up to date (that would throw the review away), but when Forgejo reports it as not mergeable (reliable once the `WIP:` marker is gone, which approval removes) it gets a conflict round too, after which CI, the review and the security review run again; this matters for a protected-path pull request that waits for a human.

When the update answers 409 the branch **conflicts**: a route with `"on": "conflict"` starts a **conflict round**, once per tip of the default branch and counted against `MAX_ROUNDS`: rebase, resolve each conflict so that the purpose of the pull request stays and what the default branch brought in is kept, run the checks, push once with `--force-with-lease`, comment what was resolved. This is the only kind of run in which a rebase and a force push are allowed. Without a conflict route, or with the rounds used up, the pull request gets `BLOCKED_LABEL` and a mention. A pull request that was busy (an active run) when the default branch moved is looked at once when that run ends, so a conflict that arrived meanwhile is not forgotten. Forgejo reports `mergeable: false` for a pull request titled `WIP:` even without a conflict, so that field is not used; the update call is the test.

### Epics and the order of sub-issues

Forgejo's own issue dependencies carry the order (the planner sets them). An issue that **depends on open issues waits** (`waiting for #n`) instead of starting, and starts when the last of them closes: ForgeHands reads `GET /issues/<n>/dependencies` when the label arrives and again just before a worker starts (an edge may be added after the label), and the `issues` event with action `closed` makes it look at `GET /issues/<n>/blocks`. An **epic** (a label of `EPIC_LABEL`) depends on all its sub-issues, so Forgejo refuses to close it while one is open. When the last dependency closes, the route with `"on": "epic_done"` starts a review: the reviewer checks every acceptance criterion against the default branch, writes **exactly one** comment with the evidence and closes the epic if all are met, otherwise leaves it open and names what is missing. `ai:close` marks an existing ticket that only needs that closing review: it has no route and starts no planner run (give it its dependencies first). `ai:plan` marks a ticket that is planned first and reviewed at the end. Without Forgejo access issues are not held back.

### Scheduling

Within a repository, work on a ticket that has begun (a round, a review, a CI fix, a conflict round, an epic review) goes before a new ticket, so that what was started gets finished; then the **oldest ticket (lowest issue number)** that can start now goes first, not the one queued first. Between repositories the starts are shared by `REPO_WEIGHTS` (default weight 1; a higher weight means more of them): weights 2, 1 and 5 give 2 of 8, 1 of 8 and 5 of 8 of the starts while all three have work. The repository with the fewest starts per unit of weight among the last 50 started runs goes first; one with nothing that can start gives its share to the others. `MAX_CONCURRENT`, `MAX_CONCURRENT_PER_TIER` and `MAX_RUNS_PER_HOUR` stay global.

### Humans and failures

**Mail only when a human is needed.** With `HUMAN_LOGIN=<forgejo login>` the comments that hand something to a human start with `@<login>`: a pull request approved and green on a protected path, a conflict, a failed merge, a pull request marked `BLOCKED_LABEL`, a failed run, and, through the prompt, an epic whose review found gaps. Nothing else mentions him (not a merge, not a round, not a rejection the worker fixes). Forgejo mails a mentioned user whose setting is "only on mention", but not the **actor** of an action, so the agents and ForgeHands must act as a Forgejo user of their own.

**A run that ends badly is not forgotten.** A conversation that ends in `error` is started once more after a minute (`ERROR_RETRIES`); a second end is final and is reported: on a pull request with `BLOCKED_LABEL` and a mention, on an issue with a comment that mentions the human. A run that reached its **iteration limit** (OpenHands reports `MaxIterationsReached` as an error) is not run again: it ends as `max_iterations`, because the same run would end the same way. With `SPLIT_LABEL` a worker run on an issue that ran out of iterations or time (`max_iterations`, `paused`, `stuck`, `timeout`) is not a case for the human: the ticket is probably too big, so the worker label comes off, `SPLIT_LABEL` goes on and the planner splits it. Planner and epic labels are never sent there.

**The model is out of quota.** When a run ends in `error` and its last events say it was a rate limit (the gateway mostly tells when the quota is back, `retry_after`), ForgeHands neither fails the job nor calls a human: it queues the job again and holds the whole `tier` of that route back until then (at least a minute, at most `QUOTA_HOLD_MAX_HOURS`, 15 minutes when the gateway gives no time). It gives the job up only when the quota has been out for `QUOTA_GIVE_UP_HOURS` in a row. The status page shows "model quota used up, ... tries again after HH:MM UTC". The hold lives in memory, so a restart means "try again now".

### Housekeeping and status

Finished runs archive themselves (`ARCHIVE_AFTER_DAYS`): about once an hour ForgeHands adds the tag `archived=true` (other tags stay, so runs can still be found by `source`, `issue`, `pr`, `ci`, `epic`) to conversations that ended long enough ago, at most 20 per round. Archived runs stay in the ledger until it prunes them (30 days).

`GET /status` and `GET /status.json` show per issue what the ledger knows: runs with kind, state, result, conversation id, cost, the pull request number, the rounds used (`n/MAX_ROUNDS`) and one line for the state (worker running, waiting for #n, follow-up round, fix after red CI, review, security review, epic review, rounds used up, failed). Read only, no event text but the issue title, **not authenticated**, so it belongs behind the same internal reverse proxy as the webhook. The labels on the pull request (`ai:approved`, `ai:changes`, `ai:blocked`) are Forgejo's side of the picture.

## Security and limitations

- Issue, pull request and comment text is untrusted. ForgeHands never fetches repository URLs from events. In direct mode it holds the secrets named in `AGENT_SECRETS` and the backend key and hands them to the agents; keep `OPENHANDS_API_KEY` and the Forgejo token out of the repository and give them to the container through its secret store.
- Restrict public access, use TLS termination, keep secrets out of logs and restrict outbound networking to your OpenHands and Forgejo.
- The delivery store and the ledger are local JSON files: **single instance only**. Use a shared atomic database before scaling out.
- Retries rely on Forgejo's retries or a manual redelivery. A failure after OpenHands accepted a webhook-mode request but before ForgeHands recorded it can cause a duplicate; configure OpenHands's `event_id_header` for defense in depth. There is no durable outgoing queue in webhook mode: if OpenHands is down the answer is HTTP 502.

## Development

```sh
npm test               # node --test, no dependencies to install for the service itself
npm run test:coverage
npm run typecheck      # tsc, needs `npm ci` for the dev dependencies
```

CI runs the tests and the type check on Node.js 26. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT (see LICENSE).
