# The end-to-end suite

The suite runs scenarios against a **dedicated test repository** through the same forge client ForgeHands uses. Each scenario is a short list of steps (create a ticket with a label, wait for a condition, assert on the forge, settle) and is carried out by the real ForgeHands instance: the ticket gets its run, the agent opens a pull request, the reviewer and the merge do what they do in production. The suite only watches, and cleans up afterwards.

It is **off by default**. Nothing runs until `E2E_REPO` names a repository, and a run needs the forge's API access (`FORGE_URL`, `FORGE_TOKEN`).

> **Never point `E2E_REPO` at a repository with real work in it.** A run creates tickets, closes them, closes the open pull requests it finds above its first ticket, deletes the `ai/issue-<n>` and `ai/revert-<n>` branches of its own numbers, and puts the default branch back to the tree it had at the start. Use a repository that exists only for this.

## Set up the test repository

1. **A repository of its own**, for example `team/forgehands-e2e`, with a default branch `main`, and its name in `ALLOWED_REPOS` (the webhooks of the forge must reach ForgeHands for it, like any other repository).
2. **Labels and routes** in `LABEL_ROUTES` as for any repository: the scenarios use the worker label `ai:ready`. The experimental scenarios also use `ai:escalate` (with `escalate_to` on `ai:ready`), `ai:blocked` and, for the conflict round, a route `ai:conflict` with `"on": "conflict"`.
3. **The forge user of ForgeHands** must be allowed to push to `main` (the cleanup puts the tree back with commits; see below). Do not protect `main` against that user.
4. **The CI step** (scenario `revert-on-red` needs it). The repository needs a workflow that fails on the default branch while the marker file `e2e/red.marker` exists. Put this in `.forgejo/workflows/e2e.yaml` (Gitea: `.gitea/workflows/`):

   ```yaml
   name: e2e-marker
   on:
     push:
     pull_request:
   jobs:
     marker:
       runs-on: docker
       steps:
         - name: Fail on the default branch while the red marker exists
           run: |
             # Only the default branch is judged: the pull request that adds the marker stays green, and its merge turns main red.
             if [ "$GITHUB_REF" = "refs/heads/main" ] && [ -f e2e/red.marker ]; then
               echo "e2e/red.marker exists on the default branch: failing on purpose"
               exit 1
             fi
   ```

   `runs-on` is the label of your runner; use the one your other workflows use. If your default branch is not `main`, change the `GITHUB_REF` comparison and the scenarios' `default` branch is still read from the repository. The workflow must run on every push, so that the merge commit of the marker gets a status.

   A repository without this step still runs scenarios 1, 3, 4 and 5; scenario 2 then fails at its `mergeCommit` wait (the merge is green).

5. **Nothing else** should write to the test repository while the suite runs. The cleanup assumes that the numbers above the first ticket of a run belong to the run.

## Run it

**After a version change (`E2E_ON_START=1`).** At each start ForgeHands compares its version with the version of the last e2e run in its ledger (`meta.e2e` in `jobs.json`). A different one, or none, runs the suite once in the background. A restart of the same version runs nothing. A run that ends with a failure is recorded too, so a broken scenario does not run again at every restart; run it on demand instead.

**On demand.** `POST /e2e/run` starts a run and answers `202` at once; a run already going answers `409`. The endpoint changes a test repository, so it is protected more strictly than `/status.json`:

```sh
curl -s -X POST -H "Authorization: Bearer $STATUS_TOKEN" http://forgehands.example:8080/e2e/run
```

- No `E2E_REPO`: `404` (there is no endpoint).
- `E2E_REPO` set but no `STATUS_TOKEN`: `403`. A run is not allowed without a token.
- Missing or wrong bearer token: `401`. The session cookie of the status page is **not** accepted here.

Watch the progress on `/status` (an "End-to-end" section) or `/status.json` (`e2e.running`, `e2e.last`).

## Scenarios

| Name | Experimental | What it shows |
| --- | --- | --- |
| `normal-delivery` | no | A ticket with `ai:ready` gets a pull request from `ai/issue-<n>`; the review verdict is `Verdict: OK`; the pull request is merged and the ticket closed. |
| `revert-on-red` | no | The ticket adds `e2e/red.marker`; the merge turns the default branch red; ForgeHands starts a revert (`ai/revert-<n>`); the revert is merged; the ticket is reopened with the cause comment (exactly one) and started again **once**; after a settle of three minutes it has no second restart. Ends with a green default branch. |
| `empty-runs` | yes | A worker that delivers nothing twice escalates once (`ai:escalate`), and then a human is called (`ai:blocked`). |
| `stuck-pull-request` | yes | A reviewer that keeps saying NOT OK on an unchanged head gets the pull request blocked (`ai:blocked`) by the stuck-PR watchdog, and it is not merged. |
| `conflict-round` | yes | Two tickets change the same file; after the first merge the second gets a conflict round (`ai:conflict`), exactly once. |

Scenarios 1 and 2 are deterministic on the repository above. Scenarios 3 to 5 depend on what the agents do; their `precondition` is in the definition (`src/e2e/scenarios.ts`) and says what the test ticket and the instance must look like. Their expectations (the names of the labels that mark the human hand-over and the conflict round) are **assumptions** that were not checked against a live instance: run them once by name (`E2E_SCENARIOS=empty-runs`) and adjust the definition if the label differs.

`E2E_SCENARIOS` names the scenarios to run, in order. Unset, every non-experimental scenario runs.

**Scenario tickets must pass the ticket pre-flight** (the README section "A ticket is checked before a worker starts"), whether or not `TICKET_PREFLIGHT` is on at the instance. A ticket that breaks a rule gets no worker: the planner splits it, the run goes elsewhere, and the scenario waits for a pull request that never comes from its branch. So every ticket body in `src/e2e/scenarios.ts` has a `## Files` section (exact paths, or marked `(new)`), a `## Steps` section that names only listed paths, and a `## Acceptance` section with a fenced command that the worker can run and that is deterministic for the scenario. A unit test runs every ticket body of every scenario, the experimental ones too, through the pre-flight and fails on a violation: a new scenario gets that check for free. A ticket of a scenario that the pre-flight rejects anyway fails the scenario at once with the reason `preflight_rejected` (the rule of the comment is in the reason), instead of at its timeout.

## Format

Scenarios are data, in the format of `src/e2e/format.ts`. A new bug becomes a new scenario: a list of steps and a predicate per check. Steps:

- `ticket`: creates an issue with a title and body, puts a label on it and names it (`as`). ForgeHands' route for the label starts a run.
- `wait`: polls a predicate until it holds, or until its `timeoutMinutes` (default: the rest of the scenario's time; a `findPull` wait defaults to 20 minutes, because a pull request that does not appear by then is a failed run). With `as` on a `findPull` wait it captures the number of the pull request it found. Every poll and every `assert` first checks the tickets of the run for the pre-flight rejection comment (`ForgeHands: the ticket breaks the pre-flight`): one that carries it fails the scenario with `preflight_rejected`.
- `assert`: checks a predicate once.
- `settle`: waits a number of seconds without asking anything, so that a late restart or merge shows up in the checks after it.

Predicates name a resource by `$name` (`$ticket`, `$pr`) and check one thing: `issue` (state, label, comment), `pull` (state, label, comment), `findPull` (a pull request from a head branch), `mergeCommit` (the commit status of the commit that merged a pull request), `branch` (the commit status of a branch; `default` is the default branch) and `runs` (how many runs ForgeHands started for an issue with a label, from its ledger). A `comment` check counts the comments that contain a text (`min`, `max`). A scenario that refers to a name no earlier step sets is refused at start.

## What the cleanup does

The cleanup runs whatever the scenario did (it is in a `finally`, after a failure, a timeout or a read error). In this order:

1. Pull requests **open** with a number above the first ticket of the run are closed.
2. The run's tickets are closed (a closed ticket stops its runs), and so is every other open issue above the first ticket: a planner that split a ticket leaves sub-issues with numbers above it, and a pull request that merges can leave them open. Issues and pull requests share one number space, so the walk goes up from the first ticket and ends after three numbers in a row that do not exist.
3. Branches `ai/issue-<n>` and `ai/revert-<n>` with `n` at or above the first ticket are deleted.
4. The default branch is put back to the tree it had when the scenario started. The forge's REST API cannot move a branch pointer, so every file that differs is written back (or deleted) by a commit of its own. The history grows by one commit per changed file, and each commit runs CI.

Step 4 runs in passes. After a pass the default branch is compared with the start again; a pass that left something (a commit that landed while it ran, a file the API refused) is followed by another, at most three passes with two seconds between them. What still differs after the last pass is then judged by the paths **the run touched**: the files that its pull requests and its branches (numbers from the first ticket on) change against the start commit.

- A difference in a path the run touched fails the cleanup. `cleanup_reason` names the paths (never their contents): `reset main: main still differs from <sha> in 1 file(s) of the run: e2e/red.marker`.
- A difference in a path the run did not touch is not the run's concern: the cleanup holds, and `cleanup_note` says what was left alone. Typical cases: a symlink or a change of the file mode (the contents API cannot write those), or a commit that landed after the last pass.

Each action is tried on its own: one that fails is listed in `cleanup_reason`. **The steps and the cleanup are judged apart.** `ok` (and `forgehands_e2e_scenario_ok`) says whether the steps held; `cleanup` (and `forgehands_e2e_cleanup_ok`) whether the cleanup held. A scenario whose steps held but whose cleanup failed is `ok: true, cleanup: failed`: the notification says so, and the log says "held, but the cleanup failed". Two runs in a row leave the repository as it was when their cleanups hold.

**What the first live run (ForgeHands 0.9.10) showed, and what the code does about it.** Both scenarios held their steps, and the cleanup failed with main still different from the start in 3 and 4 files. The code paths that produce such a result, and that are now handled, are: a single pass that let a commit landing during the restore stay (now: passes, see above); a path the contents API cannot read, which the restore skipped silently and which therefore stayed different (now: `readFile` throws for non-regular entries and for a file without content, so the restore reports it, and the touched-path rule decides); and a difference that the run did not cause at all (now: judged by the touched paths). The live repository was not inspected, so which of these happened there is not confirmed. To check it: list the open pull requests of the test repository with a number below the first ticket of the failed run (the cleanup does not close those), and look at the commits on main after the run's start for paths the run did not create. Leftovers of runs that were interrupted before their cleanup are in the start tree and are no difference at all.

## Results and reporting

- **The gauges**, per scenario, of the last run: `forgehands_e2e_scenario_ok{scenario="<name>"}` is `1` when its steps held and `0` when a step failed (a failed cleanup does not change it); `forgehands_e2e_cleanup_ok{scenario="<name>"}` is `1` when its cleanup held and `0` when not. Both absent until a run. The last run is kept in the ledger (`meta.e2e`), so a restart keeps them. A `scenario_ok 0` therefore always means a failed step; a `cleanup_ok 0` with `scenario_ok 1` means the test repository needs a look.
- **The status section**: `/status` shows an "End-to-end" section; `/status.json` has `e2e` (`repository`, `on_start`, `scenarios`, `version`, `running`, and `last` with each scenario's `ok` (the steps), `reason`, `failed_step`, `cleanup`, `cleanup_reason` and `cleanup_note`).
- **A notification** of kind `failed` for each failed scenario (and when the suite cannot run at all), naming the scenario, the reason and whether the cleanup held. It is sent only when `NOTIFY_IMMEDIATE` contains `failed` and a channel is set (SMTP or a webhook); the default of `NOTIFY_IMMEDIATE` is empty, so set it, like every other immediate notification of ForgeHands.
- The log names each scenario that failed, with its reason.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_REPO` | unset (off) | The test repository, `owner/name`, one of `ALLOWED_REPOS`. Needs direct mode and `FORGE_URL` / `FORGE_TOKEN`. |
| `E2E_ON_START` | `0` | `1`: run the suite once after a start whose version has no e2e run in the ledger. Needs `E2E_REPO`. |
| `E2E_SCENARIOS` | all non-experimental | Comma separated scenario names, run in the order given. Unknown names stop the start. |
| `E2E_TIMEOUT_MINUTES` | `90` | The time one scenario may take, cleanup not included (1 to 1440). |

## Forges

Forgejo and Gitea: yes (the fixtures the suite needs are implemented in `src/forge/forgejo`, Gitea inherits them). GitLab: no. Where the forge lacks them, `POST /e2e/run` answers `409` with `unsupported`, and a start with `E2E_ON_START=1` logs why it did not run.

## Limits and open points

- The suite cannot see the notifications ForgeHands sends (scenario 4's "block notified once" is not checked): it checks the forge and the ledger.
- Scenario 2's restart count comes from the ledger of the ForgeHands process the suite runs in, not from the forge. With a second ForgeHands instance on the same forge the count is not seen.
- Experimental scenarios 3 to 5 are not verified against a live instance; see their preconditions.
- A run of the suite is not a test of the agent's quality: the tickets are small, and a model that does not deliver fails scenario 1 for reasons that are not ForgeHands' bug. Read the reason before you blame the code.
- The `main` restore commits trigger CI on the test repository each time: that is the price of the REST-only cleanup.
