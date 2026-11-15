import { stringify } from 'yaml';
import { AppError, requireCondition } from '../core/errors.js';
import { boundedBody } from './index.js';
import { browserSession, githubLogin, githubCallback, logout, redirect, verifyCsrf, webKey, webLimit, type WebConfig } from './web-auth.js';
import { listRepositories, repositoryState, setupRepository, configurationFromForm, authorizedRepository } from './web-repositories.js';
import { beginChatGPT, chatGPTCallback, websiteOAuth, retryProvision, disconnectConnection, connectApiKey, connectionSummary } from './web-connections.js';
import { APP_CSS, APP_JS, page, html, csrf, configurationFields } from './onboarding.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const ERROR_MESSAGES: Record<string,string> = {
  web_onboarding_not_configured: 'Browser onboarding is not activated on this deployment. Ask the operator to complete its secure web configuration.',
  github_web_oauth_not_configured: 'The operator needs to register the GitHub callback and provision the App’s website client credentials.',
  web_sign_in_required: 'Sign in with GitHub to continue.', web_session_expired: 'Your session expired. Sign in again to continue.', github_authorization_expired: 'GitHub authorization is no longer valid. Sign in again.',
  repository_admin_required: 'Repository administrator access is required. Ask an administrator to set up this repository.',
  installation_mismatch_or_suspended: 'This installation cannot access the selected repository. Check repository selection and suspension in GitHub App settings.',
  installation_permission_upgrade_required: 'The installation needs Workflows, Administration and Environments write permission for browser setup. An installation administrator must accept the App’s official permission update in GitHub.',
  configuration_changed_reload_before_saving: 'The default branch changed while you edited. Reload the repository settings and review your changes again.',
  configured_model_not_in_codex_catalog: 'Choose a model from the pinned Codex catalog. Account entitlement will still be checked during inference.',
  effort_not_supported_by_selected_model: 'This model does not support the selected reasoning effort. Choose a supported effort or use the model default.',
  invalid_configuration: 'The proposed policy is invalid. Check handles, confidence thresholds, quotas and authorization patterns before trying again.',
  invalid_yaml: 'The repository configuration contains invalid YAML. Repair it through a reviewed GitHub pull request, then reload the settings.',
  configuration_must_not_contain_secrets: 'The proposed configuration appears to contain sensitive credentials. Remove them and revoke any exposed credential; credentials belong in protected connections.',
  configuration_contains_sensitive_text_requires_manual_repair: 'The existing policy appears to contain sensitive text and has not been displayed. Review it privately in GitHub and revoke any exposed credential before repairing it.',
  session_busy: 'Your credentials are in use by a review or connection operation. Wait for it to finish before reconnecting or disconnecting.',
  repository_operation_in_progress: 'Another setup or connection operation is in progress. Return to the repository and refresh its verified state.',
  web_rate_limit: 'Too many requests. Wait up to ten minutes before trying again.',
  existing_cli_connection_requires_explicit_disconnect_before_web_migration: 'An existing CLI connection was preserved. Disconnect it explicitly before moving this repository connection to browser-managed credentials.',
  disconnect_api_key_before_connecting_chatgpt: 'Disconnect the repository’s API-key connection before connecting ChatGPT.',
  disconnect_chatgpt_before_connecting_api_key: 'Disconnect the repository’s ChatGPT connection before saving an API key.',
  private_repository_environments_require_Pro_Team_Enterprise_and_admin_access: 'Private repositories need GitHub Pro, Team or Enterprise Environment support and administrator access. Protected credentials cannot be replaced with repository secrets.',
  protect_default_branch_before_storing_credentials: 'Protect the default branch in GitHub before storing credentials.',
  github_operation_unavailable: 'GitHub could not complete the operation. Return to the repository to check for an existing setup PR or pending connection before retrying.',
  configuration_unchanged: 'The proposed configuration and workflow already match the default branch.',
  no_pending_credential_provisioning: 'There is no pending connection to resume. Start a new connection if needed.'
};

function responseWithStatus(response: Response, status: number): Response { return new Response(response.body, { status, headers: response.headers }); }
export async function webRoute(request: Request, env: WebConfig): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/assets/app.css') return new Response(APP_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
  if (request.method === 'GET' && path === '/assets/app.js') return new Response(APP_JS, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
  if (!path.startsWith('/auth/') && !path.startsWith('/dashboard')) return null;
  if (env.WEB_ENABLED!=='true' && request.method==='GET' && path==='/dashboard') return redirect('/');
  try {
    webKey(env);
    if (request.method === 'GET' && path === '/auth/error') return page('Connection needs attention', '<section class="page-title"><h1>Connection needs attention.</h1><p role="alert">Sign-in or credential provisioning could not finish. No approval or inference was authorized. Return to the repository to resume pending provisioning, or start sign-in again.</p><a class="button primary" href="/dashboard">Return to dashboard</a></section>');
    if (request.method === 'GET' && path === '/auth/github') return await githubLogin(request, env);
    if (request.method === 'GET' && path === '/auth/github/callback') return await githubCallback(request, env);
    if (request.method === 'GET' && path === '/auth/openai/callback') return await chatGPTCallback(request, env);
    const session = await browserSession(request, env);
    if (request.method === 'GET') await webLimit(env, `dashboard:${session.actorId}`, 60);
    if (request.method === 'POST') {
      requireCondition(request.headers.get('content-type')?.split(';')[0] === 'application/x-www-form-urlencoded', 'web_form_required', 415);
      const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(request, 40_000)));
      requireCondition(form.getAll('csrf').length === 1, 'web_csrf_rejected', 403); verifyCsrf(request, session, form.get('csrf'), env.PUBLIC_URL);
      await webLimit(env, `mutation:${session.actorId}`, 30);
      if (path === '/auth/logout') return await logout(request, env);
      for (const key of ['installation','repository','base','replace','api_key']) requireCondition(form.getAll(key).length <= 1, 'duplicate_form_field');
      const installation = Number(form.get('installation')), repository = Number(form.get('repository'));
      const destination = `/dashboard/repository?installation=${installation}&repository=${repository}`;
      if (path === '/dashboard/setup' || path === '/dashboard/configure') {
        const pr = await setupRepository(env, session, installation, repository, path.endsWith('configure') ? form.get('base') ?? '' : undefined,
          path.endsWith('configure') ? stringify(configurationFromForm(form)) : undefined);
        return page('Pull request prepared', `<section class="page-title"><p class="eyebrow">READY FOR YOUR REVIEW</p><h1>Changes proposed.</h1><p>Nothing has been committed to your default branch. Review the diff and merge through GitHub when you are ready.</p><p><a class="button primary" href="${html(pr)}">Open setup / configuration PR ↗</a></p><a href="${destination}">Return to repository</a></section>`, session);
      }
      if (path === '/dashboard/connect') return await beginChatGPT(request, env, session, installation, repository, form.get('replace') === 'true');
      if (path === '/dashboard/retry-connection') await retryProvision(env, session, installation, repository);
      else if (path === '/dashboard/disconnect') {
        const confirmed = await disconnectConnection(env, session, installation, repository);
        return page('Connection removed', `<section class="page-title"><h1>Connection removed.</h1><p>${confirmed ? 'Remote session revocation was confirmed, or no renewable session was stored.' : 'Remote revocation was not confirmed. Disconnect CodexBot in ChatGPT Settings as well.'}</p><p>The repository workflow and review policy were preserved. Disable reviews through a configuration PR or remove repository access in GitHub installation settings.</p><a href="${destination}">Return to repository</a></section>`, session);
      } else if (path === '/dashboard/api-key') await connectApiKey(env, session, installation, repository, form.get('api_key') ?? '');
      else throw new AppError('not_found', 404);
      return redirect(destination);
    }
    requireCondition(request.method === 'GET', 'method_not_allowed', 405);
    if (path === '/dashboard/account') {
      const rows = await env.DB.prepare('SELECT installation_id,repository_id,state FROM web_connections WHERE actor_id=? ORDER BY updated_at DESC LIMIT 5').bind(session.actorId).all<{ installation_id:number; repository_id:number; state:string }>();
      const connections = await Promise.all(rows.results.map(async row => {
        try { const live = await authorizedRepository(env, session, row.installation_id, row.repository_id); return `<li><a href="/dashboard/repository?installation=${row.installation_id}&repository=${row.repository_id}">${html(live.metadata.full_name)}</a><small>${html(row.state)}</small></li>`; }
        catch { return ''; }
      }));
      return page('Account', `<section class="page-title"><p class="eyebrow">ACCOUNT & CONNECTIONS</p><h1>${html(session.login)}</h1><p>Signed in with GitHub. Credential connections belong to your numeric GitHub identity and one selected repository and installation.</p><p>Manage ChatGPT and API-key connections on each repository page. A connection verifies its grant; model entitlement is confirmed only by successful inference.</p><h2>Recent browser connections</h2><ul class="repository-list">${connections.join()}</ul><p>Existing CLI and API-key connections are also shown on their repository pages.</p><a href="/dashboard">Manage repositories</a><form action="/auth/logout" method="post">${csrf(session)}<button type="submit">Sign out</button></form></section>`, session);
    }
    if (path === '/dashboard') {
      if (url.searchParams.has('installation_id')) {
        const selected = Number(url.searchParams.get('installation_id'));
        await listRepositories(session, selected, 1); // GitHub's return parameter is only a hint until user-scoped reconciliation.
        return redirect(`/dashboard?installation=${selected}`);
      }
      const installation = url.searchParams.has('installation') ? Number(url.searchParams.get('installation')) : null, currentPage = Number(url.searchParams.get('page') ?? 1);
      const listing = await listRepositories(session, installation, currentPage);
      return page('Repositories', `<section class="page-title"><p class="eyebrow">WORKSPACE / ${html(session.login)}</p><h1>${installation ? 'Your repositories.' : 'Your installations.'}</h1><p>Choose an installation, then a repository you administer. Access is checked live with GitHub.</p></section><div class="layout"><aside><ol class="steps"><li>1. Connect GitHub ✓</li><li>2. Select repository</li><li>3. Review setup PR</li><li>4. Connect credentials</li></ol><a href="https://github.com/apps/${html(env.GITHUB_APP_SLUG)}/installations/new">Install on another account ↗</a><p><a href="/dashboard">All installations</a></p></aside><section><ul class="repository-list">${listing.installations.map(item => `<li><a href="/dashboard?installation=${item.id}">${html(item.account && 'login' in item.account ? item.account.login : item.account?.name ?? item.id)}</a><small>${item.suspended_at ? 'Suspended — resume in GitHub settings' : 'Installation available'}</small><a href="https://github.com/settings/installations/${item.id}">Manage repository selection ↗</a></li>`).join('')}${listing.repositories.map(repo => `<li><a href="/dashboard/repository?installation=${installation}&repository=${repo.id}">${html(repo.full_name)}</a><small>${repo.private ? 'Private' : 'Public'} · ${repo.permissions?.admin ? 'Administrator' : 'Administrator access required'}</small></li>`).join('')}</ul>${!listing.installations.length && !listing.repositories.length ? '<div class="notice">No repositories or installations on this page. Install the App or select repositories in GitHub settings, then refresh. Organization SSO may require a fresh GitHub sign-in.</div>' : ''}${listing.hasMore ? `<a href="/dashboard?${installation ? `installation=${installation}&` : ''}page=${currentPage + 1}">Next page →</a>` : ''}</section></div>`, session);
    }
    if (path === '/dashboard/repository') {
      const installation = Number(url.searchParams.get('installation')), repository = Number(url.searchParams.get('repository'));
      const state = await repositoryState(env, session, installation, repository), ids = `<input type="hidden" name="installation" value="${installation}"><input type="hidden" name="repository" value="${repository}">`, hidden = csrf(session) + ids;
      const connected = await connectionSummary(env, installation, repository, session.actorId);
      let chatGPTConfigured = false; try { websiteOAuth(env); chatGPTConfigured = true; } catch { /* Explicit operator prerequisite; never render an operational connect action. */ }
      const configuration = state.config ?? { ...structuredClone(DEFAULT_CONFIG), authorization: { whitelist: session.login, blacklist: '*' }, bot: { trigger: `@CBReview${repository}`, aliases: [] } };
      return page(state.metadata.full_name, `<section class="page-title"><p class="eyebrow"><a href="/dashboard?installation=${installation}">REPOSITORIES</a> / SETTINGS</p><h1>${html(state.metadata.full_name)}</h1><p class="status" role="status">${html(connected?.expired ? 'Connection expired: reconnect or renew before inference' : state.state)}</p></section><div class="layout"><aside><ol class="steps"><li>GitHub installation ${installation}</li><li>${html(state.capabilities.visibility)} repository</li><li>Connection: ${html(state.connection)}</li>${connected ? `<li>Account: ${html(connected.account)}</li><li>Workspace: ${html(connected.workspace)}</li>` : ''}<li>Model access: verified during inference</li></ol><a href="https://github.com/settings/installations/${installation}">Manage access or remove repository ↗</a></aside><section><h2>Set up once. Review on your terms.</h2><p>Setup and policy changes open a pull request. Merge it in GitHub, then refresh this page to verify the active state.</p>${state.pending.map(pr => `<p class="notice">Pending changes: <a href="${html(pr.url)}">PR #${pr.number} ↗</a></p>`).join('')}${!state.config ? `<form action="/dashboard/setup" method="post">${hidden}<button type="submit">Create setup PR</button></form>` : ''}<p>When ready, comment <code>${html(configuration.bot.trigger)} review</code> on an open pull request. Add <code>--model MODEL_ID</code> or <code>--effort high</code> for a per-review override.</p><h3>Inference connection</h3><p>ChatGPT uses your authorized plan allowance. API keys use separate paid API billing. There is no automatic fallback.</p><div class="connection-actions">${chatGPTConfigured ? `<form action="/dashboard/connect" method="post">${hidden}<button type="submit" data-oai-siwc-button>Continue with ChatGPT</button><label><input type="checkbox" name="replace" value="true">Explicitly switch to a different ChatGPT account</label></form>` : '<p class="notice">Hosted ChatGPT connection awaits the operator’s registered website client and approved inference scopes. Existing CLI connections continue working.</p>'}<form action="/dashboard/retry-connection" method="post">${hidden}<button type="submit">Resume pending connection</button></form></div><details><summary>Connect your own API key</summary><p>Use only your own key. Select API-key mode in the policy PR after connecting. Disconnect any ChatGPT connection first.</p><form action="/dashboard/api-key" method="post">${hidden}<label for="api-key">OpenAI API key<input id="api-key" type="password" name="api_key" autocomplete="off" required maxlength="503"></label><button type="submit">Save in protected Environment</button></form></details><details><summary>Disconnect credentials</summary><p>Stops your repository connection and removes its two CodexBot Environment secrets. Existing workflow files and other users are unaffected.</p><form action="/dashboard/disconnect" method="post">${hidden}<button type="submit">Disconnect this repository connection</button></form></details><details><summary>Review policy & configuration</summary><p>Blank model and effort use Codex defaults. Explicit selections must match the pinned Codex catalog at execution; catalog membership does not prove account entitlement. Aliases are text commands and may notify an unrelated GitHub user. All fields use the canonical repository schema.</p><form action="/dashboard/configure" method="post">${hidden}<input type="hidden" name="base" value="${html(state.base)}">${configurationFields(configuration)}<button type="submit">Propose configuration / workflow update</button></form><details><summary>Active configuration</summary><pre>${html(state.yaml ?? 'Not configured')}</pre></details></details><h3>Recent requests</h3><table class="activity"><thead><tr><th>Request</th><th>PR</th><th>Status</th></tr></thead><tbody>${state.recent.map(item => `<tr><td><code>${html(item.id.slice(0, 8))}</code></td><td><a href="https://github.com/${html(state.metadata.full_name)}/pull/${item.pr}${item.review_id ? `#pullrequestreview-${item.review_id}` : ''}">#${item.pr}</a></td><td>${html(item.failure_code ? 'Analysis failed' : item.state)}</td></tr>`).join('')}</tbody></table></section></div>`, session);
    }
    throw new AppError('not_found', 404);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'github_operation_unavailable', status = error instanceof AppError ? error.status : 502;
    // No exception objects, upstream bodies, request URLs or submitted fields are logged/rendered.
    console.warn(JSON.stringify({ event: 'web_operation_failed', code, status }));
    // Clear callback codes/state from the address bar on failures as well as success.
    if (path.endsWith('/callback')) return redirect('/auth/error');
    return responseWithStatus(page('Action required', `<section class="page-title"><p class="eyebrow">ACTION REQUIRED</p><h1>Let’s resolve this.</h1><p role="alert">${html(ERROR_MESSAGES[code] ?? 'This action could not be completed safely. Return to the repository and check its verified setup state before trying again.')}</p><details><summary>Technical reference</summary><code>${html(code)}</code></details><div class="actions"><a class="button primary" href="/auth/github">Sign in again</a><a class="button" href="/dashboard">Return to dashboard</a></div></section>`), status);
  }
}
