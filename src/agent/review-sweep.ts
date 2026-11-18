import { isBotPull, pullBranch, REVERT_BRANCH } from './bot.ts';
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import type { Merger } from './merge.ts';
import type { Forge } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent, Json, Job, Logger } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';

const FIRST_PASS_MS = 90000;
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

// The reconciler of REVIEW_SWEEP_MINUTES. A review is started by a green commit (webhook) or by a finished round; when an event is lost or
// deferred, or a round ends without a commit, the head of an agent or bot pull request can stay unreviewed for ever. Every pass reads the open
// pull requests of each allowed repository and starts the review of a head that has none in the ledger, when its CI is green (or the repository
// has no CI). It starts the review through the same enqueue path as the webhook, so the job key dedupes against a late event.
export class ReviewSweep {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  merger: Merger;
  enqueue: (event: ForgeEvent) => Promise<{ status: string }>;
  logger: Logger;
  now: () => number;
  running: Promise<number> | null = null;
  cooldown = new Map<string, number>(); // repository#pr@sha -> until when it is not tried again
  timer: NodeJS.Timeout | undefined;
  firstTimer: NodeJS.Timeout | undefined;

  constructor(config: DirectConfig, jobs: JobStore, forge: Forge, merger: Merger, enqueue: (event: ForgeEvent) => Promise<{ status: string }>, logger: Logger, now: () => number = Date.now) {
    this.config = config;
    this.jobs = jobs;
    this.forge = forge;
    this.merger = merger;
    this.enqueue = enqueue;
    this.logger = logger;
    this.now = now;
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

  // The reviews started by this pass.
  async pass(): Promise<number> {
    const now = this.now();
    for (const [key, until] of [...this.cooldown]) if (until <= now) this.cooldown.delete(key);
    const label = [...this.config.routes].find(([, route]) => route.kind === 'ci_success')?.[0];
    if (!label) return 0;
    let starts = 0;
    for (const repository of this.config.allowedRepos) {
      if (starts >= MAX_STARTS) break;
      if (isDry(this.config, repository)) continue; // a dry run starts nothing
      let pulls: Json[];
      try {
        pulls = await this.forge.listPulls(repository, { state: 'open', limit: PULLS_PER_REPOSITORY });
      } catch (error) {
        this.logger.error('review sweep: could not list the open pull requests of ' + repository + ':', error.message);
        continue;
      }
      if (!Array.isArray(pulls)) continue;
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
    return this.jobs.list().some((job: Job) => {
      const onPull = job.event?.repository?.full_name?.toLowerCase() === name && job.event?.pull_request?.number === number;
      if (ACTIVE.has(job.status) && (onPull || job.key.split(':')[0] === issueKey)) return true;
      if (!onPull || job.event.ci?.commit_sha?.toLowerCase() !== sha) return false;
      const kind = this.config.routes.get(job.label)?.kind;
      return kind === 'ci_success' || kind === 'sensitive_review';
    });
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
