import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { OAuth, ISSUER, RESOURCE, SCOPES, validateSession } from '../src/auth/oauth.js';
import type { OAuthSession, PendingLogin } from '../src/auth/oauth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicPrivateFile, readPrivateFile, withFileLock } from '../src/auth/files.js';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const host = 'urn:uuid:12345678-1234-4123-8123-123456789012';
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` };
async function idToken(nonce: string, subject = 'user-1', audience = 'oaiapp_test'): Promise<string> {
  return new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISSUER).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('1h').sign(privateKey);
}
function fixture() {
  const calls: { url: string; form: URLSearchParams }[] = [];
  let pending: PendingLogin | null = null, responseOverride: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(discovery);
    const form = new URLSearchParams(String(init?.body)); calls.push({ url, form });
    if (url === discovery.revocation_endpoint) return new Response('', { status: 200 });
    return Response.json({ token_type: 'Bearer', access_token: 'fixture-access', refresh_token: `rotated-${calls.length}`, id_token: await idToken(pending?.nonce ?? ''), expires_in: 3600, scope: SCOPES.join(' '), ...responseOverride });
  };
  const oauth = new OAuth(fetcher, () => publicKey);
  return { oauth, calls, setPending(value: PendingLogin) { pending = value; }, setResponse(value: Record<string, unknown>) { responseOverride = value; } };
}
function callback(pending: PendingLogin, clientId = 'oaiapp_test'): URL {
  const url = new URL(pending.redirect); url.searchParams.set('state', pending.state); url.searchParams.set('code', 'fixture-code'); url.searchParams.set('client_id', clientId); return url;
}
await test('official dynamic registration requests PKCE, state, nonce, resource and plan scopes', async () => {
  const { oauth } = fixture();
  const { url, pending } = await oauth.begin(host, 'http://127.0.0.1:1455/auth/callback');
  const query = new URL(url).searchParams;
  assert.equal(query.get('client_id'), 'dynamic_agent_client'); assert.equal(query.get('agent_name_hint'), 'CodexBot');
  assert.equal(query.get('resource'), RESOURCE); assert.equal(query.get('code_challenge_method'), 'S256');
  assert.equal(query.get('ext_agent_host_id'), host); assert.equal(query.get('state'), pending.state); assert.equal(query.get('nonce'), pending.nonce);
  assert.ok(query.get('scope')?.includes('chatgpt.tokens.use.direct')); assert.notEqual(query.get('code_challenge'), pending.verifier);
  await assert.rejects(oauth.begin(host, 'https://hosted.invalid/auth/callback'));
  await assert.rejects(oauth.begin(host, 'http://localhost:1455/auth/callback'));
});
await test('issued client id and verified identity are retained, never dynamic_agent_client', async () => {
  const f = fixture(); const { pending } = await f.oauth.begin(host, 'http://127.0.0.1:1455/auth/callback'); f.setPending(pending);
  const session = await f.oauth.complete(pending, callback(pending));
  await assert.rejects(f.oauth.complete(pending, callback(pending)), /consumed/);
  assert.equal(session.subject, 'user-1'); assert.equal(session.client_id, 'oaiapp_test'); assert.equal(session.ext_agent_host_id, host);
  assert.equal(f.calls[0]?.form.get('client_id'), 'oaiapp_test'); assert.equal(f.calls[0]?.form.get('code_verifier'), pending.verifier);
  const returning = await f.oauth.begin(host, pending.redirect, session);
  assert.equal(new URL(returning.url).searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(new URL(returning.url).searchParams.has('agent_name_hint'), false);
});
await test('invalid OAuth state, nonce, client, consent, account, audience and expiry fail closed', async () => {
  const f = fixture(); const { pending } = await f.oauth.begin(host, 'http://127.0.0.1:1455/auth/callback'); f.setPending(pending);
  const badState = callback(pending); badState.searchParams.set('state', 'forged'); await assert.rejects(f.oauth.complete(pending, badState));
  const denied = callback(pending); denied.searchParams.set('error', 'access_denied'); await assert.rejects(f.oauth.complete({ ...pending }, denied));
  await assert.rejects(f.oauth.complete({ ...pending, createdAt: 0 }, callback(pending)));
  const duplicate = callback(pending); duplicate.searchParams.append('code', 'another'); await assert.rejects(f.oauth.complete(pending, duplicate));
  await assert.rejects(f.oauth.complete({ ...pending }, callback(pending, 'dynamic_agent_client')));
  f.setResponse({ id_token: await idToken('wrong') }); await assert.rejects(f.oauth.complete({ ...pending }, callback(pending)), /nonce/);
  f.setResponse({ id_token: await idToken(pending.nonce, 'user-1', 'oaiapp_other') }); await assert.rejects(f.oauth.complete({ ...pending }, callback(pending)), /aud/);
  f.setResponse({ id_token: await idToken(pending.nonce, 'user-2') });
  await assert.rejects(f.oauth.complete({ ...pending, registration: { client_id: 'oaiapp_test', subject: 'user-1', issuer: ISSUER } }, callback(pending)));
  f.setResponse({ scope: 'openid profile email offline_access resource.invoke' }); await assert.rejects(f.oauth.complete({ ...pending }, callback(pending)), /permission_missing/);
});
await test('rotation uses saved issued client, refresh token and resource; persists complete replacement', async () => {
  const f = fixture(); const { pending } = await f.oauth.begin(host, 'http://127.0.0.1:1455/auth/callback'); f.setPending(pending);
  const session = await f.oauth.complete(pending, callback(pending));
  const rotated = await f.oauth.refresh(session);
  assert.notEqual(rotated.refresh_token, session.refresh_token); assert.equal(rotated.subject, session.subject); assert.equal(rotated.ext_agent_host_id, host);
  const form = f.calls.at(-1)!.form;
  assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), session.refresh_token); assert.equal(form.get('client_id'), 'oaiapp_test'); assert.equal(form.get('resource'), RESOURCE); assert.equal(form.has('scope'), false);
  assert.equal(await f.oauth.revoke(rotated), true);
});
await test('expired or invalid grants never fall back to API billing', async () => {
  const failing: typeof fetch = async input => String(input).endsWith('/openid-configuration') ? Response.json(discovery) : Response.json({ error: 'invalid_grant', secret: 'must-not-surface' }, { status: 400 });
  const oauth = new OAuth(failing, () => publicKey);
  const session: OAuthSession = { client_id: 'oaiapp_test', subject: 'user-1', issuer: ISSUER, ext_agent_host_id: host, access_token: 'expired', refresh_token: 'revoked', id_token: 'retained', scopes: SCOPES, expires_at: 0, earliest_refresh_at: 0 };
  await assert.rejects(oauth.refresh(session), /reconnect_required/);
  assert.throws(() => validateSession({ ...session, scopes: ['openid'] }));
  await assert.rejects(oauth.refresh({ ...session, earliest_refresh_at: Date.now() + 60_000 }));
});
await test('private atomic files and exclusive lock prevent two refresh owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexbot-test-')), path = join(directory, 'session.json');
  try {
    await atomicPrivateFile(path, { refresh_token: 'fixture-rotated' }); assert.deepEqual(await readPrivateFile(path), { refresh_token: 'fixture-rotated' });
    await withFileLock(path, async () => { await assert.rejects(withFileLock(path, async () => 1), /locked/); });
    assert.equal(await withFileLock(path, async () => 'released'), 'released');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
