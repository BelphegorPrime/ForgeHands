import type { ForgeEvent, Json, NormalizedEvent } from '../../types.ts';
import { normalizeEvent, type NormalizeOptions } from '../../webhook/events.ts';

// Gitea's webhooks, as ForgeHands reads them. The headers differ (X-Gitea-Event, X-Gitea-Signature), but the payloads of issues, pull
// requests (label changes arrive as `label_updated` there too, under the headers `issues` and `pull_request`) and pushes are the ones
// Forgejo sends, so those go through the Forgejo normalizer. What Gitea does differently is CI: it has no `action_run_failure` and
// `action_run_success`; it sends `workflow_run` (since Gitea 1.25) when a run changes state, and the outcome is in `conclusion`.
export function normalizeGiteaEvent(event: unknown, payload: Json, allowedRepos: Set<string>, labels: string[], options: NormalizeOptions): NormalizedEvent | null {
  if (event === 'workflow_run') return normalizeWorkflowRun(payload, allowedRepos, options.ci || {});
  // Forgejo's run events are not Gitea's: whatever sends them is not a Gitea.
  if (event === 'action_run_failure' || event === 'action_run_success') return null;
  const normalized = normalizeEvent(event, payload, allowedRepos, labels, options);
  return normalized && { ...normalized, source: 'gitea' };
}

// A finished Gitea Actions run, as the same internal `ci.failure` / `ci.success` event the Forgejo run events become. Gitea's
// `workflow_run` carries only a minimal pull request (number, head branch, head and base sha, no state, title, body or author), so:
//  - the pull request must be an agent branch (ai/issue-<n>); a dependency bot's pull request has no author here, so a CI event of it
//    is not recognized (its label events still are) and the issue title and body stay empty (the prompt sends the agent to read the issue);
//  - whether it is still open is left to the dispatcher, which reads the pull request before it acts on a CI event;
//  - the head repository must be the repository itself: a fork's branch named ai/issue-<n> is somebody else's code.
// `pull_requests` is filled for a run of a pull request event and, on a push, with the open pull requests of that branch, so both count.
function normalizeWorkflowRun(payload: Json, allowedRepos: Set<string>, ci: { failure?: string; success?: string }): ForgeEvent | null {
  const run = payload?.workflow_run;
  if (!run || typeof run !== 'object' || payload.action !== 'completed') return null;
  const outcome = run.conclusion === 'failure' ? 'failure' : run.conclusion === 'success' ? 'success' : null;
  const label = outcome === 'failure' ? ci.failure : outcome === 'success' ? ci.success : undefined;
  // Cancelled and skipped runs are neither a failure nor a success.
  if (!outcome || !label || (run.event !== 'pull_request' && run.event !== 'push')) return null;
  const repository = payload.repository;
  const fullName = repository?.full_name;
  if (typeof fullName !== 'string' || !allowedRepos.has(fullName.toLowerCase())) return null;
  if (typeof run.head_sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(run.head_sha)) return null;
  const pulls: Json[] = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  const pr = pulls.find((entry) => /^ai\/issue-\d+$/.test(String(entry?.head?.ref || ''))
    && Number.isSafeInteger(entry.number) && entry.number > 0
    && (entry.head?.repo?.id === undefined || repository.id === undefined || entry.head.repo.id === repository.id));
  if (!pr) return null;
  const issueNumber = Number(/^ai\/issue-(\d+)$/.exec(pr.head.ref)![1]);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  const html = typeof repository.html_url === 'string' ? repository.html_url.replace(/\/$/, '') + '/pulls/' + pr.number : null;
  return {
    type: 'ci.' + outcome,
    source: 'gitea',
    action: 'action_run_' + outcome,
    label,
    repository: {
      full_name: fullName,
      clone_url: repository.clone_url || null,
      html_url: repository.html_url || null,
      default_branch: repository.default_branch || null
    },
    issue: { number: issueNumber, title: '', body: '', html_url: html, comments: 0, labels: [] },
    pull_request: { number: pr.number, head_ref: pr.head.ref, html_url: html },
    ci: {
      run_id: run.id ?? null,
      // `path` is "<workflow file>@<ref>".
      workflow: String(run.path || payload.workflow?.name || '').split('@')[0],
      commit_sha: run.head_sha,
      status: outcome,
      html_url: run.html_url || null
    },
    sender: { login: run.trigger_actor?.login || payload.sender?.login || null }
  };
}
