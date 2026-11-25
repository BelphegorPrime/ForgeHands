// The epic sweep of REVIEW_SWEEP_MINUTES. The epic review (route "on": "epic_done") starts when the last sub-issue of an epic closes, from the
// `issues` event of the closed sub-issue (Dispatcher.onClosed). That event can be missed or fall outside the normal path: a sub-issue closed by a
// person whose login ALLOWED_SENDERS does not list, a closed issue without a run of its own, an epic that carries `ai:changes` from an earlier
// review (not an epic label), a webhook lost while ForgeHands was down. Then the epic waited for ever, and everything behind it with it.
// Every pass of the review sweep looks at the open epics of a repository (the ledger's epics, and the open issues that carry an epic or planner
// label) and starts the epic review of one whose sub-issues are all closed, when no epic review has run since the last of them closed. One start
// per default-branch head (kept per epic in the ledger: EpicSweepRecord). An epic with BLOCKED_LABEL or HOLD_LABEL is a human's call: not started.
// Reads: the epic and its sub-issues, at most EPIC_READS_PER_PASS epics a pass, the ones looked at longest ago first.
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import type { Forge, Issue } from '../types/forge.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DirectConfig, EpicSweepRecord, ForgeEvent, Job, Json, Logger } from '../types.ts';

export const EPIC_READS_PER_PASS = 20;
// Epic reviews started per pass at most; the rest of the epics follow in the next pass.
const MAX_EPIC_STARTS = 5;
const ACTIVE = new Set(['waiting', 'queued', 'running']);
const MAX_LISTED = 50;

// What the sweep needs from the dispatcher: the start of an epic review (Dispatcher.startEpicReview; false when one is active already).
export interface EpicSweepHooks {
  startReview: (event: ForgeEvent, epic: Json) => Promise<boolean>;
}

// The ledger key of an epic: "repo#n", lower case (the form of the ledger and of the status page).
export const epicKeyOf = (repository: string, number: number): string => repository.toLowerCase() + '#' + number;

// The ledger key of the epic review runs of an epic: "repo#n:<route>".
export function reviewRouteOf(config: DirectConfig): string | undefined {
  return [...config.routes].find(([, entry]) => entry.kind === 'epic_done')?.[0];
}

// The epics of a repository the ledger knows: a ticket that had a run of an epic label, or of the epic review, or an epic review record. The default
// branch is the one the events of the repository carry (null when the ledger has none of them).
export function ledgerEpics(config: DirectConfig, jobs: JobStore, repository: string): { numbers: Set<number>; branch: string | null } {
  const name = repository.toLowerCase();
  const review = reviewRouteOf(config);
  const numbers = new Set<number>();
  let branch: string | null = null;
  for (const job of jobs.list()) {
    if (job.event?.repository?.full_name?.toLowerCase() !== name) continue;
    branch ||= job.event.repository.default_branch || null;
    if (job.event.pull_request || job.event.bot || !Number.isSafeInteger(job.event.issue?.number)) continue;
    if (config.epicLabels.has(job.label) || job.label === review) numbers.add(job.event.issue.number);
  }
  for (const record of jobs.epicGaps.values()) if (record.repository.toLowerCase() === name) numbers.add(record.issue);
  return { numbers, branch };
}

// The runs of the epic review of an epic (the ledger's key "repo#n:<route>"); none when the config has no epic review route.
function reviewRuns(config: DirectConfig, jobs: JobStore, key: string): Job[] {
  const route = reviewRouteOf(config);
  return route ? jobs.list().filter((job) => job.key === key + ':' + route) : [];
}

// Is the epic review due for this epic (its record says every sub-issue is closed) and not yet run since the last close? The status page shows
// such an epic as "epic review pending". A review that is queued or running, or that is done since the last close, is not pending; a failed one is.
export function reviewPending(config: DirectConfig, jobs: JobStore, record: EpicSweepRecord | undefined): boolean {
  if (!record || record.deps === 0 || record.open.length) return false;
  const runs = reviewRuns(config, jobs, epicKeyOf(record.repository, record.issue));
  if (runs.some((job) => ACTIVE.has(job.status))) return false;
  return !runs.some((job) => job.status === 'done' && (job.finished ?? 0) >= record.last_closed);
}

// The keys ("repo#n") of the epics whose review is pending now (see reviewPending).
export function pendingEpics(config: DirectConfig, jobs: JobStore): Set<string> {
  const keys = new Set<string>();
  for (const [key, record] of jobs.epicSweeps) if (reviewPending(config, jobs, record)) keys.add(key);
  return keys;
}

// The epic sweep of one repository. Returns true when the ledger changed (the caller persists it). Never throws: a failed read is logged and the
// epic is looked at in the next pass.
export async function sweepEpics(deps: { config: DirectConfig; jobs: JobStore; forge: Forge; logger: Logger; now: number; hooks: EpicSweepHooks }, repository: string): Promise<boolean> {
  const { config, jobs, forge, logger, now, hooks } = deps;
  if (isDry(config, repository)) return false;
  const name = repository.toLowerCase();
  const known = ledgerEpics(config, jobs, repository);
  // The open issues that carry an epic label or the planner's label: an epic the ledger never saw (its webhook was lost), and an epic that was
  // closed and reopened by hand (the ledger still marks it closed, so only the listing reaches it).
  const listed = new Set<number>();
  const labels = [...config.epicLabels, ...(config.splitLabel ? [config.splitLabel] : [])];
  if (forge.issuesWithLabel) {
    for (const label of labels) {
      try {
        for (const issue of (await forge.issuesWithLabel(repository, label, MAX_LISTED)) || []) if (Number.isSafeInteger(issue?.number)) listed.add(issue.number);
      } catch (error) {
        logger.error('epic sweep: could not list the open issues with ' + label + ' in ' + repository + ':', (error as Error).message);
      }
    }
  }
  let changed = false;
  // A ledger epic whose jobs are all marked closed (JobStore.markClosed) is not read again: a closed epic costs no read.
  const closedInLedger = new Set<number>();
  for (const number of known.numbers) {
    const own = jobs.list().filter((job) => job.key.startsWith(epicKeyOf(repository, number) + ':'));
    if (own.length && own.every((job) => job.archived_view)) closedInLedger.add(number);
  }
  const numbers = new Set([...listed, ...[...known.numbers].filter((number) => !closedInLedger.has(number))]);
  // Records of epics that are no longer candidates (no label, no run) are dropped.
  for (const [key, record] of [...jobs.epicSweeps]) {
    if (record.repository === name && !numbers.has(record.issue)) { jobs.epicSweeps.delete(key); changed = true; }
  }
  if (!numbers.size) return changed;
  // The oldest look first; an epic never looked at comes before all of them.
  const order = [...numbers].sort((a, b) => (jobs.epicSweeps.get(epicKeyOf(repository, a))?.checked_at ?? 0) - (jobs.epicSweeps.get(epicKeyOf(repository, b))?.checked_at ?? 0));
  let reads = 0;
  let starts = 0;
  for (const number of order) {
    if (reads >= EPIC_READS_PER_PASS || starts >= MAX_EPIC_STARTS) break;
    const key = epicKeyOf(repository, number);
    const previous = jobs.epicSweeps.get(key);
    let issue: Issue;
    let subs: Issue[];
    try {
      reads += 1;
      issue = await forge.getIssue(repository, number);
      if (!issue || issue.state !== 'open') {
        if (issue?.state === 'closed') {
          // Closed in the forge: its jobs are marked for the status page, its record goes, and no later pass reads it (see closedInLedger).
          if (jobs.markClosed(key)) changed = true;
          if (jobs.epicSweeps.delete(key)) changed = true;
        }
        continue;
      }
      reads += 1;
      subs = await forge.dependencies(repository, number);
    } catch (error) {
      if (!/HTTP 404\b/.test((error as Error).message)) logger.error('epic sweep: could not read #' + number + ' of ' + repository + ':', (error as Error).message);
      continue;
    }
    const list = Array.isArray(subs) ? subs : [];
    const open = list.filter((sub) => sub?.state === 'open').map((sub) => sub.number);
    // The latest close of the sub-issues; a close the forge does not date counts as seen now.
    const closes = list.filter((sub) => sub?.state !== 'open').map((sub) => Date.parse(String(sub.closed_at ?? '')));
    const record: EpicSweepRecord = {
      repository: name, issue: number, deps: list.length, open, last_closed: closes.length ? Math.max(...closes.map((at) => Number.isFinite(at) ? at : now)) : now,
      checked_at: now, sha: previous?.sha ?? null, started_at: previous?.started_at ?? null
    };
    jobs.epicSweeps.set(key, record);
    changed = true;
    if (!list.length || open.length) continue; // no sub-issues, or one still open: nothing to decide
    const names = (issue.labels || []).map((label) => label?.name);
    if (names.includes(config.blockedLabel) || names.includes(config.holdLabel)) continue;
    const route = reviewRouteOf(config);
    if (!route) continue;
    const runs = reviewRuns(config, jobs, key);
    if (runs.some((job) => ACTIVE.has(job.status))) continue;
    if (runs.some((job) => job.status === 'done' && (job.finished ?? 0) >= record.last_closed)) continue;
    const branch = known.branch;
    if (!branch) continue;
    let sha: string | null;
    try {
      reads += 1;
      sha = await forge.branchTip(repository, branch);
    } catch (error) {
      logger.error('epic sweep: could not read the head of ' + repository + ' ' + branch + ' for #' + number + ':', (error as Error).message);
      continue;
    }
    if (!sha || previous?.sha === sha) continue; // one start per head: started on this head already
    const event = {
      type: 'epic.done', source: forge.kind, action: 'sweep', label: route,
      repository: { full_name: repository, clone_url: null, html_url: null, default_branch: branch },
      issue: { number, title: String(issue.title || '').slice(0, 1000), body: String(issue.body || '').slice(0, 50000), html_url: issue.html_url || null, comments: issue.comments || 0, labels: names },
      sender: { login: null }
    } as unknown as ForgeEvent;
    if (!(await hooks.startReview(event, { number, title: issue.title, body: issue.body, html_url: issue.html_url || null, comments: issue.comments || 0, labels: issue.labels || [] }))) continue;
    starts += 1;
    record.sha = sha;
    record.started_at = now;
    metrics.inc('forgehands_epic_sweep_starts_total');
    logger.error(repository + '#' + number + ': all ' + list.length + ' sub-issue(s) closed and no epic review since, starting it on head ' + sha.slice(0, 7));
  }
  return changed;
}
