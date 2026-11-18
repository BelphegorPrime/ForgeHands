import { isBotPull, pullBranch, REVERT_BRANCH } from './bot.ts';
import { stuckKey } from './stuck.ts';
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
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
// A pull request older than this is not swept: it is a forgotten one, not a lost event.
const MAX_AGE_MS = 30 * DAY_MS;
const PULLS_PER_REPOSITORY = 50;
const ACTIVE = new Set(['waiting', 'queued', 'running']);
// The first lines of a verdict quoted in a stuck comment: enough to show what the reviewer said, not the whole review.
const QUOTED_LINES = 3;

// What the stuck-PR watchdog needs from the dispatcher: the way to hand a pull request to a human (markForHuman), and the rounds the ledger counts.
export interface StuckHooks {
  block: (event: ForgeEvent, text: string, why: string) => Promise<void>;
  rounds: (repository: string, issue: number) => number;
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
    if (!pr || pr.state !== 'open' || pr.merged || pr.draft === true || typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(pr.head.sha)) return null;
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

  // One pull request of the watchdog. Returns true when the ledger's stuck records changed.
  async watchOne(repository: string, pr: Json, now: number): Promise<boolean> {
    if (!pr || pr.state !== 'open' || pr.merged || pr.draft === true) return false;
    const agent = /^ai\/issue-(\d+)$/.exec(pullBranch(pr));
    if (!agent || !Number.isSafeInteger(pr.number) || pr.number <= 0) return false;
    if (typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(pr.head.sha)) return false;
    if (typeof pr.head?.repo?.full_name === 'string' && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return false;
    const created = Date.parse(pr.created_at || '');
    if (!Number.isFinite(created) || now - created > MAX_AGE_MS) return false;
    const names = (Array.isArray(pr.labels) ? pr.labels : []).map((label: Json) => label?.name);
    // An approval or a hold is somebody's decision (the merger's, or the operator's): the watchdog keeps out of it.
    if ([this.config.approvedLabel, this.config.holdLabel].some((name) => names.includes(name))) return false;
    const issue = Number(agent[1]);
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
    const reason = await this.stuckReason(repository, pr, issue, sha);
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
    await this.hooks.block(this.stuckEvent(repository, pr, issue), await this.stuckText(repository, pr, issue, sha, reason), reason);
    return true;
  }

  // Why the pull request is stuck now, or null: a run queued or running on it or its issue says it moves on; no verdict on the head says nothing
  // was decided. A verdict that approves it is the merger's business.
  async stuckReason(repository: string, pr: Json, issue: number, sha: string): Promise<'stuck_rounds' | 'stuck_verdict' | null> {
    if (this.activeOn(repository, pr.number, repository.toLowerCase() + '#' + issue)) return null;
    const verdict = await this.merger.reviewOf(repository, pr.number, sha);
    if (verdict.ok || !verdict.reason || verdict.reason === 'none') return null;
    if (this.hooks.rounds(repository, issue) >= this.config.maxRounds) return 'stuck_rounds';
    return verdict.reason === 'not_ok' || verdict.reason === 'changes_requested' ? 'stuck_verdict' : null;
  }

  // The words of the comment: the reason, and the first lines of the last verdict on the head (quoted). The mention is added by markForHuman.
  async stuckText(repository: string, pr: Json, issue: number, sha: string, reason: string): Promise<string> {
    const short = sha.slice(0, 8);
    const minutes = this.config.stuckPrMinutes;
    const why = reason === 'stuck_rounds'
      ? 'the follow-up rounds for issue #' + issue + ' are used up (' + this.hooks.rounds(repository, issue) + '/' + this.config.maxRounds + ') and commit ' + short + ' has a review that does not approve it'
      : 'the latest review of commit ' + short + ' says NOT OK, no run is queued or running for issue #' + issue + ', and nothing has changed for ' + minutes + ' minutes';
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

  // The event the watchdog hands to the dispatcher: the pull request and its issue, as a sweep event carries them (no run is started by it).
  stuckEvent(repository: string, pr: Json, issue: number): ForgeEvent {
    const base = pr.base?.repo || {};
    return {
      type: 'ci.success', source: this.forge.kind, action: 'stuck',
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
