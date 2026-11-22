// The declarative format of an end-to-end scenario. A scenario is data: a list of steps that the runner (runner.ts) carries out against a
// test repository through the forge client, and that predicates (predicates.ts) check. A new bug becomes a new scenario, not new code.
//
// References: a step that creates a ticket names it (`as`), and a later step can use `$name` in a number or a text. `$ticket` is the
// number of that ticket. A wait with `as` captures the number of the pull request it found.

export interface CommentMatch {
  /** The text a comment must contain (`$name` references are expanded). */
  contains: string;
  /** At least this many comments contain it (default 1). */
  min?: number;
  /** At most this many (default: any number). */
  max?: number;
}

/** What a step checks on the forge (or, for runs, in the ledger of ForgeHands). Exactly one kind per predicate. */
export type Predicate =
  /** An issue: its state, a label on it, a comment on it. */
  | { issue: string; state?: 'open' | 'closed'; hasLabel?: string; comment?: CommentMatch }
  /** A pull request: its state (`merged` is a merged one), a label on it, a comment on it. */
  | { pull: string; state?: 'open' | 'closed' | 'merged'; hasLabel?: string; comment?: CommentMatch }
  /** A pull request whose head branch is this name (`$name` expanded), in the given state; the step's `as` captures its number. */
  | { findPull: string; state?: 'open' | 'closed' | 'merged' }
  /** The combined commit status of the commit a pull request merged into the default branch. */
  | { mergeCommit: string; status: string }
  /** The combined commit status of the tip of a branch; `default` is the default branch of the repository. */
  | { branch: string; status: string }
  /**
   * How many runs ForgeHands started for this issue (the ledger, not the forge): under every issue route, or only under `label` when it is
   * given. A ticket that is escalated or sent to a fallback route keeps counting, so leave `label` out unless the route is the point.
   */
  | { runs: string; label?: string; atLeast?: number; exactly?: number }
  /**
   * How many of the runs ForgeHands started for this issue were restarts caused by a revert of its change (the run's event carries the
   * `revert_retry` marker, set by Dispatcher.revertMerged). Under every issue route, as `runs` is; a hand-back escalation is not one of them.
   */
  | { revertRestarts: string; atLeast?: number; exactly?: number };

export type Step =
  /** Creates an issue with a body, puts the label on it (a route of LABEL_ROUTES starts a run) and remembers its number as `as`. */
  | { do: 'ticket'; as: string; title: string; body: string; label: string }
  /** Polls until the predicate holds. `timeoutMinutes` (default: the rest of the scenario's time) bounds the wait; `as` captures a number. */
  | { do: 'wait'; for: Predicate; as?: string; timeoutMinutes?: number }
  /** Checks the predicate once, now. */
  | { do: 'assert'; that: Predicate; message?: string }
  /** Waits without asking anything, so that a late restart or merge would show. */
  | { do: 'settle'; seconds: number };

export interface Scenario {
  /** The name used by E2E_SCENARIOS and as the `scenario` label of the gauge. Lower case, digits and dashes. */
  name: string;
  title: string;
  description: string;
  /** An experimental scenario is not run unless it is named in E2E_SCENARIOS: its outcome depends on the agents' behaviour. */
  experimental: boolean;
  /** What the test repository and the ForgeHands instance must have for the scenario to be deterministic (experimental ones). */
  precondition: string | null;
  steps: Step[];
}

/** The default timeout of a wait for a pull request (findPull), when the step names none. It counts from the start of the run (see runner.ts). */
export const DEFAULT_FIND_PULL_MINUTES = 20;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const VARIABLE = /^[a-z][a-zA-Z0-9]{0,40}$/;
const REFERENCE = /\$([a-z][a-zA-Z0-9]{0,40})/g;
const STATES = ['open', 'closed', 'merged'];

const fail = (where: string, message: string): never => { throw new Error('scenario ' + where + ': ' + message); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The variables a text refers to, so that a step using an unknown one fails at load time, not in the middle of a run.
function references(text: string): string[] { return [...text.matchAll(REFERENCE)].map((match) => match[1]); }

function checkText(where: string, value: unknown, known: Set<string>, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where, field + ' must be a non-empty text');
  for (const name of references(value as string)) if (!known.has(name)) fail(where, field + ' refers to $' + name + ', which no earlier step sets');
  return value as string;
}

function checkPredicate(where: string, value: unknown, known: Set<string>): Predicate {
  if (!isRecord(value)) fail(where, 'a predicate must be an object');
  const kinds = ['issue', 'pull', 'findPull', 'mergeCommit', 'branch', 'runs', 'revertRestarts'].filter((key) => key in (value as object));
  if (kinds.length !== 1) fail(where, 'a predicate needs exactly one of issue, pull, findPull, mergeCommit, branch, runs or revertRestarts');
  const kind = kinds[0];
  const p = value as Record<string, unknown>;
  const state = (allowed: string[]) => {
    if (p.state === undefined) return undefined;
    if (!allowed.includes(String(p.state))) fail(where, 'state must be one of ' + allowed.join(', '));
    return p.state;
  };
  const comment = (): CommentMatch | undefined => {
    if (p.comment === undefined) return undefined;
    if (!isRecord(p.comment)) fail(where, 'comment must be an object with contains, min and max');
    const c = p.comment as Record<string, unknown>;
    const min = c.min === undefined ? undefined : Number(c.min);
    const max = c.max === undefined ? undefined : Number(c.max);
    if (min !== undefined && (!Number.isInteger(min) || min < 0)) fail(where, 'comment.min must be a whole number');
    if (max !== undefined && (!Number.isInteger(max) || max < 0)) fail(where, 'comment.max must be a whole number');
    return { contains: checkText(where, c.contains, known, 'comment.contains'), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  };
  const label = (name: unknown) => { if (typeof name !== 'string' || !name.trim()) fail(where, 'hasLabel must be a label name'); return name as string; };
  const counts = (kind: string): { atLeast?: number; exactly?: number } => {
    const atLeast = p.atLeast === undefined ? undefined : Number(p.atLeast);
    const exactly = p.exactly === undefined ? undefined : Number(p.exactly);
    if (atLeast === undefined && exactly === undefined) fail(where, kind + ' needs atLeast or exactly');
    return { atLeast, exactly };
  };
  switch (kind) {
    case 'issue': return { issue: checkText(where, p.issue, known, 'issue'), ...(state(['open', 'closed']) ? { state: p.state as 'open' | 'closed' } : {}),
      ...(p.hasLabel === undefined ? {} : { hasLabel: label(p.hasLabel) }), ...(comment() ? { comment: comment() } : {}) };
    case 'pull': return { pull: checkText(where, p.pull, known, 'pull'), ...(state(STATES) ? { state: p.state as 'open' | 'closed' | 'merged' } : {}),
      ...(p.hasLabel === undefined ? {} : { hasLabel: label(p.hasLabel) }), ...(comment() ? { comment: comment() } : {}) };
    case 'findPull': return { findPull: checkText(where, p.findPull, known, 'findPull'), ...(state(STATES) ? { state: p.state as 'open' | 'closed' | 'merged' } : {}) };
    case 'mergeCommit': return { mergeCommit: checkText(where, p.mergeCommit, known, 'mergeCommit'), status: checkText(where, p.status, known, 'status') };
    case 'branch': return { branch: checkText(where, p.branch, known, 'branch'), status: checkText(where, p.status, known, 'status') };
    case 'revertRestarts': {
      const { atLeast, exactly } = counts(kind);
      return { revertRestarts: checkText(where, p.revertRestarts, known, 'revertRestarts'), ...(atLeast === undefined ? {} : { atLeast }), ...(exactly === undefined ? {} : { exactly }) };
    }
    default: {
      const { atLeast, exactly } = counts(kind);
      return { runs: checkText(where, p.runs, known, 'runs'), ...(p.label === undefined ? {} : { label: label(p.label) }),
        ...(atLeast === undefined ? {} : { atLeast }), ...(exactly === undefined ? {} : { exactly }) };
    }
  }
}

/** Checks a scenario definition (for example one read from JSON) and returns it typed. Throws with the scenario and step it is wrong in. */
export function parseScenario(value: unknown): Scenario {
  if (!isRecord(value)) throw new Error('a scenario must be an object');
  const name = String(value.name ?? '');
  if (!NAME.test(name)) throw new Error('scenario name must be lower case letters, digits and dashes, got ' + JSON.stringify(name));
  const where = name;
  if (typeof value.title !== 'string' || !value.title.trim()) fail(where, 'title is missing');
  if (typeof value.description !== 'string') fail(where, 'description is missing');
  const experimental = value.experimental === true;
  if (value.experimental !== undefined && typeof value.experimental !== 'boolean') fail(where, 'experimental must be true or false');
  if (experimental && (typeof value.precondition !== 'string' || !value.precondition.trim())) fail(where, 'an experimental scenario needs a precondition');
  if (!Array.isArray(value.steps) || value.steps.length === 0) fail(where, 'steps must be a non-empty list');
  const known = new Set<string>();
  const steps: Step[] = (value.steps as unknown[]).map((raw, index) => {
    const at = where + ', step ' + (index + 1);
    if (!isRecord(raw)) fail(at, 'a step must be an object');
    const step = raw as Record<string, unknown>;
    const capture = (): string | undefined => {
      if (step.as === undefined) return undefined;
      if (typeof step.as !== 'string' || !VARIABLE.test(step.as)) fail(at, 'as must be a name of letters and digits starting with a letter');
      return step.as as string;
    };
    const timeout = (): number | undefined => {
      if (step.timeoutMinutes === undefined) return undefined;
      const minutes = Number(step.timeoutMinutes);
      if (!(minutes > 0) || minutes > 1440) fail(at, 'timeoutMinutes must be above 0 and at most 1440');
      return minutes;
    };
    switch (step.do) {
      case 'ticket': {
        const as = capture();
        if (!as) fail(at, 'a ticket step needs as');
        const parsed: Step = { do: 'ticket', as: as as string, title: checkText(at, step.title, known, 'title'), body: checkText(at, step.body, known, 'body'), label: checkText(at, step.label, known, 'label') };
        known.add(as as string);
        return parsed;
      }
      case 'wait': {
        const for_ = checkPredicate(at, step.for, known);
        const as = capture();
        if (as && !('findPull' in for_)) fail(at, 'only a findPull wait captures a number (as)');
        if (as) known.add(as);
        // A pull request that does not appear within 20 minutes of the start of its run is a failed run, not a reason to wait for the rest of the
        // scenario's time.
        const minutes = timeout() ?? ('findPull' in for_ ? DEFAULT_FIND_PULL_MINUTES : undefined);
        return { do: 'wait', for: for_, ...(as ? { as } : {}), ...(minutes === undefined ? {} : { timeoutMinutes: minutes }) };
      }
      case 'assert': {
        const that = checkPredicate(at, step.that, known);
        return { do: 'assert', that, ...(step.message === undefined ? {} : { message: String(step.message) }) };
      }
      case 'settle': {
        const seconds = Number(step.seconds);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) fail(at, 'settle seconds must be a whole number from 1 to 3600');
        return { do: 'settle', seconds };
      }
      default: return fail(at, 'do must be ticket, wait, assert or settle, got ' + JSON.stringify(step.do));
    }
  });
  return {
    name,
    title: value.title as string,
    description: value.description as string,
    experimental,
    precondition: typeof value.precondition === 'string' ? value.precondition : null,
    steps,
  };
}
