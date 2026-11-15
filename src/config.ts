import { URL } from 'node:url';
import { globToRegExp } from './merge.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(name + ' requires http(s) and no embedded credentials');
  }
  return url;
}

function positiveInt(value, fallback, name, max = 100000) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(name + ' must be an integer between 1 and ' + max);
  return number;
}

// LABEL_ROUTES ("on": "pull_request" for a label on a pull request, a follow-up round): {"ai:plan": {"profile": "<agent profile uuid>", "tier": "strong", "max_iterations": 80, "max_budget": 1.5}, ...}
function parseRoutes(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('LABEL_ROUTES must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('LABEL_ROUTES must be a non-empty JSON object');
  }
  const routes = new Map();
  for (const [label, route] of Object.entries(parsed)) {
    if (!route || typeof route !== 'object' || !UUID.test(String(route.profile || ''))) {
      throw new Error('LABEL_ROUTES entry ' + label + ' needs a "profile" agent profile UUID');
    }
    const budget = route.max_budget === undefined ? null : Number(route.max_budget);
    if (budget !== null && !(budget > 0)) throw new Error('LABEL_ROUTES entry ' + label + ': max_budget must be > 0');
    routes.set(label, {
      profile: route.profile,
      tier: String(route.tier || 'default'),
      maxIterations: positiveInt(route.max_iterations, 100, 'max_iterations of ' + label, 1000),
      maxBudget: budget,
      maxConcurrent: route.max_concurrent === undefined ? null : positiveInt(route.max_concurrent, null, 'max_concurrent of ' + label, 100),
      // "on": "pull_request" makes the route fire for a label on the pull request of an issue (branch ai/issue-<n>).
      kind: ['pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict'].includes(route.on) ? route.on : 'issue'
    });
  }
  return routes;
}

// MERGE_POLICY: {"owner/repo": {"deny": ["stacks/**", "compose.yaml"]}}. Only the repositories named here are merged by ForgeHands,
// and only when none of the changed files matches a deny pattern. A repository without an entry is never merged automatically.
function parseMergePolicy(text) {
  const policy = new Map();
  if (!text) return policy;
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('MERGE_POLICY must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MERGE_POLICY must be a JSON object');
  for (const [name, rule] of Object.entries(parsed)) {
    if (!REPO.test(name.toLowerCase())) throw new Error('MERGE_POLICY: ' + name + ' is not owner/repository');
    const deny = rule?.deny ?? [];
    if (!Array.isArray(deny) || deny.some((glob) => typeof glob !== 'string' || !glob)) throw new Error('MERGE_POLICY: deny of ' + name + ' must be a list of patterns');
    policy.set(name.toLowerCase(), { deny: deny.map(globToRegExp) });
  }
  return policy;
}

function archiveDays(value) {
  if (value === undefined || value === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('ARCHIVE_AFTER_DAYS must be an integer between 0 and 3650');
  return days;
}

function parseHumanLogin(value) {
  const login = String(value || '').trim().replace(/^@/, '');
  if (!login) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(login)) throw new Error('HUMAN_LOGIN must be a Forgejo login');
  return login;
}

export function loadConfig(env = process.env) {
  const forgejoSecret = env.FORGEJO_WEBHOOK_SECRET || '';
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
  const dataFile = env.DATA_FILE || './data/deliveries.json';
  const common = {
    forgejoSecret,
    allowedRepos,
    allowedSenders,
    dataFile,
    port,
    host: env.HOST || '0.0.0.0',
    timeoutMs: 10000,
    maxBodyBytes: 1024 * 1024
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
  const agentSecrets = {};
  for (const name of (env.AGENT_SECRETS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Invalid AGENT_SECRETS name: ' + name);
    if (!env[name]) throw new Error('AGENT_SECRETS names ' + name + ', but it is not set');
    agentSecrets[name] = env[name];
  }
  // TIER_WEEKLY_BUDGETS: {"strong": 5} caps the LLM cost (USD) that runs of a tier may add up to within 7 days.
  const tierBudgets = new Map();
  if (env.TIER_WEEKLY_BUDGETS) {
    let parsed;
    try { parsed = JSON.parse(env.TIER_WEEKLY_BUDGETS); } catch { throw new Error('TIER_WEEKLY_BUDGETS must be valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TIER_WEEKLY_BUDGETS must be a JSON object');
    for (const [tier, amount] of Object.entries(parsed)) {
      if (!(Number(amount) > 0)) throw new Error('TIER_WEEKLY_BUDGETS: ' + tier + ' must be a number > 0');
      tierBudgets.set(tier, Number(amount));
    }
  }
  const routes = parseRoutes(env.LABEL_ROUTES || '');
  const mergePolicy = parseMergePolicy(env.MERGE_POLICY);
  const mergeMethod = env.MERGE_METHOD || 'merge';
  if (!['merge', 'squash', 'rebase', 'rebase-merge', 'fast-forward-only'].includes(mergeMethod)) throw new Error('MERGE_METHOD must be merge, squash, rebase, rebase-merge or fast-forward-only');
  if (mergePolicy.size && !(env.FORGEJO_URL && env.FORGEJO_TOKEN)) throw new Error('MERGE_POLICY needs FORGEJO_URL and FORGEJO_TOKEN');
  return {
    ...common,
    mode: 'direct',
    tierBudgets,
    apiUrl: httpUrl(env.OPENHANDS_API_URL, 'OPENHANDS_API_URL').toString().replace(/\/$/, ''),
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
    maxRunsPerHour: positiveInt(env.MAX_RUNS_PER_HOUR, 30, 'MAX_RUNS_PER_HOUR', 10000),
    maxRunMs: positiveInt(env.MAX_RUN_MINUTES, 120, 'MAX_RUN_MINUTES', 1440) * 60000,
    // Follow-up runs (routes on pull requests) per issue before ForgeHands stops and asks a human.
    maxRounds: positiveInt(env.MAX_ROUNDS, 3, 'MAX_ROUNDS', 100),
    // To tell the pull request that the rounds are used up (needs both; otherwise ForgeHands only logs it).
    forgejo: env.FORGEJO_URL && env.FORGEJO_TOKEN ? { url: httpUrl(env.FORGEJO_URL, 'FORGEJO_URL').toString().replace(/\/$/, ''), token: env.FORGEJO_TOKEN } : null,
    blockedLabel: env.BLOCKED_LABEL || 'ai:blocked',
    // When the default branch moves, open agent pull requests that fell behind and have no review or approval yet are brought up to
    // date (Forgejo's update, rebase style); one that conflicts gets a conflict round (route "on": "conflict"). 0 switches it off.
    updateBranches: env.UPDATE_BRANCHES !== '0',
    // Wait this long after the last push to the default branch before looking at the pull requests (a merge is often followed by another).
    branchUpdateDelayMs: positiveInt(env.BRANCH_UPDATE_DELAY_SECONDS, 60, 'BRANCH_UPDATE_DELAY_SECONDS', 3600) * 1000,
    // A merge needs a review comment for the current commit: it says "Verdict: OK" within its first 300 characters and has at least this
    // many characters (evidence, not a one-liner). A label alone is not a review.
    minReviewChars: positiveInt(env.MIN_REVIEW_CHARS, 300, 'MIN_REVIEW_CHARS', 20000),
    // Finished runs are archived in OpenHands (tag archived=true, the other tags stay) this many days after they ended; 0 switches it off.
    archiveAfterDays: archiveDays(env.ARCHIVE_AFTER_DAYS),
    // The Forgejo login to mention in the comments that hand something to a human (and only there), so that Forgejo mails him when his
    // notification setting is "only on mention". Needs an agent user of its own: Forgejo does not mail the actor of an action.
    humanLogin: parseHumanLogin(env.HUMAN_LOGIN),
    approvedLabel: env.APPROVED_LABEL || 'ai:approved',
    // The labels that mark an issue to be reviewed and closed when its last dependency closes (route "on": "epic_done"): ai:plan, whose
    // planner run comes first, and ai:close, which has no run of its own and only asks for that closing review.
    epicLabels: new Set((env.EPIC_LABEL || 'ai:plan,ai:close').split(',').map((value) => value.trim()).filter(Boolean)),
    pollMs: 15000,
    jobsFile: env.JOBS_FILE || dataFile.replace(/[^/\\]*$/, 'jobs.json')
  };
}
