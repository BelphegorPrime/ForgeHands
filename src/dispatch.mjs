import { buildPrompt } from './prompt.mjs';

const TERMINAL = new Set(['finished', 'error', 'stuck', 'deleted']);
const RETRY_BASE_MS = 60000;
const MAX_ATTEMPTS = 3;
const WEEK_MS = 7 * 24 * 3600 * 1000;

// Accumulated LLM cost (USD) of a conversation, summed over all of its LLMs.
export function conversationCost(data) {
  const usage = data?.metrics?.usage_to_metrics;
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
  }

  async enqueue(event) {
    const route = this.config.routes.get(event.label);
    if (!route) throw new Error('no route for label ' + event.label);
    const key = event.repository.full_name.toLowerCase() + '#' + event.issue.number + ':' + event.label;
    if (this.jobs.activeByKey(key)) return { status: 'duplicate_job' };
    this.jobs.add({ key, label: event.label, event, status: 'queued', created: this.now() });
    await this.jobs.persist(this.now());
    this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
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
      tags: { source: 'forgehands', issue: String(job.event.issue.number) },
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
