// One call to the Forgejo API of a repository, as the Forgejo user whose token ForgeHands holds.
export async function forgejoCall(config, send, repository, method, path, body) {
  const { url, token } = config.forgejo;
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
