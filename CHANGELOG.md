# Changelog

What changed in each release, from 0.4.0 on, taken from the commits. Behaviour that an operator has to act on is in [docs/UPGRADING.md](docs/UPGRADING.md).

## 0.10.0 (2026-11-26)

### Changed

- `ai:hold` stops every merge, not only a two-key one (see docs/UPGRADING.md)
- The ledger reads its file version: a ledger of a newer ForgeHands stops the start, and invalid entries are logged when they are dropped
- The dispatcher is split into one module per concern (no behaviour change)

### Fixed

- Let a fresh run take over when the label is set again while the last run is checked

## 0.9.24 (2026-11-26)

### Fixed

- Close the run's own blockers before a ticket, and leave e2e tickets to the suite

## 0.9.23 (2026-11-25)

### Fixed

- Start the epic review when the last sub-issue closed outside the normal path
- Filter the epic listing to open issues with the label

## 0.9.22 (2026-11-24)

### Fixed

- Revert a red default branch only when the failing check was green before the merge
- Rerun a flaky red check once before reverting

## 0.9.21 (2026-11-23)

### Fixed

- Comment and restart once when concurrent pushes see the same revert
- Take the status clock from the dispatcher, not Date.now
- Decide an epic whose replan run created no sub-issues

## 0.9.20 (2026-11-22)

### Added

- Link issues and pull requests to the forge
- Operator card under waiting for a human, links in the server status page

## 0.9.19 (2026-11-22)

### Fixed

- Ticket watchdog skips closed tickets and rotates its reads

## 0.9.18 (2026-11-22)

### Added

- Show the factory health signals on the dashboard
- Operator prerequisites wait for a human, not a worker

### Fixed

- Count the revert restart by its marker, not every run
- Hand a parent comment back and restart stalled tickets

## 0.9.17 (2026-11-20)

### Fixed

- An issue deleted in the forge leaves the status page

## 0.9.16 (2026-11-20)

### Fixed

- Say why an approved pull request is not merged, and sweep stranded approvals

## 0.9.15 (2026-11-20)

### Fixed

- Judge the cleanup's restore at the commit it wrote

## 0.9.14 (2026-11-20)

### Fixed

- Count a run from its start, and clean up what a closed ticket leaves behind
- A WIP title is not a merge conflict

## 0.9.13 (2026-11-19)

### Added

- Rules 1 and 4 advise, TICKET_PREFLIGHT_BLOCK picks the blocking rules

## 0.9.12 (2026-11-19)

### Fixed

- Stop rejecting workable tickets on code, versions and created files

## 0.9.11 (2026-11-19)

### Fixed

- The no-delivery notice names the escalation
- Blocks no longer hold back an answer to a planner
- Restore main in passes, judge the cleanup by the run's paths

## 0.9.10 (2026-11-18)

### Fixed

- Watch WIP-titled, revert and conflicting agent pull requests
- A worker that hands its ticket back by a comment is not a delivery
- An epic left open by its review goes back to the planner, then a human

## 0.9.9 (2026-11-18)

### Added

- File a check ticket for a NOT OK point that recurs
- Count the merges a revert undid, and alert above a revert rate

### Fixed

- Make scenario tickets pass the pre-flight and fail fast

## 0.9.8 (2026-11-18)

### Added

- Read the forge's check result and give it to the reviewer
- Reject broken worker tickets before a run starts
- Run end-to-end scenarios against a test repository after a deploy

## 0.9.7 (2026-11-18)

### Added

- A stuck agent pull request reaches a human, and the last round's NOT OK does too

### Fixed

- Read a pull request's branch from its head label once the branch is deleted

## 0.9.6 (2026-11-18)

### Fixed

- An issue run that finishes empty twice escalates before the human

## 0.9.5 (2026-11-18)

### Added

- Reopen and restart a ticket after its revert is merged

## 0.9.4 (2026-11-18)

### Added

- Improve ui

## 0.9.3 (2026-11-18)

### Added

- Start the review of a pull request head that has none

## 0.9.2 (2026-11-18)

### Fixed

- A same-files wait that closes a cycle is not taken
- The wait graph reads a done epic's dependencies from the forge

## 0.9.1 (2026-11-18)

### Added

- Delete the OpenHands conversations of old archived runs

## 0.9.0 (2026-11-18)

### Added

- A comment of the operator answers a planner without sub-issues

## 0.8.2 (2026-11-18)

### Added

- Hold a two-key merge for TWO_KEYS_HOLD_MINUTES
- Limit the merges through two keys per day
- Revert a merge of ForgeHands that turns the default branch red

### Fixed

- A ticket deleted in the forge drops its waiting and queued jobs

## 0.8.1 (2026-11-18)

### Fixed

- A timed out nudge is checked in the events, not resent blindly

## 0.8.0 (2026-11-18)

### Added

- Close the tickets the forge has closed without an event
- Leave closed tickets older than STATUS_HIDE_DAYS off the page
- Show the follow-up fixes after automatic merges
- A paused run is resumed, not split
- A paused run whose ticket was stopped is not resumed
- Nudge a worker run that explores without pushing a branch
- Say why queued work waits, and alert when nothing starts
- Count the tokens of finished runs per tier and repository

## 0.7.0 (2026-11-18)

### Added

- Clean finished clones and orphans, guard the disk

## 0.6.0 (2026-11-18)

### Added

- A comment on the parent counts as a worker delivery
- Continue a stuck or timed out run before a human is called
- A request for changes of the operator starts a round

## 0.5.1 (2026-11-17)

### Added

- Add live operations dashboard

## 0.5.0 (2026-11-17)

- Maintenance only.

## 0.4.11 (2026-11-17)

### Added

- A comment of HUMAN_LOGIN restarts a failed run

## 0.4.10 (2026-11-17)

### Added

- Review and merge a pull request in a repository without CI

## 0.4.9 (2026-11-17)

### Added

- BOT_REPOS limits dependency bot pull requests to some repositories

## 0.4.8 (2026-11-17)

### Added

- The mail as HTML with tables and links; a failed list that is up to date

## 0.4.7 (2026-11-17)

### Added

- Tell the human by a message of ForgeHands' own (SMTP, webhook, daily digest)

## 0.4.6 (2026-11-17)

### Fixed

- A ticket the forge refuses to close does not stop the sweep or repeat

## 0.4.5 (2026-11-17)

### Added

- A security review route can have a forge user of its own

## 0.4.4 (2026-11-17)

### Added

- Success per tier and closed tickets leave the waiting lists
- Hold tickets that touch the same files and close the pull request of a ticket sent to the planner

## 0.4.3 (2026-11-17)

### Added

- Two keys for selected protected paths

### Fixed

- Two keys need a second key the author cannot forge

## 0.4.2 (2026-11-17)

### Fixed

- No model available is treated like a used-up quota
- The pause for 'no model available' grows

## 0.4.1 (2026-11-17)

### Fixed

- A worker run that finishes without delivering is run once more

## 0.4.0 (2026-11-17)

### Added

- Resolve conflicts of approved pull requests; one clear hand-over
- Add a DRY_RUN mode that judges events but writes nothing
- Escalate the last round to a stronger profile before calling the human
- Review and merge dependency bot pull requests
- Fallback_to takes over a route whose tier is out of quota
- Remind the human of pull requests that wait for him
- Remind of blocked dependency bot pull requests
- Token auth and a throughput summary for the status page
- Prometheus /metrics endpoint
- FORGE=gitea, a Gitea variant of the Forgejo forge
- Native Forgejo reviews as the verdict, with a Forgejo user per reviewer
- Support GitLab as a forge (FORGE=gitlab)
- GitLab native reviews as verdict notes plus approvals

### Fixed

- An iteration limit is not an error to retry; wait for quota by time
- The run that hits the quota falls back at once; read reset times given in words

## Before 0.4.0

See the git history and the 0.3 to 0.4 notes in [docs/UPGRADING.md](docs/UPGRADING.md).
