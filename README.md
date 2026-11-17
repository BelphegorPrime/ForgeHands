# ForgeHands

ForgeHands connects a git forge (**Forgejo**, **Gitea** or **GitLab**) to **OpenHands**. In **direct mode** it runs the whole loop from a labelled ticket to a merged pull request: it starts OpenHands conversations with the agent profile that belongs to a label, follows the pull request through CI, review, follow-up rounds and merge, keeps branches current, orders tickets by their dependencies and calls a human only when one is needed. In **webhook mode** (the original, simpler use) it only verifies, filters and re-signs Forgejo issue events for an OpenHands Automation custom webhook.

A small Node.js 26 service written in TypeScript (run by type stripping, no build step, no runtime dependencies).

> Status: in daily use, released as `v0.4.x`. Coming from `v0.3.x`? Read [docs/UPGRADING.md](docs/UPGRADING.md) first. Do not expose ForgeHands to the public Internet without TLS, network controls and monitoring.

In this document "pull request" also means a GitLab **merge request**, and "Forgejo" in a variable name (`FORGEJO_URL`, `FORGEJO_TOKEN`, `forgejo_token_secret`) is kept for compatibility and stands for the configured forge.

## Contents

- [How the loop works](#how-the-loop-works-direct-mode)
- [Run it](#run-it)
- [Forge setup](#forge-setup): [what works where](#what-works-where), [Forgejo](#forgejo-setup), [Gitea](#gitea-setup), [GitLab](#gitlab-setup)
- [Reviewer accounts](#reviewer-accounts-native-reviews)
- [OpenHands setup](#openhands-setup)
- [Configuration](#configuration)
- [Behaviour in detail](#behaviour-in-detail)
- [Status page and metrics](#status-page-and-metrics)
- [Dry run](#dry-run)
- [Security and limitations](#security-and-limitations)
- [Development](#development)

## How the loop works (direct mode)

1. A label on an issue starts a run with the agent profile of that label: `ai:plan` a **planner** (splits the ticket into sub-issues and sets their dependencies), `ai:ready` a **worker**, `ai:escalate` a worker on a stronger model. The names are yours; they are the keys of `LABEL_ROUTES`. An issue that depends on open issues waits until the last of them closes.
2. The worker opens a draft pull request from the branch `ai/issue-<n>` (title starts with `WIP:`, on GitLab `Draft:`).
3. The forge reports every finished CI run. A **red** commit starts a **fix round**; a **green** commit (all workflows) starts the **review**, and on protected paths also an advisory **security review**.
4. The reviewer gives its **verdict** for that commit, `Verdict: OK` or `Verdict: NOT OK` with evidence. Where the verdict lives depends on `VERDICT_SOURCE`:
   - `comment` (default): one comment, plus the label `ai:approved` or `ai:changes`.
   - `review`: the forge's **native review** (Approve or Request changes) from a user of its own, which branch protection can enforce and which can need several approvals (`REQUIRED_APPROVALS`).
   - `both`: either of the two.

   A request for changes (`ai:changes`, or a native rejection) starts the next **round** of the worker on the same branch.
5. An approval merges the pull request when the commit is green and **no changed file matches the repository's deny list** (`MERGE_POLICY`). Otherwise the pull request is handed to a human.
6. Rounds are limited by `MAX_ROUNDS`. A route can name a stronger profile with `escalate_to`: the **last round runs on that profile before a human is called**. Only after that, the pull request gets `ai:blocked` and a comment that mentions the human.
7. A human who does not answer is **reminded** (`REMIND_AFTER_DAYS`): blocked, protected-path and untouched pull requests get a comment with a mention, a few times, then a stale label.
8. When the last dependency of an epic closes, the epic is reviewed against the default branch and closed if its criteria are met.

**Dependency bot pull requests** (Renovate and similar, `BOT_AUTHORS`) join the loop at step 3 without a worker: a green commit is reviewed, an approval merges through the same `MERGE_POLICY`.

Everything outside step 1 needs `FORGE_URL` and `FORGE_TOKEN` (or their `FORGEJO_*` names). A route per label, the limits and the policy live in ForgeHands' environment, never in the repository: an agent's pull request cannot loosen the rules it is held to. `DRY_RUN=1` lets you watch all of this without a single write.

## Run it

Prerequisites: Docker with the Compose plugin, or Node.js 26+.

GitHub Actions tests every push and pull request and publishes multi-platform images (`linux/amd64`, `linux/arm64`) to `ghcr.io/belphegorprime/forgehands` with the tags `latest` (the `master` branch), `vX.Y.Z` (a Git tag) and `sha-<full commit sha>`. Pin a version tag in production. The workflow is [`.github/workflows/ghcr.yml`](.github/workflows/ghcr.yml); it publishes with the scoped `GITHUB_TOKEN`, no personal access token is needed. A new package may start private: switch it to public in GitHub, Packages, ForgeHands, Package settings, or log in to the registry with a token that has `read:packages`.

```sh
cp .env.example .env          # webhook mode is active; uncomment the direct-mode block for direct mode
docker compose up -d          # pulls the published image, does not build
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
```

`compose.yaml` binds the port to `127.0.0.1`. To accept webhooks from another host, use a secured reverse proxy and an explicit network policy. To run without Docker: `npm start`. To build a local image: `docker build -t forgehands:local .` and `FORGEHANDS_IMAGE=forgehands:local docker compose up -d`. Keep registry and webhook secrets out of committed files. The data directory (`DATA_FILE`, `JOBS_FILE`) is a volume in `compose.yaml`; the ledger in it is what survives a restart.

### Endpoints

| Endpoint | Mode | Auth | What |
| --- | --- | --- | --- |
| `POST /webhooks/forgejo` | both | HMAC signature | The webhook of Forgejo. `POST /webhooks/gitea` with `FORGE=gitea`, `POST /webhooks/gitlab` with `FORGE=gitlab`; only the path of the configured forge exists. |
| `GET /healthz` | both | none | `{"status":"ok"}`. |
| `GET /status` | direct | `STATUS_TOKEN` if set | HTML page: summary and tickets, refreshes itself every 30 seconds. |
| `GET /status.json` | direct | `STATUS_TOKEN` if set | The same as JSON. |
| `GET /metrics` | direct | `STATUS_TOKEN` if set | Prometheus text. |

See [Status page and metrics](#status-page-and-metrics) for what they show.

## Forge setup

### What works where

| | Forgejo | Gitea | GitLab |
| --- | --- | --- | --- |
| Webhook path, check | `/webhooks/forgejo`, `X-Forgejo-Signature` (HMAC-SHA256) | `/webhooks/gitea`, `X-Gitea-Signature` (HMAC-SHA256) | `/webhooks/gitlab`, `X-Gitlab-Token` (the secret itself, **weaker**) |
| CI events | `action_run_failure`, `action_run_success` | `workflow_run` (Gitea 1.25+, Gitea Actions) | `Pipeline Hook` of merge request pipelines |
| Native reviews (`VERDICT_SOURCE=review`) | reviews API | reviews API (same code path, see Gitea notes) | verdict **note** plus **approval** |
| Issue dependencies and epics | yes | yes | needs **Premium** (issue links `blocks`) |
| CI events of dependency bot pull requests | yes | **no** | yes, from the pipeline's user |
| Branch update (`UPDATE_BRANCHES`) | `POST /pulls/<n>/update?style=rebase` | the same | `PUT .../rebase`, polled |
| Merge | `MERGE_METHOD` | `MERGE_METHOD` | `squash` or the project's own setting |
| Subgroup paths in `ALLOWED_REPOS` | n/a | n/a | yes (`group/sub/project`) |

All three need the same from you: a **user of its own** for ForgeHands and the agents, a **token**, a **webhook per allowed repository** with the events below, and the **labels** you route (`ai:plan`, `ai:ready`, `ai:escalate`, `ai:review`, `ai:changes`, `ai:approved`; `ai:blocked` is created when missing). Give that user write access to the allowed repositories and no administrator rights. Its token is `FORGE_TOKEN`; for the agent it is handed over as `FORGEJO_TOKEN` (see `AGENT_SECRETS`).

A minimal direct-mode setup, the same on every forge but for `FORGE`:

```sh
FORGE=forgejo                      # or gitea, gitlab
FORGE_URL=https://git.example.com
FORGE_TOKEN=...                    # the ForgeHands user's token
FORGE_WEBHOOK_SECRET=...           # at least 16 characters, the same as in the webhook
ALLOWED_REPOS=team/app
OPENHANDS_API_URL=http://openhands:8000
OPENHANDS_API_KEY=...
AGENT_SECRETS=FORGE_TOKEN,FORGE_URL
LABEL_ROUTES={"ai:ready": {"profile": "<worker profile uuid>", "tier": "free"}}
```

Add `MERGE_POLICY`, the review and CI routes and the rest from [Configuration](#configuration) when you want the loop beyond the first run. Try it with `DRY_RUN=1` first.

### Forgejo setup

Create a **Forgejo** webhook per allowed repository (Settings, Webhooks):

- URL `https://YOUR-HOST/webhooks/forgejo`, content type `application/json`, secret = the exact `FORGE_WEBHOOK_SECRET` (never an empty one).
- Events. Webhook mode: **Issues**. Direct mode: **Issues** (including label changes and closed), **Pull request label**, **Actions run failure** and **success** (`action_run_failure`, `action_run_success`) and **Push**. With `VERDICT_SOURCE=review` or `both` also **Pull request approved** and **Pull request rejected** (see [Reviewer accounts](#reviewer-accounts-native-reviews)).
- Forgejo may not deliver to an HTTPS URL whose certificate comes from a private CA; a plain internal `http://` URL works (the payload is HMAC-signed).

For a clean division of rights, the Forgejo user of ForgeHands is not a person: its token is `FORGE_TOKEN`, it has write access to the allowed repositories and it is not an administrator. It authors the agents' pull requests.

### Gitea setup

Set `FORGE=gitea` (with `FORGE_URL`, `FORGE_TOKEN` and `FORGE_WEBHOOK_SECRET`; the agent still gets its secrets as `FORGEJO_URL` and `FORGEJO_TOKEN`). Gitea shares Forgejo's API, so everything above applies; only the webhook differs. Create a **Gitea** webhook (type Gitea) per allowed repository:

- URL `https://YOUR-HOST/webhooks/gitea`, content type `application/json`, secret = the exact `FORGE_WEBHOOK_SECRET`. ForgeHands checks `X-Gitea-Signature` (hex HMAC-SHA256 of the body) and reads `X-Gitea-Event` and `X-Gitea-Delivery`; Forgejo's headers and `/webhooks/forgejo` are not accepted on a Gitea setup.
- Events: **Issues** (Gitea reports label changes as `issues` with action `label_updated`), **Pull request** and **Pull request label** (`pull_request`), **Workflow run** (`workflow_run`, Gitea 1.25 or newer, needs Gitea Actions) and **Push**. A finished `workflow_run` (`conclusion` `failure` or `success`) becomes the same internal event as Forgejo's `action_run_failure` and `action_run_success`; cancelled and skipped runs are ignored. With `VERDICT_SOURCE=review` or `both` also the review events (approved, rejected): Gitea's review events go through the same code as Forgejo's, but the names of the checkboxes in Gitea's webhook form are not verified here.
- Verified against the Gitea source and webhook docs: merge (`Do`, `head_commit_id`), `POST /pulls/<n>/update?style=rebase` (409 on conflict), combined status, compare, pull files, issue dependencies and blocks, reviews, and the `WIP:` / `[WIP]` title prefixes (case-insensitive, and `mergeable` is false for them, as on Forgejo).

What does not work on Gitea:

- A dependency bot's pull request (`BOT_AUTHORS`) gets no review or fix round from CI: Gitea's `workflow_run` names the pull request only by number and branch, with no author. Label events of such a pull request still work.
- A CI event of a pull request carries no title or body; the agent reads the issue itself. Whether the pull request is still open is read from the API before a round starts.
- Only runs of a pull request or a push count, and a head branch in a fork never counts as an agent branch.
- Metrics count Gitea API errors under the `forgehands_forgejo_api_errors_total` series (one family).

### GitLab setup

Set `FORGE=gitlab` with `FORGE_URL` (the instance, for example `https://gitlab.example.com`), `FORGE_TOKEN` and `FORGE_WEBHOOK_SECRET` (the agent still gets its secrets as `FORGEJO_URL` and `FORGEJO_TOKEN`, and sends the token as `PRIVATE-TOKEN`). A pull request is a **merge request** everywhere, and its number is the `iid`. `ALLOWED_REPOS` takes the full project path, subgroups included (`group/sub/project`).

- **Token**: a personal, project or group access token with the `api` scope, for a user of its own with at least the Developer role (it comments, labels, rebases and merges), sent as `PRIVATE-TOKEN`.
- **Webhook** per allowed project (Settings, Webhooks): URL `https://YOUR-HOST/webhooks/gitlab`, **Secret token** = the exact `FORGE_WEBHOOK_SECRET`. Triggers: **Issues events**, **Merge request events**, **Pipeline events** and **Push events**. ForgeHands reads `X-Gitlab-Event` (`Issue Hook`, `Merge Request Hook`, `Pipeline Hook`, `Push Hook`) and uses the `Idempotency-Key` as the delivery id.
- **CI**: a finished pipeline (`status` `failed` or `success`) of a merge request becomes the same `ci.failure` / `ci.success` event as Forgejo's run events; cancelled, skipped and running ones are ignored. The combined status of a commit is derived from its pipelines (red wins, a running or manual one holds, a rerun replaces the older pipeline of the same source and ref). Use **merge request pipelines** (`rules: - if: $CI_PIPELINE_SOURCE == "merge_request_event"`): a plain branch pipeline names no merge request in the event.
- **Labels** are matched by name. GitLab's *scoped* labels are those with a double colon (`a::b`): two of the same scope replace each other. The default labels (`ai:ready`, `ai:approved`, ...) have a single colon and are ordinary labels, so they do not replace each other; do not give your own labels a `::` unless that replacement is what you want.
- **Draft** replaces `WIP:`: the titles `Draft:`, `[Draft]` and `(Draft)` count, and ForgeHands removes the marker before it merges an approved, green merge request.
- **Rebase** (`UPDATE_BRANCHES`) is `PUT .../rebase`, which runs in the background: ForgeHands looks at the merge request until it finishes and reads a failed rebase (`merge_error`) as a conflict. **Merge** is `PUT .../merge` bound to the checked head with `sha`; `MERGE_METHOD=squash` asks for a squash, every other value is the project's own setting (merge commit, semi-linear or fast-forward), because GitLab has no such parameter.
- **Webhook security**: GitLab sends the secret itself in `X-Gitlab-Token`, not an HMAC of the body. ForgeHands compares it in constant time (both sides hashed, then `crypto.timingSafeEqual`), but it is **weaker than the HMAC of Forgejo and Gitea**: a copy of one delivery (from a proxy log, say) lets anybody post any body. Keep the hop between GitLab and ForgeHands short and on TLS, and restrict who can reach the port. GitLab's newer signing token (`webhook-signature`, Standard Webhooks) is not used yet.

What does not work, or differs, on GitLab:

- **Dependencies need Premium.** Issue links of type `blocks` / `is_blocked_by` are a Premium feature. On Free (or when the call is refused) there are no dependencies: issues are not held back, `waiting for #n` and epic review by dependencies do nothing. Links into other projects are ignored.
- A dependency bot's merge request (`BOT_AUTHORS`) is recognised from the pipeline's user only: the merge request event does not name the author, so its label events (the approval) are ignored.
- Pipelines on a merged result run on a merge commit, not on the head of the merge request, and are dropped as stale. Use plain merge request pipelines.
- The event of a pipeline carries no merge request text; the agent reads it from the API. Issue events carry no comment count.
- **Native reviews** (`VERDICT_SOURCE=review` or `both`): GitLab's REST API has no review object and no "request changes". A review is a **note** that begins with `## Verdict: OK` or `## Verdict: NOT OK` and ends with `Commit: <sha>`, plus, for OK, the reviewer's **approval** (pinned with `sha`). ForgeHands reads the notes and the approvals: an OK counts only with the approval of its author, NOT OK is a request for changes, the newest note per reviewer wins, and the commit in the note must be the head (so an old approval does not survive a push). The agent prompt tells the reviewer to post exactly that. `approval` / `unapproval` events of the merge request trigger the check like Forgejo's review events (they come with **Merge request events**).
- The agent reads review comments from the merge request's discussions (`.../discussions`).
- Metrics count GitLab API errors under the `forgehands_forgejo_api_errors_total` series (one family).

## Reviewer accounts (native reviews)

With `VERDICT_SOURCE=comment` (the default) the reviewer agent works under the same user as everybody else and the verdict is a comment plus a label. With `review` or `both` the verdict is the forge's own review, and a forge refuses a review of one's own pull request: **each reviewer needs a user of its own**, different from the user behind `FORGE_TOKEN` that authors the pull requests. ForgeHands rejects a reviewer token that equals `FORGE_TOKEN` at start. This is what to set up, in order.

**1. A user per reviewer.** Create a forge user for the reviewer (for example `forgehands-reviewer`; a second reviewer is a second user). Give it write access to the allowed repositories as a collaborator or team member, because only an approval of someone who may approve counts: on Forgejo and Gitea ForgeHands accepts an approval only when the forge marks it `official`, which means write access and, with an approvals whitelist, being on it. On GitLab give it at least the Developer role. Not an administrator.

**2. A token for it.** Create an access token for that user and put it in ForgeHands' environment under a name of your choice, for example `REVIEWER_TOKEN`. It has to read the repository and write pull request reviews (on Forgejo and Gitea the repository scope with write access, plus issue write if the reviewer should also comment; on GitLab the `api` scope). The exact scope names differ between forge versions: if the first review fails with a 403, the call is logged and the run ends without a verdict.

**3. Hand it to the reviewer route only.** List the name in `AGENT_SECRETS` and refer to it from the review route with `forgejo_token_secret`:

```sh
REVIEWER_TOKEN=...                                   # the reviewer user's token
AGENT_SECRETS=FORGE_TOKEN,FORGE_URL,REVIEWER_TOKEN
VERDICT_SOURCE=review
LABEL_ROUTES={"ai:ready":   {"profile": "<worker uuid>",   "tier": "free"},
              "ai:changes": {"profile": "<worker uuid>",   "tier": "free", "on": "pull_request"},
              "ai:review":  {"profile": "<reviewer uuid>", "tier": "free", "on": "ci_success", "forgejo_token_secret": "REVIEWER_TOKEN"}}
```

The value of `REVIEWER_TOKEN` is handed to the conversations of that route only, as `FORGEJO_TOKEN`; no other conversation receives it, so the worker cannot approve its own pull request. Start fails with an error when the name is not an extra entry of `AGENT_SECRETS`, names `FORGE_TOKEN` or `FORGE_URL`, has the value of `FORGE_TOKEN`, sits on a route that is not `"on": "ci_success"`, or when `VERDICT_SOURCE=review` has a review route without it.

**4. A second reviewer (optional).** Add a second `"on": "ci_success"` route with its own profile, user and token, and set `REQUIRED_APPROVALS=2`. Each review route runs once per commit, in parallel:

```sh
REVIEWER_A_TOKEN=...
REVIEWER_B_TOKEN=...
AGENT_SECRETS=FORGE_TOKEN,FORGE_URL,REVIEWER_A_TOKEN,REVIEWER_B_TOKEN
REQUIRED_APPROVALS=2
# "ai:review-a": {..., "on": "ci_success", "forgejo_token_secret": "REVIEWER_A_TOKEN"},
# "ai:review-b": {..., "on": "ci_success", "forgejo_token_secret": "REVIEWER_B_TOKEN"}
```

**5. Subscribe to the review events.** Forgejo: webhook events **Pull request approved** and **Pull request rejected**. Gitea: the matching review events. GitLab: **Merge request events** (they carry `approval` and `unapproval`). ForgeHands acts on these events: an approval event asks for the merge and a rejection starts the next round, so without them a review is not noticed until some other event of the pull request arrives (not verified for every case).

**6. Branch protection** (Forgejo and Gitea: Settings, Branches, the default branch). It is the enforcement for humans and a second line for ForgeHands, which merges through the API:

- **Required approvals**: the same number as `REQUIRED_APPROVALS`. ForgeHands does not read it from the protection rule; keep the two equal.
- **Whitelisted users for approvals**: the reviewer users (and the humans who may approve). Only their approvals are `official`, so only those count for ForgeHands too.
- **Dismiss stale approvals**: on, so that a push takes the approvals back. ForgeHands ignores a review for any commit but the current head anyway.
- Make sure the user behind `FORGE_TOKEN` may merge under these rules (for example through the merge whitelist), otherwise a merge is refused by the forge and handed to a human.

On GitLab use the project's merge request approval rules the same way: required approvals as `REQUIRED_APPROVALS`, and remove approvals when commits are added.

**7. `ALLOWED_SENDERS`.** If it is set, add the reviewer logins. A rejection starts a round of the worker, so the reviewer who rejects must be allowed to steer it. An approval needs no sender check: it only asks ForgeHands to read the reviews, which decide.

How a review counts: per reviewer the latest review that is not dismissed, not stale and made for exactly the head commit; an approval needs a body of at least `MIN_REVIEW_CHARS` (evidence, not a click); the pull request is approved when `REQUIRED_APPROVALS` distinct users approve and nobody's current review requests changes. A human's approval in the web interface counts the same way, so write evidence there too.

**Migrating from comment to review mode.**

1. Create the reviewer user(s), tokens and the `AGENT_SECRETS` / `forgejo_token_secret` entries (steps 1 to 3). Subscribe the webhook events (5) and set the branch protection (6).
2. Set `VERDICT_SOURCE=both` first. A review route with a token now posts native reviews; one without keeps the comment and label. Either is accepted, a request for changes always wins, so nothing in flight breaks.
3. When every review route has its token, set `VERDICT_SOURCE=review`. From then on a label alone merges nothing.
4. To go back at any time, set `VERDICT_SOURCE=comment` (the default) and lower `REQUIRED_APPROVALS` to 1, which comment mode needs. The `forgejo_token_secret` fields stay valid: a review route keeps its own user, and the reviewer then writes a comment and sets the label again.

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

For OpenHands Cloud use `Authorization: Bearer $OPENHANDS_API_KEY`. Use the returned `webhook_url` as `OPENHANDS_WEBHOOK_URL` and configure an event automation for source `forgehands` and the keys `issues.labeled` and/or `issues.opened`. The agent prompts should treat issue text as untrusted input. In webhook mode ForgeHands holds no forge or LLM credentials and only the label `ai:ready` triggers a run; the outgoing payload is:

```json
{
  "type": "issues.labeled", "source": "forgejo", "action": "labeled",
  "repository": { "full_name": "team/app", "clone_url": "https://git.example/team/app.git", "html_url": null, "default_branch": "main" },
  "issue": { "number": 42, "title": "Add tests", "body": "Implement unit tests.", "html_url": null, "labels": ["ai:ready"] },
  "sender": { "login": "developer" },
  "delivery_id": "webhook-delivery-id"
}
```

Webhook mode verifies the signature of the incoming webhook (`X-Forgejo-Signature`, HMAC SHA-256 over the raw body), allows only listed repositories, signs the outgoing body with a distinct secret in `X-Signature-256`, keeps processed delivery IDs for seven days and fails closed on a wrong signature, invalid JSON, an oversized payload or an unlisted repository.

## Configuration

Every variable ForgeHands reads is listed here. A wrong value stops the start with a message that names the variable.

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `FORGE` | no | Which forge ForgeHands talks to: `forgejo` (default), `gitea` or `gitlab`. See [Forge setup](#forge-setup). |
| `FORGE_WEBHOOK_SECRET` (alias `FORGEJO_WEBHOOK_SECRET`) | yes | Incoming webhook secret, at least 16 characters. On GitLab it is the "Secret token". |
| `FORGE_URL` (alias `FORGEJO_URL`), `FORGE_TOKEN` (alias `FORGEJO_TOKEN`) | direct mode, for most features | API access of the forge user: merge, reviews, round limits, status checks, dependencies, branch updates, reminders. Without them ForgeHands only logs what it would tell the forge. Setting both names of a pair to different values is an error. In `AGENT_SECRETS` the neutral names reach the agent as `FORGEJO_URL` and `FORGEJO_TOKEN`. |
| `ALLOWED_REPOS` | yes | Comma separated full names, for example `team/app,team/api`; on GitLab with subgroups `group/sub/project`. |
| `OPENHANDS_WEBHOOK_SECRET`, `OPENHANDS_WEBHOOK_URL` | webhook mode | Independent secret (at least 16 characters) and complete URL of the OpenHands custom webhook. |
| `OPENHANDS_API_URL`, `OPENHANDS_API_KEY` | direct mode | Setting `OPENHANDS_API_URL` switches to direct mode; the key reaches the OpenHands backend. |
| `DATA_FILE`, `JOBS_FILE` | no | Delivery store (`./data/deliveries.json`) and issue ledger (`jobs.json` next to it). |
| `PORT`, `HOST` | no | Listening port (`8080`) and address (`0.0.0.0`). |
| `STATUS_TOKEN` | no | Direct mode: at least 16 characters. `/status`, `/status.json` and `/metrics` then need `Authorization: Bearer <token>` or HTTP basic auth with the token as password. Without it they are open and ForgeHands logs a warning at start. See [Status page and metrics](#status-page-and-metrics). |
| `DRY_RUN`, `DRY_RUN_REPOS` | no | `DRY_RUN=1` receives and judges events as usual but only logs every write; `DRY_RUN_REPOS=owner/repo,...` (each must be in `ALLOWED_REPOS`) limits it to those repositories and is an error without `DRY_RUN=1`. See [Dry run](#dry-run). |

Removed in 0.4.0: `TIER_WEEKLY_BUDGETS`. A start with it set logs a warning and carries on; `max_budget` of a route and `MAX_RUNS_PER_HOUR` are the cost guards now.

### Direct mode: routes, who may trigger, limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `LABEL_ROUTES` | required | JSON, route name to route: `{"ai:plan": {"profile": "<agent profile uuid>", "tier": "strong", "max_iterations": 80, "max_budget": 1.5}, "ai:ready": {"profile": "<uuid>", "tier": "free"}}`. Fields per route: `profile` (required), `tier` (default `default`), `max_iterations` (default 100), `max_budget`, `max_concurrent`, `on` (below), `escalate_to` (see [Follow-up rounds](#follow-up-rounds-and-escalation)), `fallback_to` (see [Humans and failures](#humans-and-failures)), `forgejo_token_secret` (see [Reviewer accounts](#reviewer-accounts-native-reviews)). The first label listed wins when an issue is opened with several. |
| `ALLOWED_SENDERS` | none | Comma separated logins that may trigger runs and steer agents through comments (else the sender of the label). Add the reviewer users when it is set. |
| `MAX_CONCURRENT`, `MAX_CONCURRENT_PER_TIER`, `MAX_RUNS_PER_HOUR` | 4, 2, 30 | Runs at once in total and per `tier`, and started runs per hour (a guard against runaway fan-out). The rest waits in the queue. |
| `REPO_WEIGHTS` | none | JSON, repository to weight, for example `{"owner/a": 2, "owner/b": 1}`; default weight 1. See [Scheduling](#scheduling). |
| `MAX_RUN_MINUTES` | 120 | After this long a run stops holding its slot; the conversation itself is not touched. |
| `AGENT_SECRETS` | none | Comma separated names of environment variables (for example `FORGE_TOKEN,FORGE_URL`) whose values are handed to every started conversation as secrets. OpenHands gives its saved secrets only to callers that pass them in the start request. The values stay in ForgeHands' environment, never in the ledger. A name claimed by a route's `forgejo_token_secret` goes to that route only. |
| `WORKSPACE_DIR` | `/projects` | Working directory of the conversations. |

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
| `MERGE_POLICY` | none | JSON, per repository deny lists for automatic merge. A repository without an entry is never merged automatically. See [Auto-merge](#auto-merge). |
| `MERGE_METHOD` | `merge` | `merge`, `squash`, `rebase`, `rebase-merge` or `fast-forward-only` (GitLab: only `squash` has an effect). |
| `APPROVED_LABEL`, `BLOCKED_LABEL` | `ai:approved`, `ai:blocked` | The reviewer's approval (comment mode) and the hand-over to a human. The label for changes is the first `"on": "pull_request"` route. |
| `VERDICT_SOURCE` | `comment` | Where the verdict comes from: `comment` (a `Verdict: OK` comment plus the approval label), `review` (the forge's own review) or `both`. `review` and `both` need `FORGE_URL` and `FORGE_TOKEN`; with `review` every `"on": "ci_success"` route needs `forgejo_token_secret`. See [Native reviews](#native-reviews-as-the-verdict). |
| `REQUIRED_APPROVALS` | 1 | With `review` or `both`: how many distinct reviewers must approve the head commit (1 to 20). Above 1 needs `VERDICT_SOURCE=review` or `both`. |
| `MIN_REVIEW_CHARS` | 300 | A review comment, or the body of an approving review, must be at least this long to count as evidence. |
| `APPROVAL_GRACE_SECONDS` | 90 | An approval label without a verdict comment is looked at once more after this long before it is taken off; `0` takes it off at once. |
| `MAX_ROUNDS` | 3 | Follow-up rounds per issue. (A dependency bot's pull request has its own limit, `BOT_FIX_ROUNDS`.) |
| `ESCALATE_FROM_ROUND` | `MAX_ROUNDS` | From this round on, a round route with `escalate_to` runs with the profile and tier of that route. At most `MAX_ROUNDS`. |
| `EPIC_LABEL` | `ai:plan,ai:close` | Labels that mark an epic. |

### Dependency bot pull requests

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_AUTHORS` | none | Logins of dependency bots (for example `renovate`, case-insensitive, a leading `@` is dropped). Their pull requests are reviewed and merged like agent pull requests. |
| `BOT_BRANCH_PREFIXES` | none | Optional comma separated head branch prefixes (for example `renovate/`); a bot's pull request must match one when set. |
| `BOT_FIX_ROUNDS` | 0 | Fix rounds per bot pull request after a red commit (1 to 100); `0` starts nothing on red. |

### Humans, failures, housekeeping

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUMAN_LOGIN` | none | Login mentioned in comments that hand something to a human (and only there). The agents need a forge user of their own: forges do not mail the actor of an action. |
| `REMIND_AFTER_DAYS` | `0` (off) | `1` to `365`: remind `HUMAN_LOGIN` of pull requests that wait for him, see [Reminders](#reminders). Needs `FORGE_URL`, `FORGE_TOKEN` and `HUMAN_LOGIN`. |
| `REMIND_MAX` | 3 | Reminders per pull request. |
| `STALE_LABEL` | none | Label added with the last reminder. |
| `ERROR_RETRIES` | 1 | Restarts of a run that ended in `error`; `0` switches it off. |
| `QUOTA_HOLD_MAX_HOURS`, `QUOTA_GIVE_UP_HOURS` | 8, 24 | Out of quota: hold a tier back at most this long at a time, and give a job up once its quota has been out this long. |
| `SPLIT_LABEL` | none | Label (for example `ai:plan`) that sends a ticket whose worker ran out of iterations or time to the planner. |
| `UPDATE_BRANCHES` | on | `0` switches off keeping agent pull requests current, see [Keeping pull requests current](#keeping-pull-requests-current). |
| `BRANCH_UPDATE_DELAY_SECONDS`, `BRANCH_UPDATE_MIN_INTERVAL_MINUTES` | 60, 30 | Quiet time of the default branch before pull requests are looked at, and the least time between two updates of one pull request. |
| `ARCHIVE_AFTER_DAYS` | 7 | Archive finished OpenHands conversations after this many days; `0` = off. |

## Behaviour in detail

### Labels and re-labelling

A label added to an existing issue arrives from the forge as an `issues` event with action `label_updated` that lists the current labels but not the added one. ForgeHands remembers the labels it last saw per issue (in the ledger, 30 days) and starts a run for a trigger label that is **new** compared with that. So `ai:escalate` works next to `ai:ready`, an issue can be run again by removing and re-adding its label, and unrelated labels are ignored. For an issue it has not seen it starts the first trigger label that never ran. The ledger keeps `repo#issue:label` to conversation id; the same label on an issue that still has a queued or running run starts no second one.

### Comments and earlier work

The issue text goes into the first message between markers and is marked as untrusted. The message tells the agent to read the comments of the issue first (the event carries their count, not their text) and to look for a pull request from the branch `ai/issue-<n>`: an open one is continued on the same branch (reviews, review comments and the conversation are read and answered, no second pull request), a branch without a pull request is reused, a closed or merged one ends the run with a comment. Only `ALLOWED_SENDERS` (else the sender of the label) may steer the agent through comments and reviews; anyone else is context only. Every run has a clone directory of its own (`<workspace>/<owner>-<repo>-issue-<n>`, plus `-review-<sha8>`, `-fix-<sha8>`, `-round-<delivery>`, `-security-<sha8>`), so a review never clones into the worker's checkout.

### Follow-up rounds and escalation

A route with `"on": "pull_request"` (for example `"ai:changes": {"profile": "<worker uuid>", "tier": "free", "max_iterations": 120, "on": "pull_request"}`) fires when its label is put on the pull request of an agent issue (head branch `ai/issue-<n>`; others are ignored). The run belongs to issue `<n>`: it checks out the branch, reads reviews, the conversation and the issue comments, fixes, pushes to the **same** branch, comments and removes the label so that the next round can be asked for with it. Labels of a pull request are kept apart from those of the issue with the same number. In comment mode the verdict is a label because a forge refuses a formal review of one's own pull request when agent and human share an account; in review mode a native request for changes starts the round instead (see below).

`MAX_ROUNDS` limits rounds per issue (fix rounds and conflict rounds count, reviews do not). When used up, ForgeHands starts nothing, comments and adds `BLOCKED_LABEL`. Whatever the human (`HUMAN_LOGIN`) does on such a pull request, setting a label or pushing a commit (its CI run names him), starts the rounds again and takes `BLOCKED_LABEL` off, whatever caused the block; agents' events never reset it. Stopping a run with `POST /api/conversations/<id>/pause` frees its slot at the next poll (the job ends as `failed` with result `paused`).

**Escalation: a stronger model before a human.** A round route (`pull_request`, `ci_failure`, `conflict`) may name `"escalate_to": "<another route>"`, for example `"ai:changes": {"profile": "...", "on": "pull_request", "escalate_to": "ai:escalate"}`. The last round (the `MAX_ROUNDS`-th, or from `ESCALATE_FROM_ROUND` on) then starts with the profile and tier of the target route, so a stronger model gets the last try before a human is called. Everything else stays: branch, kind, prompt, the iteration and budget limits of the own route, and it counts as a round. The tier limits and cooldowns apply to the target's tier. The job records `escalated` and `/status` shows it. A human action that resets the rounds resets the escalation. The target's own `escalate_to` is not followed (no chains). Without `escalate_to` nothing changes. The target's profile is the operator's choice in `LABEL_ROUTES`; the label itself is not needed, so no one can trigger it from an issue. Point it only at a profile you trust for that repository: the last round runs with whatever the target profile may do.

### CI events: fix round and review

The forge sends one event per finished CI run. A commit starts at most one run per kind, however many workflows it has. A **red** commit starts a fix round (reproduce, fix, push to the same branch, comment). A **green** commit starts the **review**, only when the **combined commit status** is green, so a pending or failed second workflow holds it back. A CI outcome starts nothing when the run was cancelled or skipped (Forgejo reports a replaced run as a failure; only `status: failure` counts), when its commit is no longer the head of the pull request, or when the commit has recovered meanwhile. While an agent still works on the issue the outcome is **kept, not dropped** (shown as "CI result kept") and judged when that run ends; a kept outcome older than `MAX_RUN_MINUTES` is dropped.

### The review

The reviewer reads the issue and the diff, checks against the issue's criteria and, for anything that talks to a system outside the repository, against reality (the counterpart's own description, a real read-only call), writes **one** verdict with the evidence. It neither pushes nor merges. In comment mode the verdict is a comment and `APPROVED_LABEL` or the changes label; a new round or review takes `APPROVED_LABEL` off first, so an approval never covers commits it has not seen.

**A label is not a review (comment mode).** Before a merge the pull request must carry a review comment for its current commit: written after that commit, at least `MIN_REVIEW_CHARS` long, with `Verdict: OK` or `Verdict: NOT OK` within its first 300 characters; the latest such comment decides, one from the reviewer or a human counts. Without one, or with a NOT OK latest, nothing is merged: the approval is taken off, the pull request gets `BLOCKED_LABEL` and a comment that mentions the human. A label that arrives a moment before its comment is looked at again after `APPROVAL_GRACE_SECONDS`. A review run that ends without a verdict is run once more (not a round); a second miss blocks the pull request.

### Native reviews as the verdict

With `VERDICT_SOURCE=review` (or `both`) the verdict is the forge's own pull request review. The reviewer submits `APPROVED` or `REQUEST_CHANGES` through the reviews API with `commit_id` set to the head commit and the evidence as the body (the same rules as the comment, `MIN_REVIEW_CHARS` applies to an approval's body) and sets no label. ForgeHands counts, per reviewer, the latest review that is not dismissed, not stale and written for exactly the head commit; an approval counts only when the forge marks the reviewer as one who may approve (Forgejo and Gitea: `official`). The pull request is approved when `REQUIRED_APPROVALS` distinct users approve and nobody's current review requests changes (a request for changes wins). The review events replace the label as the trigger: an approval asks for the merge, a rejection starts the next round of the worker (and the reviewer must be in `ALLOWED_SENDERS` if that is set; the rejection is checked against the reviews first). `both` accepts either a native review or a verdict comment with the label, but a current request for changes always wins; if the reviews cannot be read, `both` falls back to the comment. A route's reviewer prompt asks for a native review in `review`, and in `both` only for a route that has its own `forgejo_token_secret`.

A reviewer needs a user of its own, because the author of a pull request cannot approve it: see [Reviewer accounts](#reviewer-accounts-native-reviews) for the setup, branch protection and the migration. Limits: `REQUIRED_APPROVALS` is an environment variable only and is not read from branch protection; with several reviewers ForgeHands can tell that a verdict exists but not which reviewer is missing; reminders (`REMIND_AFTER_DAYS`) still look for the approval label only, so a pull request approved by native reviews alone is not reminded as "approved on a protected path".

### Auto-merge

`MERGE_POLICY` (JSON, per repository) lets ForgeHands merge the pull request of an agent issue once it is approved (`APPROVED_LABEL` with a verdict comment, or enough native approvals): `{"owner/repo": {"deny": ["stacks/**", "compose.yaml"]}}`. It merges only when the pull request is open, from `ai/issue-<n>`, not blocked, mergeable, the combined status of its head commit is green and **none of its changed files (renames count with both names) matches a deny pattern**. Patterns: `*` within a folder, `**` across folders, a plain name is an exact path. The merge uses `MERGE_METHOD`, is bound to the checked head commit, deletes the branch and closes the issue. A pull request on a protected path is left to a human, with **one** comment that mentions him and says what is done (commit approved, CI green), why a human (each matching pattern with its reason, see below, and the files), what the security review found and whether the forge reports a conflict. When a security review of that commit is still under way, the hand-over waits for it and is written when that run ends. Approved and green ends the work in progress, so the `WIP:` marker is removed first, because the forge would not let the human merge it. A reason per pattern is optional: `{"owner/repo": {"deny": ["infra/**"], "reasons": {"infra/**": "decides what is reachable from the internet"}}}`. The policy lives in ForgeHands' environment on purpose: a policy file in the repository could be changed by the very pull request it should restrain.

**A merged agent pull request closes its ticket.** After every push to the default branch ForgeHands closes the tickets whose agent pull request was merged into it (also by someone else, with a comment); the usual closed event then starts what waits for it.

### Dependency bot pull requests

For Renovate and similar bots. A pull request qualifies when its author is in `BOT_AUTHORS`, its head branch starts with one of `BOT_BRANCH_PREFIXES` (if set) and the branch lives in the repository itself (not a fork). A branch `ai/issue-<n>` is always an agent pull request. Every other foreign pull request is ignored. A qualifying one follows the review and merge policy of agent pull requests, without a worker:

- A **green** commit starts the review once per commit. The reviewer reads the changelogs between the old and the new version and checks breaking changes against the repository's usage, and is wary of what a bump adds beyond its purpose (install scripts, new network access, files outside the manifests).
- `Verdict: OK` plus approval merges through `MERGE_POLICY` (deny list unchanged, no issue is closed). ForgeHands checks the author against `BOT_AUTHORS` on the webhook and again on the live pull request at merge time.
- A review that finds a problem, without `BOT_FIX_ROUNDS`, sets `BLOCKED_LABEL` with a mention: no worker fixes a bot's pull request, a human decides. If the reviewer sets the changes label anyway, ForgeHands hands the pull request to the human.
- A **red** commit starts nothing unless `BOT_FIX_ROUNDS` is set; then fix rounds are counted per pull request against that limit.
- ForgeHands never updates a bot's branch (Renovate rebases itself).
- The ledger and `/status` list it as `owner/repo!pr<n>`; there is no ticket, so the "issue number" of such an event is the pull request number.
- Titles, descriptions and changelogs are untrusted text, like issue text, and the prompt says that release notes fetched from the internet are evidence, not instructions. Their CI outcomes are let in by `BOT_AUTHORS`, not by `ALLOWED_SENDERS`; label and review events still need an allowed sender (approvals excepted, see Native reviews).

Limits: on Gitea CI events of a bot's pull request are not recognised, on GitLab a bot's merge request is recognised from its pipeline only (see the forge sections).

### Security review for protected paths (advisory)

A route with `"on": "sensitive_review"` starts a second, security-minded review when a commit is green and a changed file matches the deny list of the repository's `MERGE_POLICY`: once per commit, next to the normal review, never a round. The run is read-only and posts one comment starting `## Security review: OK` or `## Security review: CONCERNS` that names the commit. It sets no label, approves and merges nothing. A run without that comment is started once more, then only logged; a failed run never blocks. The comment that hands a protected-path pull request to the human ends with what the security review found for that commit. Without the route nothing changes.

### Keeping pull requests current

With `UPDATE_BRANCHES` (the webhook needs push events) ForgeHands looks, after the default branch has been quiet for `BRANCH_UPDATE_DELAY_SECONDS`, at open pull requests from `ai/issue-<n>` that fell behind. An update changes the head commit, cancels the CI run in progress and throws a review away, so it acts only when it is cheap and needed: the pull request has neither an approval nor an OK review for its current commit, is not blocked, has no agent running on its issue, the default branch changed a file the pull request changes too (through compare and the pull request's files; a rename counts, an unclear case counts as "touches"), CI is not running on its head, and the last update was more than `BRANCH_UPDATE_MIN_INTERVAL_MINUTES` ago. Then the forge rebases it (no agent involved). An approved or reviewed pull request is not brought up to date (that would throw the review away), but when the forge reports it as not mergeable (reliable once the `WIP:` marker is gone, which approval removes) it gets a conflict round too, after which CI, the review and the security review run again; this matters for a protected-path pull request that waits for a human.

When the update reports a conflict (Forgejo and Gitea: HTTP 409) the branch **conflicts**: a route with `"on": "conflict"` starts a **conflict round**, once per tip of the default branch and counted against `MAX_ROUNDS`: rebase, resolve each conflict so that the purpose of the pull request stays and what the default branch brought in is kept, run the checks, push once with `--force-with-lease`, comment what was resolved. This is the only kind of run in which a rebase and a force push are allowed. Without a conflict route, or with the rounds used up, the pull request gets `BLOCKED_LABEL` and a mention. A pull request that was busy (an active run) when the default branch moved is looked at once when that run ends, so a conflict that arrived meanwhile is not forgotten. Forgejo reports `mergeable: false` for a pull request titled `WIP:` even without a conflict, so that field is not used; the update call is the test.

### Epics and the order of sub-issues

The forge's own issue dependencies carry the order (the planner sets them). An issue that **depends on open issues waits** (`waiting for #n`) instead of starting, and starts when the last of them closes: ForgeHands reads the issue's dependencies when the label arrives and again just before a worker starts (an edge may be added after the label), and the `issues` event with action `closed` makes it look at what the closed issue blocks. An **epic** (a label of `EPIC_LABEL`) depends on all its sub-issues, so the forge refuses to close it while one is open. When the last dependency closes, the route with `"on": "epic_done"` starts a review: the reviewer checks every acceptance criterion against the default branch, writes **exactly one** comment with the evidence and closes the epic if all are met, otherwise leaves it open and names what is missing. `ai:close` marks an existing ticket that only needs that closing review: it has no route and starts no planner run (give it its dependencies first). `ai:plan` marks a ticket that is planned first and reviewed at the end. Without forge access issues are not held back; on GitLab Free there are no dependencies (see GitLab setup).

### Scheduling

Within a repository, work on a ticket that has begun (a round, a review, a CI fix, a conflict round, an epic review) goes before a new ticket, so that what was started gets finished; then the **oldest ticket (lowest issue number)** that can start now goes first, not the one queued first. Between repositories the starts are shared by `REPO_WEIGHTS` (default weight 1; a higher weight means more of them): weights 2, 1 and 5 give 2 of 8, 1 of 8 and 5 of 8 of the starts while all three have work. The repository with the fewest starts per unit of weight among the last 50 started runs goes first; one with nothing that can start gives its share to the others. `MAX_CONCURRENT`, `MAX_CONCURRENT_PER_TIER` and `MAX_RUNS_PER_HOUR` stay global.

### Humans and failures

**Mail only when a human is needed.** With `HUMAN_LOGIN=<login>` the comments that hand something to a human start with `@<login>`: a pull request approved and green on a protected path, a conflict, a failed merge, a pull request marked `BLOCKED_LABEL`, a failed run, and, through the prompt, an epic whose review found gaps. Nothing else mentions him (not a merge, not a round, not a rejection the worker fixes). Forges mail a mentioned user whose setting is "only on mention", but not the **actor** of an action, so the agents and ForgeHands must act as a forge user of their own.

**A run that ends badly is not forgotten.** A conversation that ends in `error` is started once more after a minute (`ERROR_RETRIES`); a second end is final and is reported: on a pull request with `BLOCKED_LABEL` and a mention, on an issue with a comment that mentions the human. A run that reached its **iteration limit** (OpenHands reports `MaxIterationsReached` as an error) is not run again: it ends as `max_iterations`, because the same run would end the same way. With `SPLIT_LABEL` a worker run on an issue that ran out of iterations or time (`max_iterations`, `paused`, `stuck`, `timeout`) is not a case for the human: the ticket is probably too big, so the worker label comes off, `SPLIT_LABEL` goes on and the planner splits it. Planner and epic labels are never sent there.

**The model is out of quota.** When a run ends in `error` and its last events say it was a rate limit (the gateway mostly tells when the quota is back, `retry_after`), ForgeHands neither fails the job nor calls a human: it queues the job again and holds the whole `tier` of that route back until then (at least a minute, at most `QUOTA_HOLD_MAX_HOURS`; a reset time given only in words, such as "reset after 4h 12m" or "Resets in 2 days", counts too; 15 minutes when there is none). It gives the job up only when the quota has been out for `QUOTA_GIVE_UP_HOURS` in a row. The status page shows "model quota used up, ... tries again after HH:MM UTC". The hold lives in memory, so a restart means "try again now".

**Fallback route.** A route may name `"fallback_to": "<another route>"`. While the tier of the route is on a quota hold (see above) and the tier of the fallback route is not, a job of the route starts with the profile and tier of the fallback route instead of waiting, so work goes on with another model. Branch, kind, prompt and the iteration and budget limits stay those of the own route. For example `"ai:ready": {"profile": "<worker on cheap>", "tier": "cheap", "fallback_to": "ai:ready-free"}, "ai:ready-free": {"profile": "<worker on free>", "tier": "free"}`. The fallback route needs no label: nobody triggers it from an issue. Any kind of route may have a fallback, an escalated round falls back from the route it escalates to, and the fallback route must not have a `fallback_to` of its own (one hop). The tier limits apply to the fallback tier, and the job records `fell_back` (shown by `/status`). When a run of the fallback model ends in a rate limit too, that tier is held and the job is queued again; the next start decides afresh. Without a free fallback the job waits as before.

### Reminders

Humans forget pull requests that wait for them. With `REMIND_AFTER_DAYS=<n>` (off by default; needs `FORGE_URL`, `FORGE_TOKEN` and `HUMAN_LOGIN`) ForgeHands looks once a day, and once after a restart, at the open `ai/issue-<n>` pull requests of the allowed repositories (dependency bot pull requests only when marked `BLOCKED_LABEL`) and finds three kinds:

- marked `BLOCKED_LABEL`,
- approved and green on a protected path (left to the human),
- untouched: no run queued, running or waiting, and no activity for `n` days.

For each, if the last ForgeHands comment is at least `n` days old, it writes one comment that starts with `@HUMAN_LOGIN`, says why the pull request waits and since when, and counts (`ForgeHands: reminder i of k`). At most `REMIND_MAX` reminders per pull request; with the last one `STALE_LABEL` is added when set. A comment by `HUMAN_LOGIN` starts the count again and holds reminders back for `n` days; a human taking over also lifts `BLOCKED_LABEL`, which ends them. Waiting jobs whose dependencies are all closed (a lost close event) are started in the same pass instead of reminded. `/status` lists what waits for a human ("waiting for a human since <date>").

Design notes: the state lives in the forge's comments (reminders are recognised by their text), so nothing new is stored and a restart only empties the `/status` list until the next pass. A pass reads one pull request list per repository, examines at most 20 agent pull requests per repository and writes at most 10 reminders. The text is built from fixed strings, label names and dates, never from issue or pull request text, and only `HUMAN_LOGIN` is ever mentioned. The recognition of its own comments is by text prefix, so someone who can comment can fake one and only delay or use up the reminders of that pull request. Reminders under `DRY_RUN` are only logged.

### Housekeeping

Finished runs archive themselves (`ARCHIVE_AFTER_DAYS`): about once an hour ForgeHands adds the tag `archived=true` (other tags stay, so runs can still be found by `source`, `issue`, `pr`, `ci`, `epic`) to conversations that ended long enough ago, at most 20 per round. Archived runs stay in the ledger until it prunes them (30 days).

## Status page and metrics

Both are direct mode only, read only and served by the same port as the webhook.

**Authentication.** With `STATUS_TOKEN` set (at least 16 characters), `/status`, `/status.json` and `/metrics` answer `401` (with `WWW-Authenticate: Basic`, no ledger data) unless the request carries `Authorization: Bearer <token>` or HTTP basic auth with any user name and the token as password, so a browser can open the page. The comparison is constant time. Basic auth sends the token in base64 on every request: keep it behind TLS. `/healthz` stays open. Without `STATUS_TOKEN` all three are open and ForgeHands logs a warning at start; either way keep them behind the same internal reverse proxy as the webhook.

**`GET /status`, `GET /status.json`.** Per issue (and per dependency bot pull request) what the ledger knows: runs with kind, state, result, conversation id, cost, the pull request number, the rounds used (`n/MAX_ROUNDS`, with "escalated to <label>" when the last round ran on the stronger route) and one line for the state (worker running, waiting for #n, follow-up round, fix after red CI, review, security review, epic review, rounds used up, waiting for a human, failed). No event text but the issue title. The page refreshes itself every 30 seconds (a meta refresh, no script). A dry run shows a banner, and `/status.json` has `dry_run` with the repositories and the latest would-be writes.

**The summary** above the tickets (in `/status.json` under `summary`, per repository, for the last 7 and 30 days of the ledger):

| Column | Meaning |
| --- | --- |
| Merged (no human) | Tickets merged in the window, and how many of them ForgeHands merged without ever calling a human (merged by ForgeHands and never blocked). A merge by a human is noticed when the push to the default branch closes the ticket, so it counts as merged, never as without a human. |
| Blocked | Tickets that got `BLOCKED_LABEL` (an unreviewed approval, used-up rounds, a failed run, ...). |
| Split | Tickets sent to the planner by `SPLIT_LABEL`. |
| Median / p90 to merge | Time from the ticket's first run to its merge. |
| Rounds per merged | Follow-up rounds per merged ticket. |
| Review / error retries | Review runs started again for a missing verdict, and runs restarted after `error`, over the runs created in the window. |
| Cost | Sum of the runs' cost in the window. |

**`GET /metrics`.** Prometheus text format, written by hand, no dependency. Gauges from the ledger, read at scrape time: `forgehands_jobs{status,kind}`, `forgehands_jobs_waiting`, `forgehands_queued_jobs{repository}`, `forgehands_tier_cooldown_active{tier}`. Counters since start (in memory, they reset on restart): `forgehands_webhook_deliveries_total{event,result}` (result `accepted`, `ignored`, `duplicate`, `rejected_signature` or `failed`), `forgehands_runs_started_total{kind}`, `forgehands_runs_finished_total{kind,state}`, `forgehands_merges_total{repository}`, `forgehands_merge_refusals_total{reason}` (`protected_paths`, `no_valid_review`, `ci_not_green`, `not_mergeable`, `blocked`, `merge_failed`), `forgehands_blocks_total{reason}`, `forgehands_error_retries_total`, `forgehands_branch_updates_total`, `forgehands_branch_conflicts_total`, `forgehands_openhands_api_errors_total{class}`, `forgehands_forgejo_api_errors_total{class}` (the forge's API errors, whichever forge; class `network`, `4xx` or `5xx`), `forgehands_escalated_rounds_total`, `forgehands_reminders_total`, `forgehands_dry_run_writes_total`; and the histogram `forgehands_run_duration_seconds{kind}`. Labels come from known sets only (repositories of `ALLOWED_REPOS`, route kinds, tiers, fixed reasons), never issue numbers. A 404 from OpenHands is not counted as an error (a deleted conversation is a normal answer).

Point Prometheus at it with the token as bearer credential:

```yaml
scrape_configs:
  - job_name: forgehands
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/forgehands-token   # the STATUS_TOKEN
    static_configs:
      - targets: ['forgehands:8080']
```

## Dry run

`DRY_RUN=1` receives and judges events as usual and changes nothing. Use it to try a new setup, a new route table or a new forge against real repositories, and to develop locally.

- **Judged as usual:** scheduling, limits, dependencies, the merge policy, the verdict check. `/status` shows what would start, wait or merge.
- **Only logged:** every write to the forge (comments, labels, reviews, merge, branch update, title change, issue close) as `DRY RUN, not sent: <method> <repository>/<path> <body>`, every OpenHands call that is not a read, and in webhook mode the forward. A job that would start ends as status `dry` with the first message it would have sent kept in the ledger as `dry_prompt`; it holds no slot. Reads stay real, with the real tokens.
- **Narrowing it:** `DRY_RUN_REPOS=owner/repo,...` makes only those repositories dry and leaves the others live. Every entry must be in `ALLOWED_REPOS`, and it is an error without `DRY_RUN=1` (it would otherwise run live without a word). `DRY_RUN` takes `1` or `0`, nothing else.
- **Seeing it:** a warning at start, a banner on `/status`, `dry_run` in `/status.json` (repositories and the latest 200 would-be writes, in memory), and the counter `forgehands_dry_run_writes_total`.
- **Limits:** the dry job finishes at once, so concurrency over a run's duration is not simulated, and what depends on a write (a label that stays, an issue that closes) does not happen, so later events see the unchanged forge. The request body to OpenHands (it carries `AGENT_SECRETS`) is never logged, but `/status.json` shows up to 300 characters of would-be comment bodies: keep it behind `STATUS_TOKEN` or a proxy.

## Security and limitations

See [SECURITY.md](SECURITY.md) for the trust model in full.

- Issue, pull request and comment text is untrusted. ForgeHands never fetches repository URLs from events. In direct mode it holds the secrets named in `AGENT_SECRETS` and the backend key and hands them to the agents; keep `OPENHANDS_API_KEY` and the forge tokens out of the repository and give them to the container through its secret store.
- Restrict public access, use TLS termination, keep secrets out of logs and restrict outbound networking to your OpenHands and forge.
- A GitLab webhook is authenticated by a shared token in clear, not by an HMAC: weaker than Forgejo and Gitea, see GitLab setup.
- `STATUS_TOKEN` protects the status page and metrics; without it they are open.
- The delivery store and the ledger are local JSON files: **single instance only**. Use a shared atomic database before scaling out.
- Retries rely on the forge's retries or a manual redelivery. A failure after OpenHands accepted a webhook-mode request but before ForgeHands recorded it can cause a duplicate; configure OpenHands's `event_id_header` for defense in depth. There is no durable outgoing queue in webhook mode: if OpenHands is down the answer is HTTP 502.

## Development

```sh
npm test               # node --test, no dependencies to install for the service itself
npm run test:coverage
npm run typecheck      # tsc, needs `npm ci` for the dev dependencies
```

CI runs the tests and the type check on Node.js 26. See [CONTRIBUTING.md](CONTRIBUTING.md) (including how to add a forge and how to develop with a dry run), [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md).

## License

MIT (see LICENSE).
