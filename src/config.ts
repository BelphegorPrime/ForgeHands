import { URL } from 'node:url';
import { globToRegExp } from './forge/glob.ts';
import { FORGES } from './forge/index.ts';
import type { ForgeKind } from './forge/types.ts';
import type { Config, Json, Logger, MergeRule, Route, RouteKind } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

function httpUrl(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(name + ' requires http(s) and no embedded credentials');
  }
  return url;
}

function positiveInt<F extends number | null>(value: unknown, fallback: F, name: string, max = 100000): number | F {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(name + ' must be an integer between 1 and ' + max);
  return number;
}

// LABEL_ROUTES ("on": "pull_request" for a label on a pull request, a follow-up round): {"ai:plan": {"profile": "<agent profile uuid>", "tier": "strong", "max_iterations": 80, "max_budget": 1.5}, ...}
function parseRoutes(text: string): Map<string, Route> {
  let parsed: Json;
  try { parsed = JSON.parse(text); } catch { throw new Error('LABEL_ROUTES must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('LABEL_ROUTES must be a non-empty JSON object');
  }
  const routes = new Map<string, Route>();
  for (const [label, route] of Object.entries(parsed as Record<string, Json>)) {
    if (!route || typeof route !== 'object' || !UUID.test(String(route.profile || ''))) {
      throw new Error('LABEL_ROUTES entry ' + label + ' needs a "profile" agent profile UUID');
    }
    const budget = route.max_budget === undefined ? null : Number(route.max_budget);
    if (budget !== null && !(budget > 0)) throw new Error('LABEL_ROUTES entry ' + label + ': max_budget must be > 0');
    routes.set(label, {
      profile: route.profile,
      tier: String(route.tier || 'default'),
      maxIterations: positiveInt(route.max_iterations, 100, 'max_iterations of ' + label, 1000) as number,
      maxBudget: budget,
      maxConcurrent: route.max_concurrent === undefined ? null : positiveInt(route.max_concurrent, null, 'max_concurrent of ' + label, 100) as number,
      // "on": "pull_request" makes the route fire for a label on the pull request of an issue (branch ai/issue-<n>).
      kind: (['pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict', 'sensitive_review'].includes(route.on) ? route.on : 'issue') as RouteKind,
      // "escalate_to": "<label of another route>": the last round (see ESCALATE_FROM_ROUND) runs with the profile and tier of that route.
      escalateTo: route.escalate_to === undefined ? null : String(route.escalate_to),
      // "fallback_to": "<label of another route>": while the tier of this route is out of quota, jobs start with the profile and tier of that route.
      fallbackTo: route.fallback_to === undefined ? null : String(route.fallback_to)
    });
  }
  for (const [label, route] of routes) {
    if (route.fallbackTo === null) continue;
    const target = routes.get(route.fallbackTo);
    if (route.fallbackTo === label || !target) throw new Error('LABEL_ROUTES entry ' + label + ': fallback_to must name another configured route');
    if (target.fallbackTo !== null) throw new Error('LABEL_ROUTES entry ' + label + ': fallback_to must name a route without a fallback_to of its own');
  }
  for (const [label, route] of routes) {
    if (route.escalateTo === null) continue;
    if (!['pull_request', 'ci_failure', 'conflict'].includes(route.kind)) throw new Error('LABEL_ROUTES entry ' + label + ': escalate_to only applies to a route that is a round (on: pull_request, ci_failure or conflict)');
    if (route.escalateTo === label || !routes.has(route.escalateTo)) throw new Error('LABEL_ROUTES entry ' + label + ': escalate_to must name another configured route');
  }
  return routes;
}

// MERGE_POLICY: {"owner/repo": {"deny": ["stacks/**", "compose.yaml"]}}. Only the repositories named here are merged by ForgeHands,
// and only when none of the changed files matches a deny pattern. A repository without an entry is never merged automatically.
function parseMergePolicy(text: string | undefined): Map<string, MergeRule> {
  const policy = new Map<string, MergeRule>();
  if (!text) return policy;
  let parsed: Json;
  try { parsed = JSON.parse(text); } catch { throw new Error('MERGE_POLICY must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MERGE_POLICY must be a JSON object');
  for (const [name, rule] of Object.entries(parsed as Record<string, Json>)) {
    if (!REPO.test(name.toLowerCase())) throw new Error('MERGE_POLICY: ' + name + ' is not owner/repository');
    const deny = rule?.deny ?? [];
    if (!Array.isArray(deny) || deny.some((glob: unknown) => typeof glob !== 'string' || !glob)) throw new Error('MERGE_POLICY: deny of ' + name + ' must be a list of patterns');
    // Optional: why a pattern needs a human, said in the comment that hands such a pull request over.
    const reasons = rule?.reasons ?? {};
    if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons) || Object.entries(reasons).some(([pattern, reason]) => !deny.includes(pattern) || typeof reason !== 'string' || !reason.trim())) {
      throw new Error('MERGE_POLICY: reasons of ' + name + ' must map patterns of its deny list to a text');
    }
    policy.set(name.toLowerCase(), { deny: deny.map(globToRegExp), patterns: [...deny], reasons: deny.map((pattern: string) => (reasons as Record<string, string>)[pattern]?.trim() || null) });
  }
  return policy;
}

function archiveDays(value: string | undefined): number {
  if (value === undefined || value === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('ARCHIVE_AFTER_DAYS must be an integer between 0 and 3650');
  return days;
}

function remindDays(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('REMIND_AFTER_DAYS must be an integer between 0 and 365');
  return days;
}

function parseHumanLogin(value: string | undefined): string | null {
  const login = String(value || '').trim().replace(/^@/, '');
  if (!login) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(login)) throw new Error('HUMAN_LOGIN must be a Forgejo login');
  return login;
}

// REPO_WEIGHTS: {"owner/repo": 5, ...}. A repository without an entry has weight 1; a higher weight means a larger share of the starts.
function parseRepoWeights(raw: string | undefined): Map<string, number> {
  const weights = new Map<string, number>();
  if (!raw || !raw.trim()) return weights;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('REPO_WEIGHTS must be a JSON object such as {"owner/repo": 2}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('REPO_WEIGHTS must be a JSON object such as {"owner/repo": 2}');
  for (const [repo, weight] of Object.entries(parsed as Record<string, unknown>)) {
    if (!REPO.test(repo.toLowerCase())) throw new Error('Invalid REPO_WEIGHTS entry: ' + repo);
    if (typeof weight !== 'number' || !(weight > 0) || weight > 1000) throw new Error('REPO_WEIGHTS: the weight of ' + repo + ' must be a number above 0 and at most 1000');
    weights.set(repo.toLowerCase(), weight);
  }
  return weights;
}

// The neutral FORGE_* name and its FORGEJO_* alias say the same thing. Both set and different is a mistake worth stopping for.
export function forgeEnv(env: NodeJS.ProcessEnv, neutral: string, alias: string): string | undefined {
  const a = env[neutral] || undefined;
  const b = env[alias] || undefined;
  if (a && b && a !== b) throw new Error(neutral + ' and ' + alias + ' are both set, with different values; set only ' + neutral);
  return a ?? b;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, logger: Logger = console): Config {
  // Removed in 0.4.0: a weekly cost cap per tier. Ignored (not an error) so that an existing setup still starts.
  if (env.TIER_WEEKLY_BUDGETS) logger.error('TIER_WEEKLY_BUDGETS is ignored, it was removed in 0.4.0 (max_budget of a route still caps one run)');
  const forge = (env.FORGE || 'forgejo').trim().toLowerCase();
  if (!(FORGES as readonly string[]).includes(forge)) throw new Error('FORGE must be ' + FORGES.join(' or ') + ', not ' + forge);
  // FORGE_URL, FORGE_TOKEN and FORGE_WEBHOOK_SECRET are the neutral names; FORGEJO_* keep working.
  const forgeUrl = forgeEnv(env, 'FORGE_URL', 'FORGEJO_URL');
  const forgeToken = forgeEnv(env, 'FORGE_TOKEN', 'FORGEJO_TOKEN');
  const forgejoSecret = forgeEnv(env, 'FORGE_WEBHOOK_SECRET', 'FORGEJO_WEBHOOK_SECRET') || '';
  const openhandsSecret = env.OPENHANDS_WEBHOOK_SECRET || '';
  const allowedRepos = new Set((env.ALLOWED_REPOS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const direct = Boolean(env.OPENHANDS_API_URL);

  if (forgejoSecret.length < 16) throw new Error('FORGEJO_WEBHOOK_SECRET must be at least 16 characters');
  if (allowedRepos.size === 0) throw new Error('ALLOWED_REPOS must contain at least one owner/repository');
  for (const repo of allowedRepos) {
    if (!REPO.test(repo)) throw new Error('Invalid ALLOWED_REPOS entry: ' + repo);
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

  const allowedSenders = env.ALLOWED_SENDERS
    ? new Set(env.ALLOWED_SENDERS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
    : null;
  // DRY_RUN=1: events are received and judged as usual, every write (Forgejo, OpenHands, the webhook forward) is only logged.
  // DRY_RUN_REPOS narrows it to some repositories; on its own it would silently run live, so it is an error.
  const dryRun = env.DRY_RUN === '1';
  const dryRunRepos = new Set((env.DRY_RUN_REPOS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (env.DRY_RUN !== undefined && env.DRY_RUN !== '' && env.DRY_RUN !== '0' && !dryRun) throw new Error('DRY_RUN must be 1 or 0');
  if (dryRunRepos.size && !dryRun) throw new Error('DRY_RUN_REPOS needs DRY_RUN=1');
  for (const repo of dryRunRepos) {
    if (!allowedRepos.has(repo)) throw new Error('DRY_RUN_REPOS entry ' + repo + ' is not in ALLOWED_REPOS');
  }
  // STATUS_TOKEN protects /status, /status.json and /metrics (direct mode); without it they are open, as before.
  const statusToken = env.STATUS_TOKEN || null;
  if (statusToken !== null && statusToken.length < 16) throw new Error('STATUS_TOKEN must be at least 16 characters');
  const dataFile = env.DATA_FILE || './data/deliveries.json';
  const common = {
    forge: forge as ForgeKind,
    forgejoSecret,
    allowedRepos,
    allowedSenders,
    statusToken,
    dataFile,
    port,
    host: env.HOST || '0.0.0.0',
    timeoutMs: 10000,
    maxBodyBytes: 1024 * 1024,
    dryRun,
    dryRunRepos
  };

  if (!direct) {
    // Legacy mode: signed webhook to an OpenHands automation, one label.
    if (openhandsSecret.length < 16) throw new Error('OPENHANDS_WEBHOOK_SECRET must be at least 16 characters');
    return {
      ...common,
      mode: 'webhook',
      openhandsSecret,
      endpoint: httpUrl(env.OPENHANDS_WEBHOOK_URL || '', 'OPENHANDS_WEBHOOK_URL').toString(),
      routes: new Map([['ai:ready', {}]])
    };
  }

  // Direct mode: start an OpenHands conversation with the agent profile that belongs to the label.
  if (!env.OPENHANDS_API_KEY) throw new Error('OPENHANDS_API_KEY is required with OPENHANDS_API_URL');
  // AGENT_SECRETS: names of environment variables whose values every started conversation receives as secrets
  // (OpenHands exposes saved secrets only to callers that pass them in the start request).
  const agentSecrets: Record<string, string> = {};
  for (const name of (env.AGENT_SECRETS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Invalid AGENT_SECRETS name: ' + name);
    // The agent's prompt names FORGEJO_URL and FORGEJO_TOKEN, so the neutral names reach it under those.
    const value = name === 'FORGE_URL' || name === 'FORGEJO_URL' ? forgeUrl : name === 'FORGE_TOKEN' || name === 'FORGEJO_TOKEN' ? forgeToken : env[name];
    if (!value) throw new Error('AGENT_SECRETS names ' + name + ', but it is not set');
    agentSecrets[name.replace(/^FORGE_/, 'FORGEJO_')] = value;
  }
  const routes = parseRoutes(env.LABEL_ROUTES || '');
  const maxRounds = positiveInt(env.MAX_ROUNDS, 3, 'MAX_ROUNDS', 100) as number;
  if (positiveInt(env.ESCALATE_FROM_ROUND, maxRounds, 'ESCALATE_FROM_ROUND', 100) as number > maxRounds) throw new Error('ESCALATE_FROM_ROUND must not be larger than MAX_ROUNDS');
  const mergePolicy = parseMergePolicy(env.MERGE_POLICY);
  const mergeMethod = env.MERGE_METHOD || 'merge';
  if (!['merge', 'squash', 'rebase', 'rebase-merge', 'fast-forward-only'].includes(mergeMethod)) throw new Error('MERGE_METHOD must be merge, squash, rebase, rebase-merge or fast-forward-only');
  if (mergePolicy.size && !(forgeUrl && forgeToken)) throw new Error('MERGE_POLICY needs FORGEJO_URL and FORGEJO_TOKEN (or FORGE_URL and FORGE_TOKEN)');
  if (remindDays(env.REMIND_AFTER_DAYS) && !(forgeUrl && forgeToken && parseHumanLogin(env.HUMAN_LOGIN))) throw new Error('REMIND_AFTER_DAYS needs FORGEJO_URL, FORGEJO_TOKEN and HUMAN_LOGIN (or FORGE_URL and FORGE_TOKEN)');
  return {
    ...common,
    mode: 'direct',
    apiUrl: httpUrl(env.OPENHANDS_API_URL!, 'OPENHANDS_API_URL').toString().replace(/\/$/, ''),
    apiKey: env.OPENHANDS_API_KEY,
    routes,
    mergePolicy,
    mergeMethod,
    // The label that asks for another round: the first route on pull requests (the reviewer sets it, a human may too).
    changesLabel: [...routes].find(([, route]) => route.kind === 'pull_request')?.[0] || 'ai:changes',
    agentSecrets,
    workspaceDir: env.WORKSPACE_DIR || '/projects',
    maxConcurrent: positiveInt(env.MAX_CONCURRENT, 4, 'MAX_CONCURRENT', 100),
    maxConcurrentPerTier: positiveInt(env.MAX_CONCURRENT_PER_TIER, 2, 'MAX_CONCURRENT_PER_TIER', 100),
    // Which repository gets the next free slot: weights per repository (JSON object, default 1), see Dispatcher.pickNext.
    repoWeights: parseRepoWeights(env.REPO_WEIGHTS),
    maxRunsPerHour: positiveInt(env.MAX_RUNS_PER_HOUR, 30, 'MAX_RUNS_PER_HOUR', 10000),
    maxRunMs: positiveInt(env.MAX_RUN_MINUTES, 120, 'MAX_RUN_MINUTES', 1440) * 60000,
    // Follow-up runs (routes on pull requests) per issue before ForgeHands stops and asks a human.
    maxRounds,
    // From this round on a route with "escalate_to" runs with the stronger profile; by default only the last round.
    escalateFromRound: positiveInt(env.ESCALATE_FROM_ROUND, maxRounds, 'ESCALATE_FROM_ROUND', 100) as number,
    // To tell the pull request that the rounds are used up (needs both; otherwise ForgeHands only logs it).
    forgejo: forgeUrl && forgeToken ? { url: httpUrl(forgeUrl, env.FORGE_URL ? 'FORGE_URL' : 'FORGEJO_URL').toString().replace(/\/$/, ''), token: forgeToken } : null,
    blockedLabel: env.BLOCKED_LABEL || 'ai:blocked',
    // When the default branch moves, open agent pull requests that fell behind and have no review or approval yet are brought up to
    // date (Forgejo's update, rebase style); one that conflicts gets a conflict round (route "on": "conflict"). 0 switches it off.
    updateBranches: env.UPDATE_BRANCHES !== '0',
    // Wait this long after the last push to the default branch before looking at the pull requests (a merge is often followed by another).
    branchUpdateDelayMs: positiveInt(env.BRANCH_UPDATE_DELAY_SECONDS, 60, 'BRANCH_UPDATE_DELAY_SECONDS', 3600) * 1000,
    // At most one update of a pull request branch in this many minutes, however often the default branch moves.
    branchUpdateMinIntervalMs: positiveInt(env.BRANCH_UPDATE_MIN_INTERVAL_MINUTES, 30, 'BRANCH_UPDATE_MIN_INTERVAL_MINUTES', 1440) * 60000,
    // A merge needs a review comment for the current commit: it says "Verdict: OK" within its first 300 characters and has at least this
    // many characters (evidence, not a one-liner). A label alone is not a review.
    minReviewChars: positiveInt(env.MIN_REVIEW_CHARS, 300, 'MIN_REVIEW_CHARS', 20000),
    // An approval label without a verdict comment is checked again after this many seconds before it is taken off; 0 takes it off at once.
    approvalGraceMs: env.APPROVAL_GRACE_SECONDS === '0' ? 0 : positiveInt(env.APPROVAL_GRACE_SECONDS, 90, 'APPROVAL_GRACE_SECONDS', 3600) * 1000,
    // A run whose conversation ends in `error` (the model failed, OpenHands was restarted) is started once more after a minute, this many
    // times, before it counts as failed; 0 switches it off. A run that stays failed is reported on the issue or pull request.
    // Out of quota: hold a tier back at most this long at a time, and give a job up once its quota has been out this long.
    quotaHoldMaxMs: positiveInt(env.QUOTA_HOLD_MAX_HOURS, 8, 'QUOTA_HOLD_MAX_HOURS', 48) * 3600000,
    quotaGiveUpMs: positiveInt(env.QUOTA_GIVE_UP_HOURS, 24, 'QUOTA_GIVE_UP_HOURS', 168) * 3600000,
    errorRetries: env.ERROR_RETRIES === '0' ? 0 : positiveInt(env.ERROR_RETRIES, 1, 'ERROR_RETRIES', 5),
    // When a worker run on an issue ends without finishing (paused at its iteration limit, stuck, timed out) the issue is probably too big:
    // this label (the planner route, e.g. ai:plan) is added so that the planner splits it into slices. Empty: off, a human is called.
    splitLabel: env.SPLIT_LABEL?.trim() || null,
    // Finished runs are archived in OpenHands (tag archived=true, the other tags stay) this many days after they ended; 0 switches it off.
    archiveAfterDays: archiveDays(env.ARCHIVE_AFTER_DAYS),
    // The Forgejo login to mention in the comments that hand something to a human (and only there), so that Forgejo mails him when his
    // notification setting is "only on mention". Needs an agent user of its own: Forgejo does not mail the actor of an action.
    humanLogin: parseHumanLogin(env.HUMAN_LOGIN),
    // Once a day, remind HUMAN_LOGIN of agent pull requests that wait for him (marked blocked, approved on a protected path, untouched):
    // after this many days, then at most once per this many days and REMIND_MAX times per pull request; 0 (default) switches it off.
    // STALE_LABEL is added after the last reminder.
    remindAfterDays: remindDays(env.REMIND_AFTER_DAYS),
    remindMax: positiveInt(env.REMIND_MAX, 3, 'REMIND_MAX', 100),
    staleLabel: env.STALE_LABEL?.trim() || null,
    approvedLabel: env.APPROVED_LABEL || 'ai:approved',
    // The labels that mark an issue to be reviewed and closed when its last dependency closes (route "on": "epic_done"): ai:plan, whose
    // planner run comes first, and ai:close, which has no run of its own and only asks for that closing review.
    // Pull requests of dependency bots (Renovate): Forgejo logins and, optionally, head branch prefixes (comma separated). They get the same
    // review and merge policy as agent pull requests, without a worker. A red commit starts a fix round only with BOT_FIX_ROUNDS (per pull request).
    botAuthors: new Set((env.BOT_AUTHORS || '').split(',').map((value) => value.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)),
    botBranchPrefixes: (env.BOT_BRANCH_PREFIXES || '').split(',').map((value) => value.trim()).filter(Boolean),
    botFixRounds: env.BOT_FIX_ROUNDS === undefined || env.BOT_FIX_ROUNDS === '' || env.BOT_FIX_ROUNDS === '0' ? 0 : positiveInt(env.BOT_FIX_ROUNDS, 0, 'BOT_FIX_ROUNDS', 100) as number,
    epicLabels: new Set((env.EPIC_LABEL || 'ai:plan,ai:close').split(',').map((value) => value.trim()).filter(Boolean)),
    pollMs: 15000,
    jobsFile: env.JOBS_FILE || dataFile.replace(/[^/\\]*$/, 'jobs.json')
  };
}
