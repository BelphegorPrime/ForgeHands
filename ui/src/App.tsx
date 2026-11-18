import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  Clock3,
  Coins,
  GitPullRequest,
  Layers3,
  Search,
  ShieldAlert,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import type { DashboardStatus, Issue, Summary } from "./types.ts";

type WindowKey = "last_7_days" | "last_30_days";
type IssueFilter = "all" | "active" | "waiting" | "closed";
type Connection = "connecting" | "live" | "reconnecting";

const money = (amount: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
const shortDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
const timeLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));

function connectionText(connection: Connection): string {
  return connection === "live"
    ? "Live updates"
    : connection === "connecting"
      ? "Connecting"
      : "Reconnecting";
}

function issueVariant(
  issue: Issue,
): "success" | "warning" | "danger" | "secondary" {
  const state = issue.state.toLowerCase();
  if (
    state.includes("failed") ||
    state.includes("blocked") ||
    state.includes("used up")
  )
    return "danger";
  if (state.includes("waiting") || state.includes("queued")) return "warning";
  if (issue.closed || state.includes("done")) return "secondary";
  return "success";
}

function matchesFilter(issue: Issue, filter: IssueFilter): boolean {
  if (filter === "closed") return !!issue.closed;
  if (filter === "active")
    return (
      !issue.closed &&
      issue.runs.some(
        (run) => run.status === "running" || run.status === "queued",
      )
    );
  if (filter === "waiting")
    return (
      !issue.closed &&
      (issue.state.toLowerCase().includes("waiting") ||
        issue.state.toLowerCase().includes("human"))
    );
  return !issue.closed;
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <Card className="metric-card">
      <CardContent className="metric-content">
        <div className={"metric-icon " + tone}>
          <Icon size={18} strokeWidth={1.8} />
        </div>
        <div className="metric-copy">
          <p className="metric-label">{label}</p>
          <p className="metric-value">{value}</p>
          <p className="metric-detail">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function App() {
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [windowKey, setWindowKey] = useState<WindowKey>("last_7_days");
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let stopped = false;
    let retryDelay = 1000;
    let retryTimer = 0;
    let connectTimer = 0;
    let socket: WebSocket | null = null;

    const load = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Authentication required. Open this page again and sign in."
              : "Dashboard data is unavailable (" + response.status + ").",
          );
        const data = (await response.json()) as DashboardStatus;
        if (!stopped) {
          setStatus(data);
          setError("");
        }
      } catch (cause) {
        if (!stopped)
          setError(
            cause instanceof Error
              ? cause.message
              : "Dashboard data is unavailable.",
          );
      }
    };

    const connect = () => {
      if (stopped) return;
      setConnection((current) => (current === "live" ? current : "connecting"));
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(scheme + "//" + location.host + "/dashboard/ws");
      socket.onopen = () => {
        if (stopped) {
          socket?.close();
          return;
        }
        retryDelay = 1000;
        setConnection("live");
      };
      socket.onmessage = (event) => {
        try {
          setStatus(JSON.parse(String(event.data)) as DashboardStatus);
          setError("");
        } catch {
          setError("Received an unreadable dashboard update.");
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setConnection("reconnecting");
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(30000, retryDelay * 2);
      };
    };

    void load();
    connectTimer = window.setTimeout(connect, 0);
    return () => {
      stopped = true;
      window.clearTimeout(connectTimer);
      window.clearTimeout(retryTimer);
      if (socket?.readyState === WebSocket.OPEN) socket.close();
    };
  }, []);

  const entries = status ? Object.entries(status.summary) : [];
  const totals = entries.reduce(
    (result, [, repository]) => {
      const summary: Summary = repository[windowKey];
      result.merged += summary.merged;
      result.blocked += summary.blocked;
      result.cost += summary.cost;
      return result;
    },
    { merged: 0, blocked: 0, cost: 0 },
  );
  const visibleIssues =
    status?.issues.filter(
      (issue) =>
        matchesFilter(issue, filter) &&
        (
          issue.issue +
          " " +
          issue.title +
          " " +
          issue.state +
          " " +
          issue.runs.map((run) => run.label).join(" ")
        )
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) || [];
  const activeTickets =
    status?.issues.filter((issue) => matchesFilter(issue, "active")).length ||
    0;
  const updatedAt = status ? timeLabel(status.generated) : "—";
  const filterTabs: { value: IssueFilter; label: string }[] = [
    { value: "all", label: "Open tickets" },
    { value: "active", label: "Active" },
    { value: "waiting", label: "Waiting" },
    { value: "closed", label: "Closed" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ForgeHands dashboard">
          <span className="brand-mark">
            <Layers3 size={19} />
          </span>
          <span>
            <strong>ForgeHands</strong>
            <small>OPERATIONS</small>
          </span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <a className="nav-item active" href="#overview">
          <Activity size={17} /> Overview
        </a>
        <a className="nav-item" href="#tickets">
          <GitPullRequest size={17} /> Tickets{" "}
          <span>
            {status?.issues.filter((issue) => !issue.closed).length || 0}
          </span>
        </a>
        <a className="nav-item" href="#repositories">
          <Layers3 size={17} /> Repositories <span>{entries.length}</span>
        </a>
        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span className="live-dot" /> Direct mode
          </div>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="topbar">
          <div className="breadcrumb">
            ForgeHands <span>/</span> Overview
          </div>
          <div className="topbar-right">
            <Badge
              variant={connection === "live" ? "success" : "warning"}
              className="connection-badge"
            >
              {connection === "live" ? (
                <Wifi size={13} />
              ) : (
                <WifiOff size={13} />
              )}{" "}
              {connectionText(connection)}
            </Badge>
            <span className="updated-at">Updated {updatedAt}</span>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">OPERATIONS OVERVIEW</p>
              <h1>Agent activity</h1>
              <p className="page-subtitle">
                Current runs, merge outcomes, and ticket queues.
              </p>
            </div>
            <div className="window-control" aria-label="Summary time window">
              <Button
                variant={windowKey === "last_7_days" ? "default" : "outline"}
                size="sm"
                onClick={() => setWindowKey("last_7_days")}
              >
                7 days
              </Button>
              <Button
                variant={windowKey === "last_30_days" ? "default" : "outline"}
                size="sm"
                onClick={() => setWindowKey("last_30_days")}
              >
                30 days
              </Button>
            </div>
          </section>

          {status?.dry_run && (
            <div className="dry-banner">
              <ShieldAlert size={18} />
              <div>
                <strong>Dry run is active</strong>
                <span>
                  Writes are simulated for{" "}
                  {status.dry_run.repositories === "all"
                    ? "all repositories"
                    : status.dry_run.repositories.join(", ")}
                  .
                </span>
              </div>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          <section className="metric-grid" aria-label="Summary metrics">
            <Metric
              icon={Activity}
              label="Running now"
              value={String(status?.limits.running ?? "—")}
              detail={
                status
                  ? "of " + status.limits.max_concurrent + " concurrent slots"
                  : "Connecting to the ledger"
              }
              tone="tone-red"
            />
            <Metric
              icon={CircleCheck}
              label="Merged tickets"
              value={String(totals.merged)}
              detail={
                status
                  ? String(entries.length) + " repositories in this window"
                  : "Last 7 days"
              }
              tone="tone-green"
            />
            <Metric
              icon={Clock3}
              label="Waiting for a human"
              value={String(status?.waiting_for_human.length ?? "—")}
              detail={String(activeTickets) + " tickets actively moving"}
              tone="tone-amber"
            />
            <Metric
              icon={Coins}
              label="Run cost"
              value={money(totals.cost)}
              detail={
                windowKey === "last_7_days"
                  ? "Across the last 7 days"
                  : "Across the last 30 days"
              }
              tone="tone-rose"
            />
          </section>

          <div className="section-grid">
            <Card className="panel summary-panel" id="repositories">
              <CardHeader className="panel-header">
                <div>
                  <CardTitle>Repository health</CardTitle>
                  <p className="panel-subtitle">
                    Merge outcomes and retries in the selected window
                  </p>
                </div>
                <span className="panel-icon">
                  <Layers3 size={17} />
                </span>
              </CardHeader>
              <CardContent className="table-content">
                {entries.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repository</TableHead>
                        <TableHead>Merged</TableHead>
                        <TableHead>Blocked</TableHead>
                        <TableHead>Retries</TableHead>
                        <TableHead className="align-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entries.map(([repository, data]) => {
                        const summary = data[windowKey];
                        return (
                          <TableRow key={repository}>
                            <TableCell>
                              <span className="repo-name">
                                <span className="repo-dot" />
                                {repository}
                              </span>
                            </TableCell>
                            <TableCell>
                              <strong>{summary.merged}</strong>
                              <span className="table-muted">
                                {" "}
                                ({summary.merged_without_human} automatic)
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  summary.blocked ? "danger" : "secondary"
                                }
                              >
                                {summary.blocked}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {summary.review_retries} / {summary.error_retries}
                            </TableCell>
                            <TableCell className="align-right">
                              {money(summary.cost)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="empty-repositories">
                    <Layers3 size={20} />
                    <span>No repository activity yet</span>
                  </div>
                )}
              </CardContent>
              <div className="panel-footer">
                <Sparkles size={14} /> Median merge time is shown from ledger
                history
              </div>
            </Card>

            <Card className="panel capacity-panel">
              <CardHeader className="panel-header">
                <div>
                  <CardTitle>Capacity</CardTitle>
                  <p className="panel-subtitle">Current dispatcher limits</p>
                </div>
                <span className="panel-icon warm">
                  <Activity size={17} />
                </span>
              </CardHeader>
              <CardContent className="capacity-content">
                <div className="capacity-number">
                  <strong>{status?.limits.running ?? "—"}</strong>
                  <span>
                    active / {status?.limits.max_concurrent ?? "—"} slots
                  </span>
                </div>
                <div className="capacity-track">
                  <span
                    style={{
                      width: status
                        ? Math.min(
                            100,
                            (status.limits.running /
                              Math.max(1, status.limits.max_concurrent)) *
                              100,
                          ) + "%"
                        : "0%",
                    }}
                  />
                </div>
                <div className="capacity-meta">
                  <span>
                    <CircleDashed size={14} /> Max rounds
                  </span>
                  <strong>{status?.limits.max_rounds ?? "—"}</strong>
                </div>
                <div className="capacity-meta">
                  <span>
                    <ArrowUpRight size={14} /> Starts per hour
                  </span>
                  <strong>{status?.limits.max_runs_per_hour ?? "—"}</strong>
                </div>
                <div className="capacity-meta">
                  <span>
                    <ShieldAlert size={14} /> Blocked
                  </span>
                  <strong>{totals.blocked}</strong>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="panel tickets-panel" id="tickets">
            <CardHeader className="tickets-header">
              <div>
                <CardTitle>Ticket activity</CardTitle>
                <p className="panel-subtitle">
                  Latest known work from the job ledger
                </p>
              </div>
              <label className="search-box">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search tickets"
                  aria-label="Search tickets"
                />
              </label>
            </CardHeader>
            <CardContent className="tickets-content">
              <Tabs
                value={filter}
                onValueChange={(value) => setFilter(value as IssueFilter)}
              >
                <TabsList>
                  {filterTabs.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {visibleIssues.length ? (
                <Table className="ticket-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Current runs</TableHead>
                      <TableHead>Rounds</TableHead>
                      <TableHead>Last started</TableHead>
                      <TableHead className="align-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleIssues.map((issue) => {
                      const run = issue.runs[0];
                      return (
                        <TableRow key={issue.issue}>
                          <TableCell>
                            <div className="ticket-title">
                              <strong>{issue.issue}</strong>
                              {issue.pr && (
                                <span className="pr-tag">PR #{issue.pr}</span>
                              )}
                              <span>{issue.title || "Untitled ticket"}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={issueVariant(issue)}>
                              {issue.state}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="run-labels">
                              {issue.runs.slice(0, 3).map((item) => (
                                <span
                                  key={item.label + item.kind}
                                  className={"run-chip run-" + item.status}
                                >
                                  {item.label} · {item.status}
                                </span>
                              ))}
                              {issue.runs.length > 3 && (
                                <span className="table-muted">
                                  +{issue.runs.length - 3}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {issue.rounds}/{status?.limits.max_rounds ?? "—"}
                          </TableCell>
                          <TableCell>
                            {shortDate(run?.started || null)}
                          </TableCell>
                          <TableCell className="align-right">
                            {money(
                              issue.runs.reduce(
                                (sum, item) => sum + (item.cost || 0),
                                0,
                              ),
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <div className="empty-state">
                  <GitPullRequest size={22} />
                  <strong>No tickets in this view</strong>
                  <span>Try another filter or search term.</span>
                </div>
              )}
            </CardContent>
          </Card>

          <footer className="page-footer">
            <span>
              <span className="live-dot" /> {connectionText(connection)}
            </span>
            <span>
              <Clock3 size={13} /> Snapshot{" "}
              {status ? timeLabel(status.generated) : "pending"}
            </span>
            <span>
              {status?.notify.channels.length
                ? "Notifications: " + status.notify.channels.join(", ")
                : "No notification channels configured"}
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
