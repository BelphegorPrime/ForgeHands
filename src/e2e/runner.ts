// Runs scenarios against a test repository through the forge client. A scenario has a deadline (E2E_TIMEOUT_MINUTES); its cleanup runs
// whatever happened: the pull requests and the issues above its first ticket are closed (sub-issues included), the queued runs of its tickets
// are dropped and the running ones waited for, the branches of its tickets and reverts are deleted, and the default branch is put back to the
// tree it had when the scenario started. The cleanup only touches what the run created: run branches (ai/issue-<n>, ai/revert-<n>) with numbers
// from the first ticket of the run on. A wait for a run counts its time from the start of the run; queueing has its own allowance.
// A ticket that the pre-flight rejects ends the scenario at once (preflight_rejected): no worker starts on it, so no pull request comes.
import { PREFLIGHT_REJECTION } from '../agent/preflight.ts';
import type { Predicate, Scenario, Step } from './format.ts';
import { branchOf, probe, runTicketOf, type Probe, type Verdict } from './predicates.ts';
import type { E2eForge, LedgerPort, TicketRun } from './port.ts';

export interface RunOptions {
  repository: string;
  forge: E2eForge;
  ledger: LedgerPort;
  /** The whole scenario, cleanup not included. */
  timeoutMs: number;
  /** How often a wait looks again. */
  pollMs: number;
  /** A run of a ticket may wait queued this long before a wait for it fails (default 60 minutes). Queueing is not counted in a run's time. */
  queueMs?: number;
  /** How long the cleanup waits for the runs of its tickets that are still going (default 30 minutes). */
  leftoverMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives the path names of the cleanup's restore retries (never contents). */
  log?: (line: string) => void;
}

export interface ScenarioResult {
  scenario: string;
  /** The steps held. A failed cleanup does not change it: it is reported in `cleanup` and `cleanup_reason`. */
  ok: boolean;
  started: number;
  finished: number;
  /** The index of the step that failed; null when the scenario held, or when it failed before its first step. */
  failed_step: number | null;
  reason: string | null;
  cleanup: 'ok' | 'failed';
  /** The paths (never contents) that a failed cleanup could not put back, with what it did. Null when the cleanup held. */
  cleanup_reason: string | null;
  /** A difference the run did not cause and the cleanup left alone (a path the run did not touch); the cleanup still counts as ok. */
  cleanup_note: string | null;
}

// A step that does not hold: its message is the reason the report gives.
class StepFailed extends Error {}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const PREDICATE_KINDS = ['issue', 'pull', 'findPull', 'mergeCommit', 'branch', 'runs'] as const;
const MINUTE = 60000;
/** How long a run of the suite's ticket may wait queued before its wait fails (E2E_QUEUE_MINUTES sets it in production). */
const DEFAULT_QUEUE_MS = 60 * MINUTE;
/** How long the cleanup waits for the runs of its tickets that are still going (a run that was started and cannot be stopped). */
const DEFAULT_LEFTOVER_MS = 30 * MINUTE;
const ACTIVE_RUN = new Set(['waiting', 'queued', 'running']);

export interface RestoreOptions {
  /**
   * The paths the run changed. A difference left in one of them fails the restore. Any other difference that is left is reported in
   * `untouched` and is not the run's concern. Null: the paths of the run could not be read, so every difference counts.
   */
  touched?: ReadonlySet<string> | null;
  /** Passes over the branch: a merge or a CI commit may land between two of them, so a pass can leave something the next one fixes. */
  attempts?: number;
  /** The wait between two passes. */
  waitMs?: number;
  /**
   * The waits before the verdict on a difference that survives the passes, in milliseconds. Each wait is followed by a fresh read of the
   * branch and another restore of what still differs. Default 2, 4, 8, 16 and 30 seconds: about a minute in all.
   */
  settle?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Receives path names and counts for the retries (never contents). Default: nothing. */
  log?: (line: string) => void;
}

export interface RestoreResult {
  /** The files a commit was written or deleted for. */
  changed: number;
  /** The paths that still differ and that the run did not touch (the restore cannot write them: a symlink, a mode change). */
  untouched: string[];
  /** Paths of the run that a commit of someone else changed after the restore: a note, not a failure. */
  moved: string[];
}

/** The waits of the settle schedule (see RestoreOptions.settle). */
const SETTLE_MS = [2000, 4000, 8000, 16000, 30000];

// The paths a compare lists, the old name of a renamed file included.
function pathsOf(diff: { files?: { filename: string; previous_filename?: string }[] }): string[] {
  return [...new Set((diff.files || []).flatMap((file) => [file.filename, file.previous_filename]).filter((path): path is string => Boolean(path)))];
}

// A path list for a message: the first ten, then the count of the rest. Paths only, never contents.
function listOf(paths: string[]): string {
  const shown = paths.slice(0, 10).join(', ');
  return paths.length > 10 ? shown + ' and ' + (paths.length - 10) + ' more' : shown;
}

// Makes the file at `path` of `branch` equal to its content at `sha`: a commit writes it back, or deletes it when it did not exist then.
// `tip` is the commit the branch has now: the file is read at that commit, not at the branch name (a name can be answered from a cache).
// Returns the commit the write made (null when the forge named none), or null when the file already is as it should be. A file the contents
// API cannot read throws.
async function restorePath(forge: E2eForge, repository: string, branch: string, tip: string, sha: string, path: string): Promise<{ commit: string | null } | null> {
  const before = await forge.readFile(repository, path, sha);
  const now = await forge.readFile(repository, path, tip);
  if (!before && !now) return null;
  // Base64 of the same bytes is the same text, so this compares the bytes; the line breaks of the encoding do not count.
  if (before && now && before.content.replace(/\s+/g, '') === now.content.replace(/\s+/g, '')) return null;
  const message = 'e2e: restore ' + path + ' as of ' + sha.slice(0, 8);
  if (before) return { commit: await forge.writeFile(repository, path, { message, branch, content: before.content, ...(now ? { sha: now.sha } : {}) }) ?? null };
  if (now) return { commit: await forge.deleteFile(repository, path, { message, branch, sha: now.sha }) ?? null };
  return null;
}

// Whether `path` differs between the commits `sha` and `at`, read at both commit ids. A read that throws is a difference: it cannot be shown
// to be the same.
async function differsAt(forge: E2eForge, repository: string, sha: string, at: string, path: string): Promise<boolean> {
  try {
    const before = await forge.readFile(repository, path, sha);
    const now = await forge.readFile(repository, path, at);
    if (!before || !now) return Boolean(before) !== Boolean(now);
    return before.content.replace(/\s+/g, '') !== now.content.replace(/\s+/g, '');
  } catch {
    return true;
  }
}

/**
 * What commit `at` still differs from `sha` in. The candidates are the paths the compare lists and the paths of the run; every candidate is
 * then read at `at` itself, so a compare that answers late cannot make a difference (or hide one of the run's paths).
 */
async function verdictAt(forge: E2eForge, repository: string, sha: string, at: string, touched: ReadonlySet<string> | null | undefined):
  Promise<{ mine: string[]; untouched: string[] }> {
  const listed = at === sha ? [] : pathsOf(await forge.compare(repository, sha, at));
  const candidates = [...new Set([...listed, ...(touched ?? [])])];
  const mine: string[] = [];
  const untouched: string[] = [];
  for (const path of candidates) {
    if (!(await differsAt(forge, repository, sha, at, path))) continue;
    if (!touched || touched.has(path)) mine.push(path);
    else untouched.push(path);
  }
  return { mine, untouched };
}

/**
 * Puts a branch back to the tree of `sha`. The forge's API cannot move a branch pointer, so every file that differs between `sha` and the
 * tip gets a commit of its own (written back, or deleted). The verdict is taken at the commit the restore wrote last (its id, from the write's
 * answer), not at the branch: a read of the branch or a compare right after a commit can still show the state before it. A verdict that
 * still differs in the paths of the run is looked at again after the settle waits (a fresh read of the branch, another restore). Throws when
 * a path the run touched still differs after all of that; the others are returned. Commits of someone else after the restore are not judged
 * except for the paths of the run, which come back as `moved`.
 */
export async function restoreBranch(forge: E2eForge, repository: string, branch: string, sha: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? pause;
  const waitMs = options.waitMs ?? 2000;
  const settle = options.settle ?? SETTLE_MS;
  const log = options.log ?? (() => {});
  const touched = options.touched;
  // Every tip read and every commit the restore made: a tip outside this set is a commit of someone else that landed after the restore.
  const seen = new Set<string>([sha]);
  const tipOf = async (): Promise<string> => {
    const tip = await forge.branchTip(repository, branch);
    if (!tip) throw new Error('branch ' + branch + ' does not exist');
    seen.add(tip);
    return tip;
  };
  let changed = 0;
  // One pass: every path that differs between `sha` and the tip read now is restored. Returns the commit to judge: the last commit the pass
  // made, or else the tip it read.
  const pass = async (): Promise<string> => {
    const tip = await tipOf();
    if (tip === sha) return tip;
    let last: string | null | undefined;
    for (const path of pathsOf(await forge.compare(repository, sha, tip))) {
      // A path the API refuses now is judged again by the verdict; a path that stays different is reported there.
      try {
        const made = await restorePath(forge, repository, branch, tip, sha, path);
        if (!made) continue;
        changed += 1;
        last = made.commit;
        if (made.commit) seen.add(made.commit);
      } catch (error) {
        log('restore of ' + path + ' failed: ' + String(error?.message || error).slice(0, 200));
      }
    }
    return last ?? tip;
  };
  let target = await pass();
  let verdict = await verdictAt(forge, repository, sha, target, touched);
  for (let round = 1; verdict.mine.length && round < attempts; round++) {
    log('restore: ' + listOf(verdict.mine) + ' still differ, another pass');
    await sleep(waitMs);
    target = await pass();
    verdict = await verdictAt(forge, repository, sha, target, touched);
  }
  // The settle waits: a difference that is still there after each of them is looked at again, with the branch read afresh.
  for (const wait of settle) {
    if (!verdict.mine.length) break;
    log('restore: ' + listOf(verdict.mine) + ' still differ, looking again in ' + Math.round(wait / 1000) + ' s');
    await sleep(wait);
    target = await pass();
    verdict = await verdictAt(forge, repository, sha, target, touched);
  }
  if (verdict.mine.length) throw new Error(branch + ' still differs from ' + sha.slice(0, 8) + ' in ' + verdict.mine.length + ' file(s) of the run: ' + listOf(verdict.mine));
  // A commit of someone else that landed after the restore: its changes to the paths of the run are reported, not repaired.
  let moved: string[] = [];
  let latest: string | null = null;
  try { latest = await forge.branchTip(repository, branch); } catch { latest = null; }
  if (latest && !seen.has(latest) && latest !== target) {
    moved = pathsOf(await forge.compare(repository, target, latest)).filter((path) => !touched || touched.has(path));
  }
  return { changed, untouched: verdict.untouched, moved };
}

/** Where the clock of a run-dependent wait stands: the run is going, a run waits in the queue, or no run is active (the wait's own clock). */
export interface RunClock {
  /** The time the wait gives up at, as things stand. */
  limit: number;
  state: 'running' | 'queued' | 'idle';
  /** For a queued run: the runs that go before it. */
  ahead: number;
}

/**
 * The clock of a wait for a run (`findPull` of a ticket's branch, `runs`). A run that is going gets `runMs` from its start: queueing does not
 * count against it. A run that waits in the queue gets `queueMs` from the moment it was queued, and that allowance is separate from the run
 * time. With no run active the wait gets `queueMs` after the last thing that happened to the ticket (`since` when it had no run at all).
 */
export function runClockOf(runs: TicketRun[], since: number, runMs: number, queueMs: number): RunClock {
  const running = runs.filter((run) => run.status === 'running');
  if (running.length) {
    const latest = Math.max(...running.map((run) => run.started ?? run.created));
    return { limit: latest + runMs, state: 'running', ahead: 0 };
  }
  const queued = runs.filter((run) => run.status === 'queued' || run.status === 'waiting');
  if (queued.length) {
    const first = queued.reduce((a, b) => (b.created < a.created ? b : a));
    return { limit: first.created + queueMs, state: 'queued', ahead: first.ahead };
  }
  const last = Math.max(since, ...runs.map((run) => run.finished ?? run.created));
  return { limit: last + queueMs, state: 'idle', ahead: 0 };
}

// The kind of check a predicate makes, for the report ("wait runs", "assert pull").
function kindOf(predicate: Predicate): string {
  return PREDICATE_KINDS.find((kind) => kind in predicate) ?? 'check';
}

/** Runs one scenario. Never throws: the result says whether it held, why it did not, and whether its cleanup held. */
export async function runScenario(scenario: Scenario, options: RunOptions): Promise<ScenarioResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const started = now();
  const deadline = started + options.timeoutMs;
  const { repository, forge } = options;
  const vars = new Map<string, number>();
  const tickets: number[] = [];
  let defaultBranch = '';
  let baseline: string | null = null;
  let failedStep: number | null = null;
  let reason: string | null = null;

  const probeOf = (): Probe => ({ forge, repository, defaultBranch, ledger: options.ledger, vars });
  // When each ticket of this run was created: a run-dependent wait with no run yet counts its queue allowance from there.
  const createdAt = new Map<number, number>();
  const queueMs = options.queueMs ?? DEFAULT_QUEUE_MS;

  // The reason a ticket of this run was rejected by the pre-flight, or null. A read that fails is no rejection: the wait goes on.
  const rejectedTicket = async (): Promise<string | null> => {
    for (const number of tickets) {
      let comments: { body?: string }[];
      try { comments = await forge.listComments(repository, number, 100); } catch { continue; }
      const note = comments.find((comment) => String(comment.body || '').includes(PREFLIGHT_REJECTION));
      if (!note) continue;
      const rules = String(note.body).split('\n').filter((line) => line.startsWith('- rule')).map((line) => line.slice(2)).join('; ');
      return 'preflight_rejected: ticket #' + number + ' breaks the pre-flight, so no worker starts on it' + (rules ? ' (' + rules.slice(0, 400) + ')' : '');
    }
    return null;
  };

  // A read that fails counts as "not yet" in a wait, so that one flaky answer does not end the scenario.
  // A wait for a run (a findPull of a ticket's branch, a runs count) does not run on the step's clock from its start: its limit comes from the
  // ticket's runs in the ledger (runClockOf). A run that is queued past queueMs fails with queued_too_long, not with a timeout.
  const waitFor = async (step: Extract<Step, { do: 'wait' }>): Promise<void> => {
    const waitStart = now();
    const fixedLimit = step.timeoutMinutes === undefined ? deadline : Math.min(deadline, waitStart + step.timeoutMinutes * 60000);
    const runMs = step.timeoutMinutes === undefined ? deadline - waitStart : step.timeoutMinutes * 60000;
    const runDependent = 'runs' in step.for || 'findPull' in step.for;
    let verdict: Verdict = { ok: false, detail: 'not checked yet' };
    for (;;) {
      const rejected = await rejectedTicket();
      if (rejected) throw new StepFailed(rejected);
      try { verdict = await probe(step.for, probeOf()); }
      catch (error) { verdict = { ok: false, detail: 'read failed: ' + String(error?.message || error).slice(0, 200) }; }
      if (verdict.ok) {
        if (step.as) vars.set(step.as, verdict.captured as number);
        return;
      }
      let limit = fixedLimit;
      let clock: RunClock | null = null;
      if (runDependent) {
        const ticket = await runTicketOf(step.for, probeOf()).catch(() => null);
        if (ticket !== null) {
          clock = runClockOf(options.ledger.runsStateOf(repository, ticket), createdAt.get(ticket) ?? waitStart, runMs, queueMs);
          limit = Math.min(deadline, clock.limit);
        }
      }
      if (now() >= limit) {
        if (clock?.state === 'queued') {
          throw new StepFailed('queued_too_long: ' + clock.ahead + ' runs ahead, the run waited more than ' + Math.round(queueMs / MINUTE)
            + ' minutes in the queue; last seen: ' + verdict.detail);
        }
        throw new StepFailed('timed out; last seen: ' + verdict.detail);
      }
      await sleep(Math.max(1, Math.min(options.pollMs, limit - now())));
    }
  };

  const runStep = async (step: Step): Promise<void> => {
    if (now() >= deadline) throw new StepFailed('the scenario ran out of its time');
    if (step.do === 'ticket') {
      // The ticket is remembered before its label is set, so that the cleanup closes it even when the label call fails.
      const issue = await forge.createIssue(repository, step.title, step.body);
      tickets.push(issue.number);
      createdAt.set(issue.number, now());
      vars.set(step.as, issue.number);
      const label = await forge.findOrCreateLabel(repository, step.label, '#0e8a16');
      await forge.addLabels(repository, issue.number, [label], 'issue');
      return;
    }
    if (step.do === 'wait') return waitFor(step);
    if (step.do === 'assert') {
      const rejected = await rejectedTicket();
      if (rejected) throw new StepFailed(rejected);
      const verdict = await probe(step.that, probeOf());
      if (!verdict.ok) throw new StepFailed((step.message ? step.message + ': ' : '') + verdict.detail);
      return;
    }
    if (now() + step.seconds * 1000 > deadline) throw new StepFailed('the scenario ran out of its time before a settle');
    await sleep(step.seconds * 1000);
  };

  try {
    const info = await forge.getRepository(repository);
    defaultBranch = info.default_branch;
    if (!defaultBranch) throw new StepFailed('the repository has no default branch');
    baseline = await forge.branchTip(repository, defaultBranch);
    if (!baseline) throw new StepFailed('the default branch ' + defaultBranch + ' has no commit');
    for (const [index, step] of scenario.steps.entries()) {
      failedStep = index;
      await runStep(step);
    }
    failedStep = null;
  } catch (error) {
    const where = failedStep === null ? 'before the first step' : 'step ' + (failedStep + 1) + ' (' + describeStep(scenario.steps[failedStep]) + ')';
    reason = where + ': ' + String(error?.message || error).slice(0, 600);
  }

  const outcome = await cleanup(repository, forge, { tickets, defaultBranch, baseline },
    { sleep, ledger: options.ledger, pollMs: options.pollMs, leftoverMs: options.leftoverMs, log: options.log })
    .catch((error): CleanupOutcome => ({ problem: String(error?.message || error).slice(0, 600), note: null }));
  return {
    scenario: scenario.name,
    ok: reason === null,
    started,
    finished: now(),
    failed_step: reason === null ? null : failedStep,
    reason,
    cleanup: outcome.problem === null ? 'ok' : 'failed',
    cleanup_reason: outcome.problem,
    cleanup_note: outcome.note,
  };
}

// What a run created and must undo. `tickets` are the issues it opened; `baseline` the commit the default branch had at the start.
interface Created { tickets: number[]; defaultBranch: string; baseline: string | null }

export interface CleanupOutcome {
  /** What failed, or null when all of it held. */
  problem: string | null;
  /** What the cleanup left alone on purpose (see ScenarioResult.cleanup_note), or null. */
  note: string | null;
}

// The branch names ForgeHands gives the runs of a ticket (`ai/issue-<n>`) and the reverts of its merges (`ai/revert-<n>`), from `first` on.
const isRunBranch = (name: string, first: number): boolean => {
  const match = /^ai\/(?:issue|revert)-(\d+)$/.exec(name);
  return Boolean(match && Number(match[1]) >= first);
};

/**
 * The paths the run changed: the files that its pull requests and its branches change against the start commit. "Its" means a run branch
 * (ai/issue-<n> or ai/revert-<n>) with a number from `first` on: a delivery of an earlier scenario's ticket that lands during this run is not
 * this run's, however high its pull request number is. Null when they cannot be read; the restore then treats every difference as the run's.
 */
async function pathsOfRun(forge: E2eForge, repository: string, baseline: string, first: number): Promise<Set<string> | null> {
  try {
    const heads = new Set<string>();
    for (const pr of await forge.listPulls(repository, { state: 'all', limit: 50, sort: 'recentupdate' })) {
      if (isRunBranch(branchOf(pr), first) && pr.head?.sha) heads.add(pr.head.sha);
    }
    for (const branch of await forge.listBranches(repository)) {
      if (isRunBranch(branch.name, first) && branch.sha) heads.add(branch.sha);
    }
    const paths = new Set<string>();
    for (const head of heads) for (const path of pathsOf(await forge.compare(repository, baseline, head))) paths.add(path);
    return paths;
  } catch {
    return null;
  }
}

/**
 * The cleanup, in an order that gives ForgeHands no chance to act on the way: pull requests first, then tickets (a closed ticket stops its
 * runs), then branches, then the default branch. Each action is tried on its own; the outcome lists what failed (problem: null when all of
 * it held) and what was left on purpose (note).
 */
export interface CleanupPacing {
  sleep?: (ms: number) => Promise<void>;
  /** The ledger: its queued runs of the tickets are dropped, and the cleanup waits for the runs that still go. Without it neither happens. */
  ledger?: LedgerPort;
  /** How often the cleanup looks at the runs that still go (default 30 s). */
  pollMs?: number;
  /** How long it waits for them (default 30 minutes). */
  leftoverMs?: number;
  /** Receives the path names of the restore's retries (never contents). */
  log?: (line: string) => void;
}

export async function cleanup(repository: string, forge: E2eForge, created: Created, pacing: CleanupPacing = {}): Promise<CleanupOutcome> {
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action(); }
    catch (error) { problems.push(what + ': ' + String(error?.message || error).slice(0, 200)); }
  };
  // The paths of the run, read before its branches are deleted. Without tickets the run changed nothing; null means "cannot say".
  let touched: Set<string> | null = new Set<string>();
  if (created.tickets.length && created.baseline) {
    const first = Math.min(...created.tickets);
    touched = await pathsOfRun(forge, repository, created.baseline, first);
  }
  if (created.tickets.length) {
    const first = Math.min(...created.tickets);
    await attempt('list pull requests', async () => {
      const pulls = await forge.listPulls(repository, { state: 'open', limit: 50, sort: 'recentupdate' });
      for (const pr of pulls.filter((entry) => isRunBranch(branchOf(entry), first))) await attempt('close pull request #' + pr.number, () => forge.closePull(repository, pr.number));
    });
    for (const number of created.tickets) await attempt('close ticket #' + number, () => forge.closeIssue(repository, number));
    // A closed ticket's run that is only queued would start later and deliver onto the branch of the next scenario: it is dropped here.
    // A run that is already going cannot be stopped; the cleanup waits for it below.
    if (pacing.ledger) {
      const ledger = pacing.ledger;
      for (const number of created.tickets) await attempt('drop the queued runs of #' + number, () => ledger.dropQueued(repository, number));
    }
    // A ticket the planner split (or a run that opened another ticket) has its issues above the first ticket, and the pull request of a
    // sub-issue can merge without closing it: those are closed too. Issues and pull requests share one number space, so the walk goes up
    // from the first ticket and ends after three numbers in a row that do not exist.
    await attempt('close the issues above the first ticket', async () => {
      let missing = 0;
      for (let number = first; missing < 3; number++) {
        let issue: { state: string; pull_request?: unknown } | null = null;
        try { issue = await forge.getIssue(repository, number); }
        catch (error) { if (!/HTTP 404\b/.test(String(error?.message))) throw error; }
        if (!issue) { missing++; continue; }
        missing = 0;
        // The issue endpoint answers for pull requests too: a pull request is not a sub-issue (the pull requests of the run are closed above).
        if (issue.state === 'open' && !issue.pull_request) await attempt('close issue #' + number, () => forge.closeIssue(repository, number));
      }
    });
    if (pacing.ledger) {
      const ledger = pacing.ledger;
      const pollMs = pacing.pollMs ?? 30000;
      const polls = Math.ceil((pacing.leftoverMs ?? DEFAULT_LEFTOVER_MS) / pollMs);
      const nap = pacing.sleep ?? pause;
      for (let poll = 0; ; poll++) {
        let active: string[];
        try {
          active = created.tickets.flatMap((number) => ledger.runsStateOf(repository, number)
            .filter((run) => ACTIVE_RUN.has(run.status)).map((run) => '#' + number + ' ' + run.status));
        } catch (error) {
          problems.push('read the runs of the tickets: ' + String(error?.message || error).slice(0, 200));
          break;
        }
        if (!active.length) break;
        if (poll >= polls) {
          problems.push('runs of the tickets still going after ' + Math.round((pacing.leftoverMs ?? DEFAULT_LEFTOVER_MS) / 1000) + ' s: ' + listOf(active));
          break;
        }
        await nap(pollMs);
      }
    }
    await attempt('list branches', async () => {
      for (const branch of await forge.listBranches(repository)) {
        if (isRunBranch(branch.name, first)) await attempt('delete branch ' + branch.name, () => forge.deleteBranch(repository, branch.name));
      }
    });
  }
  let note: string | null = null;
  if (created.baseline && created.defaultBranch) {
    const baseline = created.baseline;
    await attempt('reset ' + created.defaultBranch, async () => {
      const result = await restoreBranch(forge, repository, created.defaultBranch, baseline, { touched, sleep: pacing.sleep, log: pacing.log });
      const notes: string[] = [];
      if (result.untouched.length) {
        notes.push(created.defaultBranch + ' still differs from ' + baseline.slice(0, 8) + ' in ' + result.untouched.length
          + ' file(s) the run did not touch, left alone: ' + listOf(result.untouched));
      }
      if (result.moved.length) {
        notes.push(created.defaultBranch + ' moved on after the restore: a commit of someone else changed ' + result.moved.length
          + ' file(s) of the run, left alone: ' + listOf(result.moved));
      }
      if (notes.length) note = notes.join('; ');
    });
  }
  return { problem: problems.length ? problems.join('; ') : null, note };
}

/** Runs the scenarios one after the other; each starts from the state the previous one's cleanup left. */
export async function runSuite(scenarios: Scenario[], options: RunOptions): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, options));
  return results;
}

// A short name of a step for the report, such as "wait runs" or "create ticket first".
function describeStep(step: Step | undefined): string {
  if (!step) return 'unknown step';
  if (step.do === 'ticket') return 'create ticket ' + step.as;
  if (step.do === 'settle') return 'settle ' + step.seconds + ' s';
  if (step.do === 'wait') return 'wait for ' + kindOf(step.for);
  return 'assert ' + kindOf(step.that);
}
