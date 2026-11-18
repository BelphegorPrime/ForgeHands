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
| Cleaning of the OpenHands workspace and a disk guard (0.7.0) | `WORKSPACE_CLEANUP_DIR`, `DISK_WARN_PERCENT`, `DISK_MIN_FREE_GB` | off | README, Cleaning the workspace |
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

# Upgrading to 0.5.2: a comment on the parent delivers a run

A worker run on a ticket that blocks another ticket (its parent) now counts as delivered when the agent user comments on that parent, as it already did for a comment on the ticket itself. Before, such a run was run once more and then failed as `no_delivery`, and the parent waited for ever. README "A run that finishes without delivering is not done" has the rule.

- **No switch.** Nothing to set. The forge is read with two more calls: `GET /user` (once) and `GET /issues/<n>/blocks`. A failed read counts as no delivery, as before.
- **What you see.** The log says `<repo>#<n>: delivered as a comment on #<parent>` and the status page shows the run as done with that comment. ForgeHands does not close the ticket.

# Upgrading to 0.6.0: a stuck or timed out run is continued before a human is asked

**Behaviour change.** A run that ends `stuck` (OpenHands' stuck detection) or hits `MAX_RUN_MINUTES` used to hand its ticket or pull request to a human at once. From 0.6.0 ForgeHands first continues it, then escalates a round, and only then calls a human. README "Humans and failures" describes the three stages.

- **Stage A, resume (`RESUME_ATTEMPTS`, default `1`).** One message goes into the same conversation (the run stopped as `stuck` or `timeout`, do not repeat what was done last, take another approach, finish with a summary) and the run starts again on that conversation. A timed out run is paused first. Set `RESUME_ATTEMPTS=0` to switch it off; at most `5`. Any other value stops the start with `RESUME_ATTEMPTS must be an integer between 1 and 5`.
- **Stage B, escalate (`FAILURE_ESCALATE`, default `1`).** A round on a route with `escalate_to` that is still stuck, timed out or out of iterations starts once more on the profile of that route, once per head commit of the pull request, and not counted against `MAX_ROUNDS`. Set `FAILURE_ESCALATE=0` to switch it off. Any other value than `0` or `1` stops the start with `FAILURE_ESCALATE must be 0 or 1`.
- **Stage C, the human.** Unchanged, once A and B are used up or do not apply.

**What it costs and what it changes.**

- Each stuck run now costs one more OpenHands run on its conversation, and a round that escalates runs on the escalation profile (the stronger model, possibly with a higher cost). Point `escalate_to` only at a profile you trust for that repository, as before.
- An iteration limit (`max_iterations`) is not continued; a round that reaches it escalates at once, an issue run goes to `SPLIT_LABEL` as before.
- Quota holds, `ERROR_RETRIES`, the `no_delivery` re-run, comment restarts and `DRY_RUN` are unchanged.
- The ledger gains the fields `resumes`, `resumed_from`, `resumed_at`, `resume_pending`, `failure_escalation` and `escalated_after`. Version 0.5.1 ignores them.
- The metrics `forgehands_resumes_total{kind,state}` and `forgehands_failure_escalations_total` and the status page ("resumed", "escalated after stuck") are new.

**To keep the old behaviour** set both switches:

```sh
RESUME_ATTEMPTS=0
FAILURE_ESCALATE=0
```

**Rollback.** Go back to 0.5.1. A job whose conversation was continued when it went back is polled as before: its conversation state decides, and a stuck conversation goes to the human as 0.5.1 did. The unanswered run call of such a job (`resume_pending`) is not repeated by 0.5.1.
## Also in 0.6.0: a request for changes of the operator starts a round

In comment mode (the default `VERDICT_SOURCE=comment`) a formal request for changes of `HUMAN_LOGIN` on a pull request did nothing; the label `ai:changes` had to be set by hand. From 0.6.0 that request starts the changes round itself, as the label does.

- **The switch is `HUMAN_REVIEW_ROUNDS`, default `1`.** `0` restores the old behaviour. It needs `HUMAN_LOGIN`; without it the feature is off and the start logs nothing about it. Any other value than `0` or `1` stops the start with `HUMAN_REVIEW_ROUNDS must be 0 or 1`.
- **Webhook events.** The review events of the webhook must reach ForgeHands: **Pull request review approved**, **Pull request review rejected** and **Pull request review comment** (`pull_request_review_approved`, `pull_request_review_rejected`, `pull_request_review_comment`). The reference installation's hooks already deliver them: its Forgejo **Pull request** event expands to them, so nothing has to be added there. Without the events nothing changes.
- **ALLOWED_SENDERS.** The request is checked against `ALLOWED_SENDERS` like any rejection. If that is set, `HUMAN_LOGIN` has to be on it, or his review starts nothing.
- **What changes without a switch.** Nothing else. Reviews of anybody else are still ignored in comment mode, and with `VERDICT_SOURCE=review` or `both` the review path is the one of 0.5.1.
- **Rollback.** Set `HUMAN_REVIEW_ROUNDS=0`, or go back to 0.5.1, which ignores the review comment events and the new fields of the review event.

# Upgrading to the next version: a merged revert reopens and restarts its ticket

**New, on by default (`REVERT_RETRIES`, default `1`).** Until now a revert of a merge that turned the default branch red was started, but after it was merged nothing followed: the ticket stayed closed. Now, when the revert pull request is merged, ForgeHands reopens the ticket, comments once with the cause, and starts the worker again, once (see README, "After the revert").

- **What you see.** The ticket reopens and the worker runs again. The comment quotes the revert's own account of the failed step; the revert run now also writes that account into its pull request body. The counter `forgehands_revert_retries_total` counts the restarts. At the limit the ticket gets `ai:blocked` and the human is called.
- **Reopened tickets block their dependents.** A ticket that depends on the reopened one waits again. That is the intended order.
- **Needs push events.** The revert's merge is seen on the push to the default branch, so `UPDATE_BRANCHES` must not be `0`.
- **Caveat.** A revert that was merged before this version is not picked up: its record does not exist. Reopen such a ticket by hand, or leave it.
- **Rollback.** Set `REVERT_RETRIES=0`. The ledger gains `reverts`; the previous version ignores it.

# Upgrading to the next version: the review sweep starts the missing reviews

**New, on by default.** A pull request whose head never got a review (a lost or deferred event, or a round that ended without a new commit) used to wait for ever. Now every `REVIEW_SWEEP_MINUTES` (default `10`) ForgeHands starts the review of such a head, when its CI is green or absent.

- **What changes.** Some open pull requests get a review they did not get before. They go through the usual verdict, and an approved one merges as it always would. The first pass runs about 90 seconds after start, then every interval; at most 5 reviews a pass.
- **What to check.** The first pass logs one line per start (`<repo>#<n>: head <sha7> has no review, starting it`). A pull request you parked without a label, and that has no review on purpose, will now get one: set `BLOCKED_LABEL` or `ai:hold` on it, or set `REVIEW_SWEEP_MINUTES=0`.
- **Rollback.** Set `REVIEW_SWEEP_MINUTES=0`. Nothing else is written.

# Upgrading to the next version: the ledger is closed up, the status page hides old tickets

This is a feature release on top of 0.7.0 and nothing needs a change. Three things are new; each one is on by default and can be switched off.

- **`LEDGER_SYNC_HOURS`** (default `6`, `0` = off). The ledger reads the state in the forge of the tickets it holds as open and marks the closed ones closed, at most 60 reads a pass. On the first start a ledger with many dead tickets is worked off over several passes. Needs `FORGEJO_URL` and `FORGEJO_TOKEN`.
- **`STATUS_HIDE_DAYS`** (default `7`, `0` = hide nothing). Closed tickets older than that are left off `/status` and `/status.json`; `/status.json` gets `hidden` (their count) and `?all=1` shows them. The counters are not affected.
- **The follow-up figure in the digest** (`NOTIFY_DIGEST`): one line on the follow-up fixes after the automatic merges of 7 days. It is read from the forge, at most 120 calls a digest, and Forgejo and Gitea only. It is a quality figure, not a task for you.

## Also in 0.7.0: the workspace is cleaned up

Every OpenHands run clones the repository into its own directory below the workspace, and nothing removed them. On one host 35 GB sat in about 60 of them (mostly `node_modules`), the disk filled up, and the next deploy and the runs failed. From 0.7.0 ForgeHands can remove them itself and keep new runs from starting while the disk is nearly full.

- **The version.** This is a feature release, not a fix: it adds settings, a notification kind (`disk_full`), a field of the status JSON and a new behaviour (queued runs wait on low disk space). So it takes the minor number. The release commit sets it; the feature branch does not.
- **Off until you set it.** Nothing changes without `WORKSPACE_CLEANUP_DIR`. Mount the host directory of the OpenHands workspace into the ForgeHands container and set the variable to the mount point (README: Cleaning the workspace). The path must be absolute and not `/`; otherwise the start fails with a message that names the variable.
- **Check the permissions first.** OpenHands writes its clones as root; the ForgeHands image runs as `node`. A delete that the user may not make fails, is logged and is tried again every pass, so the disk keeps filling. Give the ForgeHands container a `user:` that may delete them, or check that the clones are owned by it.
- **Try it in a dry run.** Set `WORKSPACE_CLEANUP_DRY=1` first: the log then says `would be cleaned` for each directory and deletes nothing. Remove the variable when the list looks right.
- **Settings and their defaults.** `WORKSPACE_KEEP_HOURS` 12 (a finished run's clone), `WORKSPACE_KEEP_FAILED_HOURS` 72 (a failed run's, to look at it), `WORKSPACE_ORPHAN_HOURS` 48 (a clone no ledger job names), `DISK_WARN_PERCENT` 85 (one `disk_full` notification a day), `DISK_MIN_FREE_GB` 3 (no new run below it). `0` switches the two disk settings off.
- **What changes without a switch.** Nothing. The `disk_full` notification is sent whenever a channel is configured, without `NOTIFY_IMMEDIATE`, but only once the feature is on.
- **Rollback.** Unset `WORKSPACE_CLEANUP_DIR`. Directories already removed stay removed; nothing else is written.

# Upgrading to 0.7.1: a paused run is resumed, not split

**Behaviour change.** A run that ends `paused` used to count as a ticket that is too big: with `SPLIT_LABEL` the planner was asked to split it, and without it the human was called. An OpenHands restart pauses the runs that were going, so healthy tickets were split for nothing (openapi-generator #32 was split into two sub-tickets, a small ticket). From 0.7.1 a pause is an interruption: the run continues on its own conversation, and it is never split.

- **Pause resume (`PAUSE_RESUMES`, default `3`).** One neutral message goes into the conversation ("the run was interrupted ... continue from where you stopped ... end with the finish tool") and the run starts again, for every kind of run. Its budget is its own: stuck and timed out runs keep `RESUME_ATTEMPTS`, and the pauses do not use it up or the other way round. Set `PAUSE_RESUMES=0` to switch the resume off; a paused run then goes to the human (never to the planner). Any other value than an integer from 0 to 10 stops the start with `PAUSE_RESUMES must be an integer between 1 and 10` (`0` is the switch, the message does not mention it).
- **How to stop a run now.** Remove its trigger label from the ticket (for a round, from the pull request), or close the ticket. A paused run whose label is gone or whose ticket is closed is not resumed: it ends as `failed` with result `paused`, the log says `paused, the trigger label is gone: not resumed`, and nothing is written to the ticket. **`POST /api/conversations/<id>/pause` alone no longer stops a run**: ForgeHands resumes it, up to `PAUSE_RESUMES` times, and then hands it to the human.
- **Caveat for rounds.** The round prompt tells the agent to remove the trigger label as its last step. A pause that lands after that step (before the agent's finish) is therefore not resumed, because the label is gone; the run ends as `paused` and the human is called. Stop a round by removing the label, and check the pull request after a restart.
- **What you see.** The status page shows a run that is continued as "resumed". The metric `forgehands_resumes_total` counts the pause resumes under `state="paused"`. The job ledger gains `pause_resumes`.
- **Rollback.** Go back to 0.7.0. Its ledger loads with the new field ignored. A job that was resumed after a pause is then polled as 0.7.0 does: a paused conversation goes to the split or the human again.

# Upgrading to the next version: a run is nudged, a stall is reported, tokens are counted

This is a feature release on top of 0.7.1. Two of the three changes are on by default and change what a run does, so read the first item before you upgrade.

- **A worker that explores is nudged (`NUDGE_AT_PERCENT`, default `65`).** Measured on 60+ runs, 10 of the 12 worker runs that hit their iteration limit had pushed no branch. Once a worker run on an issue has used 65 % of its route's `max_iterations` and the forge shows no branch `ai/issue-<n>`, the conversation gets one message to stop exploring and push. Nothing else changes; a run that pushes in time never sees it. Set `NUDGE_AT_PERCENT=0` to keep the former behaviour. `NUDGE_MESSAGE` replaces the text.
- **Stalls are reported (`STALL_ALERT_MINUTES`, default `90`, `0` = off).** The log of a dispatch pass that starts nothing now says why work waits (the `idle:` line), `/status.json` has an `idle` field while it does, and the gauge `forgehands_idle_jobs{reason}` shows the same. The alert needs a channel and `NOTIFY_IMMEDIATE=stalled`, like `failed`; without `stalled` in that list nothing is sent.
- **Tokens are counted.** `forgehands_tokens_total{repository,tier,kind,type}` adds up the tokens of a run when its conversation ends, and each tier in `/status.json` has `tokens` for the last 7 days. Nothing to set. The cost stays what OpenHands reports, which is 0 for the gateway models.
- **The ledger** gains `nudged`, `nudge_settled`, `tokens` and `tokens_seen` on a job. A 0.7.1 release ignores them, so rolling back is safe.
- **Rollback.** Set `NUDGE_AT_PERCENT=0` and `STALL_ALERT_MINUTES=0` first, or go back to 0.7.1 directly.

# Upgrading to the version after 0.8.1: safety nets for merges without a human

This is a feature release on top of 0.8.1. It changes no default: the hold and the daily limit are off until you set them, and the revert needs a route of kind `main_red` before it starts a run. Without that route, `REVERT_ON_RED` (on by default) only comments on the merged pull request and tells you.

- **The hold (`TWO_KEYS_HOLD_MINUTES`, default `0`, `HOLD_LABEL`, default `ai:hold`).** A two-key merge can wait this many minutes after both keys agreed. The label stops it for as long as it is on. Nothing to change while it is off.
- **The daily limit (`TWO_KEYS_DAILY_LIMIT`, default `0`).** At most this many two-key merges per repository in 24 hours; the next one is handed to a human with the reason in the comment.
- **Revert on red (`REVERT_ON_RED`, default `1`, `REVERT_WINDOW_MINUTES`, default `120`).** A failed run of the default branch for a commit ForgeHands merged is read now; before, a failed push run was ignored. To use the revert, add a route `"on": "main_red"` to `LABEL_ROUTES`. Check it once with a real red push to the default branch: the failed run's event payload must carry the branch (`ref`), which ForgeHands reads to tell a push to the default branch apart. Set `REVERT_ON_RED=0` to keep the old behaviour.
- **Revert pull requests** (`ai/revert-<n>`) are handled as dependency bot pull requests: no ticket, no worker fixes them, `BOT_FIX_ROUNDS` decides whether a red run of one gets a fix round. Check that your reviewer accepts them.
- **The ledger** gains `holds` (the holds of two-key merges, per pull request) and `merges` (what ForgeHands merged: repository, pull request, branch, merge commit, time, two keys; kept 30 days). Version 0.8.1 ignores both fields, but it has no hold: a two-key pull request that was waiting for one merges at its next event there. Before you roll back, put `HOLD_LABEL` on the pull requests you want to keep.
- **Rollback.** Set `TWO_KEYS_HOLD_MINUTES=0`, `TWO_KEYS_DAILY_LIMIT=0` and `REVERT_ON_RED=0` first (and see the note on holds above), or go back to 0.8.1.

# Upgrading to the version after 0.8.0: the nudge waits for its answer in the background

**Fix.** On a real run the nudge's message timed out after the normal 10 seconds (a message to a running conversation answers after the agent's current step) and was lost. From this version the nudge has its own timeout, `NUDGE_TIMEOUT_SECONDS` (default `180`, 10 to 600), it is sent in the background, and a timeout is checked in the events before the message is sent again.

- Nothing to set. Any other value than an integer from 10 to 600 stops the start with `NUDGE_TIMEOUT_SECONDS must be an integer from 10 to 600`.
- Resume is unchanged: its messages keep the normal timeout.
- The log gains `nudge pending (timeout), checking the events` and `nudge confirmed in the events`. A nudge that never shows in the events is sent once more, then the run gets no further nudges (`the nudge was not delivered after 2 tries`).
- Rollback: go back to 0.8.0. A pending nudge in the ledger (`nudge_pending`) is ignored there.

# Upgrading to the next version: old conversations are deleted in OpenHands

**New, off by default.** Archiving tags a run, but OpenHands keeps the conversation on disk, so its data directory grows every day. `DELETE_AFTER_DAYS` (default `0`, off) lets ForgeHands delete the conversation of an archived run that ended that many days ago. Set `ARCHIVE_AFTER_DAYS` as well: only archived runs are deleted.

- **What is lost.** The trajectory and events of the deleted runs, in OpenHands. The ledger keeps every run with its result, cost and tokens, and the token and cost metrics stay.
- **Failed runs** may keep their conversation longer: `DELETE_FAILED_AFTER_DAYS` (default `0`, the same value). It must not be lower than `DELETE_AFTER_DAYS`.
- **Round size.** At most 40 deletions per hourly round. A large backlog goes down over a few rounds.
- **What you should check.** Whether OpenHands removes the conversation's directory on disk when it is deleted: compare `du -sh` of its data directory and the count at `/api/conversations/count` before and after the first round. The first round logs `conversations: N deleted, M kept`.
- **Rollback.** Set `DELETE_AFTER_DAYS=0`. Deleted conversations do not come back; the ledger and the status page keep working without them.

# Upgrading to the next version: a comment answers a planner

**Behaviour change.** A planner that asked its questions as comments and finished without sub-issues used to get no reaction to the operator's answers. Now a comment of `HUMAN_LOGIN` on such an issue starts the planner again (see README, "A comment answers a planner without sub-issues").

- **On by default** (`PLAN_ANSWER_RESTARTS`, default `5`, `0` switches it off). Nothing to set if the planner's prompt does not ask questions; a planner that finishes with sub-issues is never restarted.
- **Caveat.** A comment that arrives while the planner still runs starts nothing, as before. Answer once the run has finished.
- **What you see.** The log says `<repo>#<n>: <login> commented on a plan without sub-issues, running <label> again`; the counter `forgehands_plan_answer_restarts_total` counts it. At the limit one notice comment on the issue says so.
- **The webhook answer.** With `COMMENT_RESTARTS=0` a comment now reaches the dispatcher when `PLAN_ANSWER_RESTARTS` is on, so the webhook answers `comment_restarts_off` where it used to answer `ignored`. Nothing starts in either case.
- **Rollback.** Set `PLAN_ANSWER_RESTARTS=0`, or go back to the previous version. The ledger gains `plan_answer` on a job; the previous version ignores it.

# Upgrading to the version after 0.8.1: tickets deleted in the forge leave the queue

**Fix.** A ticket deleted in Forgejo kept its waiting jobs in the ledger: the dependency read answered 404 on every look, the log repeated the same line, and when its dependencies resolved a run would have started for a ticket that no longer exists. From this version a 404 of the ticket itself (not of its dependency list) drops its waiting and queued jobs.

- Nothing to set. The jobs end with status `deleted` and the ticket shows as `deleted` on the status page, in the closed list. No comment is written, no human is called and no mail goes out.
- Once per ticket the log says `<repo>#<n>: deleted in the forge, its waiting jobs are dropped`; the counter `forgehands_deleted_tickets_total` counts them.
- The ledger sync now also reads tickets with waiting or queued jobs (running ones are still left to their run), within its usual 60 reads a pass. A 404 of a dependency list alone changes nothing.
- Rollback: go back to 0.8.1. Jobs marked `deleted` are not waiting there, so they stay out of the queue.

# Upgrading to the version after 0.9.1: same-files waits no longer close cycles

**Fix.** With `WAIT_FOR_SAME_FILES=1` a ticket that shares files with an older one waited for it, and the older one could already wait for the newer one through an explicit dependency (a split epic and its children, a ticket that depends on the epic). Nothing in such a loop could start. From this version the same-files wait is skipped when the older ticket already waits for this one, and nothing else changes.

- Nothing to set. Skipped waits are logged once per pair (`not waiting for #m (same files): #m is blocked by this ticket (cycle)`) and counted in `forgehands_wait_cycles_broken_total`.
- An explicit dependency cycle (A depends on B, B on A) is never broken automatically. It is logged once (`dependency cycle: ...`), counted as the idle reason `cycle` (`/status.json` `idle.reasons.cycle` and `cycles`, gauge `forgehands_idle_jobs{reason="cycle"}`), and it now raises the stall notification (`STALL_ALERT_MINUTES`, sent when `NOTIFY_IMMEDIATE` names `stalled`), which names the tickets. Break it by removing one of the dependencies in the forge.
- Rollback: go back to 0.9.1. The same-files waits of the loop come back, and so do the deadlocks.
- The same-files check also reads the open dependencies of an epic whose job is done (its children are only in the forge): at most 40 such reads a pass, each ticket once per 10 minutes, so a pass costs a few reads at most. A failed read is taken as no dependencies.

# Upgrading to the version after 0.9.5: an issue run that delivers nothing is escalated once

**Fix.** A worker run on an issue that finished twice without a pull request or a comment went straight to the human, even when a stronger model was at hand. A route with `escalate_to` now gets one more try: after the second empty run a fresh run starts on the profile and tier of that route, on the same ticket. Only if that run is empty as well is the human called (`no_delivery`). A cheap model that claims a file cannot be read no longer costs a human a ticket.

- Nothing to set. The switch is `FAILURE_ESCALATE` (default 1; `0` restores the former behaviour). Routes without `escalate_to` behave as before.
- To use it, add `escalate_to` to an issue route in `LABEL_ROUTES`, for example `"ai:ready": {"profile": "<uuid>", "tier": "free", "escalate_to": "ai:escalate"}`. An issue route may now name `escalate_to`; the validation no longer refuses it (other route kinds still need a round route).
- The escalated run is shown on the status page as "escalated after no_delivery" and counted in the tier statistics under the target's tier (`escalated`); `forgehands_failure_escalations_total` counts it too. The second empty run is still counted as `finished` and, when it is the last one, as `no_delivery` (as before).
- Rollback: go back to the previous version, or set `FAILURE_ESCALATE=0`.

# Upgrading to the next version: stuck pull requests reach a human

**A fix and a new switch.** A pull request whose last allowed round ended with a NOT OK verdict, or whose round pushed nothing, could stand still for hours: the rounds were used up, nothing else looked at it, so no label and no mail came, and the tickets that waited behind it waited for ever. Two things change.

- **The last round is checked when it ends.** When the last round of `MAX_ROUNDS` ends and the head it left has a NOT OK verdict, the pull request gets `BLOCKED_LABEL`, the comment that mentions the human, and the notification (`NOTIFY_IMMEDIATE` with `blocked`). It used to happen only when a further round was asked for, which no event does after the last one. This is on at once and has no switch.
- **The stuck-PR watchdog (`STUCK_PR_MINUTES`, default `90`, `0` = off).** In each review sweep pass an open `ai/issue-<n>` pull request is blocked for a human when its rounds are used up (at once), or when its latest verdict says NOT OK, nothing is queued or running for its issue, and that has been so for `STUCK_PR_MINUTES`. Once per head and reason. A pull request waiting for its CI or its first review is not touched. The tickets that wait behind a blocked pull request show `waiting behind stuck #<n>` on the status page, with `blocked_by_stuck`, and count as `behind a blocked pull request` in the idle line and in `forgehands_idle_jobs{reason="stuck"}`.

- **What to check.** The first pass after the upgrade blocks the pull requests with rounds used up at once, and the ones with a NOT OK verdict once the grace has run from that first look; each gets one comment and one notification. A pull request you want to keep moving: remove `BLOCKED_LABEL` (it is eligible again after the grace) or push a commit. Pull requests you parked on purpose have `ai:hold` or `ai:approved`, which the watchdog leaves alone. The watchdog runs with the review sweep, so `REVIEW_SWEEP_MINUTES=0` switches it off as well. The review sweep reads at most 50 open pull requests per repository; a pull request beyond that page is not looked at by the watchdog.
- **Rollback.** Set `STUCK_PR_MINUTES=0`: no new blocks and no chain marks. The last-round check has no switch; to undo it, run the previous version. The ledger gains `stuck`, which the previous version ignores.

# Upgrading to the release with CHECKS_FROM_CI: checks from the forge

Review runs now get the forge's check result of their head as data (`ForgeHands check facts`), and a verdict of OK is not accepted while the head's check is a failure.

- **The switch is `CHECKS_FROM_CI`, default `1`.** Set `CHECKS_FROM_CI=0` to restore the old prompts and verdicts. Any other value stops the start with `CHECKS_FROM_CI must be 0 or 1`.
- **One extra read per review run and per verdict.** The commit status of the head is read again (one call), and a repository without a check report gets one more call for the workflow folder, as with `REVIEW_WITHOUT_CI`.
- **A failed head gets no OK.** A pull request whose head check failed is refused at the merge gate as `ci_not_green`, even with an approving review or a verdict comment. Before, the same refusal came from the merge gate's own CI check; the difference is that a review of such a head is no longer accepted either.
- **A repository without CI is reported once.** A notice (kind `checks`) per repository and process; it is sent only when `NOTIFY_IMMEDIATE` names `checks`. The review is not held back.
- **Not covered.** Check names come only from what the forge reports; step names of a failed job are not read. ForgeHands does not run the repository's check command; `.forgehands.yaml` is a planned format, see the README.
- **Rollback.** Set `CHECKS_FROM_CI=0`, or go back to the previous version (it ignores the variable).

# Upgrading to the next version: a ticket is checked before a worker starts

**A new check, on by default.** A broken ticket used to start a worker anyway, which then failed, and the reviewer kept sending the pull request back. Two of three stuck pull requests on 2026-11-18 came from a ticket whose acceptance command grepped for text that no longer existed, and another whose steps required a file that its file list forbade. Now ForgeHands checks a worker's ticket (an issue on a worker route, not a planner) before the run starts: the `Steps`, `Files` and `Acceptance` sections, and that the listed files exist. The rules and their details are in the README, [A ticket is checked before a worker starts](README.md#a-ticket-is-checked-before-a-worker-starts).

- **What changes for your tickets.** A ticket with no `Acceptance` section, or whose `Acceptance` has no fenced block with a command, now starts no run. A path named in `Steps` must be listed in `Files`, and a path listed in `Files` must exist on the default branch unless its line says `new`. Check your open `ai:ready` tickets before you upgrade: the ones that do not follow this shape will be sent back. The file list may use the heading `Exact files` (the one `WAIT_FOR_SAME_FILES` reads) instead of `Files`.
- **What happens to a broken ticket.** With `SPLIT_LABEL` set the ticket goes to the planner, with no mention. Without it the ticket gets `BLOCKED_LABEL` and the comment mentions `HUMAN_LOGIN`. Either way the trigger label comes off, and one comment names each violated rule. A ticket is commented once per revision: when you fix it, its title or body changes and it is checked and commented again; set the label again to start it.
- **Not checked yet.** The acceptance command is not run on the default branch to see that it fails there (that needs a checkout and a runner ForgeHands does not have). Rule 4 is not checked on GitLab.
- **Rollback.** Set `TICKET_PREFLIGHT=0`: tickets are not checked at all, as before. The ledger gains one `preflight:` mark per rejected revision, which the previous version ignores.

# Upgrading to the version after 0.9.7: an end-to-end suite (off by default)

**A new feature, nothing changes until you switch it on.** ForgeHands can run a suite of scenarios against a dedicated test repository: a ticket goes through its run, the pull request is reviewed and merged, a change that turns the default branch red is reverted and its ticket started again once. The scenarios clean up after themselves. The suite is described in [docs/e2e.md](e2e.md).

- Nothing to set: without `E2E_REPO` the suite is off, no endpoint answers runs (`/e2e/run` is `404`), and no metric or notification changes. `/status.json` has `"e2e": null`.
- To use it, prepare a dedicated test repository first (its own `ALLOWED_REPOS` entry, the worker label, the CI step of docs/e2e.md) and set `E2E_REPO`. Then `E2E_ON_START=1` runs the suite once per version after a start, and `POST /e2e/run` with `Authorization: Bearer <STATUS_TOKEN>` runs it on demand. Never point it at a repository with real work in it.
- The new gauge `forgehands_e2e_scenario_ok{scenario}` (1 held, 0 failed) appears after the first run. `failed` notifications need `failed` in `NOTIFY_IMMEDIATE`, as every other immediate kind.
- The result of the last run is kept in the ledger (`meta.e2e` in `jobs.json`). A version the ledger has a run for does not run again at a start, so an upgrade with `E2E_ON_START=1` runs the suite once, after which a restart of the same version runs nothing.
- The cleanup restores the default branch with commits (the forge's REST API cannot move a branch pointer): the test repository's history grows by a commit per changed file in each run, and CI runs on them. This is why the repository must be a test repository.
- Rollback: unset `E2E_REPO` (or go back to the previous version). The ledger's `meta.e2e` is ignored by the previous version.
