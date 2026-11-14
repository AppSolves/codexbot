import type { Octokit } from '@octokit/rest';
import { stringify } from 'yaml';
import { DEFAULT_CONFIG } from './core/config.js';
import { requireCondition } from './core/errors.js';
import { splitRepo } from './worker/github.js';
import { repositoryCapabilities } from './capabilities.js';

export async function ensureProtectedEnvironment(github: Octokit, repository: string, name: string): Promise<void> {
  const repo = splitRepo(repository); await repositoryCapabilities(github, repository);
  const { data: metadata } = await github.rest.repos.get(repo);
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: metadata.default_branch });
  requireCondition(branch.protected, 'protect_default_branch_before_storing_credentials', 403);
  try {
    const { data } = await github.rest.repos.getEnvironment({ ...repo, environment_name: name });
    requireCondition(data.deployment_branch_policy?.protected_branches || data.deployment_branch_policy?.custom_branch_policies, 'protect_existing_credential_environment_before_connecting');
    if (data.deployment_branch_policy?.custom_branch_policies) {
      const policies = await github.rest.repos.listDeploymentBranchPolicies({ ...repo, environment_name: name, per_page: 100 });
      requireCondition(policies.data.total_count === 1 && policies.data.branch_policies[0]?.name === metadata.default_branch && policies.data.branch_policies[0]?.type === 'branch', 'credential_environment_must_allow_only_trusted_default_branch');
    }
    return;
  } catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
  await github.rest.repos.createOrUpdateEnvironment({ ...repo, environment_name: name, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  await github.rest.repos.createDeploymentBranchPolicy({ ...repo, environment_name: name, name: metadata.default_branch, type: 'branch' });
}
export function callerWorkflow(source: string, ref: string, backend: string): string {
  splitRepo(source); requireCondition(/^[a-f0-9]{40}$/.test(ref), 'workflow_ref_must_be_full_commit_sha');
  return stringify({ name: 'CodexBot', 'run-name': 'CodexBot ${{ inputs.request_id }} ${{ inputs.dispatch_attempt }}', on: { workflow_dispatch: { inputs: {
    request_id: { description: 'Backend-bound request id', required: true, type: 'string' },
    credential_owner: { description: 'Authenticated requester numeric GitHub id', required: true, type: 'string' },
    installation_id: { description: 'Verified installation credential namespace', required: true, type: 'string' },
    dispatch_attempt: { description: 'Durable backend dispatch identity', required: true, type: 'string' },
    credential_check_only: { description: 'Check Environment availability without broker admission or inference', required: false, type: 'boolean', default: false }
  } } }, permissions: {}, concurrency: { group: 'codexbot-credentials', 'cancel-in-progress': false }, jobs: {
    review: { permissions: { contents: 'read', 'id-token': 'write' }, uses: `${source}/.github/workflows/review.yml@${ref}`,
      // Named empty grants enable Environment resolution without repository-secret fallback.
      secrets: { CODEXBOT_VAULT_KEY: '', CODEXBOT_API_KEY: '' },
      with: { request_id: '${{ inputs.request_id }}', credential_owner: '${{ inputs.credential_owner }}', installation_id: '${{ inputs.installation_id }}', credential_check_only: '${{ inputs.credential_check_only }}', backend } }
  } });
}
export async function setupPullRequest(github: Octokit, repository: string, source: string, ref: string, backend: string, login: string, principal: 'user' | 'installation' = 'user'): Promise<string> {
  const repo = splitRepo(repository), { data: metadata } = await github.rest.repos.get(repo);
  requireCondition(principal === 'installation' || metadata.permissions?.admin, 'repository_admin_required');
  requireCondition(Number.isSafeInteger(metadata.id) && metadata.id > 0, 'repository_identity_unavailable');
  const config = structuredClone(DEFAULT_CONFIG); config.authorization.whitelist = login;
  // New installations get a distinctive textual alias; existing configs retain their trigger.
  config.bot.trigger = `@CBReview${metadata.id}`;
  const desired = new Map([['.github/workflows/codexbot.yml', callerWorkflow(source, ref, backend)], ['.codexbot.yml', stringify(config)]]);
  await github.rest.repos.getContent({ ...splitRepo(source), path: '.github/workflows/review.yml', ref });
  for (const path of desired.keys()) {
    try { await github.rest.repos.getContent({ ...repo, path, ref: metadata.default_branch }); throw new Error('setup_would_overwrite_existing_file'); }
    catch (error) { requireCondition(error && typeof error === 'object' && 'status' in error && error.status === 404, 'setup_file_already_exists_or_unreadable'); }
  }
  let head: string;
  let existingHead: string | null = null;
  try {
    existingHead = (await github.rest.git.getRef({ ...repo, ref: 'heads/codexbot/setup' })).data.object.sha;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
  }
  if (existingHead) {
    head = existingHead;
    const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: head })).data;
    requireCondition(commit.parents.length === 1 && commit.parents[0]?.sha, 'existing_setup_branch_requires_manual_inspection');
    const compare = (await github.rest.repos.compareCommits({ ...repo, base: commit.parents[0].sha, head })).data;
    requireCondition(compare.total_commits === 1 && compare.files?.length === desired.size && compare.files.every(file => file.status === 'added' && desired.has(file.filename)), 'existing_setup_branch_has_unexpected_changes');
    for (const [path, content] of desired) {
      const { data } = await github.rest.repos.getContent({ ...repo, path, ref: head });
      requireCondition(!Array.isArray(data) && data.type === 'file' && 'content' in data && Buffer.from(data.content, 'base64').toString('utf8') === content, 'existing_setup_branch_content_differs');
    }
  } else {
    const base = (await github.rest.git.getRef({ ...repo, ref: `heads/${metadata.default_branch}` })).data.object.sha;
    const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: base })).data;
    const tree = (await github.rest.git.createTree({ ...repo, base_tree: commit.tree.sha,
      tree: [...desired].map(([path, content]) => ({ path, content, mode: '100644' as const, type: 'blob' as const })) })).data;
    const created = await github.rest.git.createCommit({ ...repo, message: 'Set up CodexBot reviews', tree: tree.sha, parents: [base] }); head = created.data.sha;
    // Both files become visible atomically. A lost response is reconciled by exact branch content above.
    await github.rest.git.createRef({ ...repo, ref: 'refs/heads/codexbot/setup', sha: head });
  }
  const existing = await github.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:codexbot/setup` });
  if (existing.data[0]) {
    requireCondition(existing.data[0].head.sha === head && existing.data[0].base.ref === metadata.default_branch, 'existing_setup_pr_changed');
    return existing.data[0].html_url;
  }
  const { data: pr } = await github.rest.pulls.create({ ...repo, base: metadata.default_branch, head: 'codexbot/setup', title: 'Set up CodexBot reviews',
    body: `Adds a commit-pinned workflow and default-deny policy in one commit. Text command: \`${config.bot.trigger} review\`. It is a repository-specific alias, not a guaranteed GitHub App mention. Review source and permissions, protect the default branch, configure per-user credential Environments, and perform advisory acceptance before enabling approval or merge. Setup requires temporary Workflows write; the credential is never retained.` });
  return pr.html_url;
}
