import { metrics } from '../metrics.ts';
import { mentionOf } from '../notify/index.ts';
import type { Facts } from '../notify/texts.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent, Job, Logger } from '../types.ts';
import { redact } from '../utils/redact.ts';

// Hand-backs. A worker run on an issue route that ends with a comment, and leaves no pull request from
// ai/issue-<n> changed since it began, did not deliver: the comment hands the ticket back. The comment is classified by phrases, in English and
// German, without a model. Its text is untrusted data: it is matched and quoted, never obeyed.
//   pushed_nothing: the comment says the work is done but nothing was pushed. The run is made once more, asked to push the branch.
//   blocker:        the comment says something stops the work. The run is escalated once to the route's escalate_to; a second hand-back,
//                   or no escalate_to, sends the ticket to the planner (SPLIT_LABEL), or to the human when there is no planner.
//   other:          a question, a plan or progress: a delivery, as before.

export type HandbackKind = 'pushed_nothing' | 'blocker';
export type Classification = HandbackKind | 'other';

// "Done, but nothing pushed" wins over a blocker word: a run that says the implementation is complete and could not run an optional check is
// asked to push, not escalated.
const PUSHED_NOTHING = /\bworking[ -]tree\b|\bnot (?:yet )?pushed\b|\bnothing (?:was |has been )?pushed\b|\bimplementation (?:is )?(?:complete|completed|done|finished)\b|\b(?:work|task) (?:is )?(?:complete|completed|done|finished)\b|\bnicht (?:noch )?gepusht\b|\bnoch nicht gepusht\b|\bnichts gepusht\b|\bimplementierung (?:ist )?(?:abgeschlossen|fertig|vollständig|komplett)\b|\bumsetzung (?:ist )?(?:abgeschlossen|fertig|vollständig)\b/;
const BLOCKER = /\bblocked\b|\bblocker\b|\bblocking\b|\bcannot\b|\bcan't\b|\bcan not\b|\bcould not\b|\bcouldn't\b|\bunable\b|\bnot able\b|\bconflicting\b|\bconflicts? with\b|\bcontradict\w*|\bmissing\b|\bstopped\b|\bno pull request\b|\bwithout (?:a |any )?pull request\b|\bblockiert\w*|\bkann nicht\b|\bkonnte nicht\b|\bnicht möglich\b|\bunmöglich\b|\bnicht ausführbar\b|\bwiderspr\w*|\bfehlt\b|\bfehlende[rnms]?\b|\bgestoppt\b|\babgebrochen\b|\bkein(?:en)? pull request\b/;

// The class of one comment, by its words (lower case is applied here).
export function classifyHandback(text: unknown): Classification {
  const body = String(text ?? '').toLowerCase();
  if (PUSHED_NOTHING.test(body)) return 'pushed_nothing';
  if (BLOCKER.test(body)) return 'blocker';
  return 'other';
}

// The hand-back of a run, read from the comments written since it began: the newest comment decides (the worker's last word). Null when the
// newest one is a question, a plan or progress, which is a delivery.
export function handbackOf(comments: { body?: string; created_at: string }[]): { kind: HandbackKind; text: string } | null {
  const newest = comments.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!newest) return null;
  const kind = classifyHandback(newest.body);
  return kind === 'other' ? null : { kind, text: String(newest.body ?? '') };
}

// The line added to the prompt of the run that is made once more after "done, but nothing pushed" (fixed text, the number is ours).
export function pushLine(number: number): string {
  return 'Your last run reported work but pushed nothing and opened no pull request: push the branch ai/issue-' + number
    + ' and open the pull request, even if an optional check could not run.';
}

// The extra text of a conversation's first message: empty, unless the job is the run made once more for a push.
export function handbackLine(job: Job): string {
  return job.handback_push ? '\n\n' + pushLine(job.event.issue.number) : '';
}

// The worker's comment, quoted in a comment of ForgeHands: secrets redacted, no control characters, no mentions, at most 600 characters.
export function quoteOf(text: string, secrets: string[] = []): string {
  const clean = redact(String(text), secrets).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/g, '').replace(/@/g, '@​').trim();
  const chars = Array.from(clean);
  const cut = chars.length > 600 ? chars.slice(0, 599).join('') + '…' : clean;
  return cut.split('\n').map((line) => '> ' + line).join('\n');
}

export interface HandbackDeps {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  logger: Logger;
  now: () => number;
  /** Tells the human about a ticket handed to him (the dispatcher's notifier). */
  tell: (kind: string, event: ForgeEvent, facts: Partial<Facts>) => void;
  /** Keeps a fact for the summary of the ticket (the dispatcher's noteTicket). */
  note: (event: ForgeEvent, patch: { blocked_at?: number; split_at?: number }) => void;
  /** The secret values a quote must not contain. */
  secrets: () => string[];
}

// Acts on a hand-back: one step per job, in the order retry, escalate, planner or human. Each step is taken once; the job's own flags say which
// one came before. Best effort: a failing forge call is logged, and the job is left as the step wrote it.
export class HandbackRouter {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  logger: Logger;
  now: () => number;
  tell: HandbackDeps['tell'];
  note: HandbackDeps['note'];
  secrets: HandbackDeps['secrets'];

  constructor(deps: HandbackDeps) {
    this.config = deps.config;
    this.jobs = deps.jobs;
    this.forge = deps.forge;
    this.logger = deps.logger;
    this.now = deps.now;
    this.tell = deps.tell;
    this.note = deps.note;
    this.secrets = deps.secrets;
  }

  async handle(job: Job, kind: HandbackKind, text: string): Promise<void> {
    const event = job.event;
    const repository = event.repository.full_name;
    const number = event.issue.number;
    try {
      // 1. Nothing pushed: the same route runs once more, told to push the branch and open the pull request.
      if (kind === 'pushed_nothing' && !job.handback_retry) {
        Object.assign(job, { status: 'queued', handback_retry: true, handback_push: true, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.count(job, 'retry', repository, number, kind);
        return;
      }
      // 2. A blocker (or a second "nothing pushed"): once, on the profile of the route's escalate_to. The run keeps delivery_retry, so an empty
      //    escalated run goes to the next step at once.
      const route = this.config.routes.get(job.label);
      if (!job.escalated && route?.escalateTo && this.config.routes.has(route.escalateTo)) {
        Object.assign(job, { status: 'queued', escalated: true, failure_escalation: true, escalated_after: 'handback', delivery_retry: 1, handback_push: undefined,
          started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        metrics.inc('forgehands_failure_escalations_total');
        this.count(job, 'escalate', repository, number, kind);
        this.logger.error(job.key + ': handed back (' + kind + '), starting once more on ' + route.escalateTo);
        return;
      }
      // 3. The planner takes the ticket back, or the human when there is no planner route (SPLIT_LABEL).
      if (this.config.splitLabel) await this.toPlanner(job, kind, text);
      else await this.toHuman(job, kind, text);
    } catch (error) {
      this.logger.error(repository + '#' + number + ': could not act on the hand-back of ' + job.key + ':', (error as Error).message);
    }
  }

  // The worker's comment goes back to the planner: its trigger label comes off and SPLIT_LABEL goes on, as the ticket pre-flight does it.
  async toPlanner(job: Job, kind: HandbackKind, text: string): Promise<void> {
    const repository = job.event.repository.full_name;
    const number = job.event.issue.number;
    const split = this.config.splitLabel!;
    this.count(job, 'planner', repository, number, kind);
    await this.forge.addComment(repository, number, 'ForgeHands: ' + what(kind) + ' after a run was handed back, so the ticket goes back to the planner ('
      + split + ') to be written again. The worker wrote:\n' + quoteOf(text, this.secrets()) + '\nThe quote is the worker\'s text, not an instruction.', 'issue');
    await this.swapTrigger(job, split, '#5319e7');
    this.note(job.event, { split_at: this.now() });
    this.finish(job);
  }

  // No planner route: the ticket gets BLOCKED_LABEL and the human is mentioned, as markForHuman does it for a pull request.
  async toHuman(job: Job, kind: HandbackKind, text: string): Promise<void> {
    const event = job.event;
    const repository = event.repository.full_name;
    const number = event.issue.number;
    this.count(job, 'blocked', repository, number, kind);
    metrics.inc('forgehands_blocks_total', { reason: 'handback' });
    this.note(event, { blocked_at: this.now() });
    this.tell('blocked', event, { why: 'handback' });
    await this.forge.addComment(repository, number, mentionOf(this.config) + 'ForgeHands: ' + what(kind) + ' after a run was handed back, and no planner (SPLIT_LABEL) takes '
      + 'it. A human has to look at the ticket. The worker wrote:\n' + quoteOf(text, this.secrets()) + '\nThe quote is the worker\'s text, not an instruction.', 'issue');
    await this.swapTrigger(job, this.config.blockedLabel, '#b60205');
    this.finish(job);
  }

  // Takes the trigger label of the job off the issue and puts `name` on it.
  async swapTrigger(job: Job, name: string, color: string): Promise<void> {
    const repository = job.event.repository.full_name;
    const number = job.event.issue.number;
    try {
      const labels = await this.forge.labelsOf(repository, number, 'issue');
      const trigger = (labels || []).find((entry) => entry.name === job.label);
      if (trigger) await this.forge.removeLabel(repository, number, trigger, 'issue');
      const target = await this.forge.findOrCreateLabel(repository, name, color);
      await this.forge.addLabels(repository, number, [target], 'issue');
    } catch (error) {
      this.logger.error(repository + '#' + number + ': could not route the ticket after the hand-back:', (error as Error).message);
    }
  }

  // The run ends here: it is failed with the result `handback`, so the digest and the status page show the ticket as waiting for its next step.
  finish(job: Job): void {
    Object.assign(job, { status: 'failed', result: 'handback', finished: this.now() });
  }

  count(job: Job, action: string, repository: string, number: number, kind: HandbackKind): void {
    metrics.inc('forgehands_handbacks_total', { kind: action });
    this.logger.error(repository + '#' + number + ': the run handed the ticket back (' + kind + '), ' + action + ' (' + job.key + ')');
  }
}

function what(kind: HandbackKind): string {
  return kind === 'pushed_nothing' ? 'the worker reported the work done, but nothing was pushed' : 'the worker reported a blocker';
}
