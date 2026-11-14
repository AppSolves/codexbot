import { randomSecret, seal, sha256, unseal, type Envelope } from '../core/crypto.js';
import { AppError, record, requireCondition } from '../core/errors.js';
import { client } from './github.js';
import type { BackendConfig } from './webhook.js';
import { boundedJson } from '../core/http.js';

export interface WebConfig extends BackendConfig {
  WEB_ENABLED?: string; WEB_SESSION_KEY?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string;
  OPENAI_WEB_CLIENT_ID?: string; OPENAI_WEB_CLIENT_SECRET?: string; OPENAI_WEB_AUTH_METHOD?: string;
  OPENAI_WEB_SCOPES?: string; OPENAI_HOSTED_INFERENCE_AUTHORIZED?: string;
  OPENAI_WEB_WORKSPACE_CLAIM?: string;
}
export interface BrowserSession { actorId: number; login: string; token: string; csrf: string; expiresAt: number }
const SESSION_COOKIE = '__Host-codexbot-session', TRANSACTION_COOKIE = '__Host-codexbot-auth';
export function cookie(request: Request, name: string): string {
  const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  requireCondition(values.length <= 1, 'duplicate_session_cookie', 401);
  return values[0]?.slice(name.length + 1) ?? '';
}
export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export function webKey(env: WebConfig): string {
  requireCondition(env.WEB_ENABLED === 'true' && env.WEB_SESSION_KEY && Buffer.from(env.WEB_SESSION_KEY, 'base64url').length === 32, 'web_onboarding_not_configured', 503);
  requireCondition(new URL(env.PUBLIC_URL).protocol === 'https:' && new URL(env.PUBLIC_URL).origin === env.PUBLIC_URL, 'web_requires_canonical_https_origin', 503);
  return env.WEB_SESSION_KEY;
}
export function redirect(path: string, cookies: string[] = []): Response {
  requireCondition(path.startsWith('/') && !path.startsWith('//') && !/[\r\n\\]/.test(path), 'unsafe_redirect');
  const response = new Response(null, { status: 303, headers: { Location: path } });
  for (const value of cookies) response.headers.append('Set-Cookie', value);
  return response;
}
export async function webLimit(env: WebConfig, key: string, limit = 20): Promise<void> {
  const bucket = await sha256(`${webKey(env)}|${Math.floor(Date.now() / 600_000)}|${key}`);
  const result = await env.DB.prepare(`INSERT INTO web_rate_limits(bucket,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`).bind(bucket, Date.now() + 600_000, limit).first();
  requireCondition(result, 'web_rate_limit', 429);
}
export async function beginTransaction(env: WebConfig, request: Request, kind: 'github' | 'openai', payload: unknown): Promise<{ state: string; browserCookie: string }> {
  await webLimit(env, `auth:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 20);
  const state = randomSecret(), browser = randomSecret(), hash = await sha256(state);
  await env.DB.prepare('INSERT INTO web_transactions(state_hash,browser_hash,kind,payload,expires_at) VALUES(?,?,?,?,?)')
    .bind(hash, await sha256(browser), kind, JSON.stringify(await seal(payload, webKey(env), `${env.PUBLIC_URL}|transaction|${hash}`)), Date.now() + 600_000).run();
  return { state, browserCookie: setCookie(TRANSACTION_COOKIE, browser, 600) };
}
export async function consumeTransaction(env: WebConfig, request: Request, kind: string): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  for (const field of ['state','code','error']) requireCondition(url.searchParams.getAll(field).length <= 1, 'duplicate_oauth_parameter');
  const state = url.searchParams.get('state') ?? '', browser = cookie(request, TRANSACTION_COOKIE);
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(browser), 'oauth_state_invalid', 401);
  const hash = await sha256(state);
  const row = await env.DB.prepare('DELETE FROM web_transactions WHERE state_hash=? AND browser_hash=? AND kind=? AND expires_at>? RETURNING payload')
    .bind(hash, await sha256(browser), kind, Date.now()).first<{ payload: string }>();
  requireCondition(row, 'oauth_attempt_expired_or_consumed', 401);
  requireCondition(!url.searchParams.has('error'), 'oauth_consent_denied', 403);
  return record(await unseal(JSON.parse(row.payload) as Envelope, webKey(env), `${env.PUBLIC_URL}|transaction|${hash}`));
}
export async function githubLogin(request: Request, env: WebConfig): Promise<Response> {
  requireCondition(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET, 'github_web_oauth_not_configured', 503);
  const verifier = randomSecret(), transaction = await beginTransaction(env, request, 'github', { verifier });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/auth/github/callback`, state: transaction.state,
    code_challenge: await sha256(verifier), code_challenge_method: 'S256' }).toString();
  return new Response(null, { status: 303, headers: { Location: url.href, 'Set-Cookie': transaction.browserCookie } });
}
export async function githubCallback(request: Request, env: WebConfig): Promise<Response> {
  const pending = await consumeTransaction(env, request, 'github'), code = new URL(request.url).searchParams.get('code');
  requireCondition(code && code.length <= 2048 && typeof pending.verifier === 'string' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET, 'github_oauth_callback_invalid');
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_URL}/auth/github/callback`, code_verifier: pending.verifier }) });
  requireCondition(response.ok && Number(response.headers.get('content-length') ?? 0) < 16_384, 'github_oauth_exchange_failed', 502);
  const tokens = record(await boundedJson(response, 16_384));
  requireCondition(typeof tokens.access_token === 'string' && /^[!-~]{1,4096}$/.test(tokens.access_token) && tokens.token_type === 'bearer' && !tokens.error, 'github_oauth_grant_invalid', 401);
  requireCondition(tokens.expires_in === undefined || typeof tokens.expires_in === 'number' && Number.isSafeInteger(tokens.expires_in) && tokens.expires_in > 0 && tokens.expires_in <= 86_400, 'github_oauth_grant_invalid', 401);
  const { data: actor } = await client(tokens.access_token).rest.users.getAuthenticated();
  requireCondition(actor.type === 'User' && Number.isSafeInteger(actor.id) && actor.id > 0, 'github_user_required', 403);
  const id = randomSecret(), hash = await sha256(id), expiresAt = Date.now() + Math.min(3600, typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000;
  const session: BrowserSession = { actorId: actor.id, login: actor.login, token: tokens.access_token, csrf: randomSecret(), expiresAt };
  const previous = cookie(request, SESSION_COOKIE);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM web_sessions WHERE id_hash=?').bind(await sha256(previous)),
    env.DB.prepare('INSERT INTO web_sessions(id_hash,actor_id,payload,expires_at) VALUES(?,?,?,?)')
      .bind(hash, actor.id, JSON.stringify(await seal(session, webKey(env), `${env.PUBLIC_URL}|browser|${hash}`)), expiresAt)
  ]);
  return redirect('/dashboard', [setCookie(SESSION_COOKIE, id, Math.floor((expiresAt - Date.now()) / 1000)), setCookie(TRANSACTION_COOKIE, '', 0)]);
}
export async function browserSession(request: Request, env: WebConfig): Promise<BrowserSession> {
  const id = cookie(request, SESSION_COOKIE); requireCondition(/^[A-Za-z0-9_-]{43}$/.test(id), 'web_sign_in_required', 401);
  const hash = await sha256(id), row = await env.DB.prepare('SELECT payload FROM web_sessions WHERE id_hash=? AND expires_at>?').bind(hash, Date.now()).first<{ payload: string }>();
  requireCondition(row, 'web_session_expired', 401);
  const session = await unseal(JSON.parse(row.payload) as Envelope, webKey(env), `${env.PUBLIC_URL}|browser|${hash}`) as BrowserSession;
  try { const { data: actor } = await client(session.token).rest.users.getAuthenticated(); requireCondition(actor.id === session.actorId && actor.type === 'User', 'github_identity_changed', 401); session.login = actor.login; }
  catch { await env.DB.prepare('DELETE FROM web_sessions WHERE id_hash=?').bind(hash).run(); throw new AppError('github_authorization_expired', 401); }
  return session;
}
export function verifyCsrf(request: Request, session: BrowserSession, value: unknown, origin: string): void {
  requireCondition(request.headers.get('origin') === origin && value === session.csrf && request.headers.get('sec-fetch-site') !== 'cross-site', 'web_csrf_rejected', 403);
}
export async function logout(request: Request, env: WebConfig): Promise<Response> {
  await env.DB.prepare('DELETE FROM web_sessions WHERE id_hash=?').bind(await sha256(cookie(request, SESSION_COOKIE))).run();
  return redirect('/', [setCookie(SESSION_COOKIE, '', 0), setCookie(TRANSACTION_COOKIE, '', 0)]);
}
