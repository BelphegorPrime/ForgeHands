import { forgejoCall } from './forgejo.mjs';

// `*` matches within a path segment, `**` across segments, `?` one character; a pattern without wildcards is an exact path.
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

const WIP = /^\s*(?:\[WIP\]|WIP:)\s*/i;
const PAGE = 50;
const MAX_FILES = 1000;

// Merges the pull request of an agent issue once the reviewer approved it, CI is green and it touches no protected path.
// What may merge is the operator's decision (MERGE_POLICY, per repository), never the repository's or the agent's.
export class Merger {
  constructor(config, send = fetch, logger = console) {
    this.config = config;
    this.send = send;
    this.logger = logger;
  }

  call(repository, method, path, body) {
    return forgejoCall(this.config, this.send, repository, method, path, body);
  }

  async changedFiles(repository, number) {
    const names = [];
    for (let page = 1; names.length < MAX_FILES; page++) {
      const files = await this.call(repository, 'GET', '/pulls/' + number + '/files?limit=' + PAGE + '&page=' + page);
      if (!Array.isArray(files) || !files.length) break;
      for (const file of files) names.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if (files.length < PAGE) break;
    }
    return names.filter((name) => typeof name === 'string');
  }

  async remark(repository, number, text) {
    try { await this.call(repository, 'POST', '/issues/' + number + '/comments', { body: 'ForgeHands: ' + text }); }
    catch (error) { this.logger.error('could not comment on #' + number + ':', error.message); }
  }

  // Returns the outcome as a status string; nothing here throws.
  async handle(event) {
    const repository = event.repository.full_name;
    const policy = this.config.mergePolicy.get(repository.toLowerCase());
    if (!policy || !this.config.forgejo) return 'no_merge_policy';
    const number = event.pull_request.number;
    try {
      const pr = await this.call(repository, 'GET', '/pulls/' + number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      if (!/^ai\/issue-\d+$/.test(pr.head?.ref || '')) return 'not_an_agent_branch';
      const sha = pr.head.sha;
      const labels = (pr.labels || []).map((label) => label.name);
      if (!labels.includes(this.config.approvedLabel)) return 'not_approved';
      if (labels.includes(this.config.blockedLabel)) return 'blocked';
      const status = await this.call(repository, 'GET', '/commits/' + encodeURIComponent(sha) + '/status');
      if (status?.state !== 'success' || !(status.total_count > 0)) return 'ci_not_green';
      const protectedFiles = (await this.changedFiles(repository, number))
        .filter((name) => policy.deny.some((pattern) => pattern.test(name)));
      // Forgejo refuses to merge a pull request titled as work in progress (and reports it as not mergeable). Approved and green is
      // the end of the work in progress, for a human as much as for ForgeHands: the marker goes before either merges it. Only after
      // the title is clean does `mergeable` say anything about conflicts, so look at the pull request again.
      let current = pr;
      if (WIP.test(pr.title || '')) {
        await this.call(repository, 'PATCH', '/pulls/' + number, { title: pr.title.replace(WIP, '') });
        current = await this.call(repository, 'GET', '/pulls/' + number);
      }
      if (protectedFiles.length) {
        await this.remark(repository, number, 'approved and green, but not merged automatically: it touches protected paths (' + [...new Set(protectedFiles)].slice(0, 10).join(', ') + '). It is ready for a human to merge.');
        return 'protected_paths';
      }
      if (current?.mergeable === false) {
        await this.remark(repository, number, 'approved and green, but the pull request does not merge cleanly (conflict). A human has to look at it.');
        return 'not_mergeable';
      }
      await this.call(repository, 'POST', '/pulls/' + number + '/merge', {
        Do: this.config.mergeMethod, head_commit_id: sha, delete_branch_after_merge: true
      });
      const issue = Number(/^ai\/issue-(\d+)$/.exec(pr.head.ref)[1]);
      await this.remark(repository, number, 'merged: approved by the reviewer, CI green, no protected path touched.');
      try { await this.call(repository, 'PATCH', '/issues/' + issue, { state: 'closed' }); }
      catch (error) { this.logger.error('could not close issue #' + issue + ':', error.message); }
      return 'merged';
    } catch (error) {
      this.logger.error('auto-merge of ' + repository + '#' + number + ' failed:', error.message);
      return 'merge_failed';
    }
  }

  // A new round or review means the earlier approval no longer covers the branch. Best effort.
  async clearApproval(event) {
    if (!this.config.forgejo) return;
    const repository = event.repository.full_name;
    const number = event.pull_request.number;
    try {
      const labels = await this.call(repository, 'GET', '/issues/' + number + '/labels');
      const approved = (labels || []).find((label) => label.name === this.config.approvedLabel);
      if (approved) await this.call(repository, 'DELETE', '/issues/' + number + '/labels/' + approved.id);
    } catch (error) {
      this.logger.error('could not clear the approval of #' + number + ':', error.message);
    }
  }
}
