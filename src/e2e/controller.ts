// The end-to-end suite as ForgeHands runs it: when (E2E_ON_START after a version change, or on demand through POST /e2e/run), one run at a
// time, the result kept in the ledger (so that a restart does not run it again for the same version), the gauge, the status section and a
// notification of kind `failed` for every scenario that fails. The suite is off unless E2E_REPO names a test repository.
import { isDry } from '../dry.ts';
import type { Notify } from '../notify/index.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DirectConfig, E2eRecord, Logger } from '../types.ts';
import type { Forge } from '../types/forge.ts';
import type { Scenario } from './format.ts';
import { selectScenarios } from './scenarios.ts';
import { e2eForgeOf, type E2eForge, type LedgerPort } from './port.ts';
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
  last: { version: string; trigger: 'start' | 'manual'; at: string; error: string | null; results: { scenario: string; ok: boolean; reason: string | null; cleanup: 'ok' | 'failed'; cleanup_reason: string | null; failed_step: number | null; at: string }[] } | null;
}

/** Why a run did not start: the suite is off, this repository is in a dry run, the forge cannot run it (GitLab), or a run is going. */
export type StartResult = { status: 'started'; done: Promise<void>; scenarios: string[] } | { status: 'off' | 'dry_run' | 'unsupported' | 'busy' };

// The runs ForgeHands started for an issue with a label, read from the ledger (every run it ever started, kept 30 days).
function ledgerOf(jobs: JobStore): LedgerPort {
  return {
    runsOf(repository, issue, label) {
      const prefix = repository.toLowerCase() + '#' + issue + ':';
      return jobs.list().filter((job) => job.key.toLowerCase().startsWith(prefix) && job.label === label).length;
    },
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
    const done = this.execute(trigger, e2eForge, scenarios, ledgerOf(jobs), repository)
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
        now: this.deps.now, sleep: this.deps.sleep });
    } catch (caught) {
      error = String((caught as Error)?.message || caught).slice(0, 600);
      logger.error('e2e: the suite could not run:', error);
      notifier.notify({ kind: 'failed', subject: '[e2e] the end-to-end suite could not run', text: 'The end-to-end suite stopped before its scenarios: ' + error }, repository);
    }
    const link = config.forgejo ? config.forgejo.url + '/' + repository : undefined;
    for (const result of results) {
      if (result.ok) {
        logger.log?.('e2e: ' + result.scenario + ' ok');
        continue;
      }
      const why = result.reason ?? 'the cleanup failed';
      logger.error('e2e: ' + result.scenario + ' failed: ' + why + (result.cleanup_reason ? ' (cleanup: ' + result.cleanup_reason + ')' : ''));
      notifier.notify({
        kind: 'failed', link,
        subject: '[e2e] ' + result.scenario + ' failed',
        text: 'The end-to-end scenario ' + result.scenario + ' failed on ' + repository + ' (version ' + version + ').\n' + why
          + (result.cleanup === 'failed' ? '\nThe cleanup did not hold: ' + result.cleanup_reason + ' Look at the test repository.' : ''),
      }, repository);
    }
    const record: E2eRecord = { version, trigger, started, finished: this.now(), error, results };
    jobs.meta.e2e = record;
    await jobs.persist(this.now()).catch((caught) => logger.error('e2e: the ledger could not be written:', (caught as Error)?.message));
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** The gauge forgehands_e2e_scenario_ok{scenario}: 1 when the scenario held in the last run, 0 when not. Absent until a run. */
  gauges(): { name: string; labels: Record<string, string>; value: number }[] {
    const record = this.deps.jobs.meta.e2e;
    if (!this.repository || !record) return [];
    return record.results.map((result) => ({ name: 'forgehands_e2e_scenario_ok', labels: { scenario: result.scenario }, value: result.ok ? 1 : 0 }));
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
          cleanup_reason: result.cleanup_reason, failed_step: result.failed_step, at: iso(result.finished) })),
      } : null,
    };
  }
}
