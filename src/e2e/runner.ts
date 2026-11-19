// Runs scenarios against a test repository through the forge client. A scenario has a deadline (E2E_TIMEOUT_MINUTES); its cleanup runs
// whatever happened: the pull requests and the issues above its first ticket are closed (sub-issues included), the branches of its tickets
// and reverts are deleted,
// and the default branch is put back to the tree it had when the scenario started. The cleanup only touches what the run created: pull
// requests and branches with numbers from the first ticket of the run on, which nothing else in the test repository should use.
// A ticket that the pre-flight rejects ends the scenario at once (preflight_rejected): no worker starts on it, so no pull request comes.
import { PREFLIGHT_REJECTION } from '../agent/preflight.ts';
import type { Predicate, Scenario, Step } from './format.ts';
import { probe, type Probe, type Verdict } from './predicates.ts';
import type { E2eForge, LedgerPort } from './port.ts';

export interface RunOptions {
  repository: string;
  forge: E2eForge;
  ledger: LedgerPort;
  /** The whole scenario, cleanup not included. */
  timeoutMs: number;
  /** How often a wait looks again. */
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  sleep?: (ms: number) => Promise<void>;
}

export interface RestoreResult {
  /** The files a commit was written or deleted for. */
  changed: number;
  /** The paths that still differ and that the run did not touch (the restore cannot write them: a symlink, a mode change). */
  untouched: string[];
}

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
// Returns 1 when a commit was made, 0 when the file already is as it should be. A file the contents API cannot read throws.
async function restorePath(forge: E2eForge, repository: string, branch: string, sha: string, path: string): Promise<number> {
  const before = await forge.readFile(repository, path, sha);
  const now = await forge.readFile(repository, path, branch);
  if (!before && !now) return 0;
  // Base64 of the same bytes is the same text, so this compares the bytes; the line breaks of the encoding do not count.
  if (before && now && before.content.replace(/\s+/g, '') === now.content.replace(/\s+/g, '')) return 0;
  const message = 'e2e: restore ' + path + ' as of ' + sha.slice(0, 8);
  if (before) await forge.writeFile(repository, path, { message, branch, content: before.content, ...(now ? { sha: now.sha } : {}) });
  else if (now) await forge.deleteFile(repository, path, { message, branch, sha: now.sha });
  return 1;
}

/**
 * Puts a branch back to the tree of `sha`. The forge's API cannot move a branch pointer, so every file that differs between `sha` and the
 * tip gets a commit of its own (written back, or deleted). A pass that leaves something (a commit that landed meanwhile, a file the API
 * refused) is followed by another, up to `attempts`. Throws when a path the run touched still differs; the others are returned.
 */
export async function restoreBranch(forge: E2eForge, repository: string, branch: string, sha: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? pause;
  const waitMs = options.waitMs ?? 2000;
  let changed = 0;
  let left: string[] = [];
  for (let pass = 1; ; pass++) {
    const tip = await forge.branchTip(repository, branch);
    if (!tip) throw new Error('branch ' + branch + ' does not exist');
    if (tip !== sha) {
      for (const path of pathsOf(await forge.compare(repository, sha, tip))) {
        // A path the API refuses now is looked at again by the next pass; the last pass reports it as left.
        try { changed += await restorePath(forge, repository, branch, sha, path); }
        catch { /* see above */ }
      }
    }
    const after = await forge.branchTip(repository, branch);
    if (!after) throw new Error('branch ' + branch + ' does not exist');
    left = after === sha ? [] : pathsOf(await forge.compare(repository, sha, after));
    if (!left.length || pass >= attempts) break;
    await sleep(waitMs);
  }
  const touched = options.touched;
  const mine = left.filter((path) => !touched || touched.has(path));
  if (mine.length) throw new Error(branch + ' still differs from ' + sha.slice(0, 8) + ' in ' + mine.length + ' file(s) of the run: ' + listOf(mine));
  return { changed, untouched: left };
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
  const waitFor = async (step: Extract<Step, { do: 'wait' }>): Promise<void> => {
    const limit = step.timeoutMinutes === undefined ? deadline : Math.min(deadline, now() + step.timeoutMinutes * 60000);
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
      if (now() >= limit) throw new StepFailed('timed out; last seen: ' + verdict.detail);
      await sleep(Math.max(1, Math.min(options.pollMs, limit - now())));
    }
  };

  const runStep = async (step: Step): Promise<void> => {
    if (now() >= deadline) throw new StepFailed('the scenario ran out of its time');
    if (step.do === 'ticket') {
      // The ticket is remembered before its label is set, so that the cleanup closes it even when the label call fails.
      const issue = await forge.createIssue(repository, step.title, step.body);
      tickets.push(issue.number);
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

  const outcome = await cleanup(repository, forge, { tickets, defaultBranch, baseline }, { sleep })
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
 * The paths the run changed: the files that its pull requests and its branches (numbers from `first` on) change against the start commit.
 * Null when they cannot be read; the restore then treats every difference as the run's.
 */
async function pathsOfRun(forge: E2eForge, repository: string, baseline: string, first: number): Promise<Set<string> | null> {
  try {
    const heads = new Set<string>();
    for (const pr of await forge.listPulls(repository, { state: 'all', limit: 50, sort: 'recentupdate' })) {
      if (pr.number > first && pr.head?.sha) heads.add(pr.head.sha);
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
export async function cleanup(repository: string, forge: E2eForge, created: Created, pacing: { sleep?: (ms: number) => Promise<void> } = {}): Promise<CleanupOutcome> {
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
      for (const pr of pulls.filter((entry) => entry.number > first)) await attempt('close pull request #' + pr.number, () => forge.closePull(repository, pr.number));
    });
    for (const number of created.tickets) await attempt('close ticket #' + number, () => forge.closeIssue(repository, number));
    // A ticket the planner split (or a run that opened another ticket) has its issues above the first ticket, and the pull request of a
    // sub-issue can merge without closing it: those are closed too. Issues and pull requests share one number space, so the walk goes up
    // from the first ticket and ends after three numbers in a row that do not exist.
    await attempt('close the issues above the first ticket', async () => {
      let missing = 0;
      for (let number = first; missing < 3; number++) {
        let issue: { state: string } | null = null;
        try { issue = await forge.getIssue(repository, number); }
        catch (error) { if (!/HTTP 404\b/.test(String(error?.message))) throw error; }
        if (!issue) { missing++; continue; }
        missing = 0;
        if (issue.state === 'open') await attempt('close issue #' + number, () => forge.closeIssue(repository, number));
      }
    });
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
      const result = await restoreBranch(forge, repository, created.defaultBranch, baseline, { touched, sleep: pacing.sleep });
      if (result.untouched.length) {
        note = created.defaultBranch + ' still differs from ' + baseline.slice(0, 8) + ' in ' + result.untouched.length
          + ' file(s) the run did not touch, left alone: ' + listOf(result.untouched);
      }
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
