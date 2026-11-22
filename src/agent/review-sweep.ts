import { isBotPull, pullBranch, REVERT_BRANCH } from './bot.ts';
import { stuckKey } from './stuck.ts';
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import { holdKey } from './merge.ts';
import type { Merger } from './merge.ts';
import type { Forge } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent, Json, Job, Logger } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';

const FIRST_PASS_MS = 90000;
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// At most this many reviews are started per pass; the rest waits for the next one.
const MAX_STARTS = 5;
// The same commit is tried at most once an hour, even when the enqueue answers `deferred` and nothing is in the ledger.
const COOLDOWN_MS = HOUR_MS;
// An approved pull request whose head is not merged is looked at again by Merger.handle this often (the approval safety net, see sweepApproved).
const APPROVAL_RECHECK_MS = 30 * MINUTE_MS;
// A pull request older than this is not swept: it is a forgotten one, not a lost event.
const MAX_AGE_MS = 30 * DAY_MS;
const PULLS_PER_REPOSITORY = 50;
const ACTIVE = new Set(['waiting', 'queued', 'running']);
// When a job ended (or, without an end, when it started or was made): the ticket watchdog counts from here.
const endOf = (job: Job): number => job.finished ?? job.started ?? job.created;
// The first lines of a verdict quoted in a stuck comment: enough to show what the reviewer said, not the whole review.
const QUOTED_LINES = 3;
// The ticket watchdog reads the issue of at most this many stalled candidates per pass (one forge call each).
const STALL_MAX_READS = 20;

// The line the restarted run of a stalled ticket is given (its message, after the ticket's text). Empty for any other run.
export function stallLine(event: ForgeEvent): string {
  return event.stall_retry
    ? '\n\nYour last run on this ticket ended without a pull request, without a comment and with the ticket still open, so nothing was delivered. '
      + 'This is a fresh run: deliver this time, by pushing the branch ai/issue-' + event.issue.number + ' and opening its pull request, or by closing the ticket when it is done.'
    : '';
}

// What the stuck-PR watchdog needs from the dispatcher: the way to hand a pull request to a human (markForHuman), and the rounds the ledger counts.
export interface StuckHooks {
  block: (event: ForgeEvent, text: string, why: string) => Promise<void>;
  // The follow-up rounds the ledger counts for the event's pull request (its ticket, or its own key for a bot or revert pull request).
  rounds: (event: ForgeEvent) => number;
}

// The reconciler of REVIEW_SWEEP_MINUTES. A review is started by a green commit (webhook) or by a finished round; when an event is lost or
// deferred, or a round ends without a commit, the head of an agent or bot pull request can stay unreviewed for ever. Every pass reads the open
// pull requests of each allowed repository and starts the review of a head that has none in the ledger, when its CI is green (or the repository
// has no CI). It starts the review through the same enqueue path as the webhook, so the job key dedupes against a late event.
// The same pass is the stuck-PR watchdog (STUCK_PR_MINUTES, see watchStuck): an agent pull request that nothing moves on from is blocked for a human.
export class ReviewSweep {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  merger: Merger;
  enqueue: (event: ForgeEvent) => Promise<{ status: string }>;
  logger: Logger;
  now: () => number;
  hooks: StuckHooks;
  running: Promise<number> | null = null;
  cooldown = new Map<string, number>(); // repository#pr@sha -> until when it is not tried again
  approvalCooldown = new Map<string, number>(); // repository#pr@sha -> until when the approval is not handed to the merger again
  timer: NodeJS.Timeout | undefined;
  firstTimer: NodeJS.Timeout | undefined;

  constructor(config: DirectConfig, jobs: JobStore, forge: Forge, merger: Merger, enqueue: (event: ForgeEvent) => Promise<{ status: string }>, logger: Logger, now: () => number = Date.now,
    hooks: StuckHooks = { block: async () => {}, rounds: () => 0 }) {
    this.config = config;
    this.jobs = jobs;
    this.forge = forge;
    this.merger = merger;
    this.enqueue = enqueue;
    this.logger = logger;
    this.now = now;
    this.hooks = hooks;
  }

  // Needs the forge (FORGEJO_URL and FORGEJO_TOKEN) and a route of kind ci_success: without them a review has no way to start.
  get enabled(): boolean {
    return this.config.reviewSweepMinutes > 0 && this.config.forgejo !== null && [...this.config.routes.values()].some((route) => route.kind === 'ci_success');
  }

  start(): void {
    if (!this.enabled) return;
    this.firstTimer = setTimeout(() => { void this.run(); }, FIRST_PASS_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.run(); }, this.config.reviewSweepMinutes * 60000);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  // One pass at a time; a call during a pass gets that pass. Never rejects: an error is logged and ends the pass.
  run(): Promise<number> {
    if (!this.enabled) return Promise.resolve(0);
    if (!this.running) {
      this.running = this.pass()
        .catch((error) => { this.logger.error('review sweep failed:', error.message); return 0; })
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  // The reviews started by this pass (and the watchdog's blocks are counted in the stuck records, not in the return value).
  async pass(): Promise<number> {
    const now = this.now();
    for (const [key, until] of [...this.cooldown]) if (until <= now) this.cooldown.delete(key);
    for (const [key, until] of [...this.approvalCooldown]) if (until <= now) this.approvalCooldown.delete(key);
    const label = [...this.config.routes].find(([, route]) => route.kind === 'ci_success')?.[0];
    if (!label) return 0;
    let starts = 0;
    for (const repository of this.config.allowedRepos) {
      if (isDry(this.config, repository)) continue; // a dry run starts nothing, and blocks nothing
      let pulls: Json[];
      try {
        pulls = await this.forge.listPulls(repository, { state: 'open', limit: PULLS_PER_REPOSITORY });
      } catch (error) {
        this.logger.error('review sweep: could not list the open pull requests of ' + repository + ':', error.message);
        continue;
      }
      if (!Array.isArray(pulls)) continue;
      if (this.config.stuckPrMinutes) await this.watchStuck(repository, pulls, now);
      if (this.config.ticketStallMinutes) await this.watchStalled(repository, pulls, now);
      await this.sweepApproved(repository, pulls, now);
      for (const pr of pulls) {
        if (starts >= MAX_STARTS) break;
        const candidate = this.candidate(repository, pr);
        if (!candidate) continue;
        const sha = String(pr.head.sha).toLowerCase();
        const key = repository + '#' + pr.number + '@' + sha;
        if ((this.cooldown.get(key) || 0) > now) continue;
        if (this.busy(repository, pr.number, candidate, sha)) continue;
        let state: 'green' | 'no_ci' | false;
        try {
          state = await this.merger.ciGreen(repository, sha);
        } catch (error) {
          this.logger.error('review sweep: could not read the status of ' + sha.slice(0, 7) + ' (' + repository + '#' + pr.number + '):', error.message);
          continue;
        }
        if (!state) continue; // pending, failed or not reported: the CI events own that commit
        this.cooldown.set(key, now + COOLDOWN_MS);
        try {
          const result = await this.enqueue(this.eventOf(repository, pr, candidate, sha, label, state));
          if (result.status === 'queued' || result.status === 'deferred') {
            starts += 1;
            metrics.inc('forgehands_review_sweep_starts_total');
            this.logger.error(repository + '#' + pr.number + ': head ' + sha.slice(0, 7) + ' has no review, starting it');
          }
        } catch (error) {
          this.logger.error('review sweep: could not start the review of ' + repository + '#' + pr.number + ':', error.message);
        }
      }
    }
    return starts;
  }

  // Is this an agent pull request (ai/issue-<n>, in the repository itself), a revert pull request, or a bot pull request the config lets through?
  // Labels that already say something (approved, changes, blocked, hold), a draft, a head from a fork, or a pull request too old: no.
  candidate(repository: string, pr: Json): { issue: number; bot: boolean } | null {
    if (!pr || pr.state !== 'open' || pr.merged || this.isDraft(pr) || typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(pr.head.sha)) return null;
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
    const ref = pullBranch(pr);
    if (typeof pr.head?.repo?.full_name === 'string' && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return null;
    const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((label: Json) => label?.name);
    if ([this.config.approvedLabel, this.config.changesLabel, this.config.blockedLabel, this.config.holdLabel].some((name) => labels.includes(name))) return null;
    const created = Date.parse(pr.created_at || '');
    if (!Number.isFinite(created) || this.now() - created > MAX_AGE_MS) return null;
    const agent = /^ai\/issue-(\d+)$/.exec(ref);
    if (agent) return { issue: Number(agent[1]), bot: false };
    const bots = { authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos };
    if (REVERT_BRANCH.test(ref) || isBotPull(bots, pr, repository)) return { issue: pr.number, bot: true };
    return null;
  }

  // A draft in the sense of the forge's own mark. Forgejo's `draft` follows a `WIP:` title, and every agent pull request keeps its WIP title until
  // it is merged (merge.ts strips it then). So a draft with a WIP title is the normal state of an agent pull request, and is watched and swept;
  // a draft by the author (no WIP marker) is left alone.
  isDraft(pr: Json): boolean {
    return pr.draft === true && !this.forge.isWip(String(pr.title || ''));
  }

  // Forgejo reports `mergeable: false` for a pull request titled with the WIP marker, whatever its branch (dispatch.ts and merge.ts know this too).
  // So a conflict is only one when the title is clean. The draft needs no test of its own here: a draft without the marker is skipped before this.
  conflicts(pr: Json): boolean {
    return pr.mergeable === false && !this.forge.isWip(String(pr.title || ''));
  }

  // Busy: a job of this pull request (or of its issue) is waiting, queued or running; or the head already has a review or a security review in the
  // ledger, whatever its state (a failed one is the retry logic's business, not the sweep's).
  busy(repository: string, number: number, candidate: { issue: number; bot: boolean }, sha: string): boolean {
    const name = repository.toLowerCase();
    // A bot or revert pull request has no ticket: its ledger key is "repo!pr<n>", an agent's is "repo#<issue>".
    const issueKey = candidate.bot ? name + '!pr' + number : name + '#' + candidate.issue;
    if (this.activeOn(repository, number, issueKey)) return true;
    return this.jobs.list().some((job: Job) => {
      const onPull = job.event?.repository?.full_name?.toLowerCase() === name && job.event?.pull_request?.number === number;
      if (!onPull || job.event.ci?.commit_sha?.toLowerCase() !== sha) return false;
      const kind = this.config.routes.get(job.label)?.kind;
      return kind === 'ci_success' || kind === 'sensitive_review';
    });
  }

  // A job waiting, queued or running on this pull request or on its ticket (`issueKey`: "repo#<issue>" or "repo!pr<n>").
  activeOn(repository: string, number: number, issueKey: string): boolean {
    const name = repository.toLowerCase();
    return this.jobs.list().some((job: Job) => {
      const onPull = job.event?.repository?.full_name?.toLowerCase() === name && job.event?.pull_request?.number === number;
      return ACTIVE.has(job.status) && (onPull || job.key.split(':')[0] === issueKey);
    });
  }

  // STUCK_PR_MINUTES: the watchdog over the open agent pull requests of a repository (ai/issue-<n>), run in each pass. It blocks one that nothing
  // moves on from, once per head and reason: (a) the follow-up rounds are used up (MAX_ROUNDS), or (b) the latest verdict on the head says NOT OK
  // and nothing is queued or running for the issue, for STUCK_PR_MINUTES. Both need a verdict on the head: a pull request waiting for its CI or its
  // first review is left alone. Blocking is the dispatcher's markForHuman (the comment, BLOCKED_LABEL, the notification). A pull request that
  // carries BLOCKED_LABEL is recorded (the status page marks the tickets that wait behind it); when the label comes off, it is eligible again after
  // the same grace, and a new head starts its own grace. Records of pull requests that are no longer open are dropped.
  async watchStuck(repository: string, pulls: Json[], now: number): Promise<void> {
    let changed = false;
    const open = new Set<number>();
    for (const pr of pulls) {
      open.add(pr?.number);
      try {
        if (await this.watchOne(repository, pr, now)) changed = true;
      } catch (error) {
        this.logger.error('stuck watchdog: could not look at ' + repository + '#' + pr?.number + ':', error.message);
      }
    }
    for (const [key, record] of [...this.jobs.stuck]) {
      if (record.repository.toLowerCase() !== repository.toLowerCase() || open.has(record.number)) continue;
      try {
        const pr = await this.forge.getPull(repository, record.number);
        if (pr && pr.state === 'open' && !pr.merged) continue;
      } catch (error) {
        // A pull request the forge cannot read stays on record; a 404 means it is gone.
        if (!/HTTP 404\b/.test(error.message)) continue;
      }
      this.jobs.stuck.delete(key);
      changed = true;
    }
    if (changed) {
      try { await this.jobs.persist(now); }
      catch (error) { this.logger.error('stuck watchdog: could not save the ledger:', error.message); }
    }
  }

  // TICKET_STALL_MINUTES: the ticket watchdog, run in each pass after watchStuck. An open ticket on an issue route (not an epic, not a planner ticket)
  // whose last ForgeHands run ended (done or failed) at least that long ago is stalled when no open agent pull request from ai/issue-<n> exists,
  // no run of it waits, is queued or runs, and it carries neither BLOCKED_LABEL nor HOLD_LABEL. The first time it is started once more: on the
  // escalate_to of its route when there is one, else on its own route, with the stallLine. The second time the human is called (markForHuman, reason
  // `stalled_ticket`): the tickets that wait behind it show `waiting behind stalled #n`. One record per ticket (StalledRecord, the ledger's `stalled`);
  // it goes when the ticket is no longer stalled (a pull request, a closed ticket, a label), and once the human has taken BLOCKED_LABEL off. A run that
  // could not be started is handed to the human at once. Returns the number of tickets acted on.
  async watchStalled(repository: string, pulls: Json[], now: number): Promise<number> {
    const name = repository.toLowerCase();
    const minutes = this.config.ticketStallMinutes;
    if (!minutes) return 0;
    const agent = new Set<number>();
    for (const pr of pulls) {
      const match = /^ai\/issue-(\d+)$/.exec(pullBranch(pr));
      if (match && pr?.state === 'open' && !pr.merged) agent.add(Number(match[1]));
    }
    // The runs of each ticket of this repository (a dependency bot's or a pull request's run has no ticket of its own).
    const runs = new Map<number, Job[]>();
    for (const job of this.jobs.list()) {
      if (job.event?.repository?.full_name?.toLowerCase() !== name || job.event.pull_request || job.event.bot) continue;
      const number = job.event.issue?.number;
      if (!Number.isSafeInteger(number)) continue;
      runs.set(number, [...(runs.get(number) ?? []), job]);
    }
    const numbers = new Set([...runs.keys(), ...[...this.jobs.stalled.values()].filter((record) => record.repository.toLowerCase() === name).map((record) => record.issue)]);
    let reads = 0;
    let acted = 0;
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const key = name + '#' + number;
      const record = this.jobs.stalled.get(key);
      const own = runs.get(number) ?? [];
      // A run that waits, is queued or runs: the ticket moves on (its record, if any, stays).
      if (own.some((job) => ACTIVE.has(job.status))) continue;
      if (agent.has(number)) { if (record) { this.jobs.stalled.delete(key); acted += 1; } continue; }
      const last = own.reduce<Job | null>((newest, job) => (!newest || endOf(job) > endOf(newest) ? job : newest), null);
      if (!last || (last.status !== 'done' && last.status !== 'failed')) { if (!last && record) this.jobs.stalled.delete(key); continue; }
      if (reads >= STALL_MAX_READS) break;
      reads += 1;
      let issue: Json;
      try {
        issue = await this.forge.getIssue(repository, number);
      } catch (error) {
        this.logger.error('ticket watchdog: could not read ' + repository + '#' + number + ':', error.message);
        continue;
      }
      if (!issue || issue.state !== 'open') { if (record) { this.jobs.stalled.delete(key); acted += 1; } continue; }
      const labels: string[] = (issue.labels || []).map((label: Json) => label?.name);
      if (labels.some((label) => this.config.epicLabels.has(label) || label === this.config.splitLabel)) continue; // epics and planner tickets: the epic-gap path
      // The human took BLOCKED_LABEL off: the record goes, and the ticket is looked at afresh.
      if (record?.human && !labels.includes(this.config.blockedLabel)) { this.jobs.stalled.delete(key); acted += 1; }
      const current = this.jobs.stalled.get(key);
      if (labels.includes(this.config.blockedLabel) || labels.includes(this.config.holdLabel)) continue;
      const route = this.config.routes.get(last.label);
      if (route?.kind !== 'issue' || this.config.epicLabels.has(last.label) || last.label === this.config.splitLabel) continue;
      if (current?.run === last.id) continue; // acted on this run already
      if (now - endOf(last) < minutes * MINUTE_MS) continue;
      if (!current) {
        const target = route.escalateTo && this.config.routes.has(route.escalateTo) ? route.escalateTo : last.label;
        let status = 'failed';
        try {
          status = (await this.enqueue(this.stallEvent(last.event, target))).status;
        } catch (error) {
          this.logger.error('ticket watchdog: could not start ' + repository + '#' + number + ' once more:', error.message);
        }
        const restarted = status === 'queued' || status === 'waiting' || status === 'deferred';
        metrics.inc('forgehands_stalled_ticket_actions_total', { action: restarted ? 'restart' : 'human' });
        this.logger.error(repository + '#' + number + ': stalled (its last run ' + last.id + ' ended without a delivery), ' + (restarted ? 'started once more on ' + target : 'the start failed, the human is called'));
        this.jobs.stalled.set(key, { repository: name, issue: number, run: last.id, restarts: 1, human: !restarted, at: now });
        acted += 1;
        if (!restarted) await this.hooks.block(this.ticketEvent(last.event), this.stalledText(number, minutes, 'the start did not work'), 'stalled_ticket');
        continue;
      }
      // A restarted run that ended without a delivery too: the human is called.
      metrics.inc('forgehands_stalled_ticket_actions_total', { action: 'human' });
      this.logger.error(repository + '#' + number + ': stalled again after the restart (' + last.id + '), the human is called');
      this.jobs.stalled.set(key, { repository: name, issue: number, run: last.id, restarts: current.restarts, human: true, at: now });
      acted += 1;
      await this.hooks.block(this.ticketEvent(last.event), this.stalledText(number, minutes, 'the run started once more ended the same way'), 'stalled_ticket');
    }
    if (acted) {
      try { await this.jobs.persist(now); }
      catch (error) { this.logger.error('ticket watchdog: could not save the ledger:', error.message); }
    }
    return acted;
  }

  // The event a restart is enqueued with: the ticket of the last run, on the label to start with, marked as a stall retry.
  stallEvent(base: ForgeEvent, label: string): ForgeEvent {
    return { ...base, label, label_event: false, previous_labels: undefined, ci: undefined, comment: undefined, stall_retry: true } as ForgeEvent;
  }

  // The ticket of a run as the human notice needs it (markForHuman reads the repository and the issue).
  ticketEvent(base: ForgeEvent): ForgeEvent {
    return { ...base, label: undefined, label_event: undefined, ci: undefined, pull_request: undefined, bot: undefined } as ForgeEvent;
  }

  // The words of the notice for a stalled ticket (the mention is added by markForHuman).
  stalledText(number: number, minutes: number, detail: string): string {
    return 'ForgeHands: issue #' + number + ' is stalled: its last run ended without a pull request, without a comment and with the ticket still open, and ' + detail
      + '. A human has to look at the ticket. Removing ' + this.config.blockedLabel + ' lets ForgeHands look at it again (it waits ' + minutes + ' minutes after its last run).';
  }

  // One pull request of the watchdog. Returns true when the ledger's stuck records changed. An agent pull request (ai/issue-<n>) has its ticket
  // n; a revert pull request (ai/revert-<n>, see REVERT_BRANCH) has the ticket of the original pull request from the revert ledger, or none (0).
  async watchOne(repository: string, pr: Json, now: number): Promise<boolean> {
    if (!pr || pr.state !== 'open' || pr.merged || this.isDraft(pr)) return false;
    const branch = pullBranch(pr);
    const agent = /^ai\/issue-(\d+)$/.exec(branch);
    if (!agent && !REVERT_BRANCH.test(branch)) return false;
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) return false;
    if (typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(pr.head.sha)) return false;
    if (typeof pr.head?.repo?.full_name === 'string' && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return false;
    const created = Date.parse(pr.created_at || '');
    if (!Number.isFinite(created) || now - created > MAX_AGE_MS) return false;
    const names = (Array.isArray(pr.labels) ? pr.labels : []).map((label: Json) => label?.name);
    // An approval or a hold is somebody's decision (the merger's, or the operator's): the watchdog keeps out of it.
    if ([this.config.approvedLabel, this.config.holdLabel].some((name) => names.includes(name))) return false;
    const issue = agent ? Number(agent[1]) : (this.revertTicket(repository, pr.number) ?? 0);
    const event = this.stuckEvent(repository, pr, issue, !agent);
    const sha = pr.head.sha.toLowerCase();
    const key = stuckKey(repository, pr.number);
    let record = this.jobs.stuck.get(key);
    let changed = false;
    if (names.includes(this.config.blockedLabel)) {
      if (record?.blocked) return false;
      // Blocked by somebody else (a human, or rounds that ran out before this watchdog): the record only tells the tickets that wait behind it.
      this.jobs.stuck.set(key, { repository, issue, number: pr.number, sha, why: 'label', blocked: true, eligible_at: now, blocked_at: now });
      return true;
    }
    if (record?.blocked) {
      // The label came off (a human took it off): eligible again, after the grace counted from now.
      record.blocked = false;
      record.eligible_at = now + this.config.stuckPrMinutes * MINUTE_MS;
      changed = true;
    }
    const reason = await this.stuckReason(repository, pr, event, sha);
    if (!reason) {
      if (record) this.jobs.stuck.delete(key);
      return changed || !!record;
    }
    // A new head or another reason starts a new record; its grace counts from now, except for rounds used up on a pull request never seen before.
    if (!record || record.sha !== sha || record.why !== reason) {
      record = { repository, issue, number: pr.number, sha, why: reason, blocked: false, eligible_at: !record && reason === 'stuck_rounds' ? now : now + this.config.stuckPrMinutes * MINUTE_MS, blocked_at: null };
      this.jobs.stuck.set(key, record);
      changed = true;
    }
    if (now < record.eligible_at) return changed;
    record.blocked = true;
    record.blocked_at = now;
    metrics.inc('forgehands_stuck_pr_blocks_total', { reason });
    this.logger.error(repository + '#' + pr.number + ': stuck (' + reason + ') at head ' + sha.slice(0, 7) + ', blocking it for a human');
    await this.hooks.block(event, await this.stuckText(repository, pr, event, sha, reason), reason);
    return true;
  }

  // The ticket (issue number) of a revert pull request, from the revert ledger; null when the ledger has no record of it.
  revertTicket(repository: string, number: number): number | null {
    const name = repository.toLowerCase();
    const record = this.jobs.reverts.find((entry) => entry.repository.toLowerCase() === name && entry.number === number);
    return record && Number.isSafeInteger(record.issue) && record.issue > 0 ? record.issue : null;
  }

  // Why the pull request is stuck now, or null. A run queued, waiting or running on it (or on its ticket) says it moves on. Otherwise, in this order:
  // (a) the rounds are used up and the latest verdict on the head is not OK (`stuck_rounds`); (b) Forgejo reports a merge conflict with the default
  // branch and no conflict round is on its way (`stuck_conflict`, never for a WIP title: see `conflicts`); (c) the latest verdict says NOT OK or asks for changes (`stuck_verdict`).
  // No verdict and no conflict says nothing was decided, so the pull request is left alone. An approval that is not merged yet is the merger's business.
  async stuckReason(repository: string, pr: Json, event: ForgeEvent, sha: string): Promise<'stuck_rounds' | 'stuck_verdict' | 'stuck_conflict' | null> {
    const name = repository.toLowerCase();
    const issueKey = event.bot ? name + '!pr' + pr.number : name + '#' + event.issue.number;
    if (this.activeOn(repository, pr.number, issueKey)) return null;
    const verdict = await this.merger.reviewOf(repository, pr.number, sha);
    const decided = !verdict.ok && !!verdict.reason && verdict.reason !== 'none';
    if (decided && this.hooks.rounds(event) >= this.config.maxRounds) return 'stuck_rounds';
    if (this.conflicts(pr)) return 'stuck_conflict';
    return decided && (verdict.reason === 'not_ok' || verdict.reason === 'changes_requested') ? 'stuck_verdict' : null;
  }

  // The words of the comment: the reason, and the first lines of the last verdict on the head (quoted). The mention is added by markForHuman.
  async stuckText(repository: string, pr: Json, event: ForgeEvent, sha: string, reason: string): Promise<string> {
    const short = sha.slice(0, 8);
    const minutes = this.config.stuckPrMinutes;
    // The ticket of the pull request: an agent's issue, a revert's original ticket, or none (0).
    const issue = event.issue.number;
    const subject = issue ? 'issue #' + issue : 'this pull request';
    const rounds = this.hooks.rounds(event);
    const why = reason === 'stuck_rounds'
      ? 'the follow-up rounds for ' + subject + ' are used up (' + rounds + '/' + this.config.maxRounds + ') and commit ' + short + ' has a review that does not approve it'
      : reason === 'stuck_conflict'
        ? 'commit ' + short + ' conflicts with ' + (event.repository.default_branch || 'the default branch') + ' (Forgejo says it is not mergeable), and no run is queued or running on it'
        : 'the latest review of commit ' + short + ' says NOT OK, no run is queued or running for ' + subject + ', and nothing has changed for ' + minutes + ' minutes';
    let quote = '';
    try {
      const lines = await this.merger.verdictLines(repository, pr.number, sha);
      if (lines.length) quote = 'The last verdict starts:\n' + lines.slice(0, QUOTED_LINES).map((line) => '> ' + line).join('\n') + '\n';
    } catch (error) {
      this.logger.error('stuck watchdog: could not read the verdict of ' + repository + '#' + pr.number + ':', error.message);
    }
    return 'ForgeHands: this pull request is stuck: ' + why + '.\n' + quote + 'A human has to look at it. Pushing a commit, or removing ' + this.config.blockedLabel
      + ', lets ForgeHands look at it again.';
  }

  // The approval safety net: an open pull request that carries the approval label, whose head has an OK verdict and green CI and is not merged, is
  // handed to Merger.handle once per head and APPROVAL_RECHECK_MS. A lost or early webhook cannot strand it. Never merged here: a blocked or
  // held pull request (BLOCKED_LABEL, HOLD_LABEL, a two-key hold in the ledger), a draft, a pull request that touches a protected path (the
  // merge policy's deny list, the hand-over is the dispatcher's), a pull request with a job of its own running or queued. Returns the number handled.
  async sweepApproved(repository: string, pulls: Json[], now: number): Promise<number> {
    if (!this.config.forgejo || !this.config.mergePolicy.get(repository.toLowerCase())) return 0;
    let handled = 0;
    for (const pr of pulls) {
      const ref = this.approvedCandidate(repository, pr);
      if (!ref) continue;
      const sha = String(pr.head.sha).toLowerCase();
      const key = repository + '#' + pr.number + '@' + sha;
      if ((this.approvalCooldown.get(key) || 0) > now) continue;
      if (this.activeOn(repository, pr.number, ref.issueKey) || this.merger.ledger?.holds.has(holdKey(repository, pr.number))) continue;
      try {
        if (!(await this.merger.reviewOf(repository, pr.number, sha)).ok) continue;
        if (!(await this.merger.ciGreen(repository, sha))) continue;
        const policy = this.config.mergePolicy.get(repository.toLowerCase())!;
        if ((await this.merger.changedFiles(repository, pr.number)).some((name) => policy.deny.some((pattern) => pattern.test(name)))) continue;
      } catch (error) {
        this.logger.error('approval sweep: could not read ' + repository + '#' + pr.number + ':', error.message);
        continue;
      }
      this.approvalCooldown.set(key, now + APPROVAL_RECHECK_MS);
      this.logger.error(repository + '#' + pr.number + ': approved and green at head ' + sha.slice(0, 7) + ' but not merged, the approval sweep hands it to the merger');
      handled += 1;
      await this.merger.handle(this.approvalEvent(repository, pr, ref.issue));
    }
    return handled;
  }

  // The candidates of sweepApproved: an open agent, revert or listed bot pull request in this repository, with the approval label, no label that
  // holds it back, not a draft, from the repository itself; `issueKey` is its ledger key ("repo#<issue>" or "repo!pr<n>").
  approvedCandidate(repository: string, pr: Json): { issue: number; issueKey: string } | null {
    if (!pr || pr.state !== 'open' || pr.merged || this.isDraft(pr) || typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(pr.head.sha)) return null;
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
    if (typeof pr.head?.repo?.full_name === 'string' && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return null;
    const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((label: Json) => label?.name);
    if (!labels.includes(this.config.approvedLabel) || [this.config.blockedLabel, this.config.holdLabel].some((name) => labels.includes(name))) return null;
    const created = Date.parse(pr.created_at || '');
    if (!Number.isFinite(created) || this.now() - created > MAX_AGE_MS) return null;
    const ref = pullBranch(pr);
    const agent = /^ai\/issue-(\d+)$/.exec(ref);
    const name = repository.toLowerCase();
    if (agent) return { issue: Number(agent[1]), issueKey: name + '#' + Number(agent[1]) };
    const bots = { authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos };
    if (REVERT_BRANCH.test(ref) || isBotPull(bots, pr, repository)) return { issue: pr.number, issueKey: name + '!pr' + pr.number };
    return null;
  }

  // The event the approval safety net hands to Merger.handle: the pull request, as the approval label event carries it (the merger reads the rest).
  approvalEvent(repository: string, pr: Json, issue: number): ForgeEvent {
    const base = pr.base?.repo || {};
    return {
      type: 'pull_request.approved', source: this.forge.kind, action: 'sweep', label: this.config.approvedLabel,
      repository: { full_name: repository, clone_url: base.clone_url || null, html_url: base.html_url || null, default_branch: base.default_branch || null },
      issue: { number: issue, title: String(pr.title || '').slice(0, 1000), body: '', html_url: pr.html_url || null, comments: 0, labels: [] },
      pull_request: { number: pr.number, head_ref: pullBranch(pr), html_url: pr.html_url || null },
      sender: { login: null }
    } as ForgeEvent;
  }

  // The event the watchdog hands to the dispatcher: the pull request and its ticket, as a sweep event carries them (no run is started by it).
  // A bot or revert pull request (`bot`) has no ticket of its own: its ledger key is "repo!pr<n>", as for any bot pull request.
  stuckEvent(repository: string, pr: Json, issue: number, bot: boolean): ForgeEvent {
    const base = pr.base?.repo || {};
    return {
      type: 'ci.success', source: this.forge.kind, action: 'stuck', ...(bot ? { bot: true } : {}),
      repository: { full_name: repository, clone_url: base.clone_url || null, html_url: base.html_url || null, default_branch: base.default_branch || null },
      issue: { number: issue, title: String(pr.title || '').slice(0, 1000), body: '', html_url: pr.html_url || null, comments: 0, labels: [] },
      pull_request: { number: pr.number, head_ref: pullBranch(pr), html_url: pr.html_url || null },
      sender: { login: null }
    } as ForgeEvent;
  }

  // The event a green commit makes (see onBranchPush and normalizeCiRun): a ci.success of this pull request, with the action `sweep`.
  eventOf(repository: string, pr: Json, candidate: { issue: number; bot: boolean }, sha: string, label: string, state: 'green' | 'no_ci'): ForgeEvent {
    const base = pr.base?.repo || {};
    return {
      type: 'ci.success', source: this.forge.kind, action: 'sweep', ...(candidate.bot ? { bot: true } : {}), label,
      repository: { full_name: repository, clone_url: base.clone_url || null, html_url: base.html_url || null, default_branch: base.default_branch || null },
      issue: { number: candidate.issue, title: String(pr.title || '').slice(0, 1000), body: String(pr.body || '').slice(0, 50000), html_url: pr.html_url || null,
        comments: Number.isSafeInteger(pr.comments) && pr.comments > 0 ? pr.comments : 0, labels: [] },
      pull_request: { number: pr.number, head_ref: pullBranch(pr), html_url: pr.html_url || null },
      ci: { run_id: null, workflow: '', commit_sha: sha, status: state === 'no_ci' ? 'no_ci' : 'success', html_url: null },
      sender: { login: pr.user?.login || null }
    };
  }
}
