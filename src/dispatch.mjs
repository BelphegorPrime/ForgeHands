import { buildPrompt } from './prompt.mjs';
import { forgejoCall } from './forgejo.mjs';
import { Merger } from './merge.mjs';

// `paused` counts: someone stopped the run on purpose (POST /pause), it does not end by itself and must not hold its slot or block the issue.
const TERMINAL = new Set(['finished', 'error', 'stuck', 'deleted', 'paused']);
const RETRY_BASE_MS = 60000;
const MAX_ATTEMPTS = 3;
const WEEK_MS = 7 * 24 * 3600 * 1000;
// Routes that count as a follow-up round of an issue (a review run does not).
const ROUND_KINDS = new Set(['pull_request', 'ci_failure']);

// Accumulated LLM cost (USD) of a conversation, summed over all of its LLMs.
export function conversationCost(data) {
  // OpenHands reports it under `stats`; `metrics` is null in the conversation response.
  const usage = data?.stats?.usage_to_metrics ?? data?.metrics?.usage_to_metrics;
  if (!usage || typeof usage !== 'object') return null;
  return Object.values(usage).reduce((sum, entry) => sum + (Number(entry?.accumulated_cost) || 0), 0);
}

// Starts OpenHands conversations for queued issues and keeps the load inside the configured limits.
export class Dispatcher {
  constructor(config, jobs, send = fetch, logger = console, now = Date.now) {
    this.config = config;
    this.jobs = jobs;
    this.send = send;
    this.logger = logger;
    this.now = now;
    this.current = null;
    this.timer = null;
    this.merger = new Merger(config, send, logger);
  }

  issueKey(event) {
    return event.repository.full_name.toLowerCase() + '#' + event.issue.number;
  }

  static labelsOf(payload, allowedRepos) {
    const name = payload?.repository?.full_name;
    // A pull request has its own labels, kept under its own key.
    const pull = payload?.pull_request && !payload?.issue;
    const subject = pull ? payload.pull_request : payload?.issue;
    const number = subject?.number;
    if (typeof name !== 'string' || !allowedRepos.has(name.toLowerCase()) || !Number.isSafeInteger(number)) return null;
    if (!Array.isArray(subject.labels)) return null;
    return {
      key: name.toLowerCase() + (pull ? '#pr' : '#') + number,
      labels: subject.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter((value) => typeof value === 'string')
    };
  }

  // The labels last seen on the issue of this payload (null when unknown). Read only.
  labelsBefore(payload, allowedRepos) {
    const seen = Dispatcher.labelsOf(payload, allowedRepos);
    return seen ? this.jobs.getLabels(seen.key) : null;
  }

  // Remember the labels of this payload. Called once an event has been handled, never when handling failed, so that a
  // retried delivery still sees what changed.
  recordLabels(payload, allowedRepos) {
    const seen = Dispatcher.labelsOf(payload, allowedRepos);
    if (seen && this.jobs.setLabels(seen.key, seen.labels, this.now())) {
      this.jobs.persist(this.now()).catch((error) => this.logger.error('persist failed:', error.message));
    }
  }

  // Which trigger label does this event start a run for? A label change on an existing issue does not say which label
  // was added, so it is the trigger labels that are new compared with the last labels seen on the issue. Without that
  // knowledge it is the first trigger label that never ran.
  pickLabel(event) {
    if (!event.label_event) return event.label;
    const base = this.issueKey(event);
    const kind = event.pull_request ? 'pull_request' : 'issue';
    const present = [...this.config.routes.keys()].filter((label) => (this.config.routes.get(label)?.kind || 'issue') === kind && event.issue.labels.includes(label));
    const previous = event.previous_labels;
    if (Array.isArray(previous)) return present.find((label) => !previous.includes(label));
    return present.find((label) => !this.jobs.list().some((job) => job.key === base + ':' + label));
  }

  async enqueue(event) {
    const label = this.pickLabel(event);
    if (!label) return { status: 'duplicate_job' };
    if (!this.config.routes.get(label)) throw new Error('no route for label ' + label);
    // A CI outcome belongs to one commit: the same commit starts one run, whatever the outcome of each workflow.
    const key = this.issueKey(event) + ':' + label + (event.ci ? ':' + event.ci.commit_sha.slice(0, 8) : '');
    if (event.ci ? this.jobs.list().some((job) => job.key === key) : this.jobs.activeByKey(key)) return { status: 'duplicate_job' };
    const kind = this.config.routes.get(label).kind;
    if (event.ci) {
      // While an agent still works on the issue (it will push again) the outcome is not acted on, but kept: it is looked at again
      // when that run ends (see releaseDeferred), because CI often finishes seconds before the agent's last step.
      const base = this.issueKey(event) + ':';
      if (this.jobs.list(true).some((job) => job.key.startsWith(base) && !job.waiting_for_run)) {
        const deferred = this.jobs.add({ key, label, event: { ...event, label }, status: 'waiting', waiting_for_run: true, created: this.now() });
        try {
          await this.jobs.persist(this.now());
        } catch (error) {
          this.jobs.remove(deferred.id);
          throw error;
        }
        return { status: 'deferred' };
      }
      // A commit that is no longer the head of the pull request says nothing (the run was replaced by a newer push).
      if (await this.isStale(event)) return { status: 'stale_run' };
    }
    if (kind === 'ci_success' && !(await this.commitGreen(event))) return { status: 'ci_not_green' };
    if (event.pull_request && ROUND_KINDS.has(kind) && this.rounds(event) >= this.config.maxRounds) {
      await this.roundsUsedUp(event);
      return { status: 'rounds_exceeded' };
    }
    // An issue that depends on open issues waits until the last of them closes (Forgejo's issue dependencies).
    const open = !event.pull_request && kind === 'issue' ? await this.openDependencies(event, event.issue.number) : [];
    const job = this.jobs.add({ key, label, event: { ...event, label }, status: open.length ? 'waiting' : 'queued', ...(open.length ? { waiting_for: open } : {}), created: this.now() });
    try {
      await this.jobs.persist(this.now());
    } catch (error) {
      this.jobs.remove(job.id); // not durable: the retried delivery must be able to enqueue it again
      throw error;
    }
    if (open.length) return { status: 'waiting' };
    // The earlier approval does not cover what this run will push or review.
    if (event.pull_request) await this.merger.clearApproval(event);
    this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
  }

  // Follow-up runs (pull request routes) already made for the issue of this event.
  rounds(event) {
    const base = this.issueKey(event) + ':';
    return this.jobs.list().filter((job) => job.key.startsWith(base) && ROUND_KINDS.has(this.config.routes.get(job.label)?.kind)
      && (job.started || job.status === 'queued' || job.status === 'running')).length;
  }

  forgejoCall(event, method, path, body) {
    return forgejoCall(this.config, this.send, event.repository.full_name, method, path, body);
  }

  // The reviewer approved the pull request (label): merge it when the operator's policy for the repository allows.
  async approve(event) {
    if (Array.isArray(event.previous_labels) && event.previous_labels.includes(this.config.approvedLabel)) return 'already_approved';
    return this.merger.handle(event);
  }

  // The open issues the given issue depends on. Without Forgejo access, or when the call fails, none: the issue is not held back.
  async openDependencies(event, number) {
    if (!this.config.forgejo) return [];
    try {
      const dependencies = await this.forgejoCall(event, 'GET', '/issues/' + number + '/dependencies');
      return (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open').map((issue) => issue.number);
    } catch (error) {
      this.logger.error('could not read the dependencies of #' + number + ':', error.message);
      return [];
    }
  }

  // An issue closed: what depended on it may start now (a waiting job), and an epic whose last dependency this was is reviewed.
  async onClosed(event) {
    if (!this.config.forgejo) return 'no_forgejo_access';
    let blocked;
    try { blocked = await this.forgejoCall(event, 'GET', '/issues/' + event.issue.number + '/blocks'); }
    catch (error) { this.logger.error('could not read what #' + event.issue.number + ' blocks:', error.message); return 'blocks_unknown'; }
    const outcome = [];
    let changed = false;
    for (const target of Array.isArray(blocked) ? blocked : []) {
      if (target.state !== 'open') continue;
      if ((await this.openDependencies(event, target.number)).length) continue;
      const base = event.repository.full_name.toLowerCase() + '#' + target.number + ':';
      const waiting = this.jobs.list(true).filter((job) => job.status === 'waiting' && job.key.startsWith(base));
      if (waiting.length) {
        for (const job of waiting) { job.status = 'queued'; delete job.waiting_for; }
        outcome.push('started #' + target.number);
        changed = true;
      } else if ((target.labels || []).some((label) => this.config.epicLabels.has(label.name))) {
        if (await this.startEpicReview(event, target)) { outcome.push('epic #' + target.number + ' review'); changed = true; }
      }
    }
    if (changed) {
      await this.jobs.persist(this.now());
      this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    }
    return outcome.join(', ') || 'nothing_ready';
  }

  // All dependencies of the epic are closed: have it reviewed (and closed when its criteria are met). Once per run.
  async startEpicReview(event, epic) {
    const route = [...this.config.routes].find(([, entry]) => entry.kind === 'epic_done')?.[0];
    if (!route) return false;
    const key = event.repository.full_name.toLowerCase() + '#' + epic.number + ':' + route;
    if (this.jobs.activeByKey(key)) return false;
    let children = [];
    try {
      children = (await this.forgejoCall(event, 'GET', '/issues/' + epic.number + '/dependencies')).map((issue) => ({ number: issue.number, title: String(issue.title || '').slice(0, 200) }));
    } catch (error) { this.logger.error('could not list the sub-issues of #' + epic.number + ':', error.message); }
    this.jobs.add({
      key, label: route, status: 'queued', created: this.now(),
      event: {
        type: 'epic.done', source: 'forgejo', action: 'dependencies_closed', label: route, repository: event.repository,
        issue: { number: epic.number, title: String(epic.title || '').slice(0, 1000), body: String(epic.body || '').slice(0, 50000), html_url: epic.html_url || null, comments: epic.comments || 0, labels: (epic.labels || []).map((label) => label.name) },
        epic: { children }, sender: event.sender
      }
    });
    return true;
  }

  // A CI outcome kept while an agent worked on the issue. Once no run of the issue is active any more it is judged as if it had just
  // arrived: gone when its commit is no longer the head or the status is not green (a later event can come again), otherwise started.
  async releaseDeferred(job, now) {
    const base = job.key.split(':')[0] + ':';
    if (this.jobs.list(true).some((other) => other.id !== job.id && !other.waiting_for_run && other.key.startsWith(base))) {
      if (job.created + this.config.maxRunMs < now) { this.jobs.remove(job.id); return true; }
      return false;
    }
    const event = job.event;
    const kind = this.config.routes.get(job.label)?.kind;
    let start = !(await this.isStale(event));
    if (start && kind === 'ci_success') start = await this.commitGreen(event);
    if (start && ROUND_KINDS.has(kind) && this.rounds(event) >= this.config.maxRounds) {
      await this.roundsUsedUp(event);
      start = false;
    }
    if (!start) { this.jobs.remove(job.id); return true; }
    delete job.waiting_for_run;
    job.status = 'queued';
    await this.merger.clearApproval(event);
    return true;
  }

  // Is the commit of a CI run no longer the head of its pull request? Unknown (no access, error) counts as not stale.
  async isStale(event) {
    if (!this.config.forgejo) return false;
    try {
      const pr = await this.forgejoCall(event, 'GET', '/pulls/' + event.pull_request.number);
      return Boolean(pr?.head?.sha) && pr.head.sha !== event.ci.commit_sha;
    } catch (error) {
      this.logger.error('could not read the head of #' + event.pull_request.number + ':', error.message);
      return false;
    }
  }

  // Forgejo sends one event per finished workflow run. All workflows of the commit have to be green: the combined commit
  // status says so. Without Forgejo access ForgeHands cannot tell and starts no review.
  async commitGreen(event) {
    if (!this.config.forgejo) {
      this.logger.error('ci success of ' + this.issueKey(event) + ' ignored: FORGEJO_URL and FORGEJO_TOKEN are needed to check the commit status');
      return false;
    }
    try {
      const status = await this.forgejoCall(event, 'GET', '/commits/' + encodeURIComponent(event.ci.commit_sha) + '/status');
      return status?.state === 'success' && status.total_count > 0;
    } catch (error) {
      this.logger.error('commit status failed:', error.message);
      return false;
    }
  }

  // The rounds are used up: say so on the pull request and mark it for a human. Best effort, a failure is only logged.
  async roundsUsedUp(event) {
    const { number } = event.pull_request;
    this.logger.error(this.issueKey(event) + ': ' + this.config.maxRounds + ' rounds used up, not starting another');
    if (!this.config.forgejo) return;
    const call = (method, path, body) => this.forgejoCall(event, method, path, body);
    try {
      await call('POST', '/issues/' + number + '/comments', { body: 'ForgeHands: ' + this.config.maxRounds + ' follow-up rounds for issue #' + event.issue.number + ' are used up. A human has to look at this pull request now.' });
      const known = await call('GET', '/labels?limit=100');
      let label = (known || []).find((entry) => entry.name === this.config.blockedLabel);
      if (!label) label = await call('POST', '/labels', { name: this.config.blockedLabel, color: '#b60205' });
      await call('POST', '/issues/' + number + '/labels', { labels: [label.id] });
    } catch (error) {
      this.logger.error('could not mark the pull request:', error.message);
    }
  }

  start(intervalMs = this.config.pollMs) {
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error('dispatch failed:', error.message)), intervalMs);
    this.timer.unref?.();
    return this.tick();
  }
  stop() { clearInterval(this.timer); }

  async api(method, path, body) {
    const response = await this.send(this.config.apiUrl + path, {
      method,
      headers: { 'X-Session-API-Key': this.config.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
      redirect: 'error'
    });
    return response;
  }

  // Ticks never overlap: a caller waits for the running one and then runs a fresh pass.
  async tick() {
    while (this.current) await this.current.catch(() => {});
    this.current = this.pass();
    try { await this.current; } finally { this.current = null; }
  }

  async pass() {
    let changed = false;
    const now = this.now();
    for (const job of this.jobs.list('running')) {
      if (await this.poll(job, now)) changed = true;
    }
    for (const job of this.jobs.list(true).filter((entry) => entry.status === 'waiting' && entry.waiting_for_run)) {
      if (await this.releaseDeferred(job, now)) changed = true;
    }
    for (const job of this.jobs.list('queued')) {
      if (job.next_try && job.next_try > now) continue;
      if (!this.hasRoom(job, now)) continue;
      if (await this.startJob(job, now)) changed = true;
    }
    if (changed) await this.jobs.persist(this.now());
  }

  hasRoom(job, now) {
    const running = this.jobs.list('running');
    if (running.length >= this.config.maxConcurrent) return false;
    const route = this.config.routes.get(job.label);
    const tierLimit = route.maxConcurrent ?? this.config.maxConcurrentPerTier;
    if (running.filter((other) => this.config.routes.get(other.label)?.tier === route.tier).length >= tierLimit) return false;
    const startedLastHour = this.jobs.list().filter((other) => other.started && other.started > now - 3600000).length;
    if (startedLastHour >= this.config.maxRunsPerHour) return false;
    const budget = this.config.tierBudgets?.get(route.tier);
    return budget === undefined || this.weeklySpend(route.tier, now) < budget;
  }

  // Cost of the runs of a tier started within the last 7 days (running ones count with their latest known cost).
  weeklySpend(tier, now) {
    return this.jobs.list()
      .filter((job) => job.started && job.started > now - WEEK_MS && this.config.routes.get(job.label)?.tier === tier)
      .reduce((sum, job) => sum + (job.cost || 0), 0);
  }

  async startJob(job, now) {
    const route = this.config.routes.get(job.label);
    const body = {
      workspace: { working_dir: this.config.workspaceDir },
      agent_profile_id: route.profile,
      max_iterations: route.maxIterations,
      tags: { source: 'forgehands', issue: String(job.event.issue.number), ...(job.event.pull_request ? { pr: String(job.event.pull_request.number) } : {}), ...(job.event.ci ? { ci: job.event.type.slice(3) } : {}), ...(job.event.epic ? { epic: 'done' } : {}) },
      initial_message: { role: 'user', run: true, content: [{ type: 'text', text: buildPrompt(job.event, this.config) }] }
    };
    if (route.maxBudget) body.max_budget_per_run = route.maxBudget;
    // Built per start from the environment; never stored in the ledger.
    const secrets = Object.entries(this.config.agentSecrets || {});
    if (secrets.length) {
      body.secrets = Object.fromEntries(secrets.map(([name, value]) => [name, { kind: 'StaticSecret', value, description: 'Provided by ForgeHands' }]));
    }
    try {
      const response = await this.api('POST', '/api/conversations', body);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const created = await response.json();
      if (!created?.id) throw new Error('response without conversation id');
      Object.assign(job, { status: 'running', conversation_id: created.id, started: now, error: undefined });
    } catch (error) {
      job.attempts += 1;
      job.error = error.message;
      this.logger.error('starting conversation for ' + job.key + ' failed:', error.message);
      if (job.attempts >= MAX_ATTEMPTS) Object.assign(job, { status: 'failed', finished: now });
      else job.next_try = now + RETRY_BASE_MS * job.attempts;
    }
    return true;
  }

  async poll(job, now) {
    let state = null;
    let costChanged = false;
    try {
      const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id));
      if (response.status === 404) state = 'deleted';
      else if (response.ok) {
        const data = await response.json();
        state = data.execution_status || data.status;
        const cost = conversationCost(data);
        if (cost !== null && cost !== job.cost) { job.cost = cost; costChanged = true; }
      }
    } catch (error) {
      this.logger.error('polling ' + job.key + ' failed:', error.message);
    }
    if (TERMINAL.has(state)) {
      Object.assign(job, { status: state === 'finished' ? 'done' : 'failed', result: state, finished: now });
      return true;
    }
    if (costChanged) return true;
    // Free the slot of a run that never ends; the conversation itself is left alone.
    if (job.started && job.started + this.config.maxRunMs < now) {
      Object.assign(job, { status: 'failed', result: 'timeout', finished: now });
      return true;
    }
    return false;
  }
}
