import type { Octokit } from '@octokit/rest';
import { splitRepo } from './worker/github.js';
import { requireCondition, AppError } from './core/errors.js';

/** Probe the feature with the administrator's credential; never fall back to repository secrets. */
export async function repositoryCapabilities(github: Octokit, repository: string): Promise<{ visibility: string; environmentSecrets: true }> {
  const repo = splitRepo(repository), { data } = await github.rest.repos.get(repo);
  requireCondition(data.permissions?.admin, 'repository_admin_required_for_capability_probe', 403);
  try { await github.rest.repos.getAllEnvironments({ ...repo, per_page: 1 }); }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 503;
    if (status === 429 || status >= 500) throw new AppError('environment_capability_temporarily_unavailable', 503);
    throw new AppError(data.private ? 'private_repository_environments_require_Pro_Team_Enterprise_and_admin_access' : 'environment_capability_probe_failed_check_admin_access', 403);
  }
  return { visibility: data.private ? 'private' : 'public', environmentSecrets: true };
}
