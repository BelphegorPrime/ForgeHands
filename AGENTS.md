# AGENTS.md

ForgeHands is a Forgejo ↔ OpenHands bridge: a small Node.js 26 service in TypeScript, run by type stripping. The README is the specification: "How the loop works" and "Behaviour in detail" describe what the code must do. Read the section for the behaviour you change before you touch it.

## Rules of the project

- **Zero runtime dependencies.** Use only Node's standard library (`fetch`, `node:crypto`, `node:test`, `node:fs`). A feature that seems to need a package gets written by hand, small, such as the glob matcher in `src/forgejo/glob.ts`.
- **Erasable TypeScript only.** Node strips the types and runs the files as they are; nothing is built. `tsconfig.json` enforces `erasableSyntaxOnly`: use `type`, `interface` and plain classes, and import with the `.ts` extension. Enums, namespaces and constructor parameter properties are not erasable, so they are out.
- **Policy lives in ForgeHands' environment, never in the repository it acts on.** Routes, limits, `MERGE_POLICY` and who may trigger are environment variables. A file in the target repository could be changed by the very agent pull request it should restrain.
- **Text from the forge is untrusted input.** Issue and pull request text, comments and bot changelogs go into prompts between markers and are labelled as data. Only `ALLOWED_SENDERS` (else the sender of the label) can steer an agent.
- **A human is mentioned only when one is needed** (`HUMAN_LOGIN`). Every new hand-over goes through the existing helpers (`markForHuman`, `remark`) so this stays in one place.
- **Network calls are best effort.** A failed Forgejo or OpenHands call is logged and the tick goes on. The ledger (`src/store/jobs.ts`) is the state that survives a restart, so anything that must outlive one belongs there.

## Code style

- Comments explain *why* in one or two plain English sentences above the function or branch. The existing comments in `src/agent/dispatch.ts` set the tone.
- Functions take their collaborators (`fetch`, clock, logger, config) as parameters so tests can pass doubles. Follow that seam in new code instead of reaching for globals.
- Every new environment variable is validated in `src/config.ts` with a clear error message, typed in `src/types.ts` and documented in a README table.

## Tests

`npm run typecheck` and `npm test` both pass before a commit. Tests live in `test/*.test.ts` (`node:test`, run one file at a time) and drive the real code with fake Forgejo and OpenHands APIs; see `fakeApi()` in `test/direct.test.ts`. A behaviour change comes with a test that names the behaviour in its title, in the style of the existing ones.

## Commits, pull requests, releases

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), subject in plain words about the behaviour ("look at a pull request's branch when a run on it ends"). The body says what went wrong or what was missing and why the change fixes it.
- One issue per branch (`feat/…`, `fix/…`, `docs/…`) and one pull request with `Closes #n`. The body covers behaviour and security implications.
- A behaviour change updates its README section in the same pull request.
- Releases are a separate `chore: release vX.Y.Z` commit that bumps `package.json` and `package-lock.json`, made by the maintainer. Feature branches leave the version alone.
