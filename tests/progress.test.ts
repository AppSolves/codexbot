import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { database } from './sqlite.js';
import { snapshot, clean } from './fixtures.js';
import { githubFixture } from './github-fixture.js';
import { Store } from '../src/worker/store.js';
import { updateProgress, progressBody } from '../src/worker/progress.js';
import { dispatchRequest } from '../src/worker/dispatch.js';
import { randomSecret, seal } from '../src/core/crypto.js';

function fixture() {
  const { db, sqlite } = database(), store = new Store(db), f = githubFixture(), request = { ...snapshot(), commits: 2, changedFiles: 1 };
  const ready = () => sqlite.prepare('UPDATE requests SET progress_next_at=0,workflow_checked_at=0 WHERE id=?').run(request.id);
  const update = (github = f.github) => updateProgress(github, store, request, 'codexbot', 42);
  return { ...f, db, sqlite, store, request, ready, update };
}
await test('one App comment follows confirmed queued/running/analyzing/publication states and links its native review', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request); await f.update();
    assert.equal(f.state.comments.length, 1); assert.match(String(f.state.comments[0]!.body), /2 PR commits; 1 changed files.*Stage: queued/s);
    const initialCalls = f.calls.length; await f.update(); assert.equal(f.calls.length, initialCalls); // fifteen-second update bound
    await dispatchRequest(f.github, f.store, f.request, 'codexbot'); f.ready(); await f.update();
    assert.match(String(f.state.comments[0]!.body), /Workflow: in_progress.*actions\/runs\/123/s);
    assert.equal(await f.store.prepare(f.request.id, '123'), true);
    await f.store.stage(f.request.id, '123', 'analyzing'); f.ready(); await f.update();
    assert.match(String(f.state.comments[0]!.body), /Stage: analyzing/);
    await f.store.result(f.request.id, clean(), true, '123');
    const lease = await f.store.claimPublication(f.request.id, '123'); f.ready(); await f.update();
    assert.match(String(f.state.comments[0]!.body), /Stage: publishing/);
    await f.store.published(f.request.id, 99, lease); f.state.runStatus = 'completed'; f.state.runConclusion = 'success'; f.ready(); await f.update();
    assert.match(String(f.state.comments[0]!.body), /Stage: completed.*Workflow: completed \/ success.*pullrequestreview-99/s);
    assert.equal(f.state.comments.length, 1); assert.equal(await f.store.dueProgress(), null);
  } finally { f.sqlite.close(); }
});
await test('published progress still observes the real workflow until completion is confirmed', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request); await dispatchRequest(f.github, f.store, f.request, 'codexbot'); await f.store.prepare(f.request.id, '123');
    await f.store.result(f.request.id, clean(), true, '123'); const lease = await f.store.claimPublication(f.request.id, '123'); await f.store.published(f.request.id, 99, lease);
    await f.update(); f.ready(); assert.equal(await f.store.dueProgress(), f.request.id);
    f.state.runStatus = 'completed'; f.state.runConclusion = 'success'; await f.update(); f.ready();
    assert.equal(await f.store.dueProgress(), null); assert.match(String(f.state.comments[0]!.body), /Workflow: completed \/ success/);
  } finally { f.sqlite.close(); }
});
await test('fallback publication never presents failed analysis as a completed AI review, even for legacy green workflows', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request); await dispatchRequest(f.github, f.store, f.request, 'codexbot'); await f.store.prepare(f.request.id, '123');
    await f.store.result(f.request.id, clean(), false, '123'); await f.store.noteFailure(f.request.id, '123', 'isolated_review_failed', 'analyzing');
    const lease = await f.store.claimPublication(f.request.id, '123'); await f.store.published(f.request.id, 99, lease);
    for (const conclusion of ['failure', 'success']) {
      f.state.runStatus = 'completed'; f.state.runConclusion = conclusion; f.ready();
      // Re-observe both possible historical conclusions without fabricating the actual GitHub status.
      f.sqlite.prepare('UPDATE requests SET workflow_status=NULL').run(); await f.update();
      const body = String(f.state.comments[0]!.body);
      assert.match(body, /Stage: failed/); assert.ok(body.includes(`Workflow: completed / ${conclusion}`));
      assert.match(body, /non-approving fallback report was published; this is not a completed AI review/);
      assert.match(body, /pullrequestreview-99/); assert.ok(!body.includes('isolated_review_failed'));
    }
  } finally { f.sqlite.close(); }
});
await test('terminal progress with an unknown workflow status remains recoverable and observation failures never claim a stale status', async () => {
  const f = fixture();
  const github = new Octokit({ request: { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input).includes('/actions/runs/') ? new Response('{"message":"opaque-secret"}', { status: 503 }) : f.fetcher(input, init)
  }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    await f.store.create(f.request); await dispatchRequest(f.github, f.store, f.request, 'codexbot');
    await f.store.prepare(f.request.id, '123'); await f.update();
    await f.store.failRun(f.request.id, '123', 'missing_environment_credentials', 'environment');
    f.sqlite.prepare('UPDATE requests SET workflow_status=NULL').run();
    for (let attempt = 0; attempt < 5; attempt++) {
      f.ready(); assert.equal(await f.store.dueProgress(), f.request.id); await f.update(github);
      assert.equal((await f.store.get(f.request.id)).row.progress_attempts, attempt + 1);
    }
    const body = String(f.state.comments[0]!.body);
    assert.match(body, /Stage: failed/); assert.match(body, /no current run status is asserted/);
    assert.ok(!body.includes('in_progress')); assert.ok(!body.includes('opaque-secret'));
    assert.equal(f.state.comments.length, 1); f.ready(); assert.equal(await f.store.dueProgress(), null);
  } finally { f.sqlite.close(); }
});
await test('accepted comment POST with lost response reconciles its App-owned marker without another POST', async () => {
  const f = fixture(); let lose = true;
  const github = new Octokit({ request: { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await f.fetcher(input, init);
    if (String(input).endsWith('/issues/4/comments') && init?.method === 'POST' && lose) { lose = false; throw new Error('Lost response with fixture secret'); }
    return response;
  } }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    await f.store.create(f.request); await f.update(github); assert.equal(f.state.comments.length, 1);
    assert.equal((await f.store.get(f.request.id)).row.progress_phase, 'creating');
    f.ready(); await f.update(github); assert.equal((await f.store.get(f.request.id)).row.progress_comment_id, 1000);
    assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).length, 1);
  } finally { f.sqlite.close(); }
});
await test('a crash before POST never guesses that an ambiguous creation is safe to resend', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request);
    const original = f.store.progressCreating.bind(f.store);
    const intercepted = mock.method(f.store, 'progressCreating', async (...args: Parameters<Store['progressCreating']>) => { await original(...args); throw new Error('D1 committed but response lost'); });
    await f.update(); intercepted.mock.restore();
    for (let attempt = 0; attempt < 7; attempt++) { f.ready(); await f.update(); }
    assert.equal(f.state.comments.length, 0); assert.equal((await f.store.get(f.request.id)).row.progress_attempts, 5);
    assert.equal(await f.store.prepare(f.request.id, '123'), true); // progress failure does not consume the review
  } finally { f.sqlite.close(); }
});
await test('unverifiable successful POST responses and HTTP timeouts are reconciled without another creation', async () => {
  for (const status of [201, 408]) {
    const f = fixture(); let first = true;
    const github = new Octokit({ request: { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await f.fetcher(input, init);
      if (String(input).endsWith('/issues/4/comments') && init?.method === 'POST' && first) {
        first = false;
        if (status === 408) return new Response('{}', { status });
        const body = await response.json() as Record<string, unknown>; delete body.performed_via_github_app;
        return Response.json(body, { status });
      }
      return response;
    } }, log: { debug() {}, info() {}, warn() {}, error() {} } });
    try {
      await f.store.create(f.request); await f.update(github);
      assert.equal((await f.store.get(f.request.id)).row.progress_phase, 'creating');
      f.ready(); await f.update(github); assert.equal((await f.store.get(f.request.id)).row.progress_comment_id, 1000);
      assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).length, 1);
    } finally { f.sqlite.close(); }
  }
});
await test('deleted comments stay deleted and foreign App/user/request/PR identities cannot be edited', async () => {
  for (const change of ['deleted','user','app','pr','request','repository']) {
    const f = fixture();
    try {
      await f.store.create(f.request); await f.update();
      if (change === 'deleted') f.state.comments.length = 0;
      if (change === 'user') f.state.comments[0]!.user = { login: 'alice', type: 'User' };
      if (change === 'app') f.state.comments[0]!.performed_via_github_app = { id: 999 };
      if (change === 'pr') f.state.comments[0]!.issue_url = 'https://api.github.com/repos/owner/repo/issues/99';
      if (change === 'request') f.state.comments[0]!.body = '<!-- codexbot-progress:foreign -->';
      await f.store.prepare(f.request.id, '123'); f.ready();
      if (change === 'repository') await updateProgress(f.github, f.store, { ...f.request, repositoryId: 999 }, 'codexbot', 42); else await f.update();
      assert.equal(f.calls.filter(x => x.method === 'PATCH' && x.path.includes('/issues/comments/')).length, 0);
      assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).length, 1);
      if (change === 'deleted') assert.equal((await f.store.get(f.request.id)).row.progress_phase, 'deleted');
    } finally { f.sqlite.close(); }
  }
});
await test('verified completed failed workflows finalize a never-prepared request and never display hidden context or errors', async () => {
  const f = fixture();
  try {
    f.request.command.instructions = 'opaque-secret hidden prompt';
    await f.store.create(f.request); await dispatchRequest(f.github, f.store, f.request, 'codexbot');
    f.state.runStatus = 'completed'; f.state.runConclusion = 'failure'; await f.update();
    const { row } = await f.store.get(f.request.id); assert.equal(row.state, 'failed'); assert.equal(row.run_id, '123');
    assert.equal(row.failure_code, 'workflow_ended_before_publication');
    const body = progressBody(f.request, { ...row, workflow_conclusion: '[secret](https://attacker.invalid)', failure_code: 'opaque-secret' });
    assert.match(body, /Stage: failed.*Workflow: completed/s); assert.ok(!body.includes('opaque-secret')); assert.ok(!body.includes('attacker'));
  } finally { f.sqlite.close(); }
});
await test('expired request cleanup releases its lease immediately and failed pre-publication jobs cannot bypass publisher authorization', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request); await f.store.saveSession(2, 5, await seal({}, randomSecret(), 'fixture'), 1); await f.store.acquire(f.request);
    f.sqlite.prepare('UPDATE requests SET created_at=0').run(); await f.store.cleanup();
    const session = f.sqlite.prepare('SELECT lease_until,lease_request FROM sessions').get()!; assert.equal(session.lease_until, 0); assert.equal(session.lease_request, null);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM requests').get()!.n, 0); // retention cleanup of the fixture epoch
    const fresh = { ...f.request, id: crypto.randomUUID() }; await f.store.create(fresh); await f.store.prepare(fresh.id, '123'); await f.store.result(fresh.id, clean(), true, '123');
    await f.store.failRun(fresh.id, '123', 'workflow_ended_before_publication', 'workflow');
    await assert.rejects(f.store.operatorRetry(fresh.id, 2, 1), /retry_not_allowed/);
    assert.equal((await f.store.get(fresh.id)).row.state, 'failed');
  } finally { f.sqlite.close(); }
});
await test('a lost run-binding race cannot release the admitted runner session or mark it failed', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request); await dispatchRequest(f.github, f.store, f.request, 'codexbot');
    await f.store.saveSession(2, 5, await seal({}, randomSecret(), 'fixture'), 1);
    f.state.runStatus = 'completed'; f.state.runConclusion = 'failure';
    const original = f.store.observeRun.bind(f.store);
    const intercepted = mock.method(f.store, 'observeRun', async (...args: Parameters<Store['observeRun']>) => {
      await f.store.prepare(f.request.id, '456'); await f.store.acquire(f.request); return original(...args);
    });
    await f.update(); intercepted.mock.restore();
    assert.equal((await f.store.get(f.request.id)).row.run_id, '456'); assert.equal((await f.store.get(f.request.id)).row.state, 'running');
    assert.equal(await f.store.failRun(f.request.id, '123', 'missing_environment_credentials', 'environment'), false);
    await assert.rejects(f.store.acquire({ ...f.request, id: crypto.randomUUID() }));
  } finally { f.sqlite.close(); }
});
await test('operator progress retry is tenant-bound, bounded and never resets an ambiguous POST to a new creation', async () => {
  const f = fixture();
  try {
    await f.store.create(f.request);
    f.sqlite.prepare("UPDATE requests SET progress_phase='creating',progress_attempts=5").run();
    await assert.rejects(f.store.operatorRetryProgress(f.request.id, 2, 999));
    await f.store.operatorRetryProgress(f.request.id, 2, 1); await f.update();
    assert.equal(f.state.comments.length, 0); assert.equal((await f.store.get(f.request.id)).row.progress_phase, 'creating');
    f.sqlite.prepare('UPDATE requests SET progress_attempts=5,progress_next_at=0').run();
    await f.store.operatorRetryProgress(f.request.id, 2, 1);
    f.sqlite.prepare('UPDATE requests SET progress_attempts=5').run();
    await assert.rejects(f.store.operatorRetryProgress(f.request.id, 2, 1));
    assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).length, 0);
  } finally { f.sqlite.close(); }
});
