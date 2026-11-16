import { DryLog, isDry, isWrite } from '../dry.ts';
import type { Config, Fetch, ForgejoAccess, Json } from '../types.ts';

export interface ForgejoConfig { forgejo: ForgejoAccess | null; timeoutMs: number; dryRun: Config['dryRun']; dryRunRepos: Config['dryRunRepos'] }

// One call to the Forgejo API of a repository, as the Forgejo user whose token ForgeHands holds. Every Forgejo write of ForgeHands passes
// here, so this is where a dry run (DRY_RUN) stops it: the call is logged and answered with a stand-in, never sent. Reads are real.
export async function forgejoCall(config: ForgejoConfig, send: Fetch, repository: string, method: string, path: string, body?: unknown, dry: DryLog = new DryLog()): Promise<Json> {
  if (isWrite(method) && isDry(config, repository)) {
    dry.record(repository, method, path, body);
    return { id: 0, dry_run: true };
  }
  const { url, token } = config.forgejo as ForgejoAccess;
  const response = await send(url + '/api/v1/repos/' + repository + path, {
    method,
    headers: { authorization: 'token ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(method + ' ' + path + ' -> HTTP ' + response.status);
  return response.json().catch(() => null);
}
