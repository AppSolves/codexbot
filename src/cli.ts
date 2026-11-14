import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { OAuth, validateSession } from './auth/oauth.js';
import type { Registration, OAuthSession } from './auth/oauth.js';
import { atomicPrivateFile, readPrivateFile, withFileLock } from './auth/files.js';
import { randomSecret, seal, sessionBinding } from './core/crypto.js';
import type { Envelope } from './core/crypto.js';
import { record, requireCondition, AppError } from './core/errors.js';
import { client, splitRepo } from './worker/github.js';
import { setupPullRequest, ensureProtectedEnvironment } from './setup.js';
import { backendUrl } from './runner/broker.js';
import { repositoryCapabilities } from './capabilities.js';
import { credentialEnvironment, publishingEnvironment } from './core/identity.js';
import { formatCliError, requireCliResponse } from './cli-errors.js';

let operation = 'parsing command-line arguments';

async function gh(args: string[], input?: string): Promise<string> {
  const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let length = 0;
  child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 100_000) child.kill(); else chunks.push(chunk); });
  child.stderr.resume(); child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 60_000);
  try { const [code] = await once(child, 'exit'); requireCondition(code === 0, 'github_cli_failed_check_auth_and_permissions'); return Buffer.concat(chunks).toString('utf8').trim(); }
  finally { clearTimeout(timer); }
}
interface Profile { host: string; runtimeHost: string; vaultKey: string; registration: Registration | null; session: OAuthSession | null; issuedClient?: string; pendingClient?: string }
async function login(oauth: OAuth, profile: Profile, persist: () => Promise<void>, newAccount: boolean): Promise<OAuthSession> {
  let callbackResolve: (value: URL) => void = () => { throw new AppError('callback_not_ready'); };
  let expectedState = '', consumed = false;
  const callback = new Promise<URL>(resolve => { callbackResolve = resolve; });
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string') { response.writeHead(400); response.end(); return; }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`);
    if (request.method !== 'GET' || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== expectedState || consumed) {
      response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end('Invalid or expired sign-in attempt.'); return;
    }
    consumed = true;
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    response.end('Return to CodexBot. Authentication is being validated.'); callbackResolve(url);
  });
  operation = 'starting the local OAuth callback listener';
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); requireCondition(address && typeof address !== 'string', 'callback_listener_failed');
  const registration = newAccount ? null : profile.registration;
  const selectedClient = newAccount ? profile.pendingClient : profile.issuedClient;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    operation = 'discovering OpenAI OAuth configuration';
    const attempt = await oauth.begin(profile.host, `http://127.0.0.1:${address.port}/auth/callback`, registration, undefined, selectedClient ?? null);
    expectedState = attempt.pending.state;
    process.stdout.write(`Continue with ChatGPT — open this URL in your browser:\n${attempt.url}\n`);
    operation = 'waiting for ChatGPT sign-in';
    const returned = await Promise.race([callback, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new AppError('oauth_attempt_expired')), 600_000); })]);
    const issued = returned.searchParams.get('client_id');
    if (!registration && issued && /^oaiapp_[A-Za-z0-9_-]+$/.test(issued)) {
      // Keep a provisional registration through invalid_grant; it is not an authenticated account.
      requireCondition(!selectedClient || selectedClient === issued, 'oauth_client_id_mismatch');
      if (newAccount) profile.pendingClient = issued; else profile.issuedClient = issued;
      operation = 'saving the issued OAuth client registration';
      await persist();
    }
    operation = 'validating the OAuth callback and exchanging its authorization code';
    return await oauth.complete(attempt.pending, returned);
  } finally { if (timeout) clearTimeout(timeout); server.closeAllConnections(); server.close(); }
}

async function main(): Promise<void> {
  const parsed = parseArgs({ allowPositionals: true, options: { repository: { type: 'string' }, backend: { type: 'string' }, source: { type: 'string' }, ref: { type: 'string' }, 'setup-as-user': { type: 'boolean', default: false }, 'new-account': { type: 'boolean', default: false } } });
  const command = parsed.positionals[0];
  requireCondition(['setup', 'connect', 'connect-api-key', 'disconnect'].includes(command ?? ''), 'usage_setup_connect_connect_api_key_or_disconnect_with_repository_and_backend');
  const repository = parsed.values.repository ?? ''; splitRepo(repository);
  const backend = backendUrl(parsed.values.backend ?? '');
  operation = 'reading GitHub CLI authentication';
  const token = await gh(['auth', 'token']);
  const github = client(token);
  operation = 'reading the authenticated GitHub user';
  const { data: user } = await github.rest.users.getAuthenticated();
  operation = 'reading repository metadata and administrator permissions';
  const { data: metadata } = await github.rest.repos.get(splitRepo(repository));
  requireCondition(metadata.permissions?.admin, 'repository_admin_required');
  if (command === 'setup') {
    operation = 'checking repository Environment capabilities';
    await repositoryCapabilities(github, repository);
    if (parsed.values['setup-as-user']) {
      operation = 'creating the setup pull request as the authenticated user';
      process.stdout.write(`${await setupPullRequest(github, repository, parsed.values.source ?? '', parsed.values.ref ?? '', backend, user.login)}\n`);
    } else {
      operation = 'requesting the setup pull request from the backend';
      const response = await fetch(`${backend}/v1/setup`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository, source: parsed.values.source, ref: parsed.values.ref }), redirect: 'error', signal: AbortSignal.timeout(90_000) });
      requireCliResponse(response, 'app_setup_failed_workflows_permission_required_or_use_setup_as_user');
      const result = record(await response.json()); process.stdout.write(`${String(result.pull_request)}\n`);
    }
    return;
  }
  operation = command === 'disconnect' ? 'loading the session preflight from the backend' : 'checking backend repository capabilities';
  const capabilityResponse = await fetch(`${backend}${command === 'disconnect' ? '/v1/session' : '/v1/capabilities'}?repository=${encodeURIComponent(repository)}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireCliResponse(capabilityResponse, 'capability_preflight_failed_check_plan_environment_permissions_or_GitHub_availability');
  const capability = record(await capabilityResponse.json());
  if (command === 'connect') requireCondition(capability.chatgpt_deployment_authorized === true, 'chatgpt_deployment_authorization_required_before_sign_in', 403);
  requireCondition(Number.isSafeInteger(capability.installation_id), 'invalid_live_installation');
  const environment = credentialEnvironment(Number(capability.installation_id), user.id);
  const binding = sessionBinding(backend, Number(capability.installation_id), metadata.id, user.id);
  // Existing restrictions are preserved; disconnect must remain possible without creating an Environment.
  if (command !== 'disconnect') for (const name of [environment, publishingEnvironment(Number(capability.installation_id))]) {
    operation = name === environment ? 'configuring the protected credential Environment' : 'configuring the protected publishing Environment';
    await ensureProtectedEnvironment(github, repository, name);
  }
  if (command === 'connect-api-key') {
    operation = 'storing the API key in the credential Environment';
    requireCondition(process.env.CODEXBOT_API_KEY && !/[\r\n]/.test(process.env.CODEXBOT_API_KEY), 'set_CODEXBOT_API_KEY_in_process_environment');
    await gh(['secret', 'set', 'CODEXBOT_API_KEY', '--repo', repository, '--env', environment], process.env.CODEXBOT_API_KEY);
    process.stdout.write(`API key saved in ${environment}. Set credentials.mode to api-key in .codexbot.yml. Remove any old CODEXBOT_VAULT_KEY secret before switching modes. Billing is separate from ChatGPT.\n`); return;
  }
  const stateDirectory = join(homedir(), '.config', 'codexbot');
  operation = 'creating the local credential profile directory';
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, `${new URL(backend).host.replace(/[^a-zA-Z0-9.-]/g, '_')}-${metadata.id}-${user.id}.session.json`);
  operation = 'locking and loading the local credential profile';
  await withFileLock(path, async () => {
    const saved = await readPrivateFile(path);
    const profile: Profile = saved ? saved as Profile : { host: `urn:uuid:${crypto.randomUUID()}`, runtimeHost: `urn:uuid:${crypto.randomUUID()}`, vaultKey: randomSecret(), registration: null, session: null };
    await atomicPrivateFile(path, profile);
    const endpoint = `${backend}/v1/session?repository=${encodeURIComponent(repository)}`;
    const oauth = new OAuth();
    if (command === 'disconnect') {
      operation = 'loading the latest session for revocation';
      // Revoke the latest rotated session, not a stale local copy.
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
      requireCliResponse(response, 'cannot_load_latest_session_for_revocation');
      const remote = record(await response.json()); let confirmed = true;
      if (remote.session) {
        const { unseal } = await import('./core/crypto.js');
        const value = record(remote.session);
        operation = 'decrypting and revoking the connected OAuth session';
        confirmed = await oauth.revoke(validateSession(await unseal(value.envelope as Envelope, profile.vaultKey, binding)));
      }
      operation = 'disconnecting the backend session';
      const removed = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }); requireCliResponse(removed, 'disconnect_failed');
      operation = 'clearing the local OAuth profile';
      if (profile.session) await oauth.revoke(profile.session);
      profile.session = null; profile.vaultKey = randomSecret(); await atomicPrivateFile(path, profile);
      operation = 'listing and removing credential Environment secrets';
      const names: unknown = JSON.parse(await gh(['secret', 'list', '--repo', repository, '--env', environment, '--json', 'name']));
      requireCondition(Array.isArray(names), 'cannot_list_credential_secrets_for_disconnect');
      for (const name of ['CODEXBOT_VAULT_KEY','CODEXBOT_API_KEY']) if (names.some(value => record(value).name === name)) await gh(['secret', 'delete', name, '--repo', repository, '--env', environment]);
      process.stdout.write(confirmed ? 'Disconnected; any connected renewable ChatGPT session was revoked. Revoke removed API keys in OpenAI settings as well.\n' : 'Disconnected locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.\n'); return;
    }
    if (parsed.values['new-account']) {
      operation = 'checking that the previous account is disconnected';
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      requireCliResponse(response, 'disconnect_current_account_before_switching');
      requireCondition(!record(await response.json()).session, 'disconnect_current_account_before_switching');
    }
    const session = await login(oauth, profile, () => atomicPrivateFile(path, profile), parsed.values['new-account']);
    operation = 'saving and encrypting the connected OAuth session';
    profile.issuedClient = session.client_id;
    profile.registration = { client_id: session.client_id, subject: session.subject, issuer: session.issuer, ...(session.email ? { email: session.email } : {}) };
    profile.session = session; await atomicPrivateFile(path, profile);
    const envelope = await seal({ ...session, ext_agent_host_id: profile.runtimeHost }, profile.vaultKey, binding);
    // The key goes only to GitHub; the Worker sees only an authenticated encrypted envelope.
    operation = 'storing the OAuth vault key in the credential Environment';
    await gh(['secret', 'set', 'CODEXBOT_VAULT_KEY', '--repo', repository, '--env', environment], profile.vaultKey);
    operation = 'provisioning the encrypted session in the backend';
    const response = await fetch(endpoint, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), redirect: 'error' });
    requireCliResponse(response, 'session_provisioning_failed_check_backend_deployment_authorization');
    // Rotation belongs exclusively to the remote runtime from now on. Retain only registration/key/host locally.
    operation = 'clearing local tokens after session provisioning';
    profile.session = null; delete profile.pendingClient; await atomicPrivateFile(path, profile);
    const label = [...(session.email ?? session.subject)].filter(x => x.charCodeAt(0) >= 32 && x.charCodeAt(0) !== 127).join('');
    process.stdout.write(`ChatGPT account ${label} (${session.client_id}) connected for ${user.login} in ${repository}. Account/workspace access to the selected model is verified by the first successful inference, not by the model catalog. Remove any old CODEXBOT_API_KEY secret before switching modes.\n`);
  });
}

try { await main(); }
catch (error) { process.stderr.write(`${formatCliError(error, operation)}\n`); process.exitCode = 1; }
