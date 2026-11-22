// The end-to-end suite as ForgeHands runs it: when (E2E_ON_START after a version change, or on demand through POST /e2e/run), one run at a
// time, the result kept in the ledger (so that a restart does not run it again for the same version), the gauge, the status section and a
// notification of kind `failed` for every scenario that fails. The suite is off unless E2E_REPO names a test repository.
import { isDry } from '../dry.ts';
import type { Notify } from '../notify/index.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DirectConfig, E2eRecord, JobStatus, Logger } from '../types.ts';
import type { Forge } from '../types/forge.ts';
import type { Scenario } from './format.ts';
import { selectScenarios } from './scenarios.ts';
import { e2eForgeOf, type E2eForge, type LedgerPort, type TicketRun } from './port.ts';
import { runSuite, type ScenarioResult } from './runner.ts';

export interface E2eDeps {
  config: DirectConfig;
  forge: Forge;
  jobs: JobStore;
  notifier: Notify;
  /** The ForgeHands version (package.json): a start with another one than the ledger's runs the suite once. */
  version: string;
  logger: Logger;
  now?: () => number;
  /** Drops the queued runs of an issue (ForgeHands' dispatcher; see Dispatcher.dropQueuedOf). Without it a closed ticket's queued run starts later. */
  dropQueued?: (repository: string, issue: number) => Promise<number>;
  /** Replaces the scenarios of E2E_SCENARIOS (tests). */
  scenarios?: Scenario[];
  /** How often a wait looks again (default 30 s). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** What the status page and /status.json show of the suite. */
export interface E2eState {
  repository: string;
  on_start: boolean;
  scenarios: string[];
  version: string;
  running: { trigger: 'start' | 'manual'; since: string } | null;
  last: { version: string; trigger: 'start' | 'manual'; at: string; error: string | null; results: { scenario: string; ok: boolean; reason: string | null; cleanup: 'ok' | 'failed'; cleanup_reason: string | null; cleanup_note: string | null; notes: string | null; failed_step: number | null; at: string }[] } | null;
}

/** Why a run did not start: the suite is off, this repository is in a dry run, the forge cannot run it (GitLab), or a run is going. */
export type StartResult = { status: 'started'; done: Promise<void>; scenarios: string[] } | { status: 'off' | 'dry_run' | 'unsupported' | 'busy' };

// The runs of an issue, read from the ledger (every run it ever started, kept 30 days) and the queue. A run counts under an issue route (a
// route of kind `issue`: the worker label, its escalation, the fallbacks), or under one label when a predicate names it. A run that was only
// queued and never started is not a run.
export function ledgerOf(jobs: JobStore, routes: Map<string, { kind?: string }>, dropQueued: (repository: string, issue: number) => Promise<number>): LedgerPort {
  const isIssueRoute = (label: string): boolean => routes.get(label)?.kind === 'issue';
  const ticketJobs = (repository: string, issue: number) => {
    const prefix = repository.toLowerCase() + '#' + issue + ':';
    return jobs.list().filter((job) => job.key.toLowerCase().startsWith(prefix));
  };
  const started = (status: JobStatus, startedAt?: number): boolean => Boolean(startedAt) || status === 'running' || status === 'done' || status === 'failed';
  return {
    runsOf(repository, issue, label) {
      return ticketJobs(repository, issue)
        .filter((job) => (label === undefined ? isIssueRoute(job.label) : job.label === label) && started(job.status, job.started)).length;
    },
    revertRestartsOf(repository, issue) {
      return ticketJobs(repository, issue)
        .filter((job) => isIssueRoute(job.label) && job.event?.revert_retry === true && started(job.status, job.started)).length;
    },
    runsStateOf(repository, issue) {
      const active = jobs.list(true);
      return ticketJobs(repository, issue).filter((job) => isIssueRoute(job.label)).map((job): TicketRun => ({
        label: job.label,
        status: job.status,
        created: job.created,
        ...(job.started === undefined ? {} : { started: job.started }),
        ...(job.finished === undefined ? {} : { finished: job.finished }),
        // The runs that go first: the running ones, and the queued ones created before this one.
        ahead: job.status === 'queued' || job.status === 'waiting'
          ? active.filter((other) => other !== job && (other.status === 'running' || (other.status === 'queued' && other.created < job.created))).length
          : 0,
        why: job.event?.revert_retry === true ? 'revert restart' : job.escalated ? 'escalated after ' + (job.escalated_after || 'an empty run') : job.delivery_retry ? 'delivery retry' : 'first run',
      }));
    },
    dropQueued: (repository, issue) => dropQueued(repository, issue),
  };
}

export class E2eController {
  private readonly deps: E2eDeps;
  private busy: { trigger: 'start' | 'manual'; since: number } | null = null;

  constructor(deps: E2eDeps) {
    this.deps = deps;
  }

  get repository(): string | null { return this.deps.config.e2e.repository; }

  /** The scenarios a run takes, in order. */
  scenarios(): Scenario[] {
    return this.deps.scenarios ?? selectScenarios(this.deps.config.e2e.scenarios);
  }

  /** Starts a run in the background, unless it may not run now. `done` resolves when the run is over (it never rejects). */
  start(trigger: 'start' | 'manual'): StartResult {
    const { config, forge, jobs } = this.deps;
    const repository = config.e2e.repository;
    if (!repository) return { status: 'off' };
    if (isDry(config, repository)) return { status: 'dry_run' };
    const e2eForge = e2eForgeOf(forge);
    if (!e2eForge) return { status: 'unsupported' };
    if (this.busy) return { status: 'busy' };
    const scenarios = this.scenarios();
    this.busy = { trigger, since: this.now() };
    // `done` never rejects: a run that breaks is logged, and the next start is not blocked by it.
    const done = this.execute(trigger, e2eForge, scenarios, ledgerOf(jobs, config.routes, (repo, issue) => this.dropQueued(repo, issue)), repository)
      .catch((caught) => this.deps.logger.error('e2e: the run broke:', (caught as Error)?.message))
      .finally(() => { this.busy = null; });
    return { status: 'started', done, scenarios: scenarios.map((scenario) => scenario.name) };
  }

  /** At a start: with E2E_ON_START=1 and a version the ledger has no e2e run for, the suite runs once. Returns whether it started. */
  onStart(): StartResult | { status: 'skipped' } {
    const { config, jobs, version, logger } = this.deps;
    if (!config.e2e.repository || !config.e2e.onStart) return { status: 'skipped' };
    if (jobs.meta.e2e?.version === version) {
      logger.log?.('e2e: version ' + version + ' was tested already, not run again at this start');
      return { status: 'skipped' };
    }
    const result = this.start('start');
    if (result.status === 'started') logger.log?.('e2e: version ' + version + ' is new, running ' + result.scenarios.join(', ') + ' against ' + config.e2e.repository);
    else logger.error('e2e: not run at this start (' + result.status + ')');
    return result;
  }

  // The run itself: scenario by scenario, a notification for each failure, then the record in the ledger.
  private async execute(trigger: 'start' | 'manual', forge: E2eForge, scenarios: Scenario[], ledger: LedgerPort, repository: string): Promise<void> {
    const { config, jobs, version, logger, notifier } = this.deps;
    const started = this.now();
    let results: ScenarioResult[] = [];
    let error: string | null = null;
    try {
      results = await runSuite(scenarios, { repository, forge, ledger, timeoutMs: config.e2e.timeoutMinutes * 60000, pollMs: this.deps.pollMs ?? 30000,
        queueMs: config.e2e.queueMinutes * 60000, now: this.deps.now, sleep: this.deps.sleep,
        log: (line) => logger.log?.('e2e: ' + line) });
    } catch (caught) {
      error = String((caught as Error)?.message || caught).slice(0, 600);
      logger.error('e2e: the suite could not run:', error);
      notifier.notify({ kind: 'failed', subject: '[e2e] the end-to-end suite could not run', text: 'The end-to-end suite stopped before its scenarios: ' + error }, repository);
    }
    const link = config.forgejo ? config.forgejo.url + '/' + repository : undefined;
    for (const result of results) {
      if (result.ok && result.cleanup === 'ok') {
        logger.log?.('e2e: ' + result.scenario + ' ok' + (result.cleanup_note ? ' (cleanup: ' + result.cleanup_note + ')' : '') + (result.notes ? ' (runs: ' + result.notes + ')' : ''));
        continue;
      }
      // A scenario whose steps held and whose cleanup did not is reported as such: the steps are not what failed.
      if (result.ok) {
        logger.error('e2e: ' + result.scenario + ' held, but the cleanup failed: ' + result.cleanup_reason);
        notifier.notify({
          kind: 'failed', link,
          subject: '[e2e] ' + result.scenario + ': cleanup failed',
          text: 'The end-to-end scenario ' + result.scenario + ' held on ' + repository + ' (version ' + version + '), but its cleanup did not hold: '
            + result.cleanup_reason + ' Look at the test repository.',
        }, repository);
        continue;
      }
      logger.error('e2e: ' + result.scenario + ' failed: ' + result.reason + (result.cleanup_reason ? ' (cleanup: ' + result.cleanup_reason + ')' : ''));
      notifier.notify({
        kind: 'failed', link,
        subject: '[e2e] ' + result.scenario + ' failed',
        text: 'The end-to-end scenario ' + result.scenario + ' failed on ' + repository + ' (version ' + version + ').\n' + result.reason
          + (result.cleanup === 'failed' ? '\nThe cleanup did not hold: ' + result.cleanup_reason + ' Look at the test repository.' : ''),
      }, repository);
    }
    const record: E2eRecord = { version, trigger, started, finished: this.now(), error, results };
    jobs.meta.e2e = record;
    await jobs.persist(this.now()).catch((caught) => logger.error('e2e: the ledger could not be written:', (caught as Error)?.message));
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  // Drops the queued runs of an issue of the test repository; without the dispatcher there is nothing queued to drop.
  private async dropQueued(repository: string, issue: number): Promise<number> {
    return this.deps.dropQueued ? this.deps.dropQueued(repository, issue) : 0;
  }

  /**
   * The gauges of the last run, per scenario: forgehands_e2e_scenario_ok (1 when its steps held; a failed cleanup does not change it) and
   * forgehands_e2e_cleanup_ok (1 when its cleanup held). Absent until a run.
   */
  gauges(): { name: string; labels: Record<string, string>; value: number }[] {
    const record = this.deps.jobs.meta.e2e;
    if (!this.repository || !record) return [];
    return record.results.flatMap((result) => [
      { name: 'forgehands_e2e_scenario_ok', labels: { scenario: result.scenario }, value: result.ok ? 1 : 0 },
      { name: 'forgehands_e2e_cleanup_ok', labels: { scenario: result.scenario }, value: result.cleanup === 'ok' ? 1 : 0 },
    ]);
  }

  /** The status section (status.json): what the suite is, whether it runs now, and the last run. */
  state(): E2eState | null {
    const { config, jobs, version } = this.deps;
    if (!config.e2e.repository) return null;
    const record = jobs.meta.e2e;
    const iso = (at: number) => new Date(at).toISOString();
    return {
      repository: config.e2e.repository,
      on_start: config.e2e.onStart,
      scenarios: this.scenarios().map((scenario) => scenario.name),
      version,
      running: this.busy ? { trigger: this.busy.trigger, since: iso(this.busy.since) } : null,
      last: record ? {
        version: record.version,
        trigger: record.trigger,
        at: iso(record.finished),
        error: record.error,
        results: record.results.map((result) => ({ scenario: result.scenario, ok: result.ok, reason: result.reason, cleanup: result.cleanup,
          cleanup_reason: result.cleanup_reason, cleanup_note: result.cleanup_note ?? null, notes: result.notes ?? null, failed_step: result.failed_step, at: iso(result.finished) })),
      } : null,
    };
  }
}
