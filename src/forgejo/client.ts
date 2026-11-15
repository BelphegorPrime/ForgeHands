import type { Fetch, ForgejoAccess, Json } from '../types.ts';

export interface ForgejoConfig { forgejo: ForgejoAccess | null; timeoutMs: number }

// One call to the Forgejo API of a repository, as the Forgejo user whose token ForgeHands holds.
export async function forgejoCall(config: ForgejoConfig, send: Fetch, repository: string, method: string, path: string, body?: unknown): Promise<Json> {
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
