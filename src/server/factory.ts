// The factory health section of /status.json (`factory`) and of the dashboard: the stalled tickets, the stuck pull requests, the merge
// decisions, the hand-backs, the ticket pre-flight, the epics with gaps and the deleted tickets. The lists come from the ledger and the
// notes the pre-flight keeps; the counts by action, kind, reason or result are the counters of /metrics, so they count from `since`
// (the start of the process), as the counters do.
import type { DirectConfig, EpicGapRecord, StalledRecord, StuckRecord } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { TicketPreflight } from '../agent/preflight.ts';
import { metrics } from '../metrics.ts';

// The part of a ticket row that the health section uses (see status.ts, Status.issues).
export interface FactoryIssue {
  issue: string;
  pr: number | null;
  closed?: true;
  state: string;
  merge_decision?: { reason: string; at: string };
}

export interface Factory {
  // When the counters started: the start of the process.
  since: string;
  stalled_tickets: {
    count: number;
    // by action, from the counter: restart (started once more) or human (the human was called)
    actions: Record<string, number>;
    // open tickets the watchdog acted on; `action` is what it did last, `since` when
    list: { issue: string; action: 'restart' | 'human'; restarts: number; run: string; since: string }[];
  };
  stuck_pull_requests: {
    count: number;
    // blocks by reason since the start (stuck_rounds, stuck_verdict, ...)
    blocks: Record<string, number>;
    // blocked pull requests now; `reason` is the reason the watchdog blocked them for
    list: { issue: string; pr: number; reason: string; since: string }[];
  };
  merge_decisions: {
    // open pull requests of the tickets whose last decision was a refusal ('not merged: <reason>')
    open: { issue: string; pr: number; reason: string; at: string }[];
    // since the start: merges, and refusals by reason
    counts: { merged: number; not_merged: Record<string, number> };
  };
  // hand-backs by kind since the start (retry, escalate, planner, blocked)
  handbacks: Record<string, number>;
  preflight: {
    // results since the start: ok, rejected, advised, skipped
    results: Record<string, number>;
    rules: { rule: string; result: string; count: number }[];
    // advisory notes of the open tickets the pre-flight checked since the start
    notes: { issue: string; notes: string[]; at: string }[];
  };
  epic_gaps: {
    count: number;
    // since the start, by action: replanned (back to the planner) or handed (the human was called)
    actions: Record<string, number>;
    list: { issue: string; action: 'replanned' | 'handed'; replans: number; reason: string; since: string }[];
  };
  deleted_in_forge: number;
  revert_rate: { alert_percent: number | null };
}

const RESULTS = ['ok', 'rejected', 'advised', 'skipped'];
const HANDBACK_KINDS = ['retry', 'escalate', 'planner', 'blocked'];
const ascending = (a: number, b: number): number => a - b;

// Sums of a counter by one label, with the given keys present (so that the page can show zeros).
function byLabel(name: string, label: string, keys: string[] = []): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of metrics.read(name)) {
    const key = entry.labels[label] ?? 'other';
    result[key] = (result[key] || 0) + entry.value;
  }
  return result;
}

const iso = (at: number): string => new Date(at).toISOString();

export function buildFactory(config: DirectConfig, jobs: JobStore, issues: FactoryIssue[], closed: Set<string>, preflight: TicketPreflight | null): Factory {
  const open = (repository: string, number: number): boolean => !closed.has(repository.toLowerCase() + '#' + number);

  // Stalled tickets: the records the watchdog keeps until the ticket is closed or the human takes its label off.
  const stalled = [...jobs.stalled.values()].filter((record: StalledRecord) => open(record.repository, record.issue));
  const stalledList = stalled
    .map((record) => ({ issue: record.repository + '#' + record.issue, action: (record.human ? 'human' : 'restart') as 'restart' | 'human', restarts: record.restarts, run: record.run, since: iso(record.at), at: record.at }))
    .sort((a, b) => ascending(a.at, b.at))
    .map(({ at: _at, ...entry }) => entry);

  // Stuck pull requests: the blocked ones (the gauge counts the same).
  const stuck = [...jobs.stuck.values()].filter((record: StuckRecord) => record.blocked && record.issue > 0);
  const stuckList = stuck
    .map((record) => ({ issue: record.repository + '#' + record.issue, pr: record.number, reason: record.why, since: iso(record.blocked_at ?? record.eligible_at), at: record.blocked_at ?? record.eligible_at }))
    .sort((a, b) => ascending(a.at, b.at))
    .map(({ at: _at, ...entry }) => entry);

  // Merge decisions: the last decision of each open ticket's pull request that was not merged (a merged one leaves the list).
  const decisions = openDecisions(issues);
  const merges = metrics.read('forgehands_merge_decisions_total');
  const notMerged: Record<string, number> = {};
  let merged = 0;
  for (const entry of merges) {
    if (entry.labels.result === 'merged') merged += entry.value;
    else notMerged[entry.labels.reason ?? 'other'] = (notMerged[entry.labels.reason ?? 'other'] || 0) + entry.value;
  }

  // The epics the review found open (EPIC_GAP_REPLAN), per epic, kept until the epic closes.
  const gaps = [...jobs.epicGaps.values()].filter((record: EpicGapRecord) => open(record.repository, record.issue));
  const gapList = gaps
    .map((record) => ({ issue: record.repository + '#' + record.issue, action: (record.human ? 'handed' : 'replanned') as 'replanned' | 'handed', replans: record.replans, reason: record.reason, since: iso(record.at), at: record.at }))
    .sort((a, b) => ascending(a.at, b.at))
    .map(({ at: _at, ...entry }) => entry);

  // Advisory notes of the tickets the pre-flight checked: only open tickets, and only while the ticket is still in the ledger's list.
  const notes = [...(preflight?.advisories ?? new Map<string, { notes: string[]; at: number }>())]
    .filter(([name]) => !closed.has(name))
    .map(([name, entry]) => ({ issue: name, notes: entry.notes, at: iso(entry.at), order: entry.at }))
    .sort((a, b) => ascending(b.order, a.order))
    .map(({ order: _order, ...entry }) => entry);

  const rules = metrics.read('forgehands_preflight_total').map((entry) => ({ rule: entry.labels.rule ?? 'none', result: entry.labels.result ?? 'other', count: entry.value }))
    .sort((a, b) => a.result.localeCompare(b.result) || a.rule.localeCompare(b.rule));

  return {
    since: metrics.startedAt,
    stalled_tickets: { count: stalledList.filter((entry) => entry.action === 'human').length, actions: byLabel('forgehands_stalled_ticket_actions_total', 'action', ['restart', 'human']), list: stalledList },
    stuck_pull_requests: { count: stuckList.length, blocks: byLabel('forgehands_stuck_pr_blocks_total', 'reason'), list: stuckList },
    merge_decisions: { open: decisions, counts: { merged, not_merged: notMerged } },
    handbacks: byLabel('forgehands_handbacks_total', 'kind', HANDBACK_KINDS),
    preflight: { results: byLabel('forgehands_preflight_total', 'result', RESULTS), rules, notes },
    epic_gaps: { count: gapList.length, actions: byLabel('forgehands_epic_gaps_total', 'action', ['replanned', 'handed']), list: gapList },
    deleted_in_forge: issues.filter((issue) => !issue.closed && issue.state === 'deleted in the forge').length,
    revert_rate: { alert_percent: config.revertRateAlert > 0 ? config.revertRateAlert : null }
  };
}

// The open tickets whose last decision was a refusal, newest decision first.
function openDecisions(issues: FactoryIssue[]): Factory['merge_decisions']['open'] {
  return issues
    .filter((issue) => !issue.closed && issue.pr !== null && issue.merge_decision)
    .map((issue) => ({ issue: issue.issue, pr: issue.pr as number, reason: issue.merge_decision!.reason, at: issue.merge_decision!.at }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
