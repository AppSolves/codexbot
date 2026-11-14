import { OAuth, SCOPES, validateSession, type OAuthSession, type PendingLogin, type WebsiteOAuth } from '../auth/oauth.js';
import { randomSecret, seal, unseal, sessionBinding, sha256, type Envelope } from '../core/crypto.js';
import { requireCondition } from '../core/errors.js';
import { credentialEnvironment, publishingEnvironment } from '../core/identity.js';
import { authorizedRepository, withRepositoryOperation } from './web-repositories.js';
import { beginTransaction, consumeTransaction, browserSession, webKey, redirect, setCookie, type BrowserSession, type WebConfig } from './web-auth.js';
import { ensureProtectedEnvironment } from '../setup.js';
import { putEnvironmentSecret } from './environment-secrets.js';
import { Store, type RequestSnapshot } from './store.js';

interface Connection { vault: string; subject: string; clientId: string; host: string; workspace: string; pending?: OAuthSession; provisionId?: string }
function binding(env: WebConfig, installation: number, repository: number, actor: number): string { return `${env.PUBLIC_URL}|hosted-key|${installation}|${repository}|${actor}`; }
export function websiteOAuth(env: WebConfig): WebsiteOAuth {
  const authMethod = env.OPENAI_WEB_AUTH_METHOD;
  requireCondition(env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true' && env.OPENAI_HOSTED_INFERENCE_AUTHORIZED === 'true' && env.OPENAI_WEB_CLIENT_ID &&
    ['none','client_secret_post','client_secret_basic'].includes(authMethod ?? ''), 'hosted_oauth_registration_not_configured', 503);
  const scopes = env.OPENAI_WEB_SCOPES?.split(/\s+/).filter(Boolean) ?? [];
  requireCondition(SCOPES.every(scope => scopes.includes(scope)) && scopes.length <= 20 && scopes.every(scope => /^[A-Za-z0-9._:-]{1,100}$/.test(scope)), 'hosted_inference_scopes_not_configured', 503);
  requireCondition(authMethod === 'none' || !!env.OPENAI_WEB_CLIENT_SECRET, 'hosted_oauth_client_secret_missing', 503);
  requireCondition(env.OPENAI_WEB_WORKSPACE_CLAIM && /^[!-~]{1,256}$/.test(env.OPENAI_WEB_WORKSPACE_CLAIM), 'hosted_workspace_claim_not_configured', 503);
  return { clientId: env.OPENAI_WEB_CLIENT_ID, redirect: `${env.PUBLIC_URL}/auth/openai/callback`, authMethod: authMethod as WebsiteOAuth['authMethod'], scopes,
    workspaceClaim: env.OPENAI_WEB_WORKSPACE_CLAIM,
    ...(env.OPENAI_WEB_CLIENT_SECRET ? { clientSecret: env.OPENAI_WEB_CLIENT_SECRET } : {}) };
}
async function connection(env: WebConfig, installation: number, repository: number, actor: number): Promise<Connection | null> {
  const row = await env.DB.prepare('SELECT payload FROM web_connections WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation, repository, actor).first<{ payload: string }>();
  return row ? await unseal(JSON.parse(row.payload) as Envelope, webKey(env), binding(env, installation, repository, actor)) as Connection : null;
}
export async function connectionSummary(env: WebConfig, installation: number, repository: number, actor: number): Promise<{ account: string; workspace: string; expired: boolean } | null> {
  const key = await connection(env, installation, repository, actor), saved = await new Store(env.DB).session(repository, actor, installation);
  if (!key || !saved || key.pending) return null;
  const session = validateSession(await unseal(saved.envelope, key.vault, sessionBinding(env.PUBLIC_URL, installation, repository, actor)));
  return { account: key.subject, workspace: key.workspace, expired: session.expires_at <= Date.now() };
}
async function saveConnection(env: WebConfig, installation: number, repository: number, actor: number, value: Connection, state: string, lease: string): Promise<void> {
  const result = await env.DB.prepare(`INSERT INTO web_connections(installation_id,repository_id,actor_id,payload,state,updated_at) SELECT ?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM web_operations WHERE installation_id=? AND repository_id=? AND lease=? AND lease_until>?)
    ON CONFLICT(installation_id,repository_id,actor_id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at`)
    .bind(installation, repository, actor, JSON.stringify(await seal(value, webKey(env), binding(env, installation, repository, actor))), state, Date.now(), installation, repository, lease, Date.now()).run();
  requireCondition(result.meta.changes === 1, 'repository_operation_lease_lost', 409);
}
export async function beginChatGPT(request: Request, env: WebConfig, session: BrowserSession, installation: number, repository: number, replace: boolean): Promise<Response> {
  await authorizedRepository(env, session, installation, repository);
  const oauthConfig = websiteOAuth(env), previous = await connection(env, installation, repository, session.actorId);
  const saved = await new Store(env.DB).session(repository, session.actorId, installation);
  requireCondition(!saved || previous, 'existing_cli_connection_requires_explicit_disconnect_before_web_migration', 409);
  requireCondition(!previous?.pending || previous.pending.expires_at <= Date.now(), 'finish_pending_credential_provisioning_first', 409);
  const host = previous?.host ?? `urn:uuid:${crypto.randomUUID()}`;
  const attempt = await new OAuth(fetch, undefined, oauthConfig).beginWebsite(host, previous && !replace ? { issuer: 'https://auth.openai.com', client_id: previous.clientId, subject: previous.subject, workspace: previous.workspace } : null);
  const transaction = await beginTransaction(env, request, 'openai', { pending: attempt.pending, actor: session.actorId, installation, repository, replace });
  // The durable browser-bound transaction owns state; the protocol verifier uses that same state.
  const pending = { ...attempt.pending, state: transaction.state };
  const hash = await sha256(transaction.state);
  await env.DB.prepare('UPDATE web_transactions SET payload=? WHERE state_hash=?').bind(JSON.stringify(await seal({ pending, actor: session.actorId, installation, repository, replace }, webKey(env), `${env.PUBLIC_URL}|transaction|${hash}`)), hash).run();
  const url = new URL(attempt.url); url.searchParams.set('state', transaction.state);
  return new Response(null, { status: 303, headers: { Location: url.href, 'Set-Cookie': transaction.browserCookie } });
}
export async function chatGPTCallback(request: Request, env: WebConfig): Promise<Response> {
  const session = await browserSession(request, env), pending = await consumeTransaction(env, request, 'openai');
  requireCondition(pending.actor === session.actorId && Number.isSafeInteger(pending.installation) && Number.isSafeInteger(pending.repository), 'oauth_account_binding_mismatch', 403);
  const installation = Number(pending.installation), repository = Number(pending.repository);
  await authorizedRepository(env, session, installation, repository);
  const oauthSession = await new OAuth(fetch, undefined, websiteOAuth(env)).complete(pending.pending as PendingLogin, new URL(request.url));
  await withRepositoryOperation(env, installation, repository, async (check, lease) => {
    const previous = await connection(env, installation, repository, session.actorId);
    requireCondition(!previous || pending.replace === true || previous.subject === oauthSession.subject, 'oauth_account_switch_requires_consent', 403);
    requireCondition(oauthSession.workspace, 'oauth_workspace_mismatch');
    const value: Connection = { vault: previous?.vault ?? randomSecret(), subject: oauthSession.subject, workspace: oauthSession.workspace, clientId: oauthSession.client_id, host: oauthSession.ext_agent_host_id, pending: oauthSession, provisionId: crypto.randomUUID() };
    await check();
    const existing = await env.DB.prepare('SELECT 1 FROM sessions WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation, repository, session.actorId).first();
    if (existing) {
      const locked = await env.DB.prepare(`UPDATE sessions SET lease_request=?,lease_until=? WHERE installation_id=? AND repository_id=? AND actor_id=? AND lease_until<?
        AND EXISTS(SELECT 1 FROM web_operations WHERE installation_id=? AND repository_id=? AND lease=? AND lease_until>?)`)
        .bind(`web:${value.provisionId}`, Date.now() + 300_000, installation, repository, session.actorId, Date.now(), installation, repository, lease, Date.now()).run();
      requireCondition(locked.meta.changes === 1, 'session_busy', 409);
    }
    // Retain encrypted pending credentials after partial GitHub writes; retries never redeem the code again.
    await saveConnection(env, installation, repository, session.actorId, value, 'pending', lease);
    await provision(env, session, installation, repository, value, check, lease);
  });
  return redirect(`/dashboard/repository?installation=${installation}&repository=${repository}`, [setCookie('__Host-codexbot-auth', '', 0)]);
}
async function provision(env: WebConfig, session: BrowserSession, installation: number, repository: number, value: Connection, check: () => Promise<void>, lease: string): Promise<void> {
  const { user, metadata, repo, installation: live } = await authorizedRepository(env, session, installation, repository);
  requireCondition(live.permissions?.environments === 'write' && live.permissions.administration === 'write', 'installation_permission_upgrade_required', 403);
  requireCondition(value.pending, 'no_pending_credential_provisioning', 409);
  await ensureProtectedEnvironment(user, metadata.full_name, credentialEnvironment(installation, session.actorId), check, true);
  await ensureProtectedEnvironment(user, metadata.full_name, publishingEnvironment(installation), check, true);
  const secrets = (await user.rest.actions.listEnvironmentSecrets({ ...repo, environment_name: credentialEnvironment(installation, session.actorId), per_page: 100 })).data;
  requireCondition(!secrets.secrets.some(secret => secret.name === 'CODEXBOT_API_KEY'), 'disconnect_api_key_before_connecting_chatgpt', 409);
  const lock = `web:${value.provisionId ?? value.host}`;
  const encrypted = await seal(value.pending, value.vault, sessionBinding(env.PUBLIC_URL, installation, repository, session.actorId));
  await check();
  const claimed = await env.DB.prepare(`INSERT INTO sessions(installation_id,repository_id,actor_id,envelope,lease_request,lease_until) SELECT ?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM web_operations WHERE installation_id=? AND repository_id=? AND lease=? AND lease_until>?)
    ON CONFLICT(installation_id,repository_id,actor_id) DO UPDATE SET lease_request=excluded.lease_request,lease_until=excluded.lease_until
    WHERE sessions.lease_until<? OR sessions.lease_request=? RETURNING version`)
    .bind(installation, repository, session.actorId, JSON.stringify(encrypted), lock, Date.now() + 300_000, installation, repository, lease, Date.now(), Date.now(), lock).first();
  requireCondition(claimed, 'session_busy', 409);
  await check(); await putEnvironmentSecret(user, metadata.full_name, credentialEnvironment(installation, session.actorId), 'CODEXBOT_VAULT_KEY', value.vault);
  await check();
  const result = await env.DB.prepare('UPDATE sessions SET envelope=?,version=version+1,lease_request=NULL,lease_until=0 WHERE installation_id=? AND repository_id=? AND actor_id=? AND lease_request=? AND lease_until>? AND EXISTS(SELECT 1 FROM web_operations WHERE installation_id=? AND repository_id=? AND lease=? AND lease_until>?)')
    .bind(JSON.stringify(encrypted), installation, repository, session.actorId, lock, Date.now(), installation, repository, lease, Date.now()).run();
  requireCondition(result.meta.changes === 1, 'credential_provisioning_lease_expired', 409);
  const ready = { ...value }; delete ready.pending; await saveConnection(env, installation, repository, session.actorId, ready, 'ready', lease);
}
export async function retryProvision(env: WebConfig, session: BrowserSession, installation: number, repository: number): Promise<void> {
  await authorizedRepository(env, session, installation, repository);
  await withRepositoryOperation(env, installation, repository, async (check, lease) => {
    const saved = await connection(env, installation, repository, session.actorId); requireCondition(saved?.pending, 'no_pending_credential_provisioning', 409);
    requireCondition(saved.pending.expires_at > Date.now(), 'pending_connection_expired_reconnect_required', 409);
    await provision(env, session, installation, repository, saved, check, lease);
  });
}
/** Called only after the existing signed OIDC, exact run and session-lease verification. */
export async function renewHosted(env: WebConfig, snapshot: RequestSnapshot): Promise<{ envelope: Envelope; version: number }> {
  return withRepositoryOperation(env, snapshot.installationId, snapshot.repositoryId, async (check, lease) => {
  const store = new Store(env.DB), saved = await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId);
  const key = await connection(env, snapshot.installationId, snapshot.repositoryId, snapshot.actorId);
  requireCondition(saved && key && !key.pending, 'hosted_session_unavailable', 409);
  const session = validateSession(await unseal(saved.envelope, key.vault, sessionBinding(env.PUBLIC_URL, snapshot.installationId, snapshot.repositoryId, snapshot.actorId)));
  requireCondition(session.hosted && session.subject === key.subject && session.client_id === websiteOAuth(env).clientId, 'hosted_session_identity_changed', 403);
  // An expiring session is acquired by the OIDC request before this path; CAS prevents replay/parallel renewal.
  const claimed = await env.DB.prepare(`UPDATE web_connections SET state='refreshing' WHERE installation_id=? AND repository_id=? AND actor_id=? AND state='ready'
    AND EXISTS(SELECT 1 FROM sessions WHERE installation_id=? AND repository_id=? AND actor_id=? AND lease_request=? AND lease_until>?)`)
    .bind(snapshot.installationId, snapshot.repositoryId, snapshot.actorId, snapshot.installationId, snapshot.repositoryId, snapshot.actorId, snapshot.id, Date.now()).run();
  requireCondition(claimed.meta.changes === 1, 'hosted_refresh_reconnect_required', 409);
  await check(); const renewed = await new OAuth(fetch, undefined, websiteOAuth(env)).refresh(session);
  const encrypted = await seal(renewed, key.vault, sessionBinding(env.PUBLIC_URL, snapshot.installationId, snapshot.repositoryId, snapshot.actorId));
  await check(); await store.rotate(snapshot, saved.version, encrypted, lease);
  await saveConnection(env, snapshot.installationId, snapshot.repositoryId, snapshot.actorId, key, 'ready', lease);
  return { envelope: encrypted, version: saved.version + 1 };
  });
}
export async function disconnectConnection(env: WebConfig, session: BrowserSession, installation: number, repository: number): Promise<boolean> {
  const auth = await authorizedRepository(env, session, installation, repository);
  return withRepositoryOperation(env, installation, repository, async () => {
    const key = await connection(env, installation, repository, session.actorId), lock = `disconnect:${crypto.randomUUID()}`;
    const exists = await new Store(env.DB).session(repository, session.actorId, installation);
    const locked = await env.DB.prepare('UPDATE sessions SET lease_request=?,lease_until=? WHERE installation_id=? AND repository_id=? AND actor_id=? AND lease_until<? RETURNING envelope')
      .bind(lock, Date.now() + 300_000, installation, repository, session.actorId, Date.now()).first<{ envelope: string }>();
    requireCondition(!exists || locked, 'session_busy', 409);
    const saved = locked ? { envelope: JSON.parse(locked.envelope) as Envelope } : null;
    let revoked = !saved;
    // Deleting the local session first prevents new inference; remote revocation is best effort and explicitly reported.
    await env.DB.prepare('DELETE FROM sessions WHERE installation_id=? AND repository_id=? AND actor_id=? AND lease_request=?').bind(installation, repository, session.actorId, lock).run();
    if (key) {
      try {
        const oauth = new OAuth(fetch, undefined, websiteOAuth(env));
        if (saved) revoked = await oauth.revoke(validateSession(await unseal(saved.envelope, key.vault, sessionBinding(env.PUBLIC_URL, installation, repository, session.actorId))));
        if (key.pending) revoked = await oauth.revoke(key.pending) && revoked;
      } catch { revoked = false; }
    }
    for (const secret_name of ['CODEXBOT_VAULT_KEY', 'CODEXBOT_API_KEY']) {
      try { await auth.user.rest.actions.deleteEnvironmentSecret({ ...auth.repo, environment_name: credentialEnvironment(installation, session.actorId), secret_name }); }
      catch (error) { requireCondition(error && typeof error === 'object' && 'status' in error && error.status === 404, 'credential_secret_cleanup_failed', 502); }
    }
    await env.DB.prepare('DELETE FROM web_connections WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation, repository, session.actorId).run();
    return revoked;
  });
}
export async function connectApiKey(env: WebConfig, session: BrowserSession, installation: number, repository: number, key: string): Promise<void> {
  requireCondition(/^sk-[A-Za-z0-9_-]{20,500}$/.test(key), 'invalid_api_key');
  const auth = await authorizedRepository(env, session, installation, repository);
  requireCondition(auth.installation.permissions?.environments === 'write' && auth.installation.permissions.administration === 'write', 'installation_permission_upgrade_required', 403);
  await withRepositoryOperation(env, installation, repository, async () => {
    const saved = await new Store(env.DB).session(repository, session.actorId, installation);
    requireCondition(!saved, 'disconnect_chatgpt_before_connecting_api_key', 409);
    await ensureProtectedEnvironment(auth.user, auth.metadata.full_name, credentialEnvironment(installation, session.actorId), undefined, true);
    const secrets = (await auth.user.rest.actions.listEnvironmentSecrets({ ...auth.repo, environment_name: credentialEnvironment(installation, session.actorId), per_page: 100 })).data.secrets;
    requireCondition(!secrets.some(secret => secret.name === 'CODEXBOT_VAULT_KEY'), 'disconnect_chatgpt_before_connecting_api_key', 409);
    await putEnvironmentSecret(auth.user, auth.metadata.full_name, credentialEnvironment(installation, session.actorId), 'CODEXBOT_API_KEY', key);
  });
}
