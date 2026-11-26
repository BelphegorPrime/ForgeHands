# Security policy

Please do not disclose vulnerabilities in public issues. Contact the maintainers privately through GitHub's private vulnerability reporting if enabled.

## Deployment

The webhook endpoint accepts untrusted input and must be protected with TLS, an unguessable secret, and a network/host firewall. ForgeHands has no need for a Docker socket or any forge git-write token beyond the user it acts as. Only grant OpenHands permissions for repositories in scope. ForgeHands is a single instance (its ledger is a local file).

## Trust model

- **Text from the forge is untrusted.** Issue, pull request and comment text, bot changelogs and release notes go into prompts between markers and are labelled as data. Only `ALLOWED_SENDERS` (else the sender of the label) can steer an agent.
- **Policy is ForgeHands' environment, never the repository.** Routes, limits, `MERGE_POLICY`, `BOT_AUTHORS` and who may trigger are environment variables, so an agent's pull request cannot loosen the rules it is held to.
- **Only listed repositories** (`ALLOWED_REPOS`) are handled, and a head branch in a **fork never counts** as an agent or bot branch.

## Webhook authentication

- **Forgejo and Gitea** sign the body with an HMAC-SHA256 that ForgeHands checks in constant time. A copy of one delivery is useless for any other body.
- **GitLab with a signing token** (`FORGE_WEBHOOK_SECRET=whsec_...`, GitLab 19.0 and later) is checked like Forgejo: an HMAC-SHA256 over the delivery id, its timestamp and the body (Standard Webhooks), compared in constant time. A delivery more than five minutes old is refused, and the plain token is not accepted then.
- **GitLab with a secret token** sends the secret itself in `X-Gitlab-Token`. ForgeHands compares it in constant time (both sides hashed, then `crypto.timingSafeEqual`), but it is **weaker**: anybody who sees one delivery (a proxy log, a debugging tool) can post any body with it. Use a signing token where GitLab offers one. Otherwise keep the hop between GitLab and ForgeHands short and on TLS, restrict who can reach the port, and rotate `FORGE_WEBHOOK_SECRET` if it may have leaked.
- On a Gitea setup Forgejo's headers and path are rejected, and the other way round; only the path of the configured `FORGE` exists.
- The secret has to be at least 16 characters; keep it, the forge tokens and `OPENHANDS_API_KEY` out of the repository and out of logs.

## Status page and metrics

`/status`, `/status.json` and `/metrics` are read only and show the ticket titles, the pull request numbers, costs and counters. They are **open unless `STATUS_TOKEN` is set** (at least 16 characters; the start logs a warning without it). With it they need `Authorization: Bearer <token>` or HTTP basic auth with the token as password, compared in constant time. Basic auth sends the token in base64 on every request, so keep the port behind TLS. A refused request is `401` with no ledger data. `/healthz` stays open. In a dry run `/status.json` also shows up to 300 characters of each would-be write (a comment text, say).

## Reviews and approvals

- With `VERDICT_SOURCE=comment` a verdict comment of anybody who can comment counts (the latest one for the head commit, at least `MIN_REVIEW_CHARS` long). Use `review` where that is too loose.
- With `review` or `both`, **an approval counts only from a user the forge lets approve** (Forgejo and Gitea: `official`, which means write access and, with an approvals whitelist, being on it), only on the **exact head commit**, and only with an evidence body of `MIN_REVIEW_CHARS`. A stranger's, stale or dismissed approval counts for nothing, and the author of a pull request cannot approve it. A current request for changes always wins. On GitLab the verdict is a note plus the author's approval pinned to the commit.
- **The reviewer's token is isolated per route.** A token named by `forgejo_token_secret` is handed to the conversations of that route only, as `FORGEJO_TOKEN`; every other conversation, the worker included, does not get it. It must differ from `FORGE_TOKEN`, so the author of a pull request is never its reviewer.
- Branch protection (required approvals, an approvals whitelist, dismissing stale approvals) is the enforcement for humans and a second line for ForgeHands. `REQUIRED_APPROVALS` is not read from it; keep the two equal.
- An approval event only asks ForgeHands to read the reviews, so it needs no allowed sender. A rejection starts a round, so its sender must be in `ALLOWED_SENDERS` (if set) and the reviews must confirm it.

## Dependency bot pull requests

`BOT_AUTHORS` is the operator's list of bot logins, checked on the webhook and again on the live pull request before a merge. A pull request qualifies only with an author on the list, a head branch with a listed prefix (if `BOT_BRANCH_PREFIXES` is set) and a head in the repository itself. **The CI outcome of a bot's pull request is let in by `BOT_AUTHORS`, not by `ALLOWED_SENDERS`**, because the run's trigger user is the bot or whoever re-ran CI; label and rejection events still need an allowed sender. The title, description and changelogs of such a pull request are untrusted text from the internet, fenced like issue text. A merge still needs a verdict for the current commit, a green status and no protected path.

## Dry run

`DRY_RUN=1` only ever reduces what ForgeHands does: the gate sits in the lowest write path of the forge and OpenHands clients, so a new caller cannot go around it. Reads still use the real tokens. The OpenHands request body, which carries `AGENT_SECRETS`, is never logged.

## What the agents can do

Agents hold the secrets named in `AGENT_SECRETS`. `escalate_to` and `fallback_to` start a run with the profile of another route that only the operator can choose in `LABEL_ROUTES`: point them at profiles you trust for that repository.
