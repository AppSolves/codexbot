import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportJWK, SignJWT } from 'jose';
import worker from '../src/worker/index.js';
import { database } from './sqlite.js';
import { githubFixture } from './github-fixture.js';
import { clean, RELEASE, WORKFLOW, HEAD, BASE } from './fixtures.js';
import { Store } from '../src/worker/store.js';
import { seal, randomSecret } from '../src/core/crypto.js';

const keys = await generateKeyPair('RS256', { extractable: true });
const pem = await exportPKCS8(keys.privateKey), jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' };
async function oidc(environment: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ repository: 'owner/repo', repository_id: '2', repository_owner_id: '3', event_name: 'workflow_dispatch', ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: 'owner/repo/.github/workflows/codexbot.yml@refs/heads/main', workflow_sha: WORKFLOW,
    job_workflow_ref: `operator/codexbot/.github/workflows/review.yml@${RELEASE}`, job_workflow_sha: RELEASE, runner_environment: 'github-hosted', environment, sub: `repo:owner/repo:environment:${environment}`, run_id: '123', run_attempt: '1', jti: crypto.randomUUID(), ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://token.actions.githubusercontent.com').setAudience('https://broker.invalid').setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
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
  const env: Env = { DB: db, PUBLIC_URL: 'https://broker.invalid', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'codexbot', GITHUB_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret'.repeat(2), TRUSTED_WORKFLOW: `operator/codexbot/.github/workflows/review.yml@${RELEASE}`, CHATGPT_DEPLOYMENT_AUTHORIZED: 'false', MERGE_DEPLOYMENT_AUTHORIZED: 'false' };
  const replacement: typeof fetch = async (input, init) => String(input).includes('token.actions.githubusercontent.com/.well-known/jwks') ? Response.json({ keys: [jwk] }) : github.fetcher(input, init);
  const intercepted = mock.method(globalThis, 'fetch', replacement);
  try { return await action(env, github); } finally { intercepted.mock.restore(); sqlite.close(); }
}
await test('signed webhook, OIDC preflight, committed result and separate publication work end to end', async () => fixture(async (env, f) => {
  const started = await worker.fetch(signed(payload(), env.GITHUB_WEBHOOK_SECRET), env); assert.equal(started.status, 202);
  const dispatch = f.calls.find(x => x.path.endsWith('/dispatches'))!;
  const id = (dispatch.body.inputs as Record<string, string>).request_id;
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
await test('invalid signature, replay, spoofed user, forged installation and unauthorized merge cannot dispatch', async () => fixture(async (env, f) => {
  assert.equal((await worker.fetch(signed(payload(), 'wrong-secret'), env)).status, 401);
  const valid = payload(); assert.equal((await worker.fetch(signed(valid, env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  assert.equal((await worker.fetch(signed(valid, env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  const spoofed = payload(); spoofed.comment.user.id = 6; assert.equal((await worker.fetch(signed(spoofed, env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  const forged = payload(); forged.installation.id = 99; assert.equal((await worker.fetch(signed(forged, env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  assert.equal((await worker.fetch(signed(payload('@codexbot review --merge'), env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  f.config.authorization.whitelist = ''; assert.equal((await worker.fetch(signed(payload('@codexbot review --effort low'), env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
  assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 1);
}));
await test('configured handle works at webhook boundary and hosted ChatGPT cannot bypass deployment gate', async () => fixture(async (env, f) => {
  f.config.bot.trigger = '@CodexBotReviewTest';
  assert.equal((await worker.fetch(signed(payload('@codexbot review'), env.GITHUB_WEBHOOK_SECRET), env)).status, 200);
  assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 0);
  assert.equal((await worker.fetch(signed(payload('@CODEXBOTREVIEWTEST review --effort high'), env.GITHUB_WEBHOOK_SECRET), env)).status, 202);
  f.config.credentials.mode = 'chatgpt';
  assert.equal((await worker.fetch(signed(payload('@CodexBotReviewTest review'), env.GITHUB_WEBHOOK_SECRET), env)).status, 403);
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
  await assert.rejects(store.saveSession(2, 5, envelope, 1));
  assert.equal((await post('result', 'codexbot-1-5', { output: clean(), context_complete: true })).status, 200);
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
