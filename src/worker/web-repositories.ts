import { stringify } from 'yaml';
import { appClient, client, installationClient, splitRepo } from './github.js';
import { requireCondition } from '../core/errors.js';
import { credentialEnvironment, publishingEnvironment } from '../core/identity.js';
import { callerWorkflow, callerWorkflowMatches, configurationPullRequest, ensureProtectedEnvironment, setupPullRequest } from '../setup.js';
import { repositoryCapabilities } from '../capabilities.js';
import { DEFAULT_CONFIG, parseConfig, type Config } from '../core/config.js';
import catalog from '../core/model-catalog.json' with { type: 'json' };
import type { BrowserSession, WebConfig } from './web-auth.js';
import { webLimit } from './web-auth.js';
import type { Octokit } from '@octokit/rest';
import { scanSecrets } from '../core/dlp.js';

interface AuthorizedRepository {
  user: Octokit; repo: ReturnType<typeof splitRepo>;
  metadata: Awaited<ReturnType<Octokit['rest']['repos']['get']>>['data'];
  installation: Awaited<ReturnType<Octokit['rest']['apps']['getRepoInstallation']>>['data'];
}
interface RepositoryState extends AuthorizedRepository {
  capabilities: Awaited<ReturnType<typeof repositoryCapabilities>>; state: string; config: Config | null; yaml: string | null; base: string; connection: string;
  pending: { number: number; url: string }[];
  recent: { id: string; pr: number; state: string; review_id: number | null; failure_code: string | null }[];
}

export function trustedSource(env: WebConfig): { source: string; ref: string } {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/.github\/workflows\/review.yml@([a-f0-9]{40})$/.exec(env.TRUSTED_WORKFLOW);
  requireCondition(match, 'trusted_workflow_not_configured', 503); return { source: match[1]!, ref: match[2]! };
}
export async function authorizedRepository(env: WebConfig, session: BrowserSession, installationId: number, repositoryId: number): Promise<AuthorizedRepository> {
  requireCondition(Number.isSafeInteger(installationId) && installationId > 0 && Number.isSafeInteger(repositoryId) && repositoryId > 0, 'invalid_repository_identity');
  const user = client(session.token), { data: resolved } = await user.request('GET /repositories/{repository_id}', { repository_id: repositoryId });
  const repo = splitRepo(resolved.full_name), { data: metadata } = await user.rest.repos.get(repo);
  requireCondition(metadata.id === repositoryId && metadata.permissions?.admin, 'repository_admin_required', 403);
  const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(repo);
  requireCondition(installation.id === installationId && !installation.suspended_at && installation.app_id === Number(env.GITHUB_APP_ID), 'installation_mismatch_or_suspended', 403);
  return { user, repo, metadata, installation };
}
export async function listRepositories(session: BrowserSession, installation: number | null, page: number) {
  const github = client(session.token);
  requireCondition(Number.isInteger(page) && page >= 1 && page <= 100, 'invalid_dashboard_page');
  if (installation !== null) {
    requireCondition(Number.isSafeInteger(installation) && installation > 0, 'invalid_installation');
    const { data } = await github.rest.apps.listInstallationReposForAuthenticatedUser({ installation_id: installation, per_page: 30, page });
    return { repositories: data.repositories, installations: [], hasMore: data.total_count > page * 30 };
  }
  const { data } = await github.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 30, page });
  return { repositories: [], installations: data.installations, hasMore: data.total_count > page * 30 };
}
async function content(github: ReturnType<typeof client>, repository: string, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await github.rest.repos.getContent({ ...splitRepo(repository), path, ref });
    requireCondition(!Array.isArray(data) && data.type === 'file' && 'content' in data && data.size <= 32_768, 'configuration_file_invalid');
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; }
}
export async function repositoryState(env: WebConfig, session: BrowserSession, installation: number, repository: number): Promise<RepositoryState> {
  const auth = await authorizedRepository(env, session, installation, repository), { metadata, user, repo } = auth;
  const capabilities = await repositoryCapabilities(user, metadata.full_name);
  const { data: branch } = await user.rest.repos.getBranch({ ...repo, branch: metadata.default_branch });
  const [yaml, workflow, saved, secrets, prs] = await Promise.all([
    content(user, metadata.full_name, '.codexbot.yml', branch.commit.sha), content(user, metadata.full_name, '.github/workflows/codexbot.yml', branch.commit.sha),
    env.DB.prepare('SELECT state FROM web_connections WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation, repository, session.actorId).first<{ state: string }>(),
    user.rest.actions.listEnvironmentSecrets({ ...repo, environment_name: credentialEnvironment(installation, session.actorId), per_page: 100 }).then(result => result.data.secrets.map(secret => secret.name)).catch((error: unknown): string[] => { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return []; throw error; }),
    user.rest.pulls.list({ ...repo, state: 'open', per_page: 100 })
  ]);
  const config = yaml === null ? null : parseConfig(yaml), { source, ref } = trustedSource(env);
  requireCondition(!yaml || scanSecrets(config).length === 0, 'configuration_contains_sensitive_text_requires_manual_repair');
  const workflowMatches = workflow !== null && callerWorkflowMatches(workflow, source, ref, env.PUBLIC_URL);
  const encrypted = await env.DB.prepare('SELECT 1 FROM sessions WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation, repository, session.actorId).first();
  const credentialPresent = config?.credentials.mode === 'api-key' ? secrets.includes('CODEXBOT_API_KEY') && !secrets.includes('CODEXBOT_VAULT_KEY') : !!encrypted && secrets.includes('CODEXBOT_VAULT_KEY') && !secrets.includes('CODEXBOT_API_KEY');
  let environmentsProtected = true;
  for (const environment_name of [credentialEnvironment(installation, session.actorId), publishingEnvironment(installation)]) {
    try {
      const { data: environment } = await user.rest.repos.getEnvironment({ ...repo, environment_name });
      const { data: policies } = await user.rest.repos.listDeploymentBranchPolicies({ ...repo, environment_name, per_page: 100 });
      environmentsProtected &&= environment.deployment_branch_policy?.custom_branch_policies === true && policies.total_count === 1 && policies.branch_policies[0]?.name === metadata.default_branch && policies.branch_policies[0]?.type === 'branch';
    } catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) environmentsProtected = false; else throw error; }
  }
  const state = !branch.protected ? 'Default branch protection required' : !config || !workflow ? 'Setup required'
    : !workflowMatches ? 'Configuration drift: workflow update required' : !environmentsProtected ? 'Protected Environment setup required'
      : saved?.state === 'pending' ? 'Credential provisioning pending' : saved?.state === 'reconnect_required' ? 'Provider authentication rejected: reconnect required' : saved?.state === 'refreshing' ? 'Connection refresh uncertain: reconnect required' : !credentialPresent ? 'Credential connection required' : !config.review.enabled ? 'Reviews disabled' : 'Ready for reviews';
  const recent = await env.DB.prepare("SELECT id,json_extract(snapshot,'$.pr') AS pr,state,review_id,failure_code FROM requests WHERE installation_id=? AND repository_id=? AND actor_id=? ORDER BY created_at DESC LIMIT 10")
    .bind(installation, repository, session.actorId).all<{ id: string; pr: number; state: string; review_id: number | null; failure_code: string | null }>();
  return { ...auth, capabilities, state, config, yaml, base: branch.commit.sha, connection: saved?.state ?? (credentialPresent ? 'Existing connection' : 'Not connected'),
    pending: prs.data.filter(pr => pr.head.ref.startsWith('codexbot/') && pr.user?.login === `${env.GITHUB_APP_SLUG}[bot]`).map(pr => ({ number: pr.number, url: pr.html_url })), recent: recent.results };
}
export async function withRepositoryOperation<T>(env: WebConfig, installation: number, repository: number, operation: (check: () => Promise<void>, lease: string) => Promise<T>): Promise<T> {
  const lease = crypto.randomUUID(), now = Date.now();
  const claimed = await env.DB.prepare(`INSERT INTO web_operations(installation_id,repository_id,lease,lease_until) VALUES(?,?,?,?)
    ON CONFLICT(installation_id,repository_id) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until WHERE web_operations.lease_until<? RETURNING lease`)
    .bind(installation, repository, lease, now + 300_000, now).first();
  requireCondition(claimed, 'repository_operation_in_progress', 409);
  const check = async () => {
    const renewed = await env.DB.prepare('UPDATE web_operations SET lease_until=? WHERE installation_id=? AND repository_id=? AND lease=? AND lease_until>?')
      .bind(Date.now() + 300_000, installation, repository, lease, Date.now()).run();
    requireCondition(renewed.meta.changes === 1, 'repository_operation_lease_lost', 409);
  };
  try { return await operation(check, lease); }
  finally { await env.DB.prepare('DELETE FROM web_operations WHERE installation_id=? AND repository_id=? AND lease=?').bind(installation, repository, lease).run(); }
}
export async function setupRepository(env: WebConfig, session: BrowserSession, installationId: number, repositoryId: number, expectedBase?: string, yaml?: string): Promise<string> {
  const { user, metadata, installation } = await authorizedRepository(env, session, installationId, repositoryId);
  requireCondition(installation.permissions?.workflows === 'write' && installation.permissions.administration === 'write' && installation.permissions.environments === 'write', 'installation_permission_upgrade_required', 403);
  await repositoryCapabilities(user, metadata.full_name);
  await webLimit(env, `setup:${session.actorId}:${repositoryId}`, 5);
  return withRepositoryOperation(env, installationId, repositoryId, async check => {
    const { github } = await installationClient(env, installationId, repositoryId, { contents: 'write', pull_requests: 'write', workflows: 'write' });
    // Check Environment access with the user's intersection-scoped token; mutations use setup-only App grants.
    await ensureProtectedEnvironment(user, metadata.full_name, credentialEnvironment(installationId, session.actorId), check, true);
    await ensureProtectedEnvironment(user, metadata.full_name, publishingEnvironment(installationId), check, true);
    const { source, ref } = trustedSource(env);
    if (yaml !== undefined && expectedBase) {
      const current = await content(user, metadata.full_name, '.github/workflows/codexbot.yml', expectedBase);
      const workflow = current && callerWorkflowMatches(current,source,ref,env.PUBLIC_URL) ? undefined : callerWorkflow(source,ref,env.PUBLIC_URL);
      return configurationPullRequest(github, metadata.full_name, expectedBase, yaml, workflow, check);
    }
    return setupPullRequest(github, metadata.full_name, source, ref, env.PUBLIC_URL, session.login, 'installation', check);
  });
}
export function configurationFromForm(form: URLSearchParams): Config {
  const result = structuredClone(DEFAULT_CONFIG);
  const walk = (object: Record<string, unknown>, prefix = '') => {
    for (const [key, value] of Object.entries(object)) {
      const name = prefix + key;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value as Record<string, unknown>, name + '.');
      else {
        requireCondition(form.getAll(name).length <= 1, 'duplicate_configuration_field');
        const raw = form.get(name);
        if (typeof value === 'boolean') { requireCondition(raw === null || raw === 'true', 'invalid_boolean_configuration'); object[key] = raw === 'true'; }
        else { requireCondition(raw !== null && (typeof value !== 'number' || raw.trim().length > 0), 'missing_configuration_field'); object[key] = prefix === 'quotas.' && key.endsWith('_per_day') && raw === 'unlimited' ? 'unlimited' : typeof value === 'number' ? Number(raw) : Array.isArray(value) ? raw.split(',').map(part => part.trim()).filter(Boolean) : raw === '' && value === null ? null : raw; }
      }
    }
  };
  walk(result as unknown as Record<string, unknown>);
  const config = parseConfig(stringify(result)), selected = config.review.model ? catalog.models.find(model => model.model === config.review.model) : catalog.models.find(model => model.isDefault);
  requireCondition(selected, 'configured_model_not_in_codex_catalog');
  requireCondition(config.review.effort === null || selected.efforts.includes(config.review.effort), 'effort_not_supported_by_selected_model');
  return config;
}
