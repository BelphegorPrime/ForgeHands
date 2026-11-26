# Contributing

Please open an issue before proposing large protocol changes. Keep the service dependency-free (Node's standard library only) and forge-neutral outside `src/forge/` and `src/webhook/`.

Read [AGENTS.md](AGENTS.md) first: it holds the rules of the project (zero runtime dependencies, erasable TypeScript, policy in the environment, untrusted forge text, code style, tests, commits and releases). It applies to people as much as to code agents. The README is the specification of the behaviour.

1. Fork this repository and make a branch (`feat/…`, `fix/…`, `docs/…`).
2. Add or change tests for the behaviour. Tests drive the real code with fake forge and OpenHands APIs.
3. Run `npm run typecheck` and `npm test`.
4. Update the README section of the behaviour you changed, and a new environment variable in `src/config.ts`, `src/types.ts` and a README table.
5. Open a pull request with `Closes #n`, explaining the behaviour and its security implications.

Do not submit logs containing webhook secrets, tokens, or private issue contents.

## Developing with a dry run

Run ForgeHands against a real test repository without letting it write anything: set `DRY_RUN=1` (and `DRY_RUN_REPOS=owner/repo` to keep other repositories live). Events are judged as usual, `/status` shows what would start, wait or merge, and every write is logged as `DRY RUN, not sent: ...`; a job that would start ends as `dry` with its first message in the ledger as `dry_prompt`. Reads still use your real tokens, so use a token of a throwaway user. See "Dry run" in the README for the limits.

```sh
cp .env.example .env     # uncomment the direct-mode block, set DRY_RUN=1
npm start
curl -s http://127.0.0.1:8080/status.json
```

The gate sits in the transport (`src/forge/index.ts`, `src/dry.ts`), below the forge implementations, so new code that goes through the `Forge` interface is covered without any work. Code that makes a request on its own would bypass it: do not add one.

## The agent modules

`Dispatcher` (`src/agent/dispatch.ts`) takes the events (`enqueue`, `onClosed`, `onComment`, `onReview`, `onBranchPush`, ...), runs the pass loop (`tick`, `pass`) and wires its collaborators. The work is done in one module per concern, and each module reaches the dispatcher through a narrow host type (`Pick<Dispatcher, ...>`), reading config, logger and fakes on every call:

| Module | Concern |
| --- | --- |
| `scheduler.ts` | which queued job starts next, limits and holds, quota cooldowns, starting a conversation |
| `run-watcher.ts` | polling a running conversation; continuing, escalating, retrying or reporting a run that ended |
| `delivery.ts` | what an ended worker or review run left behind (pull request, comment, verdict) |
| `wait-keeper.ts` | same-files waits and dependency cycles |
| `branch-refresh.ts` | bringing agent pull requests up to date when the default branch moves |
| `revert-keeper.ts` | `REVERT_ON_RED`, the reruns before a revert and the revert rate |
| `security-review.ts` | the second review of a protected path |
| `ticket-cleanup.ts` | closed and deleted tickets, archiving and deleting old conversations |
| `idle.ts` | the idle line, the idle state and the stall alert |
| `nudge.ts` | `NUDGE_AT_PERCENT` |
| `run-states.ts` | the run states and limits these modules share |

The older collaborators (`review-sweep.ts`, `epic-gaps.ts`, `preflight.ts`, `handback.ts`, `ledger-sync.ts`, `remind.ts`, `workspace.ts`, `merge.ts`) take their dependencies one by one. Hand-overs to a human still go through `markForHuman` (dispatcher) and `remark` (`merge.ts`). New behaviour goes into the module of its concern, or into a new one built the same way.

## Replay tests

`test/replay.test.ts` runs seeded random sequences against the real app and dispatcher in a small fake world (`test/helpers/world.ts`). The world is one repository on a fake Forgejo with issues, the agent pull requests of those issues (branch, head commit, commit status, labels, comments, merges that move the default branch) and a fake OpenHands. The sequences mix labels, comments, closes, agent pushes (plain code, files two keys may merge, or files that need the human), CI outcomes, review verdicts, security reviews, approvals, change requests, `ai:hold` on and off, ended conversations, passing time and restarts. Events reach ForgeHands as signed webhooks through `createApp`, as Forgejo sends them, and the review sweep runs as fake time passes.

After every step the test checks what must always hold:
- at most one active job per key
- a running job has a conversation
- a tier never runs more than its limit
- a merged pull request was approved and had a green head
- a merge over a protected path went through two keys: only `two_keys` files, the security OK of the merged commit, `TWO_KEYS_HOLD_MINUTES` after both keys agreed and after `ai:hold` came off, and never while `ai:hold` was on

At the end, once every pull request and issue is closed, nothing may be left active, held (no merge hold either), stuck or stalled. A restart in the middle of a sequence must end in the same ledger as the run without it.

A failure prints its seed and the list of steps. Replay one seed with `FUZZ_SEED=<n>`, and run more than the default handful with `FUZZ_SEEDS=<n>` before a change to the dispatcher or the ledger:

```sh
FUZZ_SEEDS=500 node --test test/replay.test.ts
FUZZ_SEED=760225 node --test test/replay.test.ts
```

A seed that found a bug becomes a named test at the end of the file, next to the fix. When a new invariant holds for the dispatcher, add it to `checkInvariants`. When ForgeHands learns a new kind of event, teach the generator in `steps()` and the fake world.

## The ledger file

`JobStore` (`src/store/jobs.ts`) reads and writes the ledger (`jobs.json`). Besides the jobs, every collection is one line in `COLLECTIONS`: its key in the file, its field on the store, what counts as a valid entry, and when an entry goes (after 30 days by a time field, while a job of its ticket is held, or kept until the code removes it). To add a collection, add its field and one line there. Invalid entries are logged and left out on load.

The file carries `version` (`LEDGER_VERSION`). A change that an older release would misread bumps the version and adds a step to `MIGRATIONS` that turns the old shape into the new one, with a test in `test/ledger-file.test.ts` that loads a file of the old version. A new field or collection that older releases simply ignore needs no new version.

## The forge interface

ForgeHands talks to a forge through one interface, `Forge` in `src/types/forge.ts`. The dispatcher, the merger, the reminders and the prompts use only that interface and never branch on the forge. It has two halves:

- **Webhooks in**: `webhookPath`, `verifyWebhook`, `eventName`, `deliveryId` and `normalizeEvent`, which turns a delivery into the one internal event shape (`issues.labeled`, `ci.failure`, `pull_request.review_approved`, a push, ...).
- **Operations out**: pull requests (`getPull`, `listPulls`, `pullFiles`, `compare`, `updateBranch`, `mergePull`, the work-in-progress title helpers), reviews (`listReviews`, `listReviewComments`, `submitReview`), commits (`commitStatus`, `commitTime`, `branchTip`), issues (`getIssue`, `closeIssue`, `dependencies`, `blocks`) and comments and labels. Each maps the forge's answer into the shapes of that file (`PullRequest`, `CommitStatus`, `Review`, ...). `agent(repository)` returns the API paths the prompts give the agent.

Every call goes through a `Transport`, one function per request. DRY_RUN stops writes there and API errors are counted there, so an implementation cannot write around either.

Existing implementations: `src/forge/forgejo/`, `src/forge/gitea/` (a variant of Forgejo's: only the webhook differs) and `src/forge/gitlab/` (its own). Read the closest one first.

### Adding a forge

1. Add the name to `ForgeKind` in `src/types/forge.ts` and to `FORGES` in `src/forge/index.ts`. `FORGE` is validated against that list in `src/config.ts`.
2. Write the implementation in `src/forge/<name>/index.ts`: a class that implements `Forge` (or extends the closest forge), its `AgentApi` paths, and, if the HTTP call differs (another auth header, another base path), its own transport that keeps the dry-run gate and the error counter. Map forge terms to the internal ones (GitLab's merge request is a `PullRequest`, a pipeline a `CommitStatus`).
3. Write the webhook normalizer in `src/forge/<name>/webhook.ts` if the payloads differ. Verify the signature or token in constant time, accept only the repositories of `ALLOWED_REPOS`, and never let a fork's branch count as an agent branch.
4. Wire it in `createTransport`, `createForge` and `agentApi` in `src/forge/index.ts`.
5. Add the event names the forge sends to `WEBHOOK_EVENTS` in `src/metrics.ts` (an unknown header value is counted as `other`, to keep the labels bounded).
6. Write `test/<name>.test.ts` with fixture payloads for every event, calls per path, the signature check, and the dry run gate; see `test/gitea.test.ts` and `test/gitlab.test.ts`, and the fake forge in `test/forge.test.ts`.
7. Document it in the README: a "<Name> setup" section (token, webhook and its events, what works and what does not), the row of "What works where", and the `FORGE` value in the Configuration table.

If the interface itself has to change (GitLab needed a `Subject` because it numbers issues and merge requests apart), change it for all implementations in `src/types/forge.ts` in the same pull request and keep the prompts of the other forges byte-identical.

## Reporting what is not forge-neutral

Some comments, error messages and metric names still say "Forgejo" where they mean the configured forge (for example `forgehands_forgejo_api_errors_total` and `FORGEJO_WEBHOOK_SECRET must be at least 16 characters`). Renaming a metric or a variable is a breaking change: open an issue before you do.
