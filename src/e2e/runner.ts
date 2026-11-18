// Runs scenarios against a test repository through the forge client. A scenario has a deadline (E2E_TIMEOUT_MINUTES); its cleanup runs
// whatever happened: the pull requests it opened are closed, its tickets are closed, the branches of its tickets and reverts are deleted,
// and the default branch is put back to the tree it had when the scenario started. The cleanup only touches what the run created: pull
// requests and branches with numbers from the first ticket of the run on, which nothing else in the test repository should use.
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
  ok: boolean;
  started: number;
  finished: number;
  /** The index of the step that failed; null when the scenario held, or when it failed before its first step. */
  failed_step: number | null;
  reason: string | null;
  cleanup: 'ok' | 'failed';
  cleanup_reason: string | null;
}

// A step that does not hold: its message is the reason the report gives.
class StepFailed extends Error {}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const PREDICATE_KINDS = ['issue', 'pull', 'findPull', 'mergeCommit', 'branch', 'runs'] as const;

/**
 * Puts a branch back to the tree of `sha`. The forge's API cannot move a branch pointer, so every file that differs between `sha` and the
 * tip gets a commit of its own (written back, or deleted). Returns how many files it changed; throws when the branch still differs.
 */
export async function restoreBranch(forge: E2eForge, repository: string, branch: string, sha: string): Promise<number> {
  const tip = await forge.branchTip(repository, branch);
  if (!tip) throw new Error('branch ' + branch + ' does not exist');
  if (tip === sha) return 0;
  const diff = await forge.compare(repository, sha, tip);
  const paths = [...new Set((diff.files || []).flatMap((file) => [file.filename, file.previous_filename]).filter((path): path is string => Boolean(path)))];
  let changed = 0;
  for (const path of paths) {
    const before = await forge.readFile(repository, path, sha);
    const now = await forge.readFile(repository, path, branch);
    if (!before && !now) continue;
    if (before && now && before.content.replace(/\s+/g, '') === now.content.replace(/\s+/g, '')) continue;
    const message = 'e2e: restore ' + path + ' as of ' + sha.slice(0, 8);
    if (before) await forge.writeFile(repository, path, { message, branch, content: before.content, ...(now ? { sha: now.sha } : {}) });
    else if (now) await forge.deleteFile(repository, path, { message, branch, sha: now.sha });
    changed++;
  }
  const after = await forge.branchTip(repository, branch);
  const left = after ? await forge.compare(repository, sha, after) : { files: [] };
  if (left.files?.length) throw new Error(branch + ' still differs from ' + sha.slice(0, 8) + ' in ' + left.files.length + ' file(s)');
  return changed;
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

  // A read that fails counts as "not yet" in a wait, so that one flaky answer does not end the scenario.
  const waitFor = async (step: Extract<Step, { do: 'wait' }>): Promise<void> => {
    const limit = step.timeoutMinutes === undefined ? deadline : Math.min(deadline, now() + step.timeoutMinutes * 60000);
    let verdict: Verdict = { ok: false, detail: 'not checked yet' };
    for (;;) {
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

  const cleanupReason = await cleanup(repository, forge, { tickets, defaultBranch, baseline }).catch((error) => String(error?.message || error).slice(0, 600));
  return {
    scenario: scenario.name,
    ok: reason === null && cleanupReason === null,
    started,
    finished: now(),
    failed_step: reason === null ? null : failedStep,
    reason,
    cleanup: cleanupReason === null ? 'ok' : 'failed',
    cleanup_reason: cleanupReason,
  };
}

// What a run created and must undo. `tickets` are the issues it opened; `baseline` the commit the default branch had at the start.
interface Created { tickets: number[]; defaultBranch: string; baseline: string | null }

/**
 * The cleanup, in an order that gives ForgeHands no chance to act on the way: pull requests first, then tickets (a closed ticket stops its
 * runs), then branches, then the default branch. Each action is tried on its own; the result lists what failed (null: all of it held).
 */
export async function cleanup(repository: string, forge: E2eForge, created: Created): Promise<string | null> {
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action(); }
    catch (error) { problems.push(what + ': ' + String(error?.message || error).slice(0, 200)); }
  };
  if (created.tickets.length) {
    const first = Math.min(...created.tickets);
    await attempt('list pull requests', async () => {
      const pulls = await forge.listPulls(repository, { state: 'open', limit: 50, sort: 'recentupdate' });
      for (const pr of pulls.filter((entry) => entry.number > first)) await attempt('close pull request #' + pr.number, () => forge.closePull(repository, pr.number));
    });
    for (const number of created.tickets) await attempt('close ticket #' + number, () => forge.closeIssue(repository, number));
    await attempt('list branches', async () => {
      for (const branch of await forge.listBranches(repository)) {
        const match = /^ai\/(?:issue|revert)-(\d+)$/.exec(branch.name);
        if (match && Number(match[1]) >= first) await attempt('delete branch ' + branch.name, () => forge.deleteBranch(repository, branch.name));
      }
    });
  }
  if (created.baseline && created.defaultBranch) {
    const baseline = created.baseline;
    await attempt('reset ' + created.defaultBranch, () => restoreBranch(forge, repository, created.defaultBranch, baseline));
  }
  return problems.length ? problems.join('; ') : null;
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
