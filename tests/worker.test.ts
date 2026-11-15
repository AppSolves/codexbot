import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportJWK, SignJWT } from 'jose';
import worker from '../src/worker/index.js';
import { database } from './sqlite.js';
import { githubFixture } from './github-fixture.js';
import { clean, RELEASE, WORKFLOW, HEAD, BASE, snapshot } from './fixtures.js';
import { Store } from '../src/worker/store.js';
import { seal, randomSecret } from '../src/core/crypto.js';
import { DEFAULT_BACKEND } from '../src/core/identity.js';
import { record } from '../src/core/errors.js';

const keys = await generateKeyPair('RS256', { extractable: true });
const pem = await exportPKCS8(keys.privateKey), jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' };
async function oidc(environment: string, overrides: Record<string, unknown> = {}, audience = 'https://broker.invalid'): Promise<string> {
  return new SignJWT({ repository: 'owner/repo', repository_id: '2', repository_owner_id: '3', actor: 'alice', actor_id: '5', event_name: 'workflow_dispatch', ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: 'owner/repo/.github/workflows/codexbot.yml@refs/heads/main', workflow_sha: WORKFLOW,
    job_workflow_ref: `operator/codexbot/.github/workflows/review.yml@${RELEASE}`, job_workflow_sha: RELEASE, runner_environment: 'github-hosted', environment, sub: `repo:owner/repo:environment:${environment}`, run_id: '123', run_attempt: '1', jti: crypto.randomUUID(), ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://token.actions.githubusercontent.com').setAudience(audience).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
}
function payload(body = '@codexbot review') {
  return { action: 'created', installation: { id: 1 }, repository: { id: 2, full_name: 'owner/repo' }, sender: { id: 5, login: 'alice', type: 'User' }, comment: { body, created_at: new Date().toISOString(), user: { id: 5 } }, issue: { number: 4, pull_request: {} } };
}
function signed(input: unknown, secret: string, delivery = crypto.randomUUID()): Request {
  const body = JSON.stringify(input);
  return new Request('https://broker.invalid/webhook', { method: 'POST', body, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
}
async function fixture<T>(action: (env: Env, github: ReturnType<typeof githubFixture>) => Promise<T>): Promise<T> {
  const { db, sqlite } = database(), github = githubFixture(); github.config.credentials.mode = 'api-key';
  const env: Env = { MERGE_ACCEPTANCE_REPOSITORY_ID:'',MERGE_ACCEPTANCE_INSTALLATION_ID:'',WEB_ENABLED: 'false', GITHUB_CLIENT_ID: '', OPENAI_WEB_CLIENT_ID: '', OPENAI_WEB_AUTH_METHOD: '', OPENAI_WEB_SCOPES: '', OPENAI_HOSTED_INFERENCE_AUTHORIZED: 'false', DB: db, PUBLIC_URL: 'https://broker.invalid', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'codexbot', GITHUB_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret'.repeat(2), TRUSTED_WORKFLOW: `operator/codexbot/.github/workflows/review.yml@${RELEASE}`, CHATGPT_DEPLOYMENT_AUTHORIZED: 'false', MERGE_DEPLOYMENT_AUTHORIZED: 'false' };
  const replacement: typeof fetch = async (input, init) => String(input).includes('token.actions.githubusercontent.com/.well-known/jwks') ? Response.json({ keys: [jwk] }) : github.fetcher(input, init);
  const intercepted = mock.method(globalThis, 'fetch', replacement);
  try { return await action(env, github); } finally { intercepted.mock.restore(); sqlite.close(); }
}
await test('retained aliases expose only public pages; privileged routes never redirect or accept forwarded host/origin headers', async () => fixture(async (env, f) => {
  env.PUBLIC_URL = DEFAULT_BACKEND;
  const endpoints: [string, string][] = [['/webhook','POST'], ['/v1/workload/check','POST'], ['/v1/capabilities','GET'], ['/v1/setup','POST'],
    ['/v1/session','GET'], ['/v1/session','PUT'], ['/v1/session','DELETE'], ['/v1/operations','GET'],
    ...['prepare','rotate','renew','result','publish','release','failure','stage'].map(operation => [`/v1/requests/${snapshot().id}/${operation}`, 'POST'] as [string, string])];
  for (const [path, method] of endpoints) {
    const response = await worker.fetch(new Request(`https://retired.invalid${path}`, { method, headers: { Origin: DEFAULT_BACKEND, 'X-Forwarded-Host': new URL(DEFAULT_BACKEND).host } }), env);
    assert.equal(response.status, 421); assert.equal(response.headers.get('location'), null);
    assert.deepEqual(await response.json(), { error: 'non_canonical_backend_origin' });
  }
  assert.equal(f.calls.length, 0);
  for (const path of ['/', '/health']) {
    const response = await worker.fetch(new Request(`https://retired.invalid${path}`), env); assert.equal(response.status, 200);
    if (path === '/') {
      const page = await response.text(); assert.ok(page.includes('CLI setup instructions'));
      assert.ok(page.includes(`<link rel="canonical" href="${DEFAULT_BACKEND}/">`)); assert.ok(!page.includes('WORKER_URL'));
    }
  }
  env.PUBLIC_URL = 'https://retired.invalid';
  assert.equal((await worker.fetch(new Request(`${DEFAULT_BACKEND}/health`), env)).status, 200);
  assert.equal((await worker.fetch(new Request(`${DEFAULT_BACKEND}/v1/session`), env)).status, 421);
}));
await test('canonical webhook HMAC and read-only OIDC work only with the exact new audience and Origin', async () => fixture(async (env, f) => {
  env.PUBLIC_URL = DEFAULT_BACKEND; f.state.permission = 'admin'; f.state.runActor = { id: 5, type: 'User', login: 'alice' };
  const check = async (audience: string, origin = DEFAULT_BACKEND) => worker.fetch(new Request(`${DEFAULT_BACKEND}/v1/workload/check`, {
    method: 'POST', headers: { Authorization: `Bearer ${await oidc('codexbot-1-5', {}, audience)}`, Origin: origin }
  }), env);
  assert.equal((await check('https://retired.invalid')).status, 401);
  assert.equal((await check(DEFAULT_BACKEND, 'https://retired.invalid')).status, 403);
  assert.equal((await check(DEFAULT_BACKEND)).status, 200);
  const body = signed(payload(), env.GITHUB_WEBHOOK_SECRET);
  const invalid = await worker.fetch(new Request(`${DEFAULT_BACKEND}/webhook`, { method: 'POST', headers: body.headers, body: '{}' }), env);
  assert.equal(invalid.status, 401);
  const valid = await worker.fetch(new Request(`${DEFAULT_BACKEND}/webhook`, { method: 'POST', headers: body.headers, body: await body.text() }), env);
  assert.equal(valid.status, 202);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM sessions').first<{ n: number }>())!.n, 0);
}));
await test('signed webhook, OIDC preflight, committed result and separate publication work end to end', async () => fixture(async (env, f) => {
  const started = await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env); assert.equal(started.status, 202);
  const dispatch = f.calls.find(x => x.path.endsWith('/dispatches'))!;
  const id = (dispatch.body.inputs as Record<string, string>).request_id;
  const run = (await f.github.rest.actions.getWorkflowRun({ owner: 'owner', repo: 'repo', run_id: 123 })).data;
  assert.equal(Object.hasOwn(run.repository, 'default_branch'), false);
  const post = async (operation: string, stage: string, body: unknown = {}) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(stage)}` }, body: JSON.stringify(body) }), env);
  assert.equal((await post('prepare', 'codexbot-1-6')).status, 403);
  const prepared = await post('prepare', 'codexbot-1-5'); assert.equal(prepared.status, 200);
  const result = await prepared.json() as Record<string, unknown>; assert.equal(result.read_token, 'fixture-installation-token'); assert.equal(result.session, null);
  assert.equal((await post('prepare', 'codexbot-1-5')).status, 200); // One identical retry recovers a lost response.
  assert.equal((await post('prepare', 'codexbot-1-5')).status, 409);
  assert.equal((await post('result', 'codexbot-1-5', { output: clean(), context_complete: true })).status, 200);
  assert.equal((await post('publish', 'codexbot-1-5')).status, 403);
  const published = await post('publish', 'codexbot-publish-1'); assert.equal(published.status, 200); assert.equal((await published.json() as Record<string, unknown>).event, 'APPROVE');
  assert.equal((await post('publish', 'codexbot-publish-1')).status, 200); assert.equal(f.state.reviews.length, 1);
  for (const issued of f.calls.filter(x => x.path.endsWith('/access_tokens'))) assert.deepEqual(issued.body.repository_ids, [2]);
}));
await test('delayed authorization-revocation webhooks do not delete newly authorized browser sessions by actor alone', async () => fixture(async env => {
  await env.DB.prepare('INSERT INTO web_sessions(id_hash,actor_id,payload,expires_at) VALUES(?,?,?,?)').bind('new-authorization',5,'encrypted-fixture',Date.now()+60_000).run();
  const request=signed({action:'revoked',sender:{id:5,type:'User'}},env.GITHUB_WEBHOOK_SECRET); request.headers.set('x-github-event','github_app_authorization');
  assert.equal((await worker.fetch(request,env)).status,200);
  assert.ok(await env.DB.prepare('SELECT 1 FROM web_sessions WHERE id_hash=?').bind('new-authorization').first());
}));
await test('all broker operations reject authoritative default-branch drift and forged run, actor or dispatch identities', async () => {
  const repoPath = '/repos/owner/repo', runPath = `${repoPath}/actions/runs/123`;
  const cases: [string, string, (body: Record<string, unknown>) => void, string][] = [
    ['default branch', repoPath, body => { body.default_branch = 'develop'; }, 'workflow_run_mismatch'],
    ['repository ID', repoPath, body => { body.id = 99; }, 'workflow_run_mismatch'],
    ['repository owner', repoPath, body => { record(body.owner).id = 99; }, 'workflow_run_mismatch'],
    ['run repository ID', runPath, body => { record(body.repository).id = 99; }, 'workflow_run_mismatch'],
    ['run owner', runPath, body => { record(record(body.repository).owner).id = 99; }, 'workflow_run_mismatch'],
    ['event', runPath, body => { body.event = 'push'; }, 'workflow_run_mismatch'],
    ['workflow path', runPath, body => { body.path = '.github/workflows/untrusted.yml'; }, 'workflow_run_mismatch'],
    ['head SHA', runPath, body => { body.head_sha = HEAD; }, 'workflow_run_mismatch'],
    ['run attempt', runPath, body => { body.run_attempt = 2; }, 'workflow_run_mismatch'],
    ['human actor', runPath, body => { body.actor = { type: 'User', login: 'alice' }; }, 'workflow_not_dispatched_by_this_app'],
    ['foreign App actor', runPath, body => { body.actor = { type: 'Bot', login: 'other[bot]' }; }, 'workflow_not_dispatched_by_this_app'],
    ['dispatch request', runPath, body => { body.display_title = String(body.display_title).replace(/^CodexBot \S+ /, 'CodexBot wrong-request '); }, 'workflow_dispatch_attempt_mismatch'],
    ['dispatch attempt', runPath, body => { body.display_title = String(body.display_title).replace(/ \S+$/, ' wrong-attempt'); }, 'workflow_dispatch_attempt_mismatch']
  ];
  for (const [name, path, change, code] of cases) await fixture(async (env, f) => {
    assert.equal((await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
    const id = (f.calls.find(call => call.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id!;
    const fetcher = f.fetcher;
    const intercepted = mock.method(f, 'fetcher', async (...args: Parameters<typeof fetcher>) => {
      const response = await fetcher(...args);
      if (new URL(String(args[0])).pathname !== path) return response;
      const body = record(await response.json()); change(body); return Response.json(body);
    });
    try {
      for (const operation of ['prepare','failure','publish','rotate','renew','result','stage','release']) {
        const environment = operation === 'publish' ? 'codexbot-publish-1' : 'codexbot-1-5';
        const response = await worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/${operation}`, {
          method: 'POST', headers: { Authorization: `Bearer ${await oidc(environment)}` }, body: '{}'
        }), env);
        assert.equal(response.status, 403, `${name}: ${operation}`); assert.deepEqual(await response.json(), { error: code });
      }
      assert.equal((await new Store(env.DB).get(id)).row.state, 'dispatched'); assert.equal(f.state.reviews.length, 0);
    } finally { intercepted.mock.restore(); }
  });
});
await test('minimal run repositories do not relax signed default-branch claims or protected immutable caller checks', async () => fixture(async (env, f) => {
  await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env);
  const id = (f.calls.find(call => call.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id!;
  for (const overrides of [{ ref: 'refs/heads/develop' }, { workflow_ref: 'owner/repo/.github/workflows/codexbot.yml@refs/heads/develop' },
    { workflow_sha: HEAD }, { job_workflow_sha: HEAD }]) {
    const response = await worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/prepare`, {
      method: 'POST', headers: { Authorization: `Bearer ${await oidc('codexbot-1-5', overrides)}` }, body: '{}'
    }), env);
    assert.equal(response.status, 403);
  }
  for (const change of [{ protected: false }, { commit: { sha: HEAD } }]) {
    const fetcher = f.fetcher;
    const intercepted = mock.method(f, 'fetcher', async (...args: Parameters<typeof fetcher>) => {
      const response = await fetcher(...args);
      return new URL(String(args[0])).pathname === '/repos/owner/repo/branches/main' ? Response.json({ ...record(await response.json()), ...change }) : response;
    });
    try {
      const response = await worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/prepare`, {
        method: 'POST', headers: { Authorization: `Bearer ${await oidc('codexbot-1-5')}` }, body: '{}'
      }), env);
      assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'trusted_default_branch_changed_or_unprotected' });
    } finally { intercepted.mock.restore(); }
  }
  assert.equal((await new Store(env.DB).get(id)).row.state, 'dispatched');
}));
await test('manual administrator OIDC diagnostic is read-only and never authorizes the privileged review broker', async () => fixture(async (env, f) => {
  f.state.permission = 'admin'; f.state.runActor = { id: 5, type: 'User', login: 'alice' };
  const check = async (overrides: Record<string, unknown> = {}) => worker.fetch(new Request('https://broker.invalid/v1/workload/check', { method: 'POST', headers: { Authorization: `Bearer ${await oidc('codexbot-1-5', overrides)}` } }), env);
  const response = await check(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'verified', scope: 'diagnostic_only' });
  for (const call of f.calls.filter(x => x.path.endsWith('/access_tokens'))) assert.deepEqual(call.body.permissions, { contents: 'read', pull_requests: 'read', actions: 'read' });
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM requests').first<{ n: number }>())!.n, 0);
  assert.equal((await check({ job_workflow_sha: HEAD })).status, 403);
  assert.equal((await check({ actor_id: '6' })).status, 403);
  f.state.permission = 'write'; assert.equal((await check()).status, 403); f.state.permission = 'admin';
  await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env);
  const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id;
  const admitted = await worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/prepare`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc('codexbot-1-5')}` }, body: '{}' }), env);
  assert.equal(admitted.status, 403); assert.equal((await admitted.json() as Record<string, unknown>).error, 'workflow_not_dispatched_by_this_app');
}));
await test('verified runner failure finalizes an unprepared request; foreign Environment or arbitrary failure text is denied', async () => fixture(async (env, f) => {
  await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env);
  const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id!;
  const post = async (environment: string, body: unknown) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/failure`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(environment)}` }, body: JSON.stringify(body) }), env);
  assert.equal((await post('codexbot-1-6', { stage: 'environment', code: 'missing_environment_credentials' })).status, 403);
  assert.equal((await post('codexbot-1-5', { stage: 'environment', code: 'opaque-sensitive-provider-error' })).status, 400);
  assert.equal((await post('codexbot-1-5', { stage: 'environment', code: 'missing_environment_credentials' })).status, 200);
  const { row } = await new Store(env.DB).get(id); assert.equal(row.state, 'failed'); assert.equal(row.failure_code, 'missing_environment_credentials'); assert.equal(row.run_id, '123');
  assert.equal(f.state.reviews.length, 0);
}));
await test('analysis progress is stage/run bound and failed review jobs can only publish a non-approving report', async () => fixture(async (env, f) => {
  await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env);
  const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id!;
  const post = async (operation: string, stage: string, body: unknown = {}) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(stage)}` }, body: JSON.stringify(body) }), env);
  assert.equal((await post('stage', 'codexbot-1-5', { stage: 'analyzing' })).status, 409);
  assert.equal((await post('prepare', 'codexbot-1-5')).status, 200);
  assert.equal((await post('stage', 'codexbot-1-5', { stage: 'completed' })).status, 400);
  assert.equal((await post('stage', 'codexbot-1-5', { stage: 'analyzing' })).status, 200);
  assert.equal((await post('result', 'codexbot-1-5', { output: clean(), context_complete: true, failure: { stage: 'analyzing', code: 'isolated_review_failed' } })).status, 400);
  assert.equal((await new Store(env.DB).get(id)).row.result, null);
  assert.equal((await post('result', 'codexbot-1-5', { output: clean(), context_complete: true })).status, 200);
  const response = await post('publish', 'codexbot-publish-1', { review_job_failed: true }); assert.equal(response.status, 200);
  assert.equal((await response.json() as Record<string, unknown>).event, 'COMMENT');
  assert.equal((await new Store(env.DB).get(id)).row.context_complete, 0);
}));
await test('model override survives authorized dispatch and incomplete analysis publishes COMMENT while genuine clean analysis can approve', async () => {
  for (const incomplete of [false, true]) await fixture(async (env, f) => {
    const accepted = await worker.fetch(signed(payload('@codexbot review --model codex-fixture --effort high'), env.GITHUB_WEBHOOK_SECRET), env);
    assert.equal(accepted.status, 202);
    const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id!;
    assert.equal((await new Store(env.DB).get(id)).snapshot.command.model, 'codex-fixture');
    const post = async (operation: string, stage: string, body: unknown = {}) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(stage)}` }, body: JSON.stringify(body) }), env);
    assert.equal((await post('prepare', 'codexbot-1-5')).status, 200);
    const output = incomplete ? { ...clean(), complete: false, result: 'inconclusive' } : clean();
    assert.equal((await post('result', 'codexbot-1-5', { output, context_complete: !incomplete, ...(incomplete ? { failure: { stage: 'result', code: 'review_incomplete' } } : {}) })).status, 200);
    const result = await post('publish', 'codexbot-publish-1', { review_job_failed: incomplete }); assert.equal(result.status, 200);
    assert.equal((await result.json() as { event: string }).event, incomplete ? 'COMMENT' : 'APPROVE');
    assert.ok(!f.calls.some(call => String(call.body.query).includes('mergePullRequest')));
  });
});
await test('invalid signature, replay, spoofed user, forged installation and unauthorized merge cannot dispatch', async () => fixture(async (env, f) => {
  assert.equal((await worker.fetch(signed(payload(), 'wrong-secret'), env)).status, 401);
  const valid = payload(); assert.equal((await worker.fetch(signed(valid, env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  assert.equal((await worker.fetch(signed(valid, env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  const spoofed = payload(); spoofed.comment.user.id = 6; assert.equal((await worker.fetch(signed(spoofed, env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  const forged = payload(); forged.installation.id = 99; assert.equal((await worker.fetch(signed(forged, env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  assert.equal((await worker.fetch(signed(payload('@codexbot review --merge'), env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  assert.equal((await env.DB.prepare("SELECT phase FROM review_rejections WHERE outcome='merge_not_authorized'").first<{phase:string}>())!.phase,'done');
  assert.ok(String(f.state.comments.at(-1)!.body).includes('not permitted'));
  f.config.authorization.whitelist = ''; assert.equal((await worker.fetch(signed(payload('@codexbot review --effort low'), env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 1);
}));
await test('configured handle works at webhook boundary and hosted ChatGPT cannot bypass deployment gate', async () => fixture(async (env, f) => {
  f.config.bot.trigger = '@CodexBotReviewTest';
  assert.equal((await worker.fetch(signed(payload('@codexbot review'), env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 0);
  assert.equal((await worker.fetch(signed(payload('@CODEXBOTREVIEWTEST review --effort high'), env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  f.config.credentials.mode = 'chatgpt';
  assert.equal((await worker.fetch(signed(payload('@CodexBotReviewTest review'), env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  assert.equal((await env.DB.prepare("SELECT phase FROM review_rejections WHERE outcome='chatgpt_deployment_not_authorized'").first<{phase:string}>())!.phase,'done');
  assert.equal(f.calls.filter(x=>x.path.endsWith('/dispatches')).length,1);
}));
await test('ChatGPT handoff is encrypted, lease-protected and disconnected sessions cannot publish', async () => fixture(async (env, f) => {
  env.CHATGPT_DEPLOYMENT_AUTHORIZED = 'true'; f.config.credentials.mode = 'chatgpt';
  const store = new Store(env.DB), envelope = await seal({ access_token: 'fixture-sensitive-access' }, randomSecret(), 'fixture-binding');
  await store.saveSession(2, 5, envelope, 1);
  assert.equal((await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id;
  const post = async (operation: string, stage: string, body: unknown = {}) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(stage)}` }, body: JSON.stringify(body) }), env);
  const prepared = await post('prepare', 'codexbot-1-5'); assert.equal(prepared.status, 200); const text = await prepared.text();
  assert.ok(!text.includes('fixture-sensitive-access')); assert.ok(text.includes('ciphertext'));
  assert.equal((await post('rotate', 'codexbot-1-5', { version: 1, envelope })).status, 200);
  await assert.rejects(store.saveSession(2, 5, envelope, 1));
  assert.equal((await post('result', 'codexbot-1-5', { output: clean(), context_complete: true })).status, 200);
  assert.equal((await post('release', 'codexbot-1-5')).status, 200);
  await store.deleteSession(2, 5, 1);
  assert.equal((await post('publish', 'codexbot-publish-1')).status, 403);
  assert.equal(f.state.reviews.length, 0);
}));
await test('automatic review uses live human identity and rejects replayed or stale-head events', async () => fixture(async (env, f) => {
  f.config.review.auto_review = true;
  const automatic = { action: 'synchronize', installation: { id: 1 }, repository: { id: 2, full_name: 'owner/repo' }, sender: { id: 5, login: 'alice', type: 'User' }, number: 4, pull_request: { updated_at: new Date().toISOString(), head: { sha: HEAD } } };
  const send = (value: unknown) => { const request = signed(value, env.GITHUB_WEBHOOK_SECRET); request.headers.set('x-github-event', 'pull_request'); return worker.fetch(request, env); };
  assert.equal((await send(automatic)).status, 202);
  assert.equal((await send({ ...automatic, pull_request: { ...automatic.pull_request, updated_at: '2000-01-01T00:00:00Z' } })).status, 403);
  assert.equal((await send({ ...automatic, pull_request: { ...automatic.pull_request, head: { sha: BASE } } })).status, 409);
  assert.equal((await send({ ...automatic, sender: { ...automatic.sender, type: 'Bot' } })).status, 403);
}));


await test('webhook outbox recovers an accepted dispatch response loss through scheduled reconciliation', async () => fixture(async (env, f) => {
  const fetcher = f.fetcher; let fail = true;
  const intercepted = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetcher(input, init);
    if (String(input).endsWith('/dispatches') && fail) { fail = false; throw new Error('Lost dispatch response'); }
    return response;
  });
  try {
    assert.equal((await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env)).status, 500);
    await env.DB.prepare('UPDATE deliveries SET next_attempt=0').run();
    await worker.scheduled({} as ScheduledController, env);
    const rows = await env.DB.prepare('SELECT phase FROM deliveries').all<{ phase: string }>(); assert.equal(rows.results[0]!.phase, 'done');
    assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 1);
    const request = await env.DB.prepare('SELECT state FROM requests').first<{ state: string }>(); assert.equal(request!.state, 'dispatched');
  } finally { intercepted.mock.restore(); }
}));
await test('cross-origin provisioning and recovery are rejected before external writes', async () => fixture(async (env, f) => {
  for (const path of ['/v1/setup', '/v1/session?repository=owner%2Frepo', '/v1/operations?repository=owner%2Frepo']) {
    const response = await worker.fetch(new Request(`https://broker.invalid${path}`, { method: 'POST', headers: { Origin: 'https://attacker.invalid', Authorization: 'Bearer fixture' }, body: '{}' }), env);
    assert.equal(response.status, 403);
  }
  assert.equal(f.calls.length, 0);
}));
await test('durable receipt stores only required command fields, not large issue bodies or unrelated secrets', async () => fixture(async (env) => {
  const input = { ...payload(), issue: { ...payload().issue, body: 'private-issue-body'.repeat(20_000) }, unrelated: { token: 'fixture-unrelated-sensitive' } };
  const original = env.DB.prepare.bind(env.DB); let persisted = '';
  const intercepted = mock.method(env.DB, 'prepare', (sql: string) => {
    const statement = original(sql);
    if (!sql.startsWith('INSERT OR IGNORE INTO deliveries')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: Parameters<typeof statement.bind>) => { persisted = String(values[4]); return bind(...values); };
    return statement;
  });
  try { assert.equal((await worker.fetch(signed(input, env.GITHUB_WEBHOOK_SECRET), env)).status, 202); }
  finally { intercepted.mock.restore(); }
  assert.ok(persisted.includes('@codexbot review')); assert.equal(persisted.includes('private-issue-body'), false); assert.equal(persisted.includes('fixture-unrelated-sensitive'), false);
}));

await test('repository-admin cancellation removes only the matching App pending review and leaves submitted reviews intact', async () => fixture(async (env, f) => {
  const { snapshot } = await import('./fixtures.js'), { publish } = await import('../src/worker/publish.js');
  const request = snapshot(), store = new Store(env.DB); await store.create(request);
  await store.transition(request.id, 'created', 'reviewed');
  const submit = mock.method(f.github.rest.pulls, 'submitReview', async () => { throw new Error('Before submission'); });
  await assert.rejects(publish(f.github, request, clean(), true, 'codexbot')); submit.mock.restore();
  assert.equal(f.state.reviews[0]!.state, 'PENDING');
  f.state.reviews.push({ id: 400, state: 'APPROVED', commit_id: HEAD, body: '<!-- codexbot:unrelated -->', user: { type: 'Bot', login: 'codexbot[bot]' } });
  const result = await worker.fetch(new Request('https://broker.invalid/v1/operations?repository=owner%2Frepo', { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: JSON.stringify({ id: request.id, action: 'cancel' }) }), env);
  assert.equal(result.status, 200); assert.equal(f.state.reviews.length, 1); assert.equal(f.state.reviews[0]!.id, 400);
  assert.equal((await store.get(request.id)).row.state, 'failed');
}));


await test('revoked ChatGPT hosting authorization denies an already-dispatched preflight and legacy Environment identities', async () => fixture(async (env, f) => {
  env.CHATGPT_DEPLOYMENT_AUTHORIZED = 'true'; f.config.credentials.mode = 'chatgpt';
  await new Store(env.DB).saveSession(2, 5, await seal({ access_token: 'fixture-only' }, randomSecret(), 'fixture'), 1);
  assert.equal((await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  const id = (f.calls.find(x => x.path.endsWith('/dispatches'))!.body.inputs as Record<string, string>).request_id;
  env.CHATGPT_DEPLOYMENT_AUTHORIZED = 'false';
  const post = async (environment: string) => worker.fetch(new Request(`https://broker.invalid/v1/requests/${id}/prepare`, { method: 'POST', headers: { Authorization: `Bearer ${await oidc(environment)}` } }), env);
  assert.equal((await post('codexbot-5')).status, 403);
  const denied = await post('codexbot-1-5'); assert.equal(denied.status, 403); assert.equal((await denied.json() as { error: string }).error, 'chatgpt_deployment_authorization_revoked');
  assert.equal((await new Store(env.DB).get(id!)).row.state, 'dispatched');
}));

await test('exhausted reruns produce one terminal explanation and no workflow under redelivery and simultaneous processing', async () => fixture(async (env,f) => {
  const store=new Store(env.DB); f.config.quotas.cooldown_seconds=0;
  for(let n=0;n<2;n++) {
    const request={...snapshot(),id:crypto.randomUUID(),config:f.config,command:{...snapshot().command,rerun:true}};
    await store.create(request);await store.transition(request.id,'created','failed');
  }
  const input={...payload('@codexbot review --effort high --rerun'),comment:{...payload().comment,id:777,body:'@codexbot review --effort high --rerun'}};
  const delivery=crypto.randomUUID();
  const responses=await Promise.all([worker.fetch(signed(input,env.GITHUB_WEBHOOK_SECRET,delivery),env),worker.fetch(signed(input,env.GITHUB_WEBHOOK_SECRET,delivery),env)]);
  assert.ok(responses.every(response=>response.status===200));
  assert.equal((await worker.fetch(signed(input,env.GITHUB_WEBHOOK_SECRET),env)).status,200);
  assert.equal(f.calls.filter(x=>x.path.endsWith('/dispatches')).length,0);
  assert.equal(f.state.comments.length,1);
  assert.match(String(f.state.comments[0]!.body),/rerun allowance.*2 requests.*rolling 24-hour.*UTC.*No AI inference/s);
  const row=await env.DB.prepare('SELECT outcome,phase,comment_id FROM review_rejections').first<{outcome:string;phase:string;comment_id:number}>();
  assert.equal(row!.outcome,'rerun_limit_exceeded');assert.equal(row!.phase,'done');assert.equal(row!.comment_id,1000);
  const {results}=await env.DB.prepare('SELECT phase FROM deliveries').all<{phase:string}>();assert.ok(results.every(row=>row.phase==='done'));
}));
await test('fresh invalid commands get fixed feedback; unauthorized, other-bot, quoted and expired comments disclose nothing',async()=>fixture(async(env,f)=>{
  for(const body of ['discussion','@otherbot review --bad','> @codexbot review','```\n@codexbot review --bad\n```','    @codexbot review --bad']) {
    assert.equal((await worker.fetch(signed(payload(body),env.GITHUB_WEBHOOK_SECRET),env)).status,200);
  }
  const old=payload('@codexbot review --bad');old.comment.created_at=new Date(Date.now()-700_000).toISOString();
  assert.equal((await worker.fetch(signed(old,env.GITHUB_WEBHOOK_SECRET),env)).status,403);
  f.config.authorization.whitelist='';assert.equal((await worker.fetch(signed(payload('@codexbot review --bad'),env.GITHUB_WEBHOOK_SECRET),env)).status,403);
  assert.equal(f.state.comments.length,0);
  f.config.authorization.whitelist='alice';
  assert.equal((await worker.fetch(signed(payload('@codexbot review --bad sensitive-fixture'),env.GITHUB_WEBHOOK_SECRET),env)).status,200);
  assert.equal(f.state.comments.length,1);assert.ok(!String(f.state.comments[0]!.body).includes('sensitive-fixture'));assert.equal(f.state.reviews.length,0);
}));

await test('policy-based merge intent is admitted only for independently merge-authorized reviewers without changing the original flag',async()=>{
  for(const allowed of [true,false])await fixture(async(env,f)=>{
    Object.assign(f.config.merge,{enabled:true,auto_merge_on_approval:true,minimum_human_approvals:0});f.config.merge.authorization.whitelist=allowed?'alice':'bob';
    assert.equal((await worker.fetch(signed(payload(),env.GITHUB_WEBHOOK_SECRET),env)).status,202);
    const row=await env.DB.prepare('SELECT snapshot FROM requests').first<{snapshot:string}>();const request=JSON.parse(row!.snapshot);
    assert.equal(request.command.merge,false);assert.equal(request.mergeIntent,allowed?'automatic':undefined);
  });
});
await test('automatic reviews on PR events bind credentials and optional merge intent to the authorized event actor',async()=>fixture(async(env,f)=>{
  f.config.review.auto_review=true;f.config.authorization.whitelist='bob';Object.assign(f.config.merge,{enabled:true,auto_merge_on_approval:true});f.config.merge.authorization.whitelist='bob';f.config.quotas.cooldown_seconds=0;
  for(const [index,action] of ['opened','synchronize','ready_for_review'].entries()){
    f.state.head=String(index+1).repeat(40);
    const input={action,installation:{id:1},repository:{id:2,full_name:'owner/repo'},sender:{id:6,login:'bob',type:'User'},number:4,pull_request:{updated_at:new Date().toISOString(),head:{sha:f.state.head}}};
    const body=JSON.stringify(input);const response=await worker.fetch(new Request('https://broker.invalid/webhook',{method:'POST',body,headers:{'x-github-event':'pull_request','x-github-delivery':crypto.randomUUID(),'x-hub-signature-256':`sha256=${createHmac('sha256',env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`}}),env);
    assert.equal(response.status,202);const dispatch=f.calls.filter(call=>call.path.endsWith('/dispatches')).at(-1)!;assert.equal((dispatch.body.inputs as Record<string,string>).credential_owner,'6');
    const row=await env.DB.prepare("SELECT id,snapshot FROM requests WHERE actor_id=6 AND state='dispatched'").first<{id:string;snapshot:string}>();assert.ok(row);assert.equal(JSON.parse(row.snapshot).mergeIntent,'automatic');
    // Synthetic test completion permits the next distinct PR event; no provider is invoked.
    await env.DB.prepare("UPDATE requests SET state='failed' WHERE id=?").bind(row.id).run();
    assert.equal(await new Store(env.DB).session(2,6,1),null);await assert.rejects(new Store(env.DB).acquire(JSON.parse(row.snapshot)),/session_missing_or_in_use/);
  }
  assert.equal(f.calls.filter(call=>call.path.endsWith('/dispatches')).length,3);
}));

await test('unconnected authorized contributor uses only an explicitly consenting assigned administrator for PR events, never manual commands',async()=>fixture(async(env,f)=>{
  env.CHATGPT_DEPLOYMENT_AUTHORIZED='true';f.config.credentials={mode:'chatgpt',automatic_reviewer:'alice'};f.config.authorization.whitelist='*';f.config.review.auto_review=true;
  f.state.permissionsByLogin={alice:'admin',bob:'read'};
  const store=new Store(env.DB);await store.saveSession(2,5,await seal({},randomSecret(),'synthetic-owner'),1);
  const event={action:'opened',installation:{id:1},repository:{id:2,full_name:'owner/repo'},sender:{id:6,login:'bob',type:'User'},number:4,pull_request:{updated_at:new Date().toISOString(),head:{sha:HEAD}}};
  const send=async(action:string)=>{const body=JSON.stringify({...event,action});return worker.fetch(new Request('https://broker.invalid/webhook',{method:'POST',body,headers:{'x-github-event':'pull_request','x-github-delivery':crypto.randomUUID(),'x-hub-signature-256':`sha256=${createHmac('sha256',env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`}}),env);};
  assert.equal((await send('opened')).status,200);assert.equal(f.calls.filter(call=>call.path.endsWith('/dispatches')).length,0,'Configuration alone cannot borrow credentials');
  const consent=async(body:unknown)=>worker.fetch(new Request('https://broker.invalid/v1/session?repository=owner%2Frepo',{method:'POST',headers:{Authorization:'Bearer fixture-user-token'},body:JSON.stringify(body)}),env);
  assert.equal((await consent({enabled:true,mode:'chatgpt',actor_id:6})).status,400);
  assert.equal((await consent({enabled:true,mode:'chatgpt'})).status,200);assert.equal((await store.automaticGrant(2,1))!.actor_id,5);
  assert.equal((await send('reopened')).status,202);
  const row=await env.DB.prepare('SELECT snapshot FROM requests').first<{snapshot:string}>();const request=JSON.parse(row!.snapshot);
  assert.equal(request.actorId,5);assert.equal(request.actor,'alice');assert.deepEqual(request.triggerActor,{login:'bob',id:6});assert.equal(await store.session(2,6,1),null);
  assert.equal((f.calls.find(call=>call.path.endsWith('/dispatches'))!.body.inputs as Record<string,string>).credential_owner,'5');
  await store.acquire(request);await store.release(request);
  assert.equal((await consent({enabled:false})).status,200);await assert.rejects(store.acquire(request),/automatic_review_authorization_revoked/);
  assert.equal((await worker.fetch(new Request(`https://broker.invalid/v1/requests/${request.id}/publish`,{method:'POST',headers:{Authorization:`Bearer ${await oidc('codexbot-publish-1')}`},body:'{}'}),env)).status,403);
  await store.transition(request.id,'dispatched','failed');
  const manual={...payload(),sender:{id:6,login:'bob',type:'User'},comment:{...payload().comment,user:{id:6}}};
  assert.equal((await worker.fetch(signed(manual,env.GITHUB_WEBHOOK_SECRET),env)).status,202);
  const own=await env.DB.prepare('SELECT snapshot FROM requests WHERE actor_id=6').first<{snapshot:string}>();assert.ok(own);assert.equal(JSON.parse(own.snapshot).triggerActor,undefined);assert.equal(await store.session(2,6,1),null);
}));

await test('unconnected automation contributor requires explicit owner assignment and cannot use it for manual commands', async () => fixture(async (env,f) => {
  f.config.credentials={mode:'api-key',automatic_reviewer:'alice'};f.config.authorization.whitelist='*';f.config.review.auto_review=true;f.state.permissionsByLogin={alice:'admin','github-actions[bot]':'read'};
  const store=new Store(env.DB);
  const event={action:'opened',installation:{id:1},repository:{id:2,full_name:'owner/repo'},sender:{id:41898282,login:'github-actions[bot]',type:'Bot'},number:4,pull_request:{updated_at:new Date().toISOString(),head:{sha:HEAD}}};
  const send=async()=>{const request=signed(event,env.GITHUB_WEBHOOK_SECRET);request.headers.set('x-github-event','pull_request');return worker.fetch(request,env);};
  assert.equal((await send()).status,200);assert.equal(f.calls.filter(call=>call.path.endsWith('/dispatches')).length,0);
  await store.automaticConsent(2,1,5,'alice','api-key');event.action='reopened';
  assert.equal((await send()).status,202);
  const row=await env.DB.prepare('SELECT snapshot FROM requests').first<{snapshot:string}>();const request=JSON.parse(row!.snapshot);
  assert.equal(request.actorId,5);assert.deepEqual(request.triggerActor,{login:'github-actions[bot]',id:41898282,type:'Bot'});
  const manual={...payload(),sender:event.sender,comment:{...payload().comment,user:{id:41898282}}};
  assert.equal((await worker.fetch(signed(manual,env.GITHUB_WEBHOOK_SECRET),env)).status,403);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/dispatches')).length,1);
}));
