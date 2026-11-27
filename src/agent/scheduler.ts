// Which queued job starts next, and starting it: the order of the queue, the limits per tier, repository and hour, quota and disk holds,
// and the start of a conversation.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { buildPrompt } from './prompt.ts';
import { checkFacts } from './checks.ts';
import { isDry } from '../dry.ts';
import { stallLine } from './review-sweep.ts';
import { handbackLine } from './handback.ts';
import { metrics } from '../metrics.ts';
import type { Job, Json } from '../types.ts';
import { RETRY_BASE_MS, MAX_ATTEMPTS, ROUND_KINDS, RECENT_STARTS } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What Scheduler reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type SchedulerHost = Pick<Dispatcher, 'api' | 'commitGreen' | 'commitRecovered' | 'config' | 'effectiveRoute' | 'escalationTarget' | 'forge' | 'isPlannerLabel' | 'isStale' | 'jobs' | 'logger' | 'merger' | 'nudger' | 'openDependencies' | 'parallelReview' | 'preflight' | 'roundLimit' | 'rounds' | 'roundsUsedUp' | 'route' | 'securityReview' | 'tierOf' | 'waitKeeper' | 'workspace'>;

export class Scheduler {
  host: SchedulerHost;
  cooldowns = new Map<string, number>(); // tier -> until when its model is out of quota (not kept across a restart: the next error sets it again)

  constructor(host: SchedulerHost) {
    this.host = host;
  }

  // When a job that hit a quota hold may start again: the earliest end of the holds of the routes it can run on (its own or escalated route
  // and that route's fallback), or undefined when one of them is free now (a fallback takes over at once).
  earliestStart(job: Job, now: number): number | undefined {
    const base = this.host.escalationTarget(job) ?? this.host.route(job.label);
    const tiers = [base.tier, ...(base.fallbackTo && this.host.config.routes.get(base.fallbackTo) ? [this.host.config.routes.get(base.fallbackTo)!.tier] : [])];
    const earliest = Math.min(...tiers.map((tier) => this.cooldowns.get(tier) || 0));
    return earliest > now ? earliest : undefined;
  }

  // A CI outcome kept while an agent worked on the issue. Once no run of the issue is active any more it is judged as if it had just
  // arrived: gone when its commit is no longer the head or the status is not green (a later event can come again), otherwise started.
  async releaseDeferred(job: Job, now: number): Promise<boolean> {
    const base = job.key.split(':')[0] + ':';
    if (this.host.jobs.list(true).some((other) => other.id !== job.id && !other.waiting_for_run && other.key.startsWith(base) && !this.host.parallelReview(other, job.event))) {
      if (job.created + this.host.config.maxRunMs < now) { this.host.jobs.remove(job.id); return true; }
      return false;
    }
    const event = job.event;
    const kind = this.host.config.routes.get(job.label)?.kind;
    let start = !(await this.host.isStale(event));
    if (start && (kind === 'ci_success' || kind === 'sensitive_review')) start = await this.host.commitGreen(event);
    if (start && kind === 'ci_failure') start = !(await this.host.commitRecovered(event));
    if (start && ROUND_KINDS.has(kind) && this.host.rounds(event) >= this.host.roundLimit(event)) {
      await this.host.roundsUsedUp(event);
      start = false;
    }
    if (!start) { this.host.jobs.remove(job.id); return true; }
    delete job.waiting_for_run;
    job.status = 'queued';
    await this.host.merger.clearApproval(event);
    if (kind === 'ci_success') await this.host.securityReview.startSecurityReview(event);
    return true;
  }

  // The hold on a tier lives in memory and is gone after a restart; the wait of a job that was queued again for a rate limit lives in the
  // ledger. A restart clears both, so that it means "try again now" (the quota may be back, or the model was changed). If the model is still
  // out of quota the first attempt fails again and sets the hold anew (a counter keeps that from going on for ever).
  clearQuotaHolds(): number {
    let cleared = 0;
    for (const job of this.host.jobs.list('queued')) {
      if (job.retry_at) { delete job.next_try; delete job.retry_at; cleared += 1; }
    }
    return cleared;
  }

  // Which queued job gets the next free slot. Between repositories the starts are shared by weight (REPO_WEIGHTS, default 1; a higher weight
  // means more of the starts): the repository with the fewest recent starts per unit of weight goes first, so weights 2, 1 and 5 give 2 of 8,
  // 1 of 8 and 5 of 8 starts when all three have work. Within a repository see `before`: begun tickets first, then the oldest ticket (lowest
  // issue number) that can start now, not the one that was queued first. A repository without a startable job does not take a share: the others use it.
  pickNext(now: number, tried: Set<string>): Job | null {
    const heads = new Map<string, Job>();
    for (const job of this.host.jobs.list('queued')) {
      if (tried.has(job.id) || (job.next_try && job.next_try > now) || !this.hasRoom(job, now)) continue;
      const repo = job.event.repository.full_name.toLowerCase();
      const best = heads.get(repo);
      if (!best || this.before(job, best)) heads.set(repo, job);
    }
    if (!heads.size) return null;
    const recent = new Map<string, number>();
    for (const job of this.host.jobs.list().filter((entry) => entry.started).sort((a, b) => (b.started || 0) - (a.started || 0)).slice(0, RECENT_STARTS)) {
      const repo = job.event.repository.full_name.toLowerCase();
      recent.set(repo, (recent.get(repo) || 0) + 1);
    }
    let pick: { repo: string; job: Job; score: number; weight: number } | null = null;
    for (const [repo, job] of heads) {
      const weight = this.host.config.repoWeights.get(repo) ?? 1;
      const score = (recent.get(repo) || 0) / weight;
      if (!pick || score < pick.score || (score === pick.score && (weight > pick.weight || (weight === pick.weight && repo < pick.repo)))) pick = { repo, job, score, weight };
    }
    return pick!.job;
  }

  // Order within a repository: work on a ticket that has begun (a round, a review, a fix, a conflict, an epic review) before a new ticket, so
  // that what was started gets finished; then the lowest issue number; then the job that was queued first.
  before(a: Job, b: Job): boolean {
    const begun = (job: Job) => (job.event.pull_request || job.event.type === 'epic.done' ? 0 : 1);
    if (begun(a) !== begun(b)) return begun(a) < begun(b);
    if (a.event.issue.number !== b.event.issue.number) return a.event.issue.number < b.event.issue.number;
    return a.created < b.created;
  }

  hasRoom(job: Job, now: number): boolean {
    return this.holdOf(job, now) === null;
  }

  // The limit that keeps a queued job from starting now, checked in this order, or null when it may start: low disk space (DISK_MIN_FREE_GB, running
  // jobs are not touched), the global concurrency, the quota hold of its tier (`tier` is that tier), the concurrency of its tier, the hourly limit.
  holdOf(job: Job, now: number): { reason: 'disk' | 'quota' | 'concurrency' | 'hourly'; tier?: string } | null {
    if (this.host.workspace.holding) return { reason: 'disk' };
    const running = this.host.jobs.list('running');
    if (running.length >= this.host.config.maxConcurrent) return { reason: 'concurrency' };
    const effective = this.host.effectiveRoute(job, now).route;
    const tier = effective.tier;
    if ((this.cooldowns.get(tier) || 0) > now) return { reason: 'quota', tier };
    const tierLimit = effective.maxConcurrent ?? this.host.config.maxConcurrentPerTier;
    if (running.filter((other) => this.host.tierOf(other) === tier).length >= tierLimit) return { reason: 'concurrency' };
    const startedLastHour = this.host.jobs.list().filter((other) => other.started && other.started > now - 3600000).length;
    if (startedLastHour >= this.host.config.maxRunsPerHour) return { reason: 'hourly' };
    return null;
  }

  async startJob(job: Job, now: number): Promise<boolean> {
    // Dependencies are looked at when the job is queued, but an edge may be added afterwards (a ticket labelled before its dependencies were
    // set): look again before a worker starts, so that the order the edges give is kept.
    if (this.host.config.routes.get(job.label)?.kind === 'issue' && !job.event.pull_request && this.host.config.forgejo) {
      const open = await this.host.openDependencies(job.event, job.event.issue.number);
      // The ticket was found deleted (and its jobs dropped): nothing starts for it.
      if (job.status === 'deleted') return true;
      if (open.length) {
        Object.assign(job, { status: 'waiting', waiting_for: open });
        this.host.logger.error(job.key + ' waits for ' + open.map((number) => '#' + number).join(', ') + ' (dependencies added after it was queued)');
        return true;
      }
    }
    // WAIT_FOR_SAME_FILES: an older ticket or pull request that changes the same files goes first.
    if (this.host.config.waitForSameFiles && this.host.config.routes.get(job.label)?.kind === 'issue' && !job.event.pull_request && !this.host.config.epicLabels.has(job.label)) {
      const blockers = await this.host.waitKeeper.filesBlockers(job);
      if (blockers.length) {
        Object.assign(job, { status: 'waiting', waiting_for_files: blockers });
        this.host.logger.error(job.key + ' waits for ' + blockers.map((number) => '#' + number).join(', ') + ' (same files)');
        return true;
      }
      delete job.waiting_for_files;
    }
    if (job.event.ci && this.host.config.routes.get(job.label)?.kind === 'ci_failure' && (await this.host.commitRecovered(job.event))) {
      this.host.jobs.remove(job.id);
      return true;
    }
    const route = this.host.route(job.label);
    // The last round goes to the stronger profile of "escalate_to": same branch, same kind, same prompt and the limits of its own route.
    const target = this.host.escalationTarget(job);
    if (target && !job.escalated) {
      job.escalated = true;
      this.host.logger.error(job.key + ': round ' + this.host.rounds(job.event) + ' is escalated to ' + route.escalateTo);
      metrics.inc('forgehands_escalated_rounds_total');
    }
    const { route: effective, fellBack } = this.host.effectiveRoute(job, now);
    job.fell_back = fellBack;
    if (fellBack) this.host.logger.error(job.key + ': the tier of its route is out of quota, starting with the fallback route ' + fellBack);
    // PLAN_ANSWER_RESTARTS: a planner run records the dependencies it starts with; an answer later counts only the sub-issues created since (planAnswer).
    // Without a readable forge the snapshot stays out, and planAnswer falls back to the creation dates.
    delete job.deps_before;
    if (this.host.isPlannerLabel(job.label) && !job.event.pull_request && this.host.config.forgejo) {
      try {
        const before = await this.host.forge.dependencies(job.event.repository.full_name, job.event.issue.number);
        if (Array.isArray(before)) job.deps_before = before.map((issue: Json) => issue.number).filter((number: unknown) => Number.isInteger(number)).sort((a: number, b: number) => a - b);
      } catch (error) {
        this.host.logger.error('could not read the dependencies of #' + job.event.issue.number + ' before its planner run:', error.message);
      }
    }
    // CHECKS_FROM_CI: a review run is given the check result of its head, read from the forge now (see agent/checks.ts).
    const checks = this.host.config.checksFromCi && job.event.ci && (job.event.type === 'ci.success' || job.event.type === 'ci.sensitive')
      ? await checkFacts(this.host.forge, job.event.repository.full_name, job.event.ci.commit_sha, this.host.logger, this.host.config.reviewWithoutCi) : null;
    // The advisory findings of the ticket pre-flight are given to a worker's prompt as notes (preflight.ts); blocking ones never get here.
    const notes = !job.event.pull_request && this.host.config.routes.get(job.label)?.kind === 'issue' && !this.host.isPlannerLabel(job.label)
      ? await this.host.preflight.notesOf(job.event) : [];
    // A Git global config file of the run's own, so that two conversations of the same checkout never share what one writes with
    // `git config --global` (a credential helper, an include, a URL rewrite). It lives outside every checkout: created before a
    // clone it must not make the clone directory non-empty, and written after it must not land in the working tree. The path is
    // only a name and is never created here; a Git process that inherits the conversation environment points GIT_CONFIG_GLOBAL at it.
    const gitConfigGlobal = posix.join(this.host.config.workspaceDir, '.gitconfig.d', randomUUID() + '.gitconfig');
    const body: Json = {
      workspace: { working_dir: this.host.config.workspaceDir },
      agent_profile_id: effective.profile,
      max_iterations: route.maxIterations,
      tags: { source: 'forgehands', ...(job.event.bot ? { bot: 'dependency' } : { issue: String(job.event.issue.number) }), ...(job.event.pull_request ? { pr: String(job.event.pull_request.number) } : {}), ...(job.event.ci ? { ci: job.event.type.slice(3) } : {}), ...(job.event.epic ? { epic: 'done' } : {}), ...(job.event.type === 'pull_request.conflict' ? { conflict: 'default-branch' } : {}) },
      initial_message: { role: 'user', run: true, content: [{ type: 'text', text: buildPrompt(job.event, this.host.config, checks, notes) + handbackLine(job) + stallLine(job.event) }] }
    };
    if (route.maxBudget) body.max_budget_per_run = route.maxBudget;
    // Built per start from the environment; never stored in the ledger.
    // A route's own Forgejo token (the reviewer user) goes to its conversations only, as FORGEJO_TOKEN; no other conversation gets it.
    const claimed = new Set([...this.host.config.routes.values()].map((entry) => entry.forgejoTokenSecret).filter(Boolean));
    const own = route.forgejoTokenSecret ? this.host.config.agentSecrets[route.forgejoTokenSecret] : undefined;
    // GIT_CONFIG_GLOBAL always comes from ForgeHands: a configured value of that name is dropped so that the per-start path wins.
    const secrets = [...Object.entries(this.host.config.agentSecrets || {}).filter(([name]) => name !== 'GIT_CONFIG_GLOBAL' && !claimed.has(name) && !(own && name === 'FORGEJO_TOKEN')),
      ...(own ? [['FORGEJO_TOKEN', own] as [string, string]] : []),
      ['GIT_CONFIG_GLOBAL', gitConfigGlobal] as [string, string]];
    body.secrets = Object.fromEntries(secrets.map(([name, value]) => [name, { kind: 'StaticSecret', value, description: 'Provided by ForgeHands' }]));
    // A dry run judges and schedules as usual, but starts nothing: the job ends as `dry` with the message the agent would have got.
    // `started` stays set so that the hourly limit and the round count behave as live.
    if (isDry(this.host.config, job.event.repository.full_name)) {
      Object.assign(job, { status: 'dry', started: now, finished: now, result: 'dry', dry_prompt: body.initial_message.content[0].text });
      this.host.logger.error('DRY RUN, not started: ' + job.key + ' (' + effective.profile + ', tier ' + effective.tier + ')');
      return true;
    }
    try {
      const response = await this.host.api('POST', '/api/conversations', body, job.event.repository.full_name);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const created = (await response.json()) as Json;
      if (!created?.id) throw new Error('response without conversation id');
      Object.assign(job, { status: 'running', conversation_id: created.id, started: now, error: undefined });
      // A new conversation gets its own resumes (the fields described Job.resumes belong to the one before).
      delete job.resumes; delete job.pause_resumes; delete job.resumed_from; delete job.resumed_at; delete job.resume_pending;
      // The nudge is once per conversation too (see nudgeIfNoBranch).
      delete job.nudged; delete job.nudge_settled; delete job.nudge_pending; delete job.nudge_gave_up; this.host.nudger.nudgeChecks.delete(job.id);
      delete job.tokens_seen;
      metrics.inc('forgehands_runs_started_total', { kind: this.host.route(job.label).kind });
    } catch (error) {
      job.attempts += 1;
      job.error = error.message;
      this.host.logger.error('starting conversation for ' + job.key + ' failed:', error.message);
      if (job.attempts >= MAX_ATTEMPTS) Object.assign(job, { status: 'failed', finished: now });
      else job.next_try = now + RETRY_BASE_MS * job.attempts;
    }
    return true;
  }
}
