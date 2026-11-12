import { URL } from 'node:url';

export function loadConfig(env = process.env) {
  const forgejoSecret = env.FORGEJO_WEBHOOK_SECRET || '';
  const openhandsSecret = env.OPENHANDS_WEBHOOK_SECRET || '';
  const endpoint = env.OPENHANDS_WEBHOOK_URL || '';
  const allowedRepos = new Set((env.ALLOWED_REPOS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));

  if (forgejoSecret.length < 16 || openhandsSecret.length < 16) {
    throw new Error('FORGEJO_WEBHOOK_SECRET and OPENHANDS_WEBHOOK_SECRET must each be at least 16 characters');
  }
  if (allowedRepos.size === 0) {
    throw new Error('ALLOWED_REPOS must contain at least one owner/repository');
  }
  for (const repo of allowedRepos) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
      throw new Error('Invalid ALLOWED_REPOS entry: ' + repo);
    }
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('OPENHANDS_WEBHOOK_URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('OPENHANDS_WEBHOOK_URL requires http(s) and no embedded credentials');
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  return {
    forgejoSecret,
    openhandsSecret,
    endpoint: url.toString(),
    allowedRepos,
    dataFile: env.DATA_FILE || './data/deliveries.json',
    port,
    host: env.HOST || '0.0.0.0',
    timeoutMs: 10000,
    maxBodyBytes: 1024 * 1024
  };
}
