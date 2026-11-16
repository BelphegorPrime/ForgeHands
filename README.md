# ForgeHands

ForgeHands connects **Forgejo issues** to **OpenHands Automation custom webhooks**. A small, dependency-free Node.js 22 service that authenticates, filters, transforms and re-signs events.

> Status: MVP / early development. Do not deploy directly to the public Internet without TLS, network controls and monitoring.

## Features

- Verifies Forgejo's `X-Forgejo-Signature` (HMAC SHA-256 over the **raw request body**).
- Explicit repository allowlist and opt-in `ai:ready` label.
- Processes `issues.opened` (only when labeled) and `issues.labeled` (only when `ai:ready` was added).
- Creates a minimal normalized `type: "issues.labeled"` or `type: "issues.opened"` event.
- Signs the outgoing JSON body with a distinct HMAC SHA-256 secret in `X-Signature-256`.
- Persists processed delivery IDs for seven days, rejects concurrent duplicates in the same process.
- Fails closed on wrong signature, invalid JSON, oversized payloads, unlisted repositories.
- Exposes `GET /healthz`.

No Git credentials or LLM API keys are required by ForgeHands. OpenHands handles coding and PR creation via its own automation.

## Container images (GHCR)

GitHub Actions builds and publishes multi-platform OCI images (`linux/amd64`, `linux/arm64`) to:

```text
ghcr.io/belphegorprime/forgehands
```

The workflow is in [`.github/workflows/ghcr.yml`](.github/workflows/ghcr.yml).

| Source | Tags | Publish? |
| --- | --- | --- |
| Pull request | Test + Docker build | No |
| Temporary feature branch `feat/forgejo-webhook-adapter` | `edge`, `sha-<full-commit-sha>` | Yes, for MVP testing only |
| `master` | `latest`, `sha-<full-commit-sha>` | Yes |
| Git tag `v1.2.3` | `v1.2.3`, `sha-<full-commit-sha>` | Yes |

Publishing uses the scoped `GITHUB_TOKEN` with `packages: write`. No personal access token or registry password is needed in GitHub repository secrets. The initial package may be private even when the repository is public: the owner can enable public visibility in GitHub → Packages → ForgeHands → Package settings.

The feature-branch `edge` publish rule is temporary; remove it after the MVP has been merged and use `latest` for normal deployments.

## Quick start (Docker Compose)

Prerequisites: Docker with the Compose plugin.

```sh
cp .env.example .env
# Update both independent secrets, allowlist and OpenHands webhook URL.

# While the MVP is on the feature branch:
FORGEHANDS_IMAGE=ghcr.io/belphegorprime/forgehands:edge docker compose up -d

# After merging to master:
docker compose up -d
```

`compose.yaml` pulls a published GHCR image by default; it does not build from source. To run without Docker, use Node.js 22+ and `npm start`. To build a local image for development, run `docker build -t forgehands:local .`, then `FORGEHANDS_IMAGE=forgehands:local docker compose up -d`.

A public GHCR image can be pulled anonymously. For a private package, authenticate the Docker client with a token that has `read:packages` privileges before pulling:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

Do not put registry or webhook secrets in committed files.

```sh
docker compose ps
docker compose logs --tail=100 forgehands
curl -fsS http://127.0.0.1:8080/healthz
```

The Compose example binds the published port to `127.0.0.1`. To accept Forgejo webhooks from another host, use a secured reverse proxy and explicit network policy, not an unprotected public port.

## Forgejo setup

In repository Settings → Webhooks, create a **Forgejo** webhook:

- URL: `https://YOUR-HOST/webhooks/forgejo` (TLS recommended).
- Content type: `application/json`.
- Secret: exact `FORGEJO_WEBHOOK_SECRET` value.
- Event: **Issues** (select issue events, not every repository event).
- Label an issue with `ai:ready` to trigger a run.

Never configure an empty Forgejo webhook secret.

## OpenHands setup

This service targets the **OpenHands Automation custom webhook** API, not the generic Agent Server directly.

### Self-hosted Agent Canvas (Docker)

The official `ghcr.io/openhands/agent-canvas` Docker image bundles Canvas, Agent Server, and Automation Server. In Canvas, look for **Automate → Events** to register a custom source if supported by your deployed version. The incoming source should use `forgehands` as the source, `type` as the event key expression, `X-Signature-256` as the signature header and a dedicated secret shared with ForgeHands.

Check that the automation API exists before configuring the bridge (replace the port with your published port):

```sh
curl -i http://127.0.0.1:8000/api/automation/v1/webhooks
```

A 401/403 can indicate the endpoint exists but requires the backend session key. A 404 suggests the wrong image, path or version; a 502/503 may indicate an unhealthy automation backend. **Do not paste or publish session keys or webhook secrets.**

For a self-hosted API request, use `X-Session-API-Key` with the backend/session key (`LOCAL_BACKEND_API_KEY`), **not** your model provider API key. The following example expects `OPENHANDS_HOST`, `OPENHANDS_SESSION_API_KEY`, and `OPENHANDS_WEBHOOK_SECRET` to be set in your shell:

```sh
curl -X POST "$OPENHANDS_HOST/api/automation/v1/webhooks" \\
  -H "X-Session-API-Key: $OPENHANDS_SESSION_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "ForgeHands Forgejo Issues",
    "source": "forgehands",
    "event_key_expr": "type",
    "signature_header": "X-Signature-256",
    "signature_scheme": "hmac_sha256_hex",
    "event_id_header": "X-ForgeHands-Delivery",
    "webhook_secret": "REPLACE_WITH_OPENHANDS_WEBHOOK_SECRET"
  }'
```

The literal secret placeholder in the JSON above must be replaced securely. Prefer registration through the Canvas UI or a locally generated JSON request to avoid leaking secrets to shell history. For **OpenHands Cloud**, use `Authorization: Bearer $OPENHANDS_API_KEY` instead.

### Automation source registration

Alternatively, register a source through the Automation API with the appropriate authentication for your deployment:

```sh
curl -X POST "$OPENHANDS_HOST/api/automation/v1/webhooks" \
  -H "Authorization: Bearer $OPENHANDS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ForgeHands Forgejo Issues",
    "source": "forgehands",
    "event_key_expr": "type",
    "signature_header": "X-Signature-256",
    "signature_scheme": "hmac_sha256_hex",
    "event_id_header": "X-ForgeHands-Delivery",
    "webhook_secret": "REPLACE_WITH_OPENHANDS_WEBHOOK_SECRET"
  }'
```

Use the returned `webhook_url` as `OPENHANDS_WEBHOOK_URL`. Configure an OpenHands event automation for source `forgehands` and event keys `issues.labeled` and/or `issues.opened`. Agent prompts should treat issue text as **untrusted user input** and only open draft PRs without merging.

The registered custom webhook must be reachable from ForgeHands. The official Agent Canvas Docker distribution includes the automation backend, but other OpenHands image variants or older deployments may not. Confirm endpoint availability before configuring this bridge. For a LAN-only Forgejo deployment, ForgeHands and OpenHands can remain on private networking; public internet ingress is not required.

## Configuration

| Env var | Required | Description |
| --- | --- | --- |
| `FORGEJO_WEBHOOK_SECRET` | yes | Incoming Forgejo webhook secret (min 16 characters). |
| `OPENHANDS_WEBHOOK_SECRET` | yes | Independent OpenHands custom webhook secret (min 16). |
| `OPENHANDS_WEBHOOK_URL` | yes | Complete URL from OpenHands custom webhook registration. |
| `ALLOWED_REPOS` | yes | Comma-separated full names (for example `team/app,team/api`). |
| `DATA_FILE` | no | Persistent delivery store; defaults to `./data/deliveries.json`. |
| `PORT` | no | Listening port; default `8080`. |
| `HOST` | no | Binding address; default `0.0.0.0`. |

Example outgoing payload:

```json
{
  "type": "issues.labeled",
  "source": "forgejo",
  "action": "labeled",
  "repository": { "full_name": "team/app", "clone_url": "https://git.example/team/app.git", "html_url": null, "default_branch": "main" },
  "issue": { "number": 42, "title": "Add tests", "body": "Implement unit tests.", "html_url": null, "labels": ["ai:ready"] },
  "sender": { "login": "developer" },
  "delivery_id": "webhook-delivery-id"
}
```

## Development

```sh
npm test
npm run test:coverage
```

No external dependencies are installed. CI runs tests on Node.js 22.

## Operational limitations

- Current delivery store uses a local JSON file and is **single-instance only**. Use a shared atomic database before horizontal scaling.
- Retries rely on Forgejo retries or manual redelivery. A network failure after OpenHands accepts a request but before ForgeHands records completion can cause duplicates; configure OpenHands's `event_id_header` for defense in depth.
- No durable outgoing work queue yet; if OpenHands is down, responses are HTTP 502.
- Event payloads are untrusted text; LLM prompts must not execute instructions found inside issue bodies as privileged directions.
- Repository URLs provided by webhook events are **not fetched by this service**.
- Restrict public access, use TLS termination, avoid exposing secrets in logs, and restrict outbound networking to your OpenHands deployment.

## Direct mode (v0.2.0): one agent profile per label

Set `OPENHANDS_API_URL` (for example `http://openhands:8000`) and `OPENHANDS_API_KEY` and ForgeHands starts an OpenHands conversation itself, with the agent profile that belongs to the label. Without `OPENHANDS_API_URL` it works as before (signed webhook to an automation, label `ai:ready`).

| Variable | Meaning |
| --- | --- |
| `LABEL_ROUTES` | JSON, label to route: `{"ai:plan": {"profile": "<agent profile uuid>", "tier": "strong", "max_iterations": 80, "max_budget": 1.5}, "ai:ready": {"profile": "<uuid>", "tier": "free"}}`. Optional per route: `max_concurrent`. First label listed wins when an issue is opened with several. |
| `ALLOWED_SENDERS` | Optional, comma separated Forgejo logins that may trigger runs. |
| `MAX_CONCURRENT_PER_TIER` / `MAX_CONCURRENT` | Runs at once per `tier` (default 2) and in total (default 4). The rest wait in the queue. |
| `MAX_RUNS_PER_HOUR` | Hard cap on started runs per hour (default 30), a guard against runaway fan-out. |
| `TIER_WEEKLY_BUDGETS` | JSON, tier to USD per 7 days, for example `{"strong": 5}`. ForgeHands reads the accumulated LLM cost of every run from OpenHands (running runs with their latest cost); once the runs of a tier started within 7 days add up to the budget, further runs of that tier wait in the queue. Tiers without an entry are not limited. `max_budget` of a route stays the cap of a single run. |
| `MAX_RUN_MINUTES` | After this long a run stops holding its slot (default 120). The conversation itself is not touched. |
| `AGENT_SECRETS` | Comma separated names of environment variables (for example `FORGEJO_TOKEN,FORGEJO_URL`) whose values are handed to every started conversation as secrets. OpenHands exposes its saved secrets only to callers that pass them in the start request, so without this the agent has no Forgejo access. The values stay in ForgeHands' environment and are never written to the ledger. |
| `WORKSPACE_DIR` | Working directory of the conversations (default `/projects`). The agent clones the repository there. |
| `JOBS_FILE` | Issue ledger next to `DATA_FILE` by default. |

- A label added to an existing issue arrives from Forgejo as an `issues` event with action `label_updated` (an `issue_label` event is accepted too). It lists the current labels but not the added one, so ForgeHands remembers the labels it last saw on each issue (in the ledger file, 30 days) and starts a run for a trigger label that is **new** compared with that. That makes `ai:escalate` next to `ai:ready` work, lets you run an issue again by removing and re-adding its label, and ignores unrelated labels. For an issue it has not seen before it starts the first trigger label that never ran.
- The ledger keeps `repo#issue:label` to conversation id. The same label on an issue that still has a queued or running run does not start a second one; a re-label after the run ended does.
- The issue text goes into the first message between markers and is marked as untrusted. In direct mode ForgeHands holds the secrets named in `AGENT_SECRETS` (and the backend key) and passes them to the agents; in webhook mode it still holds no Forgejo or LLM credentials.
- **Comments and earlier work.** The first message tells the agent, before it starts, to read the comments of the issue (the event carries their count as `issue.comments`; Forgejo does not send their text) and to look for a pull request from the branch `ai/issue-<n>`. An open one is continued on the same branch (reviews, review comments and the comments in the pull request's conversation are read and answered, no second pull request), a branch without a pull request is reused, a closed or merged pull request ends the run with a comment. That is what makes a re-label after a review a follow-up instead of a new attempt. Only the logins in `ALLOWED_SENDERS` (else the sender of the label) may steer the agent through comments and reviews; text from anyone else is context only. The step applies to the role that implements an issue, not to planning or reviewing.
- **Follow-up rounds (pull request labels).** A route with `"on": "pull_request"` fires when its label is put on the pull request of an agent issue (head branch `ai/issue-<n>`; closed, merged and other pull requests are ignored). Example: `"ai:changes": {"profile": "<worker uuid>", "tier": "free", "max_iterations": 120, "on": "pull_request"}`. The run belongs to issue `<n>` and gets a different first message: check out the branch, read the reviews, the pull request's conversation and the issue comments (only `ALLOWED_SENDERS`, else the sender of the label, may ask for changes), fix, push to the **same** branch, comment, and remove the label so that the next round can be asked for with the same label. Forgejo reports a label on a pull request like on an issue (`pull_request` event, action `label_updated`, current labels only), so the same label diff applies; labels of a pull request are kept apart from those of the issue with the same number. Reviews with a verdict do not work when the agent and the human share one Forgejo account (Forgejo answers 422 for one's own pull request), which is why the verdict is a label.
- **CI events (fix round and review).** Forgejo sends one event per finished Actions run (`X-Forgejo-Event: action_run_failure` or `action_run_success`; subscribe the webhook to both). For a pull request of an agent issue (`ai/issue-<n>`) two more route kinds apply, named freely in `LABEL_ROUTES` since they have no label: `"on": "ci_failure"` starts a **fix round** (reproduce the failing checks, fix, push to the same branch, comment) and `"on": "ci_success"` starts the **review**. Example: `"ci:failure": {"profile": "<worker uuid>", "tier": "free", "on": "ci_failure"}`, `"ci:success": {"profile": "<reviewer uuid>", "tier": "strong", "max_iterations": 60, "on": "ci_success"}`. A commit starts at most one run per kind (several workflows per commit send several events).
- Stopping a run with `POST /api/conversations/<id>/pause` frees its slot and the issue at the next poll (the job ends as `failed` with result `paused`).
- A CI outcome starts nothing in three cases: the run was **cancelled** or skipped (Forgejo sends `action_run_failure` for a run that a newer push replaced; only `status: failure` counts, only `success` for a success), its commit is **no longer the head** of the pull request, or an agent is **still working** on the issue. In the last case the outcome is **kept, not dropped** (a job with `waiting_for_run`, shown on the status page as "CI result kept"): CI often finishes seconds before the agent's last step, and a dropped result left a green pull request without its review. When no run of the issue is active any more the kept outcome is judged as if it had just arrived: dropped when its commit is no longer the head of the pull request, when the combined status is not green (for the review) or when the rounds are used up, otherwise started. A kept outcome that waits longer than `MAX_RUN_MINUTES` is dropped.
- **The model is out of quota.** When a run ends in the state `error` and its last events say it was a rate limit (`LLMRateLimitError`, the gateway tells when the quota is back: `retry_after`), ForgeHands does not fail the job or call a human: it queues the job again, holds the whole `tier` of that route back until then (clamped to one minute up to six hours, 15 minutes when the gateway gives no number) and starts it afterwards as a new run. A job is retried at most 12 times; any other error ends the run as before. The status page shows "model quota used up, ... tries again after HH:MM UTC". The hold on the tier is kept in memory and the wait of a re-queued job in the ledger; a **restart clears both**, so that it means "try again now" (the quota may be back, or the model was changed). A model that is still out of quota fails again and sets the hold anew; the retry counter keeps that from going on for ever.
- **Finished runs archive themselves (`ARCHIVE_AFTER_DAYS`, default 7, 0 = off).** About once an hour ForgeHands archives the OpenHands conversations of runs (done or failed) that ended more than that many days ago: it adds the tag `archived=true` and keeps every other tag, so the runs can still be found by issue, pull request and kind (`source`, `issue`, `pr`, `ci`, `epic`). At most 20 per round; a conversation that was deleted is skipped for good, a running one and a failing call are tried again in the next round. Archived runs stay in the ledger until it prunes them (30 days).
- **A label is not a review.** Before ForgeHands merges, the pull request must carry a **review comment for its current commit**: written after that commit, at least `MIN_REVIEW_CHARS` characters long (default 300, so it can hold evidence), with `Verdict: OK` or `Verdict: NOT OK` within its first 300 characters (a heading or bold is fine); the latest such comment decides, a comment of the reviewer or of a human counts, a comment older than the commit does not. Without one, or with a NOT OK as the latest, nothing is merged: the approval label is taken off, the pull request gets `BLOCKED_LABEL` and a comment that mentions the human (`HUMAN_LOGIN`). A comment that cannot be read is a failed merge, never a pass. A label that arrives before any verdict comment (the reviewer sometimes sets it a moment early) is looked at once more after `APPROVAL_GRACE_SECONDS` (default 90; `0` takes it off at once) before it is taken off; the wait does not hold the webhook delivery. The review prompt also asks for checks against reality (read the counterpart's own description and run what can be run for real instead of trusting a test with a fake; compare security defaults with the issue text character by character; list every operator requirement as met or not). The review prompt asks for exactly that comment and says not to send the commands of several steps in one turn, because a review that fires everything at once judges nothing it has read. Found when a review run sent 19 commands in one turn, read no output, and set `ai:approved`: the comment it tried to post never arrived and the pull request was merged.

- **Dependencies are checked again when a worker starts.** A ticket that was labelled before its dependency edges were set waits for them like one labelled after (`waiting for #n`), instead of starting in the wrong order.

- **A security review for protected paths (advisory).** A route with `"on": "sensitive_review"` (for example `"sensitive:review": {"profile": "<sensitive-reviewer id>", "tier": "strong", "max_iterations": 60, "on": "sensitive_review"}`) starts a second, security-minded review when a commit of an agent pull request is green and a changed file matches the deny list of the repository's `MERGE_POLICY`: once per commit, next to the normal review, never a round. The run is read-only and posts one comment that starts with `## Security review: OK` or `## Security review: CONCERNS` and names the commit; it sets no label, approves nothing and merges nothing. A run that ended without that comment is started once more, then only logged; a failed run never blocks the pull request. The comment that hands a protected-path pull request to the human (`approved and green, but not merged automatically`) ends with what the security review found for that commit (`CONCERNS`, no concerns, or none yet), so the human sees it where he decides. Without the route nothing changes.

- **A run that ends badly is not forgotten.** A conversation that ends in `error` (a failing model call, a restart of OpenHands) is started once more after a minute (`ERROR_RETRIES`, default 1, `0` switches it off); the second end is final. A run that failed for good is reported: on a pull request it gets `BLOCKED_LABEL` and a comment that mentions the human, on an issue without one a comment that mentions him. With `SPLIT_LABEL` (for example `ai:plan`) a worker run on an issue that ran out of iterations or time (`paused`, `stuck`, `timeout`) is not a case for the human: the ticket is probably too big, so the worker label comes off, `SPLIT_LABEL` goes on and a comment says why, and the planner splits it into slices. The planner and epic labels themselves are never sent there.
- **Mail only when a human is needed (`HUMAN_LOGIN`).** With `HUMAN_LOGIN=<forgejo login>` the comments that hand something to a human start with `@<login>`: a pull request that is approved and green but touches a protected path, a conflict, a failed merge, a pull request marked `BLOCKED_LABEL` (rounds used up, a review without a verdict) and, through the prompt, an epic whose closing review found gaps. Nothing else mentions him: not a merge, not a follow-up round, not a rejection the worker fixes. Forgejo mails a mentioned user when his setting (Settings, Account, E-mail notifications) is "only on mention"; for that the agents and ForgeHands have to act as a Forgejo user of their own, because Forgejo does not mail the **actor** of an action (as the human's own account a mention would send nothing). Without `HUMAN_LOGIN` the same comments are written without a mention.
- **Open pull requests are kept up to date (`UPDATE_BRANCHES`, default on; `BRANCH_UPDATE_DELAY_SECONDS`, default 60).** The webhook needs the event `push`; ForgeHands only looks at pushes to the **default branch** of an allowed repository (other branches and deletions are ignored, so its own updates and the agents' pushes cause nothing). After the default branch has been quiet for the delay it looks at the open pull requests from `ai/issue-<n>` that fell behind it (the `merge_base` of the pull request is not the new tip). What a rebase throws away is a review, so it acts only when it is cheap: a pull request with **neither an approval nor an OK review for its current commit**, **not marked `BLOCKED_LABEL`**, and with **no agent running on its issue** is brought up to date through Forgejo (`POST /pulls/<n>/update?style=rebase`, no agent involved); CI and the review then run on the new commit. An update changes the head commit, cancels the CI run in progress and starts the review over, so it is only done **where it is needed**: when the default branch changed a file since the merge base that the pull request changes too (compared through `/compare/<base>...<tip>` and `/pulls/<n>/files`; a rename counts, a failing call or a list that may be cut off counts as "touches"). Otherwise the pull request is left alone and the merge brings it up to date. It is also **postponed while CI is still running on the head commit** (looked at again after the delay) and happens **at most once per `BRANCH_UPDATE_MIN_INTERVAL_MINUTES`** (default 30) per pull request. Approved and reviewed pull requests are left alone: they merge as they are, and a conflict shows when the merge is tried. When the update answers 409 the branch **conflicts**: a route with `"on": "conflict"` (for example `"pr:conflict": {"profile": "<worker uuid>", "tier": "free", "max_iterations": 120, "on": "conflict"}`) starts a **conflict round** of the worker, once per tip of the default branch and counted against `MAX_ROUNDS`: rebase onto the default branch, resolve each conflict so that the purpose of the pull request stays and what the default branch brought in is kept, run the checks, push once with `--force-with-lease`, comment what was resolved. This is the one kind of run in which a rebase and a force push are allowed (the worker profiles say so). Without a conflict route, or with the rounds used up, the pull request gets `BLOCKED_LABEL` and a comment that mentions the human. Whatever the human (`HUMAN_LOGIN`) does on such a pull request, whether he sets a label or pushes a commit (its CI run names him), starts the rounds again: the rounds so far no longer count and `BLOCKED_LABEL` comes off, so that a pull request stopped for used-up rounds can go on after he looked at it. The block comes off for any cause (a review that ended twice without a verdict, an approval that was not trusted, a failed run), since a merge refuses while the label is on. Only him: an agent's events never reset the budget. Forgejo reports `mergeable: false` for a pull request titled `WIP:` even without a conflict, so that field is not used here; the update call is the test.
- **A directory of its own per run.** The prompt names the clone directory `<workspace>/<owner>-<repo>-issue-<n>` for the worker and adds `-review-<sha8>`, `-fix-<sha8>` or `-round-<delivery>` for the runs on the pull request, so that a review never tries to clone into the worker's checkout (a clone into an existing directory fails, and a review that gave up on it ended without a word); every prompt also says to delete a leftover directory and clone again.
- **A review that ends without a verdict is not silent.** When a review run ends and its pull request is still open, still at the reviewed commit and carries neither `APPROVED_LABEL` nor the changes label nor `BLOCKED_LABEL`, ForgeHands first runs the review once more (same commit, a new run; this does not count as a round). Only when that second run ends without a verdict too does it comment that the review ended twice without one and add `BLOCKED_LABEL`: a human looks, or pushes a commit to start the review again.
- The review only starts when the **combined commit status** is green (`GET /repos/<repo>/commits/<sha>/status`, state `success`), so a pending or failed second workflow holds it back; without `FORGEJO_URL` and `FORGEJO_TOKEN` ForgeHands cannot check and starts no review. The reviewer reads the issue and the diff, writes one comment with the evidence and adds the label `APPROVED_LABEL` (default `ai:approved`) or, if changes are needed, the label of the first `"on": "pull_request"` route (`ai:changes`), which starts the next round. It does not push or merge. A fix round counts as a round like a label round (`MAX_ROUNDS`); a review does not, and a fix or label round that pushes a new commit leads to a new CI run and so to a new review, until the rounds are used up.
- **Auto-merge.** `MERGE_POLICY` (JSON, per repository) lets ForgeHands merge the pull request of an agent issue once the label `APPROVED_LABEL` (default `ai:approved`, set by the reviewer or by you) is put on it: `{"owner/repo": {"deny": ["stacks/**", "compose.yaml"]}}`. It merges only when the pull request is open, from `ai/issue-<n>`, not marked `BLOCKED_LABEL`, mergeable, the combined commit status of its head commit is green and **none of its changed files (renames count with both names) matches a deny pattern**. Patterns: `*` within a folder, `**` across folders, a plain name is an exact path. Otherwise it leaves the pull request for a human (a comment names the protected paths) and removes the `WIP:` marker first, since approved and green ends the work in progress and Forgejo would not let the human merge it; a pull request that is not approved, red or blocked keeps its title. A repository **without an entry is never merged automatically**. The policy lives in ForgeHands' environment on purpose: a policy file in the repository could be changed by the very pull request it should restrain. A `WIP:` title (Forgejo refuses to merge it) is cleaned first; the merge uses `MERGE_METHOD` (default `merge`), is bound to the checked head commit (`head_commit_id`), deletes the branch and closes the issue. Needs `FORGEJO_URL` and `FORGEJO_TOKEN`; the webhook must send `pull_request_label`.
- A new round or review takes the label `APPROVED_LABEL` off the pull request first, so an approval never covers commits it has not seen.
- **Epics and the order of sub-issues** use Forgejo's own issue dependencies (the planner sets them; the issue page shows them). An issue that **depends on open issues waits** instead of starting (job status `waiting`) and starts when the last of them closes: ForgeHands reads `GET /issues/<n>/dependencies` when the label arrives, and the `issues` event with action `closed` makes it look at `GET /issues/<n>/blocks`. An **epic** (a label of `EPIC_LABEL`, a comma separated list, default `ai:plan,ai:close`) depends on all its sub-issues, so Forgejo itself refuses to close it while one is open (HTTP 412). When its last dependency closes, the route with `"on": "epic_done"` (name it freely, for example `"epic:done": {"profile": "<reviewer uuid>", "tier": "strong", "on": "epic_done"}`) starts a review of the epic: the reviewer checks every acceptance criterion against the default branch, writes **exactly one** comment with the evidence (no drafts, no deleting or rewriting afterwards: the first closing review spent its iterations on posting three versions and cleaning up) and closes the epic if all are met, otherwise leaves it open and names what is missing. It runs once per epic and needs `FORGEJO_URL`/`FORGEJO_TOKEN`; the webhook must send `issues` (including closed events). Without Forgejo access issues are not held back. **`ai:close`** is the label for an existing ticket that only needs that closing review: it has no route and starts nothing when set, no planner run; it counts at the moment the last dependency closes (give the ticket its dependencies first; a ticket whose dependencies are all closed already is not reviewed, there is no closing event left). `ai:plan` marks a ticket that is planned first and reviewed at the end.
- **Status.** In direct mode `GET /status` (page) and `GET /status.json` show per issue what ForgeHands knows from its ledger: the runs with kind, state, result, conversation id, cost, the pull request number, the rounds used (`n/MAX_ROUNDS`) and one line for the state (worker running, waiting for #n, follow-up round, fix after red CI, review, epic review, rounds used up, failed). It is read only, shows no event text but the issue title and is not authenticated, so it belongs behind the same internal reverse proxy as the webhook. It says nothing about Forgejo's side (the pull request itself); the labels `ai:approved`, `ai:changes` and `ai:blocked` on the pull request are that.
- `MAX_ROUNDS` (default 3) limits the follow-up rounds per issue. When they are used up ForgeHands starts nothing, comments on the pull request and adds the label `BLOCKED_LABEL` (default `ai:blocked`, created if missing). That needs `FORGEJO_URL` and `FORGEJO_TOKEN` in its environment, which direct mode has when they are listed in `AGENT_SECRETS`; without them it only logs.
- `OPENHANDS_API_KEY` is a backend key. Keep it out of the repository; give it to the container through its secret store.

## License

MIT (see LICENSE).
