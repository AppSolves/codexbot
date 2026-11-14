import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { randomSecret, sha256 } from '../core/crypto.js';
import { record, requireCondition, AppError } from '../core/errors.js';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
export interface Registration { client_id: string; subject: string; issuer: string; email?: string }
export interface OAuthSession extends Registration {
  ext_agent_host_id: string; access_token: string; refresh_token: string; id_token: string;
  scopes: string[]; expires_at: number; earliest_refresh_at: number;
}
export interface PendingLogin { state: string; nonce: string; verifier: string; redirect: string; host: string; createdAt: number; registration: Registration | null; issuedClient: string | null }
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string }
export class OAuth {
  private readonly consumed = new WeakSet<PendingLogin>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly keys?: JWTVerifyGetKey) {}
  private async discovery(): Promise<Discovery> {
    const response = await this.fetcher(`${ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    requireCondition(response.ok, 'oauth_discovery_failed', 502);
    const data = record(await response.json());
    requireCondition(data.issuer === ISSUER, 'oauth_discovery_issuer_mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      if (key === 'revocation_endpoint' && data[key] === undefined) continue;
      requireCondition(typeof data[key] === 'string' && new URL(data[key]).origin === ISSUER, 'oauth_discovery_endpoint_mismatch');
    }
    return data as unknown as Discovery;
  }
  async begin(host: string, redirect: string, registration: Registration | null = null, idTokenHint?: string, issuedClient: string | null = null): Promise<{ url: string; pending: PendingLogin }> {
    requireCondition(/^urn:uuid:[a-f0-9-]{36}$/.test(host), 'invalid_host_id');
    const callback = new URL(redirect);
    requireCondition(callback.hostname === '127.0.0.1' && callback.protocol === 'http:' && callback.pathname === '/auth/callback' && !callback.search && !callback.hash && !callback.username && !callback.password, 'oauth_requires_loopback_callback');
    const discovery = await this.discovery();
    requireCondition(!issuedClient || /^oaiapp_[A-Za-z0-9_-]+$/.test(issuedClient), 'invalid_saved_client_id');
    const pending: PendingLogin = { state: randomSecret(), nonce: randomSecret(), verifier: randomSecret(), redirect, host, createdAt: Date.now(), registration, issuedClient };
    const url = new URL(discovery.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: registration?.client_id ?? issuedClient ?? 'dynamic_agent_client', ext_agent_host_id: host,
      response_type: 'code', redirect_uri: redirect, scope: SCOPES.join(' '), resource: RESOURCE,
      state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: await sha256(pending.verifier)
    };
    if (!registration && !issuedClient) params.agent_name_hint = 'CodexBot';
    else if (idTokenHint) params.id_token_hint = idTokenHint;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { url: url.href, pending };
  }
  async complete(pending: PendingLogin, callback: URL): Promise<OAuthSession> {
    requireCondition(!this.consumed.has(pending) && Date.now() - pending.createdAt <= 600_000, 'oauth_attempt_expired_or_consumed');
    const expected = new URL(pending.redirect);
    requireCondition(callback.origin === expected.origin && callback.pathname === expected.pathname, 'oauth_callback_mismatch');
    for (const field of ['state', 'code', 'client_id', 'error']) requireCondition(callback.searchParams.getAll(field).length <= 1, 'duplicate_oauth_parameter');
    requireCondition(callback.searchParams.get('state') === pending.state, 'oauth_state_mismatch');
    this.consumed.add(pending);
    requireCondition(!callback.searchParams.has('error'), 'oauth_consent_denied');
    const returnedId = callback.searchParams.get('client_id');
    const clientId = pending.registration?.client_id ?? pending.issuedClient ?? returnedId;
    requireCondition(clientId && clientId !== 'dynamic_agent_client' && /^oaiapp_[A-Za-z0-9_-]+$/.test(clientId), 'oauth_missing_issued_client_id');
    requireCondition(!returnedId || returnedId === clientId, 'oauth_client_id_mismatch');
    const code = callback.searchParams.get('code'); requireCondition(code, 'oauth_code_missing');
    const discovery = await this.discovery();
    const tokens = await this.tokens(discovery.token_endpoint, {
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, resource: RESOURCE
    });
    requireCondition(typeof tokens.id_token === 'string', 'oauth_id_token_missing');
    const { payload } = await jwtVerify(tokens.id_token, this.keys ?? createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 30, requiredClaims: ['sub', 'exp', 'iat', 'nonce']
    });
    requireCondition(payload.nonce === pending.nonce && typeof payload.sub === 'string' && payload.sub.length > 0, 'oauth_nonce_or_subject_invalid');
    requireCondition(!pending.registration || (payload.sub === pending.registration.subject && pending.registration.issuer === ISSUER), 'oauth_account_mismatch');
    if (payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1)) requireCondition(payload.azp === clientId, 'oauth_authorized_party_mismatch');
    const session = this.session(tokens, { client_id: clientId, subject: payload.sub, issuer: ISSUER, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) }, pending.host);
    return session;
  }
  private async tokens(endpoint: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { throw new AppError('oauth_token_exchange_uncertain_reconnect_required', 502); }
    // Never expose the response body, which may contain credentials or account identifiers.
    requireCondition(response.ok, response.status === 400 || response.status === 401 ? 'oauth_grant_invalid_reconnect_required' : 'oauth_token_endpoint_failed', 401);
    return record(await response.json());
  }
  private session(tokens: Record<string, unknown>, registration: Registration, host: string, previous?: OAuthSession): OAuthSession {
    requireCondition(tokens.token_type === 'Bearer' && typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string', 'oauth_invalid_token_response');
    for (const key of ['access_token', 'refresh_token']) requireCondition(typeof tokens[key] === 'string' && tokens[key].length > 0 && tokens[key].length <= 20_000 && [...tokens[key]].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127), 'oauth_invalid_credential');
    requireCondition(typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 && tokens.expires_in <= 86_400, 'oauth_invalid_expiry');
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous?.scopes ?? [];
    requireCondition(SCOPES.every(x => scopes.includes(x)), 'chatgpt_plan_usage_permission_missing', 403);
    const earliest = typeof tokens.earliest_refresh_at === 'number' ? tokens.earliest_refresh_at * 1000 : 0;
    requireCondition(Number.isFinite(earliest) && earliest >= 0, 'oauth_invalid_refresh_time');
    return { ...registration, ext_agent_host_id: host, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: typeof tokens.id_token === 'string' ? tokens.id_token : previous?.id_token ?? '', scopes,
      expires_at: Date.now() + tokens.expires_in * 1000, earliest_refresh_at: earliest };
  }
  async refresh(session: OAuthSession): Promise<OAuthSession> {
    requireCondition(Date.now() >= session.earliest_refresh_at, 'oauth_refresh_too_early');
    const discovery = await this.discovery();
    const tokens = await this.tokens(discovery.token_endpoint, { grant_type: 'refresh_token', client_id: session.client_id, refresh_token: session.refresh_token, resource: RESOURCE });
    if (typeof tokens.id_token === 'string') {
      const { payload } = await jwtVerify(tokens.id_token, this.keys ?? createRemoteJWKSet(new URL(discovery.jwks_uri)), {
        issuer: ISSUER, audience: session.client_id, subject: session.subject, algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 30, requiredClaims: ['exp', 'iat']
      });
      requireCondition(payload.sub === session.subject, 'oauth_refresh_account_mismatch');
      if (payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1)) requireCondition(payload.azp === session.client_id, 'oauth_refresh_authorized_party_mismatch');
    }
    return this.session(tokens, session, session.ext_agent_host_id, session);
  }
  async revoke(session: OAuthSession): Promise<boolean> {
    try {
      const discovery = await this.discovery();
      if (!discovery.revocation_endpoint) return false;
      const response = await this.fetcher(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: session.refresh_token, token_type_hint: 'refresh_token', client_id: session.client_id }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return response.status === 200;
    } catch { return false; }
  }
}

export function validateSession(value: unknown): OAuthSession {
  const session = record(value);
  for (const field of ['client_id', 'subject', 'issuer', 'ext_agent_host_id', 'access_token', 'refresh_token', 'id_token']) requireCondition(typeof session[field] === 'string' && session[field].length > 0, 'invalid_saved_session');
  const scopes = session.scopes;
  requireCondition(session.issuer === ISSUER && session.client_id !== 'dynamic_agent_client' && Array.isArray(scopes) && SCOPES.every(x => scopes.includes(x)), 'invalid_saved_registration');
  requireCondition(typeof session.expires_at === 'number' && Number.isFinite(session.expires_at) && typeof session.earliest_refresh_at === 'number' && Number.isFinite(session.earliest_refresh_at), 'invalid_saved_expiry');
  return session as unknown as OAuthSession;
}
