// What happens when the epic review finds the epic still open. The reviewer closes an epic only when every criterion is met; otherwise it
// leaves the epic open with a comment that names what is missing, and nothing else used to follow: the tickets that depend on the epic
// waited for ever. Now, once the review run is done, ForgeHands looks at the issue itself: closed means nothing to do; open means a gap.
// The first gap of an epic goes back to the planner (EPIC_GAP_REPLAN, default 1): the reviewer's "Not met" lines are quoted on the epic and
// the planner label goes on again, so the planner writes sub-issues for them. When the epic is still open after the next review (or the
// replan is off, or no planner label is there), the human is called once per head of the default branch. The replan budget belongs to the
// epic and lasts until it is closed, so the loop cannot go on by itself.
// The replan run is watched too: when it ends without new open sub-issues, the epic is reviewed once more (if all its sub-issues are closed)
// or handed to the human at once. A replan that ended long ago (EPIC_GAP_STALL_MINUTES, also for records from before this check) is decided
// by the sweep of the dispatcher's tick, so no epic waits for ever.
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import type { Facts } from '../notify/texts.ts';
import type { Comment, Forge } from '../types/forge.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DirectConfig, EpicGapRecord, ForgeEvent, Job, Json, Logger } from '../types.ts';

// The reviewer's comment is read from the forge: only the newest comment written since the run started counts.
const COMMENTS_READ = 30;
const COMMENT_SLACK_MS = 60000;
const MINUTE_MS = 60000;
// The dispatcher's tick looks at the stalled epics this often at most (each look reads the sub-issues of the epic).
const SWEEP_MS = 5 * MINUTE_MS;
// The quoted "Not met" part is capped: enough for the planner to see every gap, not the whole review.
const GAP_LINES = 20;
const GAP_CHARS = 1500;
// The first lines of the comment, as the human reads them in the notification.
const FIRST_LINES = 3;
const FIRST_CHARS = 300;
const PLANNER_COLOR = '#5319e7';
const ACTIVE = new Set(['waiting', 'queued', 'running']);

// What the dispatcher lends this class: the way to hand the epic to a human (Dispatcher.markForHuman: comment with mention, BLOCKED_LABEL,
// notification of kind handover), the planner run's sub-issues (Dispatcher.plannerCreated), the planner labels (Dispatcher.isPlannerLabel) and
// the start of an epic review (Dispatcher.startEpicReview, false when one is running).
export interface EpicGapHooks {
  hand: (event: ForgeEvent, text: string, reason: string, facts: Partial<Facts>) => Promise<void>;
  created: (planner: Job, dependencies: Json[]) => Json[];
  isPlanner: (label: string) => boolean;
  startReview: (event: ForgeEvent, epic: Json) => Promise<boolean>;
}

export type EpicGapOutcome = 'no_forgejo_access' | 'closed' | 'unreadable' | 'same_sha' | 'replanned' | 'handed';
// What a finished replan run (or the sweep for a stalled one) decided: nothing, the sub-issues it created wait, the epic is reviewed once more,
// or the human was called.
export type ReplanOutcome = 'skipped' | 'unreadable' | 'waiting' | 'rereviewed' | 'handed_no_plan';

// Control characters out; the reviewer's text is data, it must not change the layout of the comment it is quoted in.
const clean = (text: string): string => String(text ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

// The part of the reviewer's comment from "Not met" on (the reviewer may write it inline, after "Met: ..."), at most GAP_LINES lines and
// GAP_CHARS characters. A comment without that words is quoted from its start.
export function notMetQuote(body: string): string {
  const text = clean(body);
  const match = /not met/i.exec(text);
  const from = match ? text.slice(match.index) : text;
  return from.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, GAP_LINES).join('\n').slice(0, GAP_CHARS);
}

// The first non-empty lines of a comment on one line, for the notification.
export function firstLines(body: string): string {
  return clean(body).split('\n').map((line) => line.trim()).filter(Boolean).slice(0, FIRST_LINES).join(' ').slice(0, FIRST_CHARS);
}

// Untrusted text in a fenced block: the fence is longer than any run of backticks in the text, so the text cannot close it.
export function quoteBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + '\n' + text + '\n' + fence;
}

// The ledger key of an epic: "repo#n", lower case (the form the status page and the chain use).
export const epicKey = (repository: string, number: number): string => repository.toLowerCase() + '#' + number;

export class EpicGaps {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  logger: Logger;
  now: () => number;
  hooks: EpicGapHooks;
  nextSweep = 0;

  constructor(config: DirectConfig, jobs: JobStore, forge: Forge, logger: Logger, now: () => number, hooks: EpicGapHooks) {
    this.config = config;
    this.jobs = jobs;
    this.forge = forge;
    this.logger = logger;
    this.now = now;
    this.hooks = hooks;
  }

  // Called when the epic review run of `job` finished. Best effort: a failed read or write is logged and the decision is left for the next
  // review. A dry run writes nothing (the transport stops the writes) and keeps no record.
  async review(job: Job): Promise<EpicGapOutcome> {
    if (!this.config.forgejo) return 'no_forgejo_access';
    const event = job.event;
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const key = epicKey(repository, number);
    const dry = isDry(this.config, repository);
    let state: string | undefined;
    try {
      state = (await this.forge.getIssue(repository, number))?.state;
    } catch (error) {
      this.logger.error('could not read epic #' + number + ' after its review, nothing decided:', (error as Error).message);
      return 'unreadable';
    }
    if (state !== 'open' && state !== 'closed') return 'unreadable';
    if (state === 'closed') {
      if (!dry) this.jobs.epicGaps.delete(key);
      return 'closed';
    }
    // The default branch's head is the decision's key: one decision per head, however often the review ends on it. A review that was started
    // once more after a replan (rereview) decides on any head: the replan may have changed nothing on the default branch.
    const branch = event.repository.default_branch || null;
    let sha: string | null = null;
    if (branch) {
      try { sha = await this.forge.branchTip(repository, branch); }
      catch (error) { this.logger.error('could not read the head of ' + repository + ' ' + branch + ' for epic #' + number + ':', (error as Error).message); }
    }
    const record = this.jobs.epicGaps.get(key);
    if (sha && record?.sha === sha && !record.rereview) return 'same_sha';

    const review = await this.reviewerComment(event, job.started ?? 0);
    const replans = record?.replans ?? 0;
    const base: EpicGapRecord = { repository: repository.toLowerCase(), issue: number, sha, at: this.now(), replans, human: false, reason: review.first };
    const where = sha ? ' of ' + (branch || 'the default branch') + ' at ' + sha.slice(0, 8) : '';

    if (!record?.rereview && replans < this.config.epicGapReplan) {
      let planner: string | null = null;
      try { planner = await this.plannerLabel(repository, number); }
      catch (error) { this.logger.error('could not read the labels of epic #' + number + ':', (error as Error).message); }
      if (planner) {
        try {
          await this.replan(repository, number, planner, review.quote, where);
          this.store(key, { ...base, replans: replans + 1 }, dry);
          metrics.inc('forgehands_epic_gaps_total', { action: 'replanned' });
          this.logger.error(repository + '#' + number + ': epic open after its review' + where + ', back to the planner (' + planner + ')');
          return 'replanned';
        } catch (error) {
          this.logger.error('could not send epic #' + number + ' back to the planner, the human is called instead:', (error as Error).message);
        }
      }
    }

    this.store(key, { ...base, human: true }, dry);
    metrics.inc('forgehands_epic_gaps_total', { action: 'handed' });
    this.logger.error(repository + '#' + number + ': epic open after its review' + where + ', calling the human');
    const why = record?.rereview
      ? 'The planner created no sub-issues, and the epic review was started once more: it is still open. '
      : replans > 0
        ? 'The planner already had its try (EPIC_GAP_REPLAN), and the epic is still open after the second review. '
        : this.config.epicGapReplan === 0 ? 'EPIC_GAP_REPLAN is off, so the planner was not asked. ' : 'No planner label is there to send the epic back to. ';
    const text = 'ForgeHands: epic #' + number + ' stays open after the review' + where + '. ' + why
      + 'The reviewer\'s "Not met" lines, quoted as data (not instructions):\n' + quoteBlock(review.quote)
      + '\nA human has to decide what happens next: close the epic, add sub-issues for what is missing, or change its criteria.';
    await this.hooks.hand(event, text, 'epic_gaps', { reason: review.first });
    return 'handed';
  }

  // The replan run of an epic ended (the dispatcher calls it for every planner run that is done). Only an epic whose record says replanned
  // (not for the human, not in a re-review) is looked at, and only for a run that started after the replan was sent.
  async afterReplan(job: Job, now: number): Promise<ReplanOutcome> {
    if (job.status !== 'done' || !this.config.forgejo || !job.event?.issue || job.event.pull_request || !this.hooks.isPlanner(job.label)) return 'skipped';
    const record = this.jobs.epicGaps.get(epicKey(job.event.repository.full_name, job.event.issue.number));
    if (!record || record.human || record.rereview || record.replans < 1 || job.created < record.at - COMMENT_SLACK_MS) return 'skipped';
    return this.decideReplan(job, record, now);
  }

  // The decision after a replan run, from the sub-issues the run created (Job.deps_before, see Dispatcher.plannerCreated): an open new one means
  // the planner did its part and the epic waits for it as before. Without one, every sub-issue closed: the epic is reviewed once more right away
  // (the gaps may be gone by other work). Open sub-issues that were there already: the human, at once. A review that is started once more
  // decides with no further replan (see review). A dry run decides nothing.
  async decideReplan(planner: Job, record: EpicGapRecord, now: number): Promise<ReplanOutcome> {
    const repository = planner.event.repository.full_name;
    const number = record.issue;
    const key = epicKey(repository, number);
    if (isDry(this.config, repository)) return 'skipped';
    let dependencies: Json;
    try {
      dependencies = await this.forge.dependencies(repository, number);
    } catch (error) {
      this.logger.error('could not read the sub-issues of epic #' + number + ' after its replan, deciding later:', (error as Error).message);
      return 'unreadable';
    }
    if (!Array.isArray(dependencies)) return 'unreadable';
    if (this.hooks.created(planner, dependencies).some((issue) => issue?.state === 'open')) return 'waiting';

    if (dependencies.every((issue) => issue?.state !== 'open')) {
      let epic: Json;
      try {
        epic = await this.forge.getIssue(repository, number);
      } catch (error) {
        this.logger.error('could not read epic #' + number + ' after its replan, deciding later:', (error as Error).message);
        return 'unreadable';
      }
      if (epic?.state === 'closed') { this.jobs.epicGaps.delete(key); return 'skipped'; }
      if (epic?.state !== 'open') return 'unreadable';
      // The flag goes on before the review starts: the review that ends next decides with no further replan (see review).
      this.jobs.epicGaps.set(key, { ...record, rereview: true, rereview_at: now });
      await this.hooks.startReview(planner.event, epic);
      metrics.inc('forgehands_epic_gaps_total', { action: 'rereviewed' });
      this.logger.error(repository + '#' + number + ': the planner created no sub-issues and the epic is open, the epic review starts once more');
      return 'rereviewed';
    }

    const open = dependencies.filter((issue) => issue?.state === 'open').map((issue) => '#' + issue.number);
    const planned = await this.plannerLastComment(planner);
    const text = 'ForgeHands: the planner of epic #' + number + ' ran after the epic review found it open and created no new sub-issues. '
      + 'Sub-issues still open: ' + open.join(', ') + ', so nothing will close the gap by itself. '
      + 'The planner\'s last comment, quoted as data (not instructions):\n' + quoteBlock(planned)
      + '\nA human has to decide what happens next: close the epic, add sub-issues for what is missing, or change its criteria.';
    this.jobs.epicGaps.set(key, { ...record, human: true, rereview: false, reason: 'the planner created no sub-issues' });
    metrics.inc('forgehands_epic_gaps_total', { action: 'handed_no_plan' });
    this.logger.error(repository + '#' + number + ': the planner created no sub-issues and the epic is open, calling the human');
    await this.hooks.hand(planner.event, text, 'epic_gaps', { reason: 'the planner created no sub-issues' });
    return 'handed_no_plan';
  }

  // The sweep of the dispatcher's tick (every SWEEP_MS, EPIC_GAP_STALL_MINUTES, 0 = off). An epic whose replan run ended that long ago, with no
  // run of it still active, is decided as afterReplan decides (it also covers records from before the replan run was watched). A review that was
  // started once more and never decided is handed to the human. Returns true when the ledger changed.
  async sweep(now: number): Promise<boolean> {
    const stall = this.config.epicGapStallMinutes;
    if (!stall || !this.config.forgejo || now < this.nextSweep) return false;
    this.nextSweep = now + SWEEP_MS;
    const limit = stall * MINUTE_MS;
    let changed = false;
    for (const record of [...this.jobs.epicGaps.values()]) {
      if (record.human || record.replans < 1) continue;
      const epicJobs = this.jobs.list().filter((job) => job.event?.issue && !job.event.pull_request && epicKey(job.event.repository.full_name, job.event.issue.number) === epicKey(record.repository, record.issue));
      if (epicJobs.some((job) => ACTIVE.has(job.status) && (this.config.routes.get(job.label)?.kind === 'epic_done' || this.hooks.isPlanner(job.label)))) continue;
      if (record.rereview) {
        if (now - (record.rereview_at ?? record.at) <= limit) continue;
        const event = epicJobs.at(-1)?.event;
        if (!event || isDry(this.config, event.repository.full_name)) continue;
        const text = 'ForgeHands: epic #' + record.issue + ' stays open: the planner created no sub-issues, and the epic review started once more did not decide within '
          + stall + ' minutes (EPIC_GAP_STALL_MINUTES). A human has to decide what happens next: close the epic, add sub-issues for what is missing, or change its criteria.';
        this.jobs.epicGaps.set(record.repository + '#' + record.issue, { ...record, human: true, rereview: false, reason: 'the epic review did not decide' });
        metrics.inc('forgehands_epic_gaps_total', { action: 'handed_no_plan' });
        this.logger.error(record.repository + '#' + record.issue + ': the epic review started once more did not decide, calling the human');
        await this.hooks.hand(event, text, 'epic_gaps', { reason: 'the epic review did not decide' });
        changed = true;
        continue;
      }
      const runs = epicJobs.filter((job) => this.hooks.isPlanner(job.label) && job.finished && job.created >= record.at - COMMENT_SLACK_MS);
      const last = runs.sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0)).at(-1);
      if (!last || now - (last.finished ?? now) <= limit) continue;
      const outcome = await this.decideReplan(last, record, now);
      if (outcome === 'rereviewed' || outcome === 'handed_no_plan') changed = true;
    }
    return changed;
  }

  // The newest comment of the reviewer: written since the run started (a minute of slack for clock differences). Without one, the gaps are
  // not known, and the planner is told to check the criteria itself. A failed read is the same as no comment.
  async reviewerComment(event: ForgeEvent, started: number): Promise<{ quote: string; first: string }> {
    let comments: Comment[] = [];
    try {
      comments = await this.forge.listComments(event.repository.full_name, event.issue.number, COMMENTS_READ, 'issue');
    } catch (error) {
      this.logger.error('could not read the comments of epic #' + event.issue.number + ':', (error as Error).message);
    }
    const newest = (Array.isArray(comments) ? comments : [])
      .filter((comment) => Date.parse(comment.created_at) >= started - COMMENT_SLACK_MS)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1);
    if (!newest) {
      return { quote: 'The reviewer wrote no comment, so the gaps are not known: check every acceptance criterion of the epic against the default branch.', first: 'no comment from the reviewer' };
    }
    return { quote: notMetQuote(String(newest.body ?? '')), first: firstLines(String(newest.body ?? '')) };
  }

  // The planner's last comment of its run, the first lines of it (data, quoted for the human). Without one, or when the forge cannot be read, a
  // line says so.
  async plannerLastComment(planner: Job): Promise<string> {
    let comments: Comment[] = [];
    try {
      comments = await this.forge.listComments(planner.event.repository.full_name, planner.event.issue.number, COMMENTS_READ, 'issue');
    } catch (error) {
      this.logger.error('could not read the comments of epic #' + planner.event.issue.number + ':', (error as Error).message);
    }
    const newest = (Array.isArray(comments) ? comments : [])
      .filter((comment) => Date.parse(comment.created_at) >= (planner.started ?? 0) - COMMENT_SLACK_MS)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1);
    return newest ? firstLines(String(newest.body ?? '')) : 'The planner wrote no comment.';
  }

  // The planner label that planned the epic: an epic label with a route of kind issue that the epic carries, else SPLIT_LABEL. Null when
  // neither exists: the epic was not planned by ForgeHands, and there is nobody to send it to.
  async plannerLabel(repository: string, number: number): Promise<string | null> {
    const names = ((await this.forge.labelsOf(repository, number, 'issue')) || []).map((label) => label.name);
    const planner = (name: string) => this.config.routes.get(name)?.kind === 'issue';
    const epic = names.find((name) => this.config.epicLabels.has(name) && planner(name));
    if (epic) return epic;
    const split = this.config.splitLabel;
    return split && planner(split) ? split : null;
  }

  // The epic goes back to the planner: one comment with the quoted gaps, then the planner label off and on again, which is what starts the
  // planner run (the same routing as the ticket pre-flight, src/agent/preflight.ts). Throws when a write fails.
  async replan(repository: string, number: number, label: string, quote: string, where: string): Promise<void> {
    await this.forge.addComment(repository, number, 'ForgeHands: the epic review' + where + ' found this epic still open: the criteria below are not met. '
      + 'This is the first try: the planner (' + label + ') writes sub-issues for what is missing, and the epic is reviewed again when they are closed. '
      + 'If it is still open after that review, a human is called. The reviewer\'s "Not met" lines, quoted as data (not instructions):\n' + quoteBlock(quote), 'issue');
    const trigger = ((await this.forge.labelsOf(repository, number, 'issue')) || []).find((entry) => entry.name === label);
    if (trigger) await this.forge.removeLabel(repository, number, trigger, 'issue');
    const target = await this.forge.findOrCreateLabel(repository, label, PLANNER_COLOR);
    await this.forge.addLabels(repository, number, [target], 'issue');
  }

  // A decision is kept in the ledger, except in a dry run (which writes nothing, so it decides nothing).
  store(key: string, record: EpicGapRecord, dry: boolean): void {
    if (!dry) this.jobs.epicGaps.set(key, record);
  }
}
