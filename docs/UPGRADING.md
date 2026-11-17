# Upgrading from 0.3.x to 0.4.0

This page is for an operator who runs ForgeHands `v0.3.x` in direct mode (webhook mode has no breaking change). A 0.3.x setup starts on 0.4.0 and behaves as before once you have checked the three items under "Before you upgrade". Everything new is off or unchanged until you switch it on.

## Before you upgrade

1. **`TIER_WEEKLY_BUDGETS` is gone.** The weekly cost cap per tier no longer exists. If the variable is still set, ForgeHands logs `TIER_WEEKLY_BUDGETS is ignored, it was removed in 0.4.0` at start and carries on; runs of a tier are then no longer held back by accumulated cost. Remove the variable and, if you relied on the cap, use `max_budget` on the routes (it caps one run) and `MAX_RUNS_PER_HOUR` (the global guard).
2. **The ledger of v0.2.0 to v0.2.4 is no longer read.** A `jobs.json` written since v0.2.5 is `{"version": 2, ...}` and loads as before. A file that is a bare JSON array (the v0.2.0 to v0.2.4 format) now stops the start with `Invalid job store`. A 0.3.x ledger is already in the new format. If you still have an old file, start any v0.2.5 to v0.3.x release once, which rewrites it, then upgrade; or delete it and accept that the history, the seen labels and the rounds used are lost.
3. **Variables that are stricter or wider than before.**
   - `STATUS_TOKEN` is new; when set it must be at least 16 characters, otherwise the start fails.
   - `ALLOWED_REPOS`, `MERGE_POLICY` and `REPO_WEIGHTS` now accept paths with subgroups (`group/sub/project`) for GitLab. Every entry you had still validates; on Forgejo and Gitea a path with more than one slash never matches a repository.

Nothing else is required. In particular the default `VERDICT_SOURCE` is `comment`, the 0.3 behaviour. Set it explicitly if you want that to stay so whatever the defaults become:

```sh
VERDICT_SOURCE=comment
```

## What changed without a switch

These apply from the first start on 0.4.0:

- **An approved pull request on a protected path that conflicts** with the default branch gets a conflict round once the forge reports it as not mergeable, instead of waiting for a human who cannot merge it. The hand-over to the human is one comment (what is done, why a human, what the security review found) that waits for a security review still under way.
- **An iteration limit is not retried.** A run that reached its iteration limit ends as `max_iterations` (which `SPLIT_LABEL` sends to the planner) instead of being run once more.
- **Quota holds.** A tier out of quota is held back at most `QUOTA_HOLD_MAX_HOURS` (default 8; it was a fixed 6 hours), and a job is given up after `QUOTA_GIVE_UP_HOURS` (default 24) out of quota instead of after 12 attempts. Reset times given in words ("reset after 4h 12m") are read.
- **The status page** gains a summary above the ticket table and refreshes itself every 30 seconds.
- **The start logs a warning** when `STATUS_TOKEN` is not set: `/status`, `/status.json` and the new `/metrics` are then open to everybody who can reach the port.
- **The code moved**: `src/forgejo/` is now `src/forge/`. This matters only if you patch or script against the source.

## New features and their switches

| Feature | Switch | Default | Where to read |
| --- | --- | --- | --- |
| Gitea and GitLab as forges | `FORGE=gitea` or `FORGE=gitlab`; neutral names `FORGE_URL`, `FORGE_TOKEN`, `FORGE_WEBHOOK_SECRET` (the `FORGEJO_*` names keep working) | `forgejo` | README, Forge setup |
| Native reviews as the verdict, several approvals | `VERDICT_SOURCE=review` or `both`, `REQUIRED_APPROVALS`, `forgejo_token_secret` on review routes | `comment`, 1 | README, Reviewer accounts |
| Escalation of the last round to a stronger profile | `escalate_to` on a round route, `ESCALATE_FROM_ROUND` | off | README, Follow-up rounds and escalation |
| Dependency bot pull requests (Renovate) | `BOT_AUTHORS`, `BOT_BRANCH_PREFIXES`, `BOT_FIX_ROUNDS` | off | README, Dependency bot pull requests |
| Reminders for pull requests that wait for a human | `REMIND_AFTER_DAYS`, `REMIND_MAX`, `STALE_LABEL` | off | README, Reminders |
| Notifications of ForgeHands' own (SMTP, webhook, daily digest) instead of the forge's mail | `SMTP_*`, `NOTIFY_WEBHOOK_URL`, `NOTIFY_IMMEDIATE`, `NOTIFY_DIGEST`, `HUMAN_MENTION` | off | README, Notifications |
| Dry run | `DRY_RUN=1`, `DRY_RUN_REPOS` | off | README, Dry run |
| Token for the status page, summary, Prometheus metrics | `STATUS_TOKEN`, `GET /metrics` | open | README, Status page and metrics |

## Setting up reviewer accounts (optional)

If you want branch protection to see the reviews, move to native reviews. It needs a forge user per reviewer, so that the author of a pull request is not its approver. The short path, in full in README "Reviewer accounts":

1. Create the reviewer user and a token. Give it write access.
2. Add the token to `AGENT_SECRETS` under its own name and to the review route as `forgejo_token_secret`.
3. Set `VERDICT_SOURCE=both`, subscribe the webhook events for approved and rejected reviews, set the branch protection (required approvals, approvals whitelist, dismiss stale approvals) and add the reviewer logins to `ALLOWED_SENDERS` if you use it.
4. When every review route has its token, set `VERDICT_SOURCE=review`.

## Checking the upgrade

1. Set `DRY_RUN=1` for the first start. ForgeHands judges and logs every write but sends none (README "Dry run").
2. Open `/status` (with `STATUS_TOKEN` if you set one) and look at the summary and the queue.
3. Check `/healthz`, then remove `DRY_RUN` and restart.

A rollback to 0.3.x works: v0.3.10 loads a `jobs.json` written by 0.4.0 (including `dry` jobs and the new ticket fields) and starts with a 0.4 configuration, because it ignores the route fields it does not know (`escalate_to`, `forgejo_token_secret`) and the new variables. Checked with the code of both releases; not tried against a live forge. Two things to do first:

- **Take the reviewer tokens out of `AGENT_SECRETS`.** 0.3.x hands every entry of `AGENT_SECRETS` to every conversation; keeping a reviewer's token private to its route is a 0.4 feature. Left in, the worker would hold the reviewer's token too.
- Features you switched on, such as reviews by users of their own, bot pull requests, escalation or reminders, are not understood by 0.3.x and simply do nothing; with `VERDICT_SOURCE=review` the reviewer posts a native review, but 0.3.x looks for a verdict comment and a label, finds none and hands the pull request to a human after two reviews, so switch to `comment` (and the old reviewer prompt) before you roll back.

# Upgrading to 0.4.10: repositories without CI

A repository that has no workflow file never produces a CI run, so until now the pull request of an agent (or of a bot) there was never reviewed, never approved and never merged. From 0.4.10 the review starts without waiting for a green run in such a repository. Nothing else changes: **a repository that has any workflow file behaves exactly as before** (red, pending, and "no status yet" all keep waiting for the real run).

- **The switch is `REVIEW_WITHOUT_CI`, default `1`.** Set `REVIEW_WITHOUT_CI=0` to restore the old behaviour everywhere. Any other value stops the start with `REVIEW_WITHOUT_CI must be 0 or 1`.
- **How "no CI" is decided.** At the head commit of the pull request the commit has no commit status at all, and `.forgejo/workflows`, `.gitea/workflows` and `.github/workflows` (Forgejo's order; the first folder that exists counts) hold no `.yml` or `.yaml` file. ForgeHands reads that through the contents API. A forge that cannot be read starts no review.
- **Webhook events.** The review starts from the **Push** event you already send, and from **Pull request** events (opened, reopened, synchronized) for a pull request that is opened after its branch was pushed. If your webhook sends only the label event of pull requests, add the pull request events, or a branch pushed before its pull request exists is only reviewed with its next commit.
- **Merge.** `MERGE_POLICY` merges a pull request of such a repository on the approved review alone; the merge comment says `there is no CI in this repository` instead of `CI green`. Nothing is merged without `MERGE_POLICY` for the repository, as before.
- **Not covered.** GitLab (the switch has no effect there).
- **Rollback.** Set `REVIEW_WITHOUT_CI=0` (or go back to 0.4.9: it ignores the variable and never starts such a review).

# Upgrading to 0.4.11: a comment restarts a failed run

A comment of the operator (`HUMAN_LOGIN`) on an issue whose last run failed, or was handed to him, starts that run again, with the same label, and the run reads the comment. Until now such a run stayed failed until its label was taken off and put on again. README "Comments and earlier work" describes the rules.

- **The hook must deliver `issue_comment`.** Add the **Issue comment** event to the webhook of each allowed repository (Forgejo and Gitea). The reference installation's hooks already do. Without the event nothing changes.
- **Switches.** The feature needs `HUMAN_LOGIN`, which is off without it. `COMMENT_RESTARTS` (default `2`) caps the restarts per issue and label; `COMMENT_RESTARTS=0` switches the feature off. Any other value than an integer from 0 to 100 stops the start with `COMMENT_RESTARTS must be an integer between 0 and 100`.
- **What changes without a switch.** Nothing else. A comment on a pull request, an edited or deleted comment, and a comment of anybody else are ignored as before. The ledger gains a `dedupe` section (the ids of comments that restarted a run, and the notices sent); 0.4.10 ignores it.
- **Rollback.** Go back to 0.4.10: it ignores `issue_comment` events and the new ledger section, so comments no longer restart runs.
