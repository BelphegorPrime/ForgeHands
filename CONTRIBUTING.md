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

## The forge interface

ForgeHands talks to a forge through one interface, `Forge` in `src/forge/types.ts`. The dispatcher, the merger, the reminders and the prompts use only that interface and never branch on the forge. It has two halves:

- **Webhooks in**: `webhookPath`, `verifyWebhook`, `eventName`, `deliveryId` and `normalizeEvent`, which turns a delivery into the one internal event shape (`issues.labeled`, `ci.failure`, `pull_request.review_approved`, a push, ...).
- **Operations out**: pull requests (`getPull`, `listPulls`, `pullFiles`, `compare`, `updateBranch`, `mergePull`, the work-in-progress title helpers), reviews (`listReviews`, `listReviewComments`, `submitReview`), commits (`commitStatus`, `commitTime`, `branchTip`), issues (`getIssue`, `closeIssue`, `dependencies`, `blocks`) and comments and labels. Each maps the forge's answer into the shapes of that file (`PullRequest`, `CommitStatus`, `Review`, ...). `agent(repository)` returns the API paths the prompts give the agent.

Every call goes through a `Transport`, one function per request. DRY_RUN stops writes there and API errors are counted there, so an implementation cannot write around either.

Existing implementations: `src/forge/forgejo.ts`, `src/forge/gitea.ts` (a variant of Forgejo's: only the webhook differs, plus `src/webhook/gitea.ts`) and `src/forge/gitlab.ts` (its own, plus `src/webhook/gitlab.ts`). Read the closest one first.

### Adding a forge

1. Add the name to `ForgeKind` in `src/forge/types.ts` and to `FORGES` in `src/forge/index.ts`. `FORGE` is validated against that list in `src/config.ts`.
2. Write the implementation in `src/forge/<name>.ts`: a class that implements `Forge` (or extends the closest forge), its `AgentApi` paths, and, if the HTTP call differs (another auth header, another base path), its own transport that keeps the dry-run gate and the error counter. Map forge terms to the internal ones (GitLab's merge request is a `PullRequest`, a pipeline a `CommitStatus`).
3. Write the webhook normalizer in `src/webhook/<name>.ts` if the payloads differ. Verify the signature or token in constant time, accept only the repositories of `ALLOWED_REPOS`, and never let a fork's branch count as an agent branch.
4. Wire it in `createTransport`, `createForge` and `agentApi` in `src/forge/index.ts`.
5. Add the event names the forge sends to `WEBHOOK_EVENTS` in `src/metrics.ts` (an unknown header value is counted as `other`, to keep the labels bounded).
6. Write `test/<name>.test.ts` with fixture payloads for every event, calls per path, the signature check, and the dry run gate; see `test/gitea.test.ts` and `test/gitlab.test.ts`, and the fake forge in `test/forge.test.ts`.
7. Document it in the README: a "<Name> setup" section (token, webhook and its events, what works and what does not), the row of "What works where", and the `FORGE` value in the Configuration table.

If the interface itself has to change (GitLab needed a `Subject` because it numbers issues and merge requests apart), change it for all implementations in the same pull request and keep the prompts of the other forges byte-identical.

## Reporting what is not forge-neutral

Some comments, error messages and metric names still say "Forgejo" where they mean the configured forge (for example `forgehands_forgejo_api_errors_total` and `FORGEJO_WEBHOOK_SECRET must be at least 16 characters`). Renaming a metric or a variable is a breaking change: open an issue before you do.
