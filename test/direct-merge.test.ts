// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Merging an approved pull request: MERGE_POLICY, MERGE_METHOD, WIP titles, mergeability and protected paths.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { globToRegExp } from '../src/utils/glob.ts';
import { ctx, repo, quiet, env, fakeApi, event, webhook, prPayload, prEvent, withMerge, API, fakeForgejo, goodRoutes, mergerFor, approvedEvent, wipThenClean, issue, pull } from './helpers/direct.ts';

test('globs: * stays in a folder, ** crosses folders, a plain name is exact', () => {
  const m = (glob, path) => globToRegExp(glob).test(path);
  assert.ok(m('compose.yaml', 'compose.yaml'));
  assert.ok(!m('compose.yaml', 'sub/compose.yaml'));
  assert.ok(m('.github/**', '.github/workflows/image.yaml'));
  assert.ok(!m('.github/**', 'x.github/a'));
  assert.ok(m('stacks/*/compose.yaml', 'stacks/app/compose.yaml'));
  assert.ok(!m('stacks/*/compose.yaml', 'stacks/app/sub/compose.yaml'));
  assert.ok(m('**/*.env', 'a/b/c.env'));
  assert.ok(m('**/*.env', 'c.env'));
  assert.ok(m('docs/**/*.secret', 'docs/a/b/x.secret'));
  assert.ok(!m('a.b', 'aXb'));
});

test('MERGE_POLICY and MERGE_METHOD are validated; a repository without an entry has no policy', () => {
  const policy = loadConfig(env(withMerge())).mergePolicy;
  assert.deepEqual([...policy.keys()], ['owner/hello']);
  assert.ok(policy.get('owner/hello').deny[0].test('compose.yaml'));
  assert.equal(loadConfig(env(withMerge({ MERGE_METHOD: 'squash' }))).mergeMethod, 'squash');
  assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: '{' }))), /MERGE_POLICY must be valid JSON/);
  assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: '{"nope":{}}' }))), /not owner\/repository/);
  assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: '{"a/b":{"deny":"x"}}' }))), /list of patterns/);
  assert.throws(() => loadConfig(env(withMerge({ MERGE_METHOD: 'octopus' }))), /MERGE_METHOD/);
  assert.throws(() => loadConfig(env(withMerge({ FORGEJO_URL: '', FORGEJO_TOKEN: '', AGENT_SECRETS: '' }))), /needs FORGEJO_URL and FORGEJO_TOKEN/);
});

test('the approval label on a pull request becomes a merge event, a round label comes first, and it needs the policy', () => {
  const norm = (labels, options = { approved: 'ai:approved', prLabels: ['ai:changes'] }) =>
    normalizeEvent('pull_request', prPayload(labels), new Set([repo]), [], { labelEvents: true, ...options });
  assert.equal(norm(['ai:approved']).type, 'pull_request.approved');
  assert.equal(norm(['ai:approved']).pull_request.number, 34);
  assert.equal(norm(['ai:approved', 'ai:changes']).type, 'pull_request.labeled');
  assert.equal(norm(['ai:approved'], { approved: '', prLabels: ['ai:changes'] }), null);
  const labeled = normalizeEvent('pull_request', { ...prPayload(['ai:approved']), action: 'labeled', label: { name: 'ai:approved' } }, new Set([repo]), [], { approved: 'ai:approved' });
  assert.equal(labeled.type, 'pull_request.approved');
});

test('merge: approved, green, nothing protected -> title cleaned, merged on the checked commit, issue closed', async () => {
  const { merger, forgejo } = await mergerFor(goodRoutes());
  const notes = [];
  merger.note = (...fact) => notes.push(fact);
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.deepEqual(notes, [[repo + '#26', 'merged']]);
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /pulls/34/merge', 'POST /issues/34/comments', 'PATCH /issues/26']);
  const byPath = (method, path) => forgejo.calls.find((call) => call.method === method && call.path === API + path);
  assert.equal(byPath('PATCH', '/pulls/34').body.title, 'Fix it');
  assert.deepEqual(byPath('POST', '/pulls/34/merge').body, { Do: 'merge', head_commit_id: 'cafe0000cafe', delete_branch_after_merge: true });
  assert.deepEqual(byPath('PATCH', '/issues/26').body, { state: 'closed' });
  assert.match(byPath('POST', '/issues/34/comments').body.body, /merged: approved by the reviewer/);
});

test('merge: the method comes from MERGE_METHOD, and a title without WIP is left alone', async () => {
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: true, title: 'Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] } });
  const { merger, forgejo } = await mergerFor(routes, { MERGE_METHOD: 'squash' });
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.ok(!forgejo.wrote().includes('PATCH /pulls/34'));
  assert.equal(forgejo.calls.find((call) => call.path.endsWith('/merge')).body.Do, 'squash');
});

test('merge: a WIP title makes Forgejo report not mergeable; the title is cleaned first and the pull request read again', async () => {
  let cleaned = false;
  const pr = () => ({ state: 'open', merged: false, mergeable: cleaned, title: cleaned ? 'Fix it' : 'WIP: Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] });
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34']: pr, ['PATCH ' + API + '/pulls/34']: () => { cleaned = true; return {}; } });
  const { merger, forgejo } = await mergerFor(routes);
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /pulls/34/merge', 'POST /issues/34/comments', 'PATCH /issues/26']);
});

test('merge: a stale false mergeable after the WIP marker is gone is read again, and a true on the second re-read merges', async () => {
  const { routes, reads } = wipThenClean(3);
  const { merger, forgejo } = await mergerFor(routes);
  const waits = [];
  merger.sleep = async (ms) => { waits.push(ms); };
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.deepEqual(waits, [2000, 2000], 'two waits of two seconds: the read after the title change and the first re-read said false');
  assert.equal(reads(), 3, 'the read after the title change, then two re-reads');
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /pulls/34/merge', 'POST /issues/34/comments', 'PATCH /issues/26']);
});

test('merge: a mergeable false that stays false after four re-reads is a conflict: refused as not_mergeable, one comment', async () => {
  const { routes, reads } = wipThenClean(Infinity);
  const { merger, forgejo } = await mergerFor(routes);
  const waits = [];
  merger.sleep = async (ms) => { waits.push(ms); };
  assert.equal(await merger.handle(approvedEvent()), 'not_mergeable');
  assert.deepEqual(waits, [2000, 2000, 2000, 2000], 'four re-reads, two seconds apart');
  assert.equal(reads(), 5, 'the read after the title change and the four re-reads');
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /issues/34/comments']);
  assert.match(forgejo.calls.find((call) => call.method === 'POST' && call.path.endsWith('/issues/34/comments')).body.body, /does not merge cleanly/);
});

test('merge: a clean title with a false mergeable is not re-read at all (no WIP marker, no wait)', async () => {
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: false, title: 'Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] } });
  const { merger, forgejo } = await mergerFor(routes);
  const waits = [];
  merger.sleep = async (ms) => { waits.push(ms); };
  assert.equal(await merger.handle(approvedEvent()), 'not_mergeable');
  assert.deepEqual(waits, []);
  assert.equal(forgejo.calls.filter((call) => call.method === 'GET' && call.path === API + '/pulls/34').length, 1);
});

test('merge: a real conflict after the title is clean is reported, and a blocked pull request keeps its WIP title', async () => {
  const conflict = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: false, title: 'WIP: Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] } }));
  assert.equal(await conflict.merger.handle(approvedEvent()), 'not_mergeable');
  assert.deepEqual(conflict.forgejo.wrote(), ['PATCH /pulls/34', 'POST /issues/34/comments']);
  // not ready (red status): the marker stays
  const red = await mergerFor(goodRoutes({ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'failure', total_count: 1 } }));
  assert.equal(await red.merger.handle(approvedEvent()), 'ci_not_green');
  assert.ok(!red.forgejo.wrote().includes('PATCH /pulls/34'));
});

test('merge: a repository without any workflow file merges an approved pull request that has no status; one with workflows, or a red status, still refuses', async () => {
  const quiet = goodRoutes({ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'pending', total_count: 0 } });
  const none = await mergerFor(quiet);
  assert.equal(await none.merger.handle(approvedEvent()), 'merged');
  assert.ok(none.forgejo.calls.some((call) => call.path === API + '/contents/.github/workflows' && call.search === '?ref=cafe0000cafe'));
  assert.match(none.forgejo.calls.find((call) => call.method === 'POST' && call.path.endsWith('/issues/34/comments')).body.body, /there is no CI in this repository/);
  // workflows exist but nothing has reported yet: not green
  const waiting = await mergerFor({ ...quiet, ['GET ' + API + '/contents/.forgejo/workflows']: [{ type: 'file', name: 'ci.yaml' }] });
  assert.equal(await waiting.merger.handle(approvedEvent()), 'ci_not_green');
  assert.ok(!waiting.forgejo.wrote().includes('POST /pulls/34/merge'));
  // a red status refuses whatever the tree holds
  const red = await mergerFor(goodRoutes({ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'failure', total_count: 1 } }));
  assert.equal(await red.merger.handle(approvedEvent()), 'ci_not_green');
  // an unreadable folder listing is unknown, so refused; and the switch restores the old rule
  const unknown = await mergerFor({ ...quiet, ['GET ' + API + '/contents/.forgejo/workflows']: { __status: 500 } });
  assert.equal(await unknown.merger.handle(approvedEvent()), 'ci_not_green');
  const off = await mergerFor(quiet, { REVIEW_WITHOUT_CI: '0' });
  assert.equal(await off.merger.handle(approvedEvent()), 'ci_not_green');
  assert.ok(!off.forgejo.calls.some((call) => call.path.includes('/contents/')));
});

test('merge: a protected path hands the pull request to a human with the WIP marker already removed', async () => {
  const { merger, forgejo } = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }] }));
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /issues/34/comments']);
  assert.equal(forgejo.calls.find((call) => call.method === 'PATCH').body.title, 'Fix it');
  assert.match(forgejo.calls.find((call) => call.method === 'POST').body.body, /ready for a human to merge/);
});

test('merge: a protected path stops it with a comment, whichever page of files it is on', async () => {
  const page = (n) => Array.from({ length: 50 }, (_, i) => ({ filename: 'src/f' + n + '-' + i + '.mjs' }));
  const files = (url) => {
    const p = Number(url.searchParams.get('page'));
    if (p === 1 || p === 2) return page(p);
    if (p === 3) return [{ filename: 'ok.txt' }, { filename: 'old.txt', previous_filename: '.github/workflows/image.yaml' }];
    return [];
  };
  const { merger, forgejo } = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34/files']: files }));
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  assert.deepEqual(forgejo.wrote(), ['PATCH /pulls/34', 'POST /issues/34/comments']);
  assert.match(forgejo.calls.find((call) => call.method === 'POST').body.body, /- `\.github\/\*\*` \(\.github\/workflows\/image\.yaml\)/);
});

test('merge: nothing happens without policy, approval, green CI, a clean merge, an open agent branch', async () => {
  const pr = (over) => ({ ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: true, title: 'x', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }], ...over } });
  const cases = [
    [pr({ labels: [] }), 'not_approved', []],
    [pr({ labels: [{ name: 'ai:approved' }, { name: 'ai:blocked' }] }), 'blocked', []],
    [pr({ merged: true }), 'not_open', []],
    [pr({ state: 'closed' }), 'not_open', []],
    [pr({ head: { ref: 'feature/x', sha: 'cafe0000cafe' } }), 'not_an_agent_branch', []],
    [pr({ mergeable: false }), 'not_mergeable', ['POST /issues/34/comments']],
    [{ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'pending', total_count: 1 } }, 'ci_not_green', []],
    // nothing reported yet while the repository has workflows: the CI has not started, so not green
    [{ ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'success', total_count: 0 }, ['GET ' + API + '/contents/.forgejo/workflows']: [{ type: 'file', name: 'ci.yaml' }] }, 'ci_not_green', []]
  ];
  for (const [over, outcome, wrote] of cases) {
    const { merger, forgejo } = await mergerFor(goodRoutes(over));
    assert.equal(await merger.handle(approvedEvent()), outcome);
    assert.deepEqual(forgejo.wrote(), wrote);
  }
  const noPolicy = await mergerFor(goodRoutes());
  noPolicy.config.mergePolicy.clear();
  assert.equal(await noPolicy.merger.handle(approvedEvent()), 'no_merge_policy');
  assert.equal(noPolicy.forgejo.calls.length, 0);
});

test('merge: a Forgejo error is reported as a failed merge, never thrown', async () => {
  const { merger } = await mergerFor(goodRoutes({ ['POST ' + API + '/pulls/34/merge']: undefined }));
  assert.equal(await merger.handle(approvedEvent()), 'merge_failed');
});

test('a round or a review takes back the earlier approval first', async () => {
  const forgejo = fakeForgejo({ ['GET ' + API + '/issues/34/labels']: [{ id: 5, name: 'ai:approved' }, { id: 6, name: 'bug' }], ['DELETE ' + API + '/issues/34/labels/5']: {} });
  const api = fakeApi();
  const config = loadConfig(env(withMerge()));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request), quiet, () => ctx.clock);
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  assert.deepEqual(forgejo.wrote(), ['DELETE /issues/34/labels/5']);
});

test('the webhook merges an approved agent pull request and says so', async () => {
  const forgejo = fakeForgejo(goodRoutes());
  const config = loadConfig(env(withMerge()));
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, forgejo.send, quiet, () => ctx.clock);
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = async (labels, delivery) => {
    const raw = Buffer.from(JSON.stringify(prPayload(labels)));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'pull_request', 'x-forgejo-delivery': delivery,
        'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') },
      body: raw
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.deepEqual(await post(['ai:approved'], 'd-merge-1'), { status: 202, body: { status: 'merged', delivery_id: 'd-merge-1' } });
    assert.ok(forgejo.wrote().includes('POST /pulls/34/merge'));
    forgejo.calls.length = 0;
    // the same label again, with the label seen before: no second merge attempt
    assert.equal((await post(['ai:approved'], 'd-merge-2')).body.status, 'already_approved');
    assert.equal(forgejo.calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
