import { URL } from 'node:url';
import { dirname, isAbsolute, normalize } from 'node:path';
import { globToRegExp } from './utils/glob.ts';
import { FORGES } from './forge/index.ts';
import type { ForgeKind } from './types/forge.ts';
import { parseNotify } from './notify/config.ts';
import type { Config, DirectConfig, Json, Logger, MergeRule, Route, RouteKind } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// owner/name; GitLab projects may sit in subgroups (group/sub/name).
const REPO = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/;

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
      kind: (['pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict', 'sensitive_review', 'main_red'].includes(route.on) ? route.on : 'issue') as RouteKind,
      // "escalate_to": "<label of another route>": the last round (see ESCALATE_FROM_ROUND) runs with the profile and tier of that route.
      escalateTo: route.escalate_to === undefined ? null : String(route.escalate_to),
      // "fallback_to": "<label of another route>": while the tier of this route is out of quota, jobs start with the profile and tier of that route.
      fallbackTo: route.fallback_to === undefined ? null : String(route.fallback_to),
      // "forgejo_token_secret": the reviewer's own Forgejo user (the author of a pull request cannot approve it), see loadConfig.
      forgejoTokenSecret: route.forgejo_token_secret === undefined ? null : String(route.forgejo_token_secret)
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
// `two_keys` of a MERGE_POLICY entry: patterns inside the deny list that merge with an independent security review instead of a human.
// Each one, taken as a literal path (wildcards become `x`), must match a deny pattern, otherwise it could never apply.
function parseTwoKeys(name: string, value: unknown, deny: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((glob: unknown) => typeof glob !== 'string' || !glob.trim())) throw new Error('MERGE_POLICY: two_keys of ' + name + ' must be a list of patterns');
  if (!deny.length && value.length) throw new Error('MERGE_POLICY: two_keys of ' + name + ' needs a deny list');
  const denyRules = deny.map(globToRegExp);
  for (const glob of value as string[]) {
    const literal = glob.replace(/\*+/g, 'x').replace(/\?/g, 'x');
    if (!denyRules.some((rule) => rule.test(literal))) throw new Error('MERGE_POLICY: two_keys pattern ' + glob + ' of ' + name + ' is not covered by a deny pattern');
  }
  return [...value as string[]];
}

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
    const twoKeys = parseTwoKeys(name, rule?.two_keys, deny);
    policy.set(name.toLowerCase(), { deny: deny.map(globToRegExp), patterns: [...deny], reasons: deny.map((pattern: string) => (reasons as Record<string, string>)[pattern]?.trim() || null),
      twoKeys: twoKeys.map(globToRegExp), twoKeyPatterns: twoKeys });
  }
  return policy;
}

function archiveDays(value: string | undefined): number {
  if (value === undefined || value === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('ARCHIVE_AFTER_DAYS must be an integer between 0 and 3650');
  return days;
}

// WORKSPACE_CLEANUP_DIR: the host directory the OpenHands workspace is mounted from, as this container sees it. Empty switches the cleanup
// off. It must be an absolute path that is not the root: a cleanup that deletes below "/" would be a disaster, so that is a start error.
export function cleanupDirOf(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!isAbsolute(text)) throw new Error('WORKSPACE_CLEANUP_DIR must be an absolute path (the directory as this container sees it), got a relative one');
  const dir = normalize(text).replace(/(.)\/+$/, '$1');
  if (dirname(dir) === dir) throw new Error('WORKSPACE_CLEANUP_DIR must not be the root directory');
  return dir;
}

// Hours of the cleanup settings: a number of hours, 0 included, at most a year.
function hoursOf(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 8760) throw new Error(name + ' must be a number of hours between 0 and 8760');
  return hours;
}

// DISK_WARN_PERCENT (an integer from 0 to 100, 0 = off) and DISK_MIN_FREE_GB (a number of gigabytes, 0 = off).
function diskPercentOf(value: string | undefined): number {
  if (value === undefined || value === '') return 85;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw new Error('DISK_WARN_PERCENT must be an integer between 0 and 100');
  return Number(value);
}
function diskFreeGbOf(value: string | undefined): number {
  if (value === undefined || value === '') return 3;
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb < 0 || gb > 100000) throw new Error('DISK_MIN_FREE_GB must be a number of gigabytes between 0 and 100000');
  return gb;
}

// LEDGER_SYNC_HOURS (0 = off) and STATUS_HIDE_DAYS (0 = hide nothing): whole numbers with a default.
function wholeOf(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new Error(name + ' must be an integer between 0 and ' + max);
  return number;
}

function remindDays(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('REMIND_AFTER_DAYS must be an integer between 0 and 365');
  return days;
}

function parseBotRepos(value: string | undefined, allowed: Set<string>): Set<string> {
  const repos = new Set((value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  for (const repo of repos) if (!allowed.has(repo)) throw new Error('BOT_REPOS: ' + repo + ' is not in ALLOWED_REPOS');
  return repos;
}

function parseLogins(value: string | undefined): Set<string> | null {
  const logins = (value || '').split(',').map((login) => login.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  return logins.length ? new Set(logins) : null;
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
  if (!(FORGES as readonly string[]).includes(forge)) throw new Error('FORGE must be ' + FORGES.slice(0, -1).join(', ') + ' or ' + FORGES.at(-1) + ', not ' + forge);
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
  // VERDICT_SOURCE: `comment` (default) is a "Verdict: OK" comment plus the approval label; `review` is Forgejo's own pull request review
  // (Approve / Request changes) on the head commit, which branch protection can enforce; `both` accepts either.
  const verdictSource = (env.VERDICT_SOURCE || 'comment').trim().toLowerCase();
  if (!['comment', 'review', 'both'].includes(verdictSource)) throw new Error('VERDICT_SOURCE must be comment, review or both');
  if (verdictSource !== 'comment' && !(forgeUrl && forgeToken)) throw new Error('VERDICT_SOURCE=' + verdictSource + ' needs FORGEJO_URL and FORGEJO_TOKEN (or FORGE_URL and FORGE_TOKEN) to read the reviews');
  const requiredApprovals = positiveInt(env.REQUIRED_APPROVALS, 1, 'REQUIRED_APPROVALS', 20) as number;
  if (requiredApprovals > 1 && verdictSource === 'comment') throw new Error('REQUIRED_APPROVALS above 1 needs VERDICT_SOURCE=review or both (a comment verdict has no approver to count)');
  // A route's own Forgejo token: it has to be one of AGENT_SECRETS (so that it is read from the environment like the others) and is then
  // withheld from every other conversation. It must be another user than the one of FORGEJO_TOKEN, who authors the pull requests and cannot approve them.
  for (const [label, route] of routes) {
    const name = route.forgejoTokenSecret;
    if (name === null) {
      if (verdictSource === 'review' && route.kind === 'ci_success') throw new Error('LABEL_ROUTES entry ' + label + ': VERDICT_SOURCE=review needs "forgejo_token_secret" on every review route (on: ci_success), the reviewer needs a Forgejo user of its own');
      continue;
    }
    if (route.kind !== 'ci_success' && route.kind !== 'sensitive_review') throw new Error('LABEL_ROUTES entry ' + label + ': forgejo_token_secret only applies to a review route (on: ci_success) or a security review route (on: sensitive_review)');
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !(name in agentSecrets) || ['FORGEJO_TOKEN', 'FORGEJO_URL'].includes(name)) {
      throw new Error('LABEL_ROUTES entry ' + label + ': forgejo_token_secret must name an extra entry of AGENT_SECRETS (not FORGE_TOKEN or FORGE_URL)');
    }
    if (agentSecrets[name] === forgeToken) throw new Error('LABEL_ROUTES entry ' + label + ': ' + name + ' is the token of FORGE_TOKEN; the reviewer needs its own Forgejo user, the author of a pull request cannot approve it');
  }
  // Two keys name who may write the second key: a security route needs a token of its own for that, or the worker could sign as the security reviewer.
  if ([...parseMergePolicy(env.MERGE_POLICY).values()].some((rule) => rule.twoKeys.length)) {
    for (const [label, route] of routes) if (route.kind === 'sensitive_review' && !route.forgejoTokenSecret) throw new Error('LABEL_ROUTES entry ' + label + ': MERGE_POLICY two_keys needs "forgejo_token_secret" on every sensitive_review route, so that the worker cannot sign as the security reviewer');
  }
  const maxRounds = positiveInt(env.MAX_ROUNDS, 3, 'MAX_ROUNDS', 100) as number;
  if (positiveInt(env.ESCALATE_FROM_ROUND, maxRounds, 'ESCALATE_FROM_ROUND', 100) as number > maxRounds) throw new Error('ESCALATE_FROM_ROUND must not be larger than MAX_ROUNDS');
  const mergePolicy = parseMergePolicy(env.MERGE_POLICY);
  const mergeMethod = env.MERGE_METHOD || 'merge';
  if (!['merge', 'squash', 'rebase', 'rebase-merge', 'fast-forward-only'].includes(mergeMethod)) throw new Error('MERGE_METHOD must be merge, squash, rebase, rebase-merge or fast-forward-only');
  if (mergePolicy.size && !(forgeUrl && forgeToken)) throw new Error('MERGE_POLICY needs FORGEJO_URL and FORGEJO_TOKEN (or FORGE_URL and FORGE_TOKEN)');
  if ([...mergePolicy.values()].some((rule) => rule.twoKeys.length) && !parseLogins(env.SECURITY_REVIEWERS)) throw new Error('MERGE_POLICY two_keys needs SECURITY_REVIEWERS: the logins whose security review comment counts as the second key (a user the worker does not control)');
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
    // The cleanup of the workspace (README: Cleaning the workspace). Off unless WORKSPACE_CLEANUP_DIR names the mounted directory.
    workspaceCleanupDir: cleanupDirOf(env.WORKSPACE_CLEANUP_DIR),
    workspaceCleanupDry: switchOff(env.WORKSPACE_CLEANUP_DRY, 'WORKSPACE_CLEANUP_DRY'),
    workspaceKeepHours: hoursOf(env.WORKSPACE_KEEP_HOURS, 12, 'WORKSPACE_KEEP_HOURS'),
    workspaceKeepFailedHours: hoursOf(env.WORKSPACE_KEEP_FAILED_HOURS, 72, 'WORKSPACE_KEEP_FAILED_HOURS'),
    workspaceOrphanHours: hoursOf(env.WORKSPACE_ORPHAN_HOURS, 48, 'WORKSPACE_ORPHAN_HOURS'),
    // Disk guard, measured on the filesystem of WORKSPACE_CLEANUP_DIR: a warning notification at DISK_WARN_PERCENT, and no new run below DISK_MIN_FREE_GB.
    diskWarnPercent: diskPercentOf(env.DISK_WARN_PERCENT),
    diskMinFreeGb: diskFreeGbOf(env.DISK_MIN_FREE_GB),
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
    // A repository without any workflow file never reports a CI run, so a pull request there would never be reviewed: with this on (the
    // default) the review starts on the new commit without waiting. A repository with workflows is not affected. 0 switches it off.
    reviewWithoutCi: reviewSwitch(env.REVIEW_WITHOUT_CI),
    // Off unless 1: a ticket whose declared files ('## Exact files' in its body) overlap those of an older open ticket or agent pull request waits.
    waitForSameFiles: switchOff(env.WAIT_FOR_SAME_FILES, 'WAIT_FOR_SAME_FILES'),
    // Wait this long after the last push to the default branch before looking at the pull requests (a merge is often followed by another).
    branchUpdateDelayMs: positiveInt(env.BRANCH_UPDATE_DELAY_SECONDS, 60, 'BRANCH_UPDATE_DELAY_SECONDS', 3600) * 1000,
    // At most one update of a pull request branch in this many minutes, however often the default branch moves.
    branchUpdateMinIntervalMs: positiveInt(env.BRANCH_UPDATE_MIN_INTERVAL_MINUTES, 30, 'BRANCH_UPDATE_MIN_INTERVAL_MINUTES', 1440) * 60000,
    // A merge needs a review comment for the current commit: it says "Verdict: OK" within its first 300 characters and has at least this
    // many characters (evidence, not a one-liner). A label alone is not a review.
    verdictSource: verdictSource as DirectConfig['verdictSource'],
    requiredApprovals,
    minReviewChars: positiveInt(env.MIN_REVIEW_CHARS, 300, 'MIN_REVIEW_CHARS', 20000),
    // An approval label without a verdict comment is checked again after this many seconds before it is taken off; 0 takes it off at once.
    approvalGraceMs: env.APPROVAL_GRACE_SECONDS === '0' ? 0 : positiveInt(env.APPROVAL_GRACE_SECONDS, 90, 'APPROVAL_GRACE_SECONDS', 3600) * 1000,
    // A run whose conversation ends in `error` (the model failed, OpenHands was restarted) is started once more after a minute, this many
    // times, before it counts as failed; 0 switches it off. A run that stays failed is reported on the issue or pull request.
    // Out of quota: hold a tier back at most this long at a time, and give a job up once its quota has been out this long.
    quotaHoldMaxMs: positiveInt(env.QUOTA_HOLD_MAX_HOURS, 8, 'QUOTA_HOLD_MAX_HOURS', 48) * 3600000,
    quotaGiveUpMs: positiveInt(env.QUOTA_GIVE_UP_HOURS, 24, 'QUOTA_GIVE_UP_HOURS', 168) * 3600000,
    errorRetries: env.ERROR_RETRIES === '0' ? 0 : positiveInt(env.ERROR_RETRIES, 1, 'ERROR_RETRIES', 5),
    // A run that ends stuck or timed out is continued on its own conversation this many times (a message, then the run) before the next
    // stage: a round escalates (FAILURE_ESCALATE), anything else goes to the human. 0 switches it off.
    resumeAttempts: env.RESUME_ATTEMPTS === '0' ? 0 : positiveInt(env.RESUME_ATTEMPTS, 1, 'RESUME_ATTEMPTS', 5),
    // A paused run (an interruption, not a sign of a big ticket) continues on its conversation this many times, on a budget of its own.
    pauseResumes: env.PAUSE_RESUMES === '0' ? 0 : positiveInt(env.PAUSE_RESUMES, 3, 'PAUSE_RESUMES', 10),
    // A round that is still stuck, timed out or out of iterations after that starts once more on the profile of its escalate_to route, once per
    // head commit of the pull request. 0 switches it off.
    failureEscalate: failureEscalateOf(env.FAILURE_ESCALATE),
    // When a worker run on an issue ends without finishing (paused at its iteration limit, stuck, timed out) the issue is probably too big:
    // this label (the planner route, e.g. ai:plan) is added so that the planner splits it into slices. Empty: off, a human is called.
    splitLabel: env.SPLIT_LABEL?.trim() || null,
    // Finished runs are archived in OpenHands (tag archived=true, the other tags stay) this many days after they ended; 0 switches it off.
    archiveAfterDays: archiveDays(env.ARCHIVE_AFTER_DAYS),
    // The ledger sync (src/agent/ledger-sync.ts) asks the forge about the open tickets of the ledger this often; 0 switches it off.
    ledgerSyncHours: wholeOf(env.LEDGER_SYNC_HOURS, 6, 'LEDGER_SYNC_HOURS', 720),
    // The status page and /status.json leave out closed tickets whose last activity is older than this many days (?all=1 shows them).
    statusHideDays: wholeOf(env.STATUS_HIDE_DAYS, 7, 'STATUS_HIDE_DAYS', 3650),
    // The Forgejo login to mention in the comments that hand something to a human (and only there), so that Forgejo mails him when his
    // notification setting is "only on mention". Needs an agent user of its own: Forgejo does not mail the actor of an action.
    humanLogin: parseHumanLogin(env.HUMAN_LOGIN),
    // A comment of HUMAN_LOGIN on an issue whose last run failed (or waits for him) starts that run again; this many times per issue and label.
    commentRestarts: commentRestartsOf(env.COMMENT_RESTARTS),
    // PLAN_ANSWER_RESTARTS: 0 to 20, default 5; a comment of HUMAN_LOGIN answers a planner that finished without sub-issues (0 switches it off).
    planAnswerRestarts: wholeOf(env.PLAN_ANSWER_RESTARTS, 5, 'PLAN_ANSWER_RESTARTS', 20),
    // HUMAN_REVIEW_ROUNDS: a request for changes of HUMAN_LOGIN on an agent pull request starts a round in comment mode too. Off without HUMAN_LOGIN.
    humanReviewRounds: humanReviewRoundsOf(env.HUMAN_REVIEW_ROUNDS) && parseHumanLogin(env.HUMAN_LOGIN) !== null,
    // NUDGE_AT_PERCENT: a worker run that has used this share of its iteration limit without a branch ai/issue-<n> is told to stop exploring and
    // push (once per run). 0 switches it off. NUDGE_MESSAGE replaces the text of that message.
    nudgeAtPercent: nudgePercentOf(env.NUDGE_AT_PERCENT),
    nudgeMessage: nudgeMessageOf(env.NUDGE_MESSAGE),
    // NUDGE_TIMEOUT_SECONDS: a nudge is a message to a running conversation, which answers after the agent's current step: it gets this long.
    nudgeTimeoutMs: nudgeTimeoutOf(env.NUDGE_TIMEOUT_SECONDS),
    // STALL_ALERT_MINUTES (0 = off): work waits on a quota, the disk or a limit and nothing has started for this long, so the human is told once.
    stallAlertMinutes: wholeOf(env.STALL_ALERT_MINUTES, 90, 'STALL_ALERT_MINUTES', 10080),
    // Notifications of ForgeHands' own (SMTP, webhook, digest) and whether the hand-over comments mention HUMAN_LOGIN, see src/notify.
    notify: parseNotify(env),
    // Whose security review comments count (comma separated logins, case-insensitive). Empty: the comment of anybody counts, which is fine for
    // the advisory display but not for two_keys, so two_keys needs it: the second key must be a user the author of the pull request does not control.
    securityReviewers: parseLogins(env.SECURITY_REVIEWERS),
    // Once a day, remind HUMAN_LOGIN of agent pull requests that wait for him (marked blocked, approved on a protected path, untouched):
    // after this many days, then at most once per this many days and REMIND_MAX times per pull request; 0 (default) switches it off.
    // STALE_LABEL is added after the last reminder.
    remindAfterDays: remindDays(env.REMIND_AFTER_DAYS),
    remindMax: positiveInt(env.REMIND_MAX, 3, 'REMIND_MAX', 100),
    staleLabel: env.STALE_LABEL?.trim() || null,
    approvedLabel: env.APPROVED_LABEL || 'ai:approved',
    // TWO_KEYS_HOLD_MINUTES (0 = off, at most a day): a merge that needs both keys waits this long after they agreed, so that the operator can
    // stop it. HOLD_LABEL on the pull request stops it for as long as it is there; taking it off starts a full hold again.
    twoKeysHoldMinutes: wholeOf(env.TWO_KEYS_HOLD_MINUTES, 0, 'TWO_KEYS_HOLD_MINUTES', 1440),
    holdLabel: env.HOLD_LABEL?.trim() || 'ai:hold',
    // TWO_KEYS_DAILY_LIMIT (0 = off, at most 100): merges through two keys per repository in the last 24 hours; the next one is handed to a human.
    twoKeysDailyLimit: wholeOf(env.TWO_KEYS_DAILY_LIMIT, 0, 'TWO_KEYS_DAILY_LIMIT', 100),
    // REVERT_ON_RED (1 by default, 0 = off) and REVERT_WINDOW_MINUTES (default 120): a red default branch within this long after a merge of
    // ForgeHands starts the revert, once, when a route of "on": "main_red" exists; without one the human is told instead.
    revertOnRed: switchDefault(env.REVERT_ON_RED, true, 'REVERT_ON_RED'),
    revertWindowMinutes: positiveInt(env.REVERT_WINDOW_MINUTES, 120, 'REVERT_WINDOW_MINUTES', 10080) as number,
    // The labels that mark an issue to be reviewed and closed when its last dependency closes (route "on": "epic_done"): ai:plan, whose
    // planner run comes first, and ai:close, which has no run of its own and only asks for that closing review.
    // Pull requests of dependency bots (Renovate): Forgejo logins and, optionally, head branch prefixes (comma separated). They get the same
    // review and merge policy as agent pull requests, without a worker. A red commit starts a fix round only with BOT_FIX_ROUNDS (per pull request).
    botAuthors: new Set((env.BOT_AUTHORS || '').split(',').map((value) => value.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)),
    botBranchPrefixes: (env.BOT_BRANCH_PREFIXES || '').split(',').map((value) => value.trim()).filter(Boolean),
    // Only these repositories (comma separated owner/repository, each one of ALLOWED_REPOS) have bot pull requests; empty: all of them. A repository
    // whose bot pull requests the operator merges himself (and wants the forge's own mail for) is left out.
    botRepos: parseBotRepos(env.BOT_REPOS, allowedRepos),
    botFixRounds: env.BOT_FIX_ROUNDS === undefined || env.BOT_FIX_ROUNDS === '' || env.BOT_FIX_ROUNDS === '0' ? 0 : positiveInt(env.BOT_FIX_ROUNDS, 0, 'BOT_FIX_ROUNDS', 100) as number,
    epicLabels: new Set((env.EPIC_LABEL || 'ai:plan,ai:close').split(',').map((value) => value.trim()).filter(Boolean)),
    pollMs: 15000,
    jobsFile: env.JOBS_FILE || dataFile.replace(/[^/\\]*$/, 'jobs.json')
  };
}

// A 0/1 switch that is on unless set to 0; any other value is a mistake worth a clear message.
function reviewSwitch(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error('REVIEW_WITHOUT_CI must be 0 or 1');
}

// FAILURE_ESCALATE: a 0/1 switch that is on unless set to 0; any other value is a mistake worth a clear message.
function failureEscalateOf(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error('FAILURE_ESCALATE must be 0 or 1');
}

// HUMAN_REVIEW_ROUNDS: 1 (default) or 0; any other value is a mistake worth a clear message.
function humanReviewRoundsOf(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error('HUMAN_REVIEW_ROUNDS must be 0 or 1');
}

// NUDGE_AT_PERCENT: an integer from 0 (off) to 95, default 65.
function nudgePercentOf(value: string | undefined): number {
  if (value === undefined || value === '') return 65;
  if (!/^\d{1,2}$/.test(value) || Number(value) > 95) throw new Error('NUDGE_AT_PERCENT must be an integer from 0 (off) to 95');
  return Number(value);
}

// NUDGE_TIMEOUT_SECONDS: an integer from 10 to 600, default 180; returned in milliseconds.
function nudgeTimeoutOf(value: string | undefined): number {
  if (value === undefined || value === '') return 180000;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 10 || Number(value) > 600) throw new Error('NUDGE_TIMEOUT_SECONDS must be an integer from 10 to 600');
  return Number(value) * 1000;
}

// NUDGE_MESSAGE: the text of the nudge (unset or empty: the default text). At most 2000 characters.
function nudgeMessageOf(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.length > 2000) throw new Error('NUDGE_MESSAGE must be at most 2000 characters');
  return text;
}

// COMMENT_RESTARTS: 0 to 100, default 2; 0 switches the comment restarts off.
function commentRestartsOf(value: string | undefined): number {
  if (value === undefined || value === '') return 2;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw new Error('COMMENT_RESTARTS must be an integer between 0 and 100');
  return Number(value);
}

// A 0/1 switch with a default; any other value is a mistake worth a clear message.
function switchDefault(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(name + ' must be 0 or 1');
}

// A 0/1 switch that is off unless set to 1; any other value is a mistake worth a clear message.
function switchOff(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(name + ' must be 0 or 1');
}
