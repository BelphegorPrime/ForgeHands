import {
  Activity,
  CircleCheck,
  ClipboardCheck,
  FlaskConical,
  GitMerge,
  Hand,
  Layers3,
  Timer,
  Undo2,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { ForgeLink, LinkedText } from "./forge-link.tsx";
import {
  ageText,
  countRows,
  operatorRows,
  percent,
  reasonLabel,
  revertRows,
  scenarioText,
} from "../factory-view.ts";
import type { DashboardStatus } from "../types.ts";

const HANDBACK_TEXT: Record<string, string> = {
  retry: "nothing pushed, run once more",
  escalate: "blocker, run on the stronger route",
  planner: "back to the planner",
  blocked: "a human, no planner",
};

const shortDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

// Empty states say so: "None" beats a blank card.
function None({ text = "None" }: { text?: string }) {
  return <p className="health-none">{text}</p>;
}

function HealthCard({
  icon: Icon,
  title,
  subtitle,
  count,
  countLabel = "now",
  children,
  id,
}: {
  icon: typeof Activity;
  title: string;
  subtitle: string;
  count?: number;
  countLabel?: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <Card className="panel health-card" id={id}>
      <CardHeader className="panel-header">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="panel-subtitle">{subtitle}</p>
        </div>
        <span className="panel-icon">
          <Icon size={17} />
        </span>
      </CardHeader>
      <CardContent className="health-body">
        {count !== undefined && (
          <p className="health-count">
            <strong>{count}</strong>
            <span>{countLabel}</span>
          </p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

// The tickets the watchdog found stalled, and what it did: restarted, or handed to the human.
function StalledCard({ status }: { status: DashboardStatus }) {
  const { stalled_tickets: stalled } = status.factory;
  return (
    <HealthCard
      id="factory-stalled"
      icon={Timer}
      title="Stalled tickets"
      subtitle="Ticket watchdog: the last run ended without a pull request or comment"
      count={stalled.count}
      countLabel="handed to a human"
    >
      <CountList
        heading="Actions since start"
        rows={[
          { label: "restarted once more", count: stalled.actions.restart ?? 0 },
          { label: "handed to the human", count: stalled.actions.human ?? 0 },
        ]}
      />
      {stalled.list.length ? (
        <ul className="health-list">
          {stalled.list.map((entry) => (
            <li key={entry.issue + entry.run}>
              <strong>
                <ForgeLink href={entry.issue_url}>{entry.issue}</ForgeLink>
              </strong>{" "}
              <Badge variant={entry.action === "human" ? "danger" : "warning"}>
                {entry.action === "human" ? "handed to human" : "restarted"}
              </Badge>
              <span className="table-muted">
                {" "}
                {ageText(entry.since, status.generated)}, restarts {entry.restarts}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <None text="No stalled tickets" />
      )}
    </HealthCard>
  );
}

// The pull requests the stuck-PR watchdog blocked for a human, with the reason.
function StuckCard({ status }: { status: DashboardStatus }) {
  const { stuck_pull_requests: stuck } = status.factory;
  return (
    <HealthCard
      id="factory-stuck"
      icon={Hand}
      title="Stuck pull requests"
      subtitle="Stuck-PR watchdog: blocked for a human, tickets wait behind them"
      count={stuck.count}
      countLabel="blocked now"
    >
      <CountList
        heading="Blocks since start, by reason"
        rows={countRows(stuck.blocks, reasonLabel)}
        empty="No blocks"
      />
      {stuck.list.length ? (
        <ul className="health-list">
          {stuck.list.map((entry) => (
            <li key={entry.issue + "#" + entry.pr}>
              <strong>
                <ForgeLink href={entry.issue_url}>{entry.issue}</ForgeLink>
              </strong>{" "}
              <ForgeLink href={entry.pr_url} className="pr-tag">PR #{entry.pr}</ForgeLink>{" "}
              <Badge variant="danger">{reasonLabel(entry.reason)}</Badge>
              <span className="table-muted"> blocked {ageText(entry.since, status.generated)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <None text="No blocked pull requests" />
      )}
    </HealthCard>
  );
}

// The last decision on each open agent pull request, and the refusals by reason since start.
function MergeCard({ status }: { status: DashboardStatus }) {
  const { merge_decisions: decisions } = status.factory;
  return (
    <HealthCard
      id="factory-merges"
      icon={GitMerge}
      title="Merge decisions"
      subtitle="Last decision per open pull request, with approval"
      count={decisions.open.length}
      countLabel="open, not merged"
    >
      <CountList
        heading={"Since start: " + decisions.counts.merged + " merged"}
        rows={countRows(decisions.counts.not_merged, (key) => "not merged: " + key)}
        empty="No refusals"
      />
      {decisions.open.length ? (
        <ul className="health-list">
          {decisions.open.map((entry) => (
            <li key={entry.issue + "#" + entry.pr}>
              <strong>
                <ForgeLink href={entry.issue_url}>{entry.issue}</ForgeLink>
              </strong>{" "}
              <ForgeLink href={entry.pr_url} className="pr-tag">PR #{entry.pr}</ForgeLink>{" "}
              <Badge variant="warning">not merged: {entry.reason}</Badge>
              <span className="table-muted"> {shortDate(entry.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <None text="No open pull request waits for a merge decision" />
      )}
    </HealthCard>
  );
}

// Merges ForgeHands made, the ones a merged revert undid, and the ones that needed a human, per repository, 7 and 30 days.
function RevertCard({ status }: { status: DashboardStatus }) {
  const rows = revertRows(status);
  const alertPercent = status.factory.revert_rate.alert_percent;
  return (
    <HealthCard
      id="factory-reverts"
      icon={Undo2}
      title="Revert rate"
      subtitle="Merges ForgeHands made whose revert was merged"
    >
      <p className="health-note">
        {alertPercent === null
          ? "Alert threshold: off (REVERT_RATE_ALERT)"
          : "Alert threshold: " + alertPercent + " % over 30 days"}
      </p>
      {rows.length ? (
        <div className="health-table-wrap">
          <table className="health-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Window</th>
                <th>Merges</th>
                <th>Reverted</th>
                <th>Ratio</th>
                <th>Needed human</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.repository + row.window}>
                  <td>{row.repository}</td>
                  <td>{row.window}</td>
                  <td>{row.rate.merges}</td>
                  <td>{row.rate.reverted}</td>
                  <td>
                    {percent(row.rate.ratio)}{" "}
                    {row.alert && <Badge variant="danger">above threshold</Badge>}
                  </td>
                  <td>{row.rate.needed_human}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <None text="No repository activity" />
      )}
    </HealthCard>
  );
}

// Hand-backs of worker runs (a comment instead of a pull request) by what ForgeHands did, since start.
function HandbackCard({ status }: { status: DashboardStatus }) {
  const kinds = Object.entries(HANDBACK_TEXT);
  const total = kinds.reduce((sum, [kind]) => sum + (status.factory.handbacks[kind] ?? 0), 0);
  return (
    <HealthCard
      id="factory-handbacks"
      icon={ClipboardCheck}
      title="Hand-backs"
      subtitle="Worker runs that handed the ticket back by a comment"
      count={total}
      countLabel="since start"
    >
      <CountList
        heading="Since start, by kind"
        rows={kinds.map(([kind, text]) => ({ label: kind + ": " + text, count: status.factory.handbacks[kind] ?? 0 }))}
        empty="None"
      />
    </HealthCard>
  );
}

// Ticket pre-flight: results and the rules behind them since start, and the advisory notes of the tickets checked.
function PreflightCard({ status }: { status: DashboardStatus }) {
  const { preflight } = status.factory;
  const results = ["ok", "advised", "rejected", "skipped"];
  return (
    <HealthCard
      id="factory-preflight"
      icon={CircleCheck}
      title="Ticket pre-flight"
      subtitle="Worker tickets checked before a run starts (since start)"
    >
      <div className="health-results">
        {results.map((result) => (
          <span key={result} className="health-result">
            <strong>{preflight.results[result] ?? 0}</strong> {result}
          </span>
        ))}
      </div>
      <CountList
        heading="By rule"
        rows={preflight.rules
          .filter((entry) => entry.rule !== "none" && entry.count > 0)
          .map((entry) => ({ label: "rule " + entry.rule + " " + entry.result, count: entry.count }))}
        empty="No rule fired"
      />
      <p className="health-subhead">Advisory notes of current tickets</p>
      {preflight.notes.length ? (
        <ul className="health-list">
          {preflight.notes.map((entry) => (
            <li key={entry.issue}>
              <strong>
                <ForgeLink href={entry.issue_url}>{entry.issue}</ForgeLink>
              </strong>
              <ul className="health-notes">
                {entry.notes.map((note, index) => (
                  <li key={index}>
                    <LinkedText text={note} links={entry.notes_links} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <None text="No advisory notes" />
      )}
    </HealthCard>
  );
}

// Epics the epic review found still open: sent back to the planner, or handed to the human.
function EpicCard({ status }: { status: DashboardStatus }) {
  const { epic_gaps: gaps } = status.factory;
  return (
    <HealthCard
      id="factory-epics"
      icon={Layers3}
      title="Epic gaps"
      subtitle="Epics the review found still open"
      count={gaps.count}
      countLabel="open"
    >
      <CountList
        heading="Since start"
        rows={[
          { label: "replanned (back to the planner)", count: gaps.actions.replanned ?? 0 },
          { label: "handed to the human", count: gaps.actions.handed ?? 0 },
        ]}
      />
      {gaps.list.length ? (
        <ul className="health-list">
          {gaps.list.map((entry) => (
            <li key={entry.issue}>
              <strong>
                <ForgeLink href={entry.issue_url}>{entry.issue}</ForgeLink>
              </strong>{" "}
              <Badge variant={entry.action === "handed" ? "danger" : "warning"}>
                {entry.action === "handed" ? "handed to human" : "replanned"}
              </Badge>
              <span className="table-muted">
                {" "}
                {ageText(entry.since, status.generated)}, replans {entry.replans}
              </span>
              {entry.reason && (
                <p className="health-note">
                  <LinkedText text={entry.reason} links={entry.reason_links} />
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <None text="No open epic gaps" />
      )}
    </HealthCard>
  );
}

// The end-to-end suite: whether it runs, and the last run per scenario.
function E2eCard({ status }: { status: DashboardStatus }) {
  const e2e = status.e2e;
  return (
    <HealthCard
      id="factory-e2e"
      icon={FlaskConical}
      title="End-to-end suite"
      subtitle="Scenario checks against a test repository"
    >
      {!e2e ? (
        <None text="Off (E2E_REPO is not set)" />
      ) : (
        <>
          <p className="health-note">
            Repository {e2e.repository}, version {e2e.version}, scenarios {e2e.scenarios.join(", ") || "none"}
            {e2e.running && " · running since " + shortDate(e2e.running.since)}
          </p>
          {e2e.last ? (
            <>
              <p className="health-note">
                Last run {shortDate(e2e.last.at)} ({e2e.last.trigger}), version {e2e.last.version}
              </p>
              {e2e.last.error && <p className="health-error">{e2e.last.error}</p>}
              <ul className="health-list">
                {e2e.last.results.map((result) => (
                  <li key={result.scenario}>
                    <strong>{result.scenario}</strong>{" "}
                    <Badge variant={result.ok && result.cleanup === "ok" ? "success" : "danger"}>
                      {result.ok ? "ok" : "failed"}
                    </Badge>
                    <span className="table-muted"> {scenarioText(result)}</span>
                    {result.notes && <p className="health-note">{result.notes}</p>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <None text="No run yet" />
          )}
        </>
      )}
    </HealthCard>
  );
}

function CountList({
  heading,
  rows,
  empty = "None",
}: {
  heading: string;
  rows: { label: string; count: number }[];
  empty?: string;
}) {
  const shown = rows.filter((row) => row.count > 0);
  return (
    <div className="health-counts">
      <p className="health-subhead">{heading}</p>
      {shown.length ? (
        <ul>
          {shown.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <strong>{row.count}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <None text={empty} />
      )}
    </div>
  );
}

// The operator prerequisites: tickets labelled for the operator, that wait for a person. Shown right under "Waiting for a human".
export function OperatorCard({ status }: { status: DashboardStatus }) {
  const { operator_tickets: operator } = status.factory;
  const rows = operatorRows(operator.list, status.generated);
  return (
    <Card className="panel waiting-panel" id="waiting-operator">
      <CardHeader className="panel-header">
        <div>
          <CardTitle>Waiting for you: operator prerequisites</CardTitle>
          <p className="panel-subtitle">
            {rows.length ? "Oldest first" : "Nothing waits for you"}
          </p>
        </div>
        <span className="panel-icon warm">
          <UserRound size={17} />
        </span>
      </CardHeader>
      <CardContent className="health-body">
        <p className="health-count">
          <strong>{operator.count}</strong>
          <span>open</span>
        </p>
        {rows.length ? (
          <ul className="health-list waiting-list">
            {rows.map((row) => (
              <li key={row.key}>
                <ForgeLink href={row.href}>
                  #{row.number} {row.title || "Untitled ticket"}
                </ForgeLink>{" "}
                <span className="table-muted">
                  {row.repository} · open {row.age}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <None text="None" />
        )}
      </CardContent>
    </Card>
  );
}

// The waiting list, first on the page: the reasons are shown as words, unknown ones too.
export function WaitingForHuman({ status }: { status: DashboardStatus }) {
  const entries = status.waiting_for_human;
  return (
    <Card className="panel waiting-panel" id="waiting">
      <CardHeader className="panel-header">
        <div>
          <CardTitle>Waiting for a human</CardTitle>
          <p className="panel-subtitle">
            {entries.length
              ? entries.length + " waiting, with the reason"
              : "Nothing is handed to you"}
          </p>
        </div>
        <span className="panel-icon warm">
          <UserRound size={17} />
        </span>
      </CardHeader>
      <CardContent className="health-body">
        {entries.length ? (
          <ul className="health-list waiting-list">
            {entries.map((entry) => (
              <li key={entry.repository + "#" + entry.issue + "#" + entry.reason}>
                <strong>
                  {entry.repository}{" "}
                  {entry.pr ? (
                    <ForgeLink href={entry.pr_url}>PR #{entry.pr}</ForgeLink>
                  ) : (
                    <ForgeLink href={entry.issue_url}>#{entry.issue}</ForgeLink>
                  )}
                </strong>{" "}
                <Badge variant="warning">
                  <LinkedText text={reasonLabel(entry.reason)} links={entry.reason_links} />
                </Badge>
                <span className="table-muted"> since {entry.since}</span>
              </li>
            ))}
          </ul>
        ) : (
          <None text="None" />
        )}
      </CardContent>
    </Card>
  );
}

// The factory health area: the watchdogs, merge decisions, revert rate, hand-backs, pre-flight, epic review and the end-to-end suite.
export function FactoryHealth({ status }: { status: DashboardStatus }) {
  return (
    <section className="factory-health" id="factory" aria-label="Factory health">
      <div className="health-heading">
        <p className="eyebrow">FACTORY HEALTH</p>
        <p className="page-subtitle">
          <Activity size={13} /> Counts since{" "}
          {shortDate(status.factory.since)} (the start of the process); lists and
          the revert rate come from the ledger.
        </p>
      </div>
      <div className="health-grid">
        <StalledCard status={status} />
        <StuckCard status={status} />
        <MergeCard status={status} />
        <RevertCard status={status} />
        <HandbackCard status={status} />
        <PreflightCard status={status} />
        <EpicCard status={status} />
        <E2eCard status={status} />
      </div>
    </section>
  );
}
