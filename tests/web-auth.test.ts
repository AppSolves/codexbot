import { configurationFields } from '../src/worker/onboarding.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { database } from './sqlite.js';
import { beginTransaction, consumeTransaction, githubLogin, githubCallback, browserSession, logout, verifyCsrf, webLimit, redirect, type WebConfig } from '../src/worker/web-auth.js';
import { sealEnvironmentSecret } from '../src/worker/environment-secrets.js';
import { randomSecret, sha256, unseal, seal } from '../src/core/crypto.js';
import { authorizedRepository, configurationFromForm, withRepositoryOperation } from '../src/worker/web-repositories.js';
import { websiteOAuth, connectApiKey, disconnectConnection } from '../src/worker/web-connections.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { parseCommand } from '../src/core/command.js';
import { Store } from '../src/worker/store.js';
import worker from '../src/worker/index.js';
import sodium from 'libsodium-wrappers';
const pem = await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey);
function fixture() {
  const { db, sqlite } = database();
  const env: WebConfig = { DB: db, PUBLIC_URL: 'https://web.invalid', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'codexbot', GITHUB_PRIVATE_KEY: pem, TRUSTED_WORKFLOW: `owner/source/.github/workflows/review.yml@${'a'.repeat(40)}`,
    CHATGPT_DEPLOYMENT_AUTHORIZED: 'true', WEB_ENABLED: 'true', WEB_SESSION_KEY: randomSecret(), GITHUB_CLIENT_ID: 'Iv1.fixture', GITHUB_CLIENT_SECRET: 'fixture-client-secret' };
  const session = { actorId: 5, login: 'alice', token: 'fixture-user-token', csrf: randomSecret(), expiresAt: Date.now() + 60_000 };
  let admin = true, installed = true, installationId = 1, actorId = 5;
  const writes: { path: string; body: Record<string,unknown> }[] = [], keys = nacl.box.keyPair();
  const secrets = new Set<string>();
  const intercepted = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method ?? 'GET';
    if (url.origin === 'https://github.com') {
      assert.equal(path, '/login/oauth/access_token'); assert.equal(init?.redirect, 'error');
      const form = new URLSearchParams(String(init?.body)); assert.equal(form.get('client_id'), env.GITHUB_CLIENT_ID); assert.equal(form.get('client_secret'), env.GITHUB_CLIENT_SECRET); assert.ok(form.get('code_verifier'));
      return Response.json({ access_token: session.token, token_type: 'bearer', expires_in: 3600 });
    }
    if (path === '/user') return Response.json({ id: actorId, login: 'alice', type: 'User' });
    if (path === '/repositories/2' || path === '/repos/owner/repo') return Response.json({ id: 2, full_name: 'owner/repo', default_branch: 'main', private: false, owner: { id: 3 }, permissions: { admin } });
    if (path.endsWith('/installation')) return Response.json({ id: installationId, app_id: 42, suspended_at: installed ? null : 'now', permissions: { workflows: 'write', administration: 'write', environments: 'write' } });
    if (path.endsWith('/branches/main')) return Response.json({ protected: true, commit: { sha: 'b'.repeat(40) } });
    if (path.endsWith('/deployment-branch-policies')) return Response.json({ total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] });
    if (path.endsWith('/public-key')) return Response.json({ key_id: 'key1', key: Buffer.from(keys.publicKey).toString('base64') });
    if (path.endsWith('/secrets')) return Response.json({ total_count: secrets.size, secrets: [...secrets].map(name => ({ name })) });
    if (path.includes('/secrets/') && ['PUT','DELETE'].includes(method)) {
      const name = path.split('/').at(-1)!;
      if (method === 'DELETE') secrets.delete(name);
      else secrets.add(name);
      writes.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : {} }); return new Response(null, { status: 204 });
    }
    if (path.endsWith('/environments')) return Response.json({ total_count: 0, environments: [] });
    if (path.includes('/environments/')) return Response.json({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    throw new Error(`Unmocked GitHub contract ${method} ${path}`);
  });
  return { env, session, sqlite, db, keys, writes, secrets, admin(value: boolean) { admin = value; }, installed(value: boolean) { installed = value; }, installation(value: number) { installationId = value; }, actor(value: number) { actorId = value; }, close() { intercepted.mock.restore(); sqlite.close(); } };
}
const browserCookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
await test('GitHub OAuth uses PKCE, exact callback and encrypted one-time browser state; sessions rotate and never disclose tokens', async () => {
  const f = fixture();
  try {
    const start = await githubLogin(new Request('https://web.invalid/auth/github'), f.env), url = new URL(start.headers.get('location')!);
    assert.equal(url.origin, 'https://github.com'); assert.equal(url.searchParams.get('redirect_uri'), 'https://web.invalid/auth/github/callback'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const row = f.sqlite.prepare('SELECT payload FROM web_transactions').get()!; assert.ok(!String(row.payload).includes('verifier'));
    const callback = new Request(`https://web.invalid/auth/github/callback?state=${url.searchParams.get('state')}&code=fixture-code`, { headers: { cookie: browserCookie(start) } });
    const complete = await githubCallback(callback, f.env); assert.equal(complete.headers.get('location'), '/dashboard');
    assert.match(complete.headers.get('set-cookie')!, /Secure; HttpOnly; SameSite=Lax/); assert.ok(!complete.headers.get('set-cookie')!.includes(f.session.token));
    await assert.rejects(githubCallback(callback, f.env), /expired_or_consumed/);
    const authenticated = new Request('https://web.invalid/dashboard', { headers: { cookie: browserCookie(complete) } });
    const session = await browserSession(authenticated, f.env); assert.equal(session.actorId, 5);
    const stored = f.sqlite.prepare('SELECT payload FROM web_sessions').get()!; assert.ok(!String(stored.payload).includes(f.session.token));
    await logout(authenticated, f.env); await assert.rejects(browserSession(authenticated, f.env), /web_session_expired/);
  } finally { f.close(); }
});
await test('OAuth state rejects wrong browser, replay, expiry, duplicated state, missing state and tenant rebinding', async () => {
  const f = fixture();
  try {
    const pending = await beginTransaction(f.env, new Request('https://web.invalid'), 'github', { verifier: 'private-value' });
    const target = `https://web.invalid/auth/github/callback?state=${pending.state}&code=test`;
    await assert.rejects(consumeTransaction(f.env, new Request(target), 'github'));
    await assert.rejects(consumeTransaction(f.env, new Request(target, { headers: { cookie: '__Host-codexbot-auth=' + randomSecret() } }), 'github'));
    const headers = { cookie: pending.browserCookie.split(';')[0]! };
    await assert.rejects(consumeTransaction(f.env, new Request(target + '&state=x', { headers }), 'github'));
    await assert.rejects(consumeTransaction({ ...f.env, PUBLIC_URL: 'https://other.invalid' }, new Request(target, { headers }), 'github'));
    const expired = await beginTransaction(f.env, new Request('https://web.invalid'), 'github', {});
    f.sqlite.prepare('UPDATE web_transactions SET expires_at=0').run();
    await assert.rejects(consumeTransaction(f.env, new Request(`https://web.invalid/cb?state=${expired.state}`, { headers: { cookie: expired.browserCookie.split(';')[0]! } }), 'github'));
    assert.throws(() => redirect('//evil.invalid')); assert.throws(() => redirect('/\\evil'));
  } finally { f.close(); }
});
await test('live GitHub authorization failure invalidates only the presented session, not another actor or a newly valid grant', async () => {
  const f=fixture();
  try {
    const id=randomSecret(), hash=await sha256(id), envelope=await seal(f.session,f.env.WEB_SESSION_KEY!,`${f.env.PUBLIC_URL}|browser|${hash}`);
    f.sqlite.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(hash,5,JSON.stringify(envelope),Date.now()+60_000);
    f.sqlite.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run('other-actor',9,'unrelated-ciphertext',Date.now()+60_000);
    const request=new Request('https://web.invalid/dashboard',{headers:{cookie:'__Host-codexbot-session='+id}});
    assert.equal((await browserSession(request,f.env)).actorId,5); f.actor(9);
    await assert.rejects(browserSession(request,f.env),/github_authorization_expired/);
    assert.deepEqual(f.sqlite.prepare('SELECT actor_id FROM web_sessions').all().map(row=>row.actor_id),[9]);
  } finally {f.close();}
});
await test('CSRF, session identity changes, endpoint quotas and repository operations fail closed under concurrency', async () => {
  const f = fixture();
  try {
    assert.throws(() => verifyCsrf(new Request('https://web.invalid/x', { method: 'POST' }), f.session, f.session.csrf, f.env.PUBLIC_URL));
    assert.throws(() => verifyCsrf(new Request('https://web.invalid/x', { headers: { origin: 'https://evil.invalid' } }), f.session, f.session.csrf, f.env.PUBLIC_URL));
    verifyCsrf(new Request('https://web.invalid/x', { headers: { origin: f.env.PUBLIC_URL } }), f.session, f.session.csrf, f.env.PUBLIC_URL);
    const admissions = await Promise.allSettled(Array.from({ length: 5 }, () => webLimit(f.env, 'same-user', 2)));
    assert.equal(admissions.filter(item => item.status === 'fulfilled').length, 2);
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    const active = withRepositoryOperation(f.env, 1, 2, () => waiting);
    await assert.rejects(withRepositoryOperation(f.env, 1, 2, async () => {}), /operation_in_progress/);
    await withRepositoryOperation(f.env, 9, 2, async () => {}); finish(); await active;
    await withRepositoryOperation(f.env, 1, 2, async () => {});
    await withRepositoryOperation(f.env, 1, 2, async check => {
      await check();
      f.sqlite.prepare("UPDATE web_operations SET lease='new-owner' WHERE installation_id=1 AND repository_id=2").run();
      await assert.rejects(check(), /operation_lease_lost/);
    });
    assert.equal(f.sqlite.prepare('SELECT lease FROM web_operations WHERE installation_id=1 AND repository_id=2').get()!.lease, 'new-owner', 'An old owner cannot release a successor lease');
  } finally { f.close(); }
});
await test('live administration and installation identity are required; URL numeric IDs never grant access', async () => {
  const f = fixture();
  try {
    await authorizedRepository(f.env, f.session, 1, 2);
    f.admin(false); await assert.rejects(authorizedRepository(f.env, f.session, 1, 2), /admin_required/); f.admin(true);
    f.installation(9); await assert.rejects(authorizedRepository(f.env, f.session, 1, 2), /installation_mismatch/); f.installation(1);
    f.installed(false); await assert.rejects(authorizedRepository(f.env, f.session, 1, 2), /suspended/);
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});
await test('Environment API secrets use sealed boxes, never plaintext; ChatGPT/API modes cannot overlap', async () => {
  const f = fixture(), value = 'sk-fixture-only-'.padEnd(40, 'x');
  try {
    await sodium.ready;
    const sealed = Buffer.from(sealEnvironmentSecret(value, Buffer.from(f.keys.publicKey).toString('base64')), 'base64'), ephemeral = sealed.subarray(0, 32);
    assert.equal(new TextDecoder().decode(sodium.crypto_box_seal_open(sealed, f.keys.publicKey, f.keys.secretKey)), value);
    const nonce = blake2b(Buffer.concat([ephemeral, f.keys.publicKey]), undefined, 24);
    assert.equal(Buffer.from(nacl.box.open(sealed.subarray(32), nonce, ephemeral, f.keys.secretKey)!).toString(), value);
    assert.notEqual(sealEnvironmentSecret(value, Buffer.from(f.keys.publicKey).toString('base64')), sealed.toString('base64'));
    await connectApiKey(f.env, f.session, 1, 2, value); assert.equal(f.writes.length, 1);
    assert.ok(f.writes[0]!.path.includes('/environments/codexbot-1-5/secrets/CODEXBOT_API_KEY')); assert.ok(!JSON.stringify(f.writes).includes(value));
    await new Store(f.db).saveSession(2, 5, await seal({}, randomSecret(), 'fixture'), 1);
    await assert.rejects(connectApiKey(f.env, f.session, 1, 2, value), /disconnect_chatgpt/);
    await disconnectConnection(f.env, f.session, 1, 2); assert.equal(await new Store(f.db).session(2, 5, 1), null);
    assert.equal(f.secrets.size, 0);
  } finally { f.close(); }
});
function configForm(): URLSearchParams {
  const form = new URLSearchParams();
  const walk = (value: Record<string,unknown>, prefix = '') => { for (const [key,item] of Object.entries(value)) { const name = prefix + key; if (item && typeof item === 'object' && !Array.isArray(item)) walk(item as Record<string,unknown>, name + '.'); else if (typeof item === 'boolean') { if (item) form.set(name,'true'); } else form.set(name, String(item ?? '')); } };
  walk(structuredClone(DEFAULT_CONFIG) as unknown as Record<string,unknown>); return form;
}
await test('web policy fields use canonical schema and pinned model catalog, with no silent model/effort substitution', () => {
  const form = configForm(); assert.deepEqual(configurationFromForm(form), DEFAULT_CONFIG);
  form.set('review.model','gpt-6.1-sol'); form.set('review.effort','ultra'); assert.equal(configurationFromForm(form).review.effort, 'ultra');
  assert.equal(parseCommand('@CBReview review --model=gpt-6.1-sol --effort ultra', '@CBReview')?.model, 'gpt-6.1-sol');
  form.set('review.model','unknown-model'); assert.throws(() => configurationFromForm(form), /not_in_codex_catalog/);
  form.set('review.model','gpt-5.5'); assert.throws(() => configurationFromForm(form), /effort_not_supported/);
  form.set('review.effort',''); form.set('bot.trigger','@bad-handle'); assert.throws(() => configurationFromForm(form));
});
await test('identity-only website OAuth cannot activate inference and web remains explicitly disabled until configured', async () => {
  const f = fixture();
  try {
    assert.throws(() => websiteOAuth(f.env), /not_configured/);
    assert.throws(() => websiteOAuth({ ...f.env, OPENAI_HOSTED_INFERENCE_AUTHORIZED: 'true', OPENAI_WEB_CLIENT_ID:'oaiapp_test', OPENAI_WEB_AUTH_METHOD:'none', OPENAI_WEB_SCOPES:'openid email profile' }), /inference_scopes/);
    const disabled = await worker.fetch(new Request('https://web.invalid/auth/github'), { ...f.env, WEB_ENABLED:'false' } as Env);
    assert.equal(disabled.status, 503); assert.ok(!(await disabled.text()).includes(f.env.GITHUB_CLIENT_SECRET!));
    const cliLanding=await worker.fetch(new Request('https://web.invalid/dashboard?installation_id=untrusted&next=https://evil.invalid'),{...f.env,WEB_ENABLED:'false'} as Env);assert.equal(cliLanding.status,303);assert.equal(cliLanding.headers.get('location'),'/');
    assert.equal((await worker.fetch(new Request('https://web.invalid/dashboard',{method:'POST'}),{...f.env,WEB_ENABLED:'false'} as Env)).status,503);
    const missing = await worker.fetch(new Request('https://web.invalid/dashboard'), f.env as Env); assert.equal(missing.status, 401);
  } finally { f.close(); }
});
await test('browser encryption is bound to origin and ID; uninstall removes only its hosted connection records', async () => {
  const f = fixture();
  try {
    const id = randomSecret(), hash = await sha256(id), binding = `${f.env.PUBLIC_URL}|browser|${hash}`;
    const encrypted = await seal(f.session, f.env.WEB_SESSION_KEY!, binding);
    await assert.rejects(seal({ value:'x'.repeat(60_000) }, f.env.WEB_SESSION_KEY!, binding), /invalid_envelope/);
    await assert.rejects(unseal(encrypted, f.env.WEB_SESSION_KEY!, `${f.env.PUBLIC_URL}|browser|other`));
    await assert.rejects(unseal(encrypted, f.env.WEB_SESSION_KEY!, `https://other.invalid|browser|${hash}`));
    f.sqlite.prepare('INSERT INTO web_connections VALUES(?,?,?,?,?,?)').run(1,2,5,JSON.stringify(encrypted),'ready',Date.now());
    f.sqlite.prepare('INSERT INTO web_connections VALUES(?,?,?,?,?,?)').run(9,2,5,JSON.stringify(encrypted),'ready',Date.now());
    await new Store(f.db).removeInstallation(1);
    assert.deepEqual(f.sqlite.prepare('SELECT installation_id FROM web_connections').all().map(row => row.installation_id), [9]);
  } finally { f.close(); }
});

await test('browser merge modes use canonical reviewed settings and retain explicit opt-in and human limits',()=>{
  const html=configurationFields(DEFAULT_CONFIG);assert.ok(html.includes('Fully Autonomous'));assert.ok(html.includes('Human-in-the-Loop'));assert.ok(html.includes('GitHub repository protections still apply'));
  const form=configForm();form.set('merge.enabled','true');form.set('merge.auto_merge_on_approval','true');form.set('merge.minimum_human_approvals','0');
  const autonomous=configurationFromForm(form);assert.equal(autonomous.merge.minimum_human_approvals,0);assert.equal(autonomous.merge.auto_merge_on_approval,true);
  form.set('merge.minimum_human_approvals','2');assert.equal(configurationFromForm(form).merge.minimum_human_approvals,2);
  form.append('merge.minimum_human_approvals','0');assert.throws(()=>configurationFromForm(form),/duplicate_configuration_field/);
});
