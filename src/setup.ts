import type { Octokit } from '@octokit/rest';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { repositoryCapabilities } from './capabilities.js';
import { DEFAULT_CONFIG, parseConfig } from './core/config.js';
import { sha256 } from './core/crypto.js';
import { scanSecrets } from './core/dlp.js';
import { record, requireCondition } from './core/errors.js';
import { DEFAULT_BACKEND } from './core/identity.js';
import { splitRepo } from './worker/github.js';

export async function ensureProtectedEnvironment(github: Octokit, repository: string, name: string, beforeWrite?: () => Promise<void>, defaultBranchOnly = false): Promise<void> {
  const repo = splitRepo(repository); await repositoryCapabilities(github, repository);
  const { data: metadata } = await github.rest.repos.get(repo);
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: metadata.default_branch });
  requireCondition(branch.protected, 'protect_default_branch_before_storing_credentials', 403);
  try {
    const { data } = await github.rest.repos.getEnvironment({ ...repo, environment_name: name });
    if (defaultBranchOnly) requireCondition(data.deployment_branch_policy?.custom_branch_policies === true, 'credential_environment_must_allow_only_trusted_default_branch');
    requireCondition(data.deployment_branch_policy?.protected_branches || data.deployment_branch_policy?.custom_branch_policies, 'protect_existing_credential_environment_before_connecting');
    if (data.deployment_branch_policy?.custom_branch_policies) {
      const policies = await github.rest.repos.listDeploymentBranchPolicies({ ...repo, environment_name: name, per_page: 100 });
      requireCondition(policies.data.total_count === 1 && policies.data.branch_policies[0]?.name === metadata.default_branch && policies.data.branch_policies[0]?.type === 'branch', 'credential_environment_must_allow_only_trusted_default_branch');
    }
    return;
  } catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
  await beforeWrite?.();
  await github.rest.repos.createOrUpdateEnvironment({ ...repo, environment_name: name, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  await beforeWrite?.();
  await github.rest.repos.createDeploymentBranchPolicy({ ...repo, environment_name: name, name: metadata.default_branch, type: 'branch' });
}
export function callerWorkflow(source: string, ref: string, backend = DEFAULT_BACKEND): string {
  splitRepo(source); requireCondition(/^[a-f0-9]{40}$/.test(ref), 'workflow_ref_must_be_full_commit_sha');
  return stringify({
    name: 'CodexBot', 'run-name': 'CodexBot ${{ inputs.request_id }} ${{ inputs.dispatch_attempt }}', on: {
      workflow_dispatch: {
        inputs: {
          request_id: { description: 'Backend-bound request id', required: true, type: 'string' },
          credential_owner: { description: 'Authenticated requester numeric GitHub id', required: true, type: 'string' },
          installation_id: { description: 'Verified installation credential namespace', required: true, type: 'string' },
          dispatch_attempt: { description: 'Durable backend dispatch identity', required: true, type: 'string' },
          credential_check_only: { description: 'Check Environment availability without broker admission or inference', required: false, type: 'boolean', default: false }
        }
      }
    }, permissions: {}, concurrency: { group: 'codexbot-credentials', 'cancel-in-progress': false }, jobs: {
      'credential-scope': {
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 1, permissions: {}, steps: [{
          name: 'Reject credentials outside protected Environments', shell: 'bash',
          // No Environment here: this checks the same queued repository/org snapshot
          // used by the named references below, without passing credential values.
          env: { CODEXBOT_SHARED_CREDENTIAL_PRESENT: "${{ secrets.CODEXBOT_VAULT_KEY != '' || secrets.CODEXBOT_API_KEY != '' }}" },
          run: `node --input-type=module <<'JS'
if (process.env.CODEXBOT_SHARED_CREDENTIAL_PRESENT !== 'false') {
  console.error(JSON.stringify({event: 'review_failed', stage: 'environment', code: 'non_environment_credentials_forbidden'}));
  process.exitCode = 1;
}
JS
`
        }]
      },
      review: {
        needs: ['credential-scope'], permissions: { contents: 'read', 'id-token': 'write' }, uses: `${source}/.github/workflows/review.yml@${ref}`,
        secrets: { CODEXBOT_VAULT_KEY: '${{ secrets.CODEXBOT_VAULT_KEY }}', CODEXBOT_API_KEY: '${{ secrets.CODEXBOT_API_KEY }}' },
        with: { request_id: '${{ inputs.request_id }}', credential_owner: '${{ inputs.credential_owner }}', installation_id: '${{ inputs.installation_id }}', credential_check_only: '${{ inputs.credential_check_only }}', backend }
      }
    }
  });
}
export function callerWorkflowMatches(current: string, source: string, ref: string, backend: string): boolean {
  try {
    const document = parseDocument(current, { uniqueKeys: true }); if (document.errors.length) return false;
    const actual = record(document.toJS({ maxAliasCount: 0 }) as unknown), expected = record(parseDocument(callerWorkflow(source, ref, backend)).toJS() as unknown);
    const inputs = record(record(record(actual.jobs).review).with);
    if (typeof inputs.docker_cache === 'boolean') record(record(record(expected.jobs).review).with).docker_cache = inputs.docker_cache;
    return isDeepStrictEqual(actual, expected);
  } catch { return false; }
}
export async function setupPullRequest(github: Octokit, repository: string, source: string, ref: string, backend: string, login: string, principal: 'user' | 'installation' = 'user', beforeWrite?: () => Promise<void>): Promise<string> {
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
    await beforeWrite?.();
    const tree = (await github.rest.git.createTree({
      ...repo, base_tree: commit.tree.sha,
      tree: [...desired].map(([path, content]) => ({ path, content, mode: '100644' as const, type: 'blob' as const }))
    })).data;
    await beforeWrite?.();
    const created = await github.rest.git.createCommit({ ...repo, message: 'Set up CodexBot reviews', tree: tree.sha, parents: [base] }); head = created.data.sha;
    // Both files become visible atomically. A lost response is reconciled by exact branch content above.
    await beforeWrite?.(); await github.rest.git.createRef({ ...repo, ref: 'refs/heads/codexbot/setup', sha: head });
  }
  const existing = await github.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:codexbot/setup` });
  if (existing.data[0]) {
    requireCondition(existing.data[0].head.sha === head && existing.data[0].base.ref === metadata.default_branch, 'existing_setup_pr_changed');
    return existing.data[0].html_url;
  }
  await beforeWrite?.();
  const { data: pr } = await github.rest.pulls.create({
    ...repo, base: metadata.default_branch, head: 'codexbot/setup', title: 'Set up CodexBot reviews',
    body: `Adds a commit-pinned workflow and default-deny policy in one commit. Text command: \`${config.bot.trigger} review\`. It is a repository-specific alias, not a guaranteed GitHub App mention. Review source and permissions, protect the default branch, configure per-user credential Environments, and perform advisory acceptance before enabling approval or merge. Setup requires temporary Workflows write; the credential is never retained.`
  });
  return pr.html_url;
}

/** Configuration remains on GitHub; an exact base commit prevents overwriting concurrent edits. */
export async function configurationPullRequest(github: Octokit, repository: string, expectedBase: string, yaml: string, workflow?: string, beforeWrite?: () => Promise<void>): Promise<string> {
  const config = parseConfig(yaml), repo = splitRepo(repository), { data: metadata } = await github.rest.repos.get(repo);
  requireCondition(scanSecrets(config).length === 0, 'configuration_must_not_contain_secrets');
  requireCondition(/^[a-f0-9]{40}$/.test(expectedBase), 'invalid_configuration_base');
  const base = (await github.rest.git.getRef({ ...repo, ref: `heads/${metadata.default_branch}` })).data.object.sha;
  requireCondition(base === expectedBase, 'configuration_changed_reload_before_saving', 409);
  const desired = new Map([['.codexbot.yml', stringify(config)], ...(workflow ? [['.github/workflows/codexbot.yml', workflow] as [string, string]] : [])]);
  for (const [path, content] of desired) {
    try {
      const { data } = await github.rest.repos.getContent({ ...repo, path, ref: base });
      requireCondition(!Array.isArray(data) && data.type === 'file' && 'content' in data && data.size <= 32_768, 'configuration_file_invalid');
      const previous = Buffer.from(data.content, 'base64').toString('utf8');
      if (path === '.codexbot.yml') {
        const active = parseConfig(previous), document = parseDocument(previous);
        const update = (next: Record<string, unknown>, before: Record<string, unknown>, prefix: string[] = []) => {
          for (const [key, value] of Object.entries(next)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) update(value as Record<string, unknown>, before[key] as Record<string, unknown>, [...prefix, key]);
            else if (!isDeepStrictEqual(value, before[key])) document.setIn([...prefix, key], value);
          }
        };
        if (isDeepStrictEqual(active, config)) desired.delete(path);
        else { update(config as unknown as Record<string, unknown>, active as unknown as Record<string, unknown>); desired.set(path, document.toString()); }
      } else if (previous === content) desired.delete(path);
    } catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
  }
  requireCondition(desired.size, 'configuration_unchanged', 409);
  const branch = `codexbot/config-${(await sha256(JSON.stringify([base, [...desired]]))).slice(0, 20)}`;
  let head: string | undefined;
  try { head = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha; }
  catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
  if (!head) {
    const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: base })).data;
    await beforeWrite?.();
    const tree = (await github.rest.git.createTree({ ...repo, base_tree: commit.tree.sha, tree: [...desired].map(([path, content]) => ({ path, content, mode: '100644' as const, type: 'blob' as const })) })).data;
    await beforeWrite?.(); head = (await github.rest.git.createCommit({ ...repo, message: 'Update CodexBot configuration', tree: tree.sha, parents: [base] })).data.sha;
    await beforeWrite?.(); await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: head });
  } else {
    const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: head })).data;
    requireCondition(commit.parents.length === 1 && commit.parents[0]?.sha === base, 'configuration_branch_changed', 409);
    const compare = (await github.rest.repos.compareCommits({ ...repo, base, head })).data;
    requireCondition(compare.total_commits === 1 && compare.files?.length === desired.size && compare.files.every(file => desired.has(file.filename) && ['added', 'modified'].includes(file.status)), 'configuration_branch_changed', 409);
    for (const [path, content] of desired) {
      const { data } = await github.rest.repos.getContent({ ...repo, path, ref: head });
      requireCondition(!Array.isArray(data) && data.type === 'file' && 'content' in data && Buffer.from(data.content, 'base64').toString('utf8') === content, 'configuration_branch_changed', 409);
    }
  }
  const existing = (await github.rest.pulls.list({ ...repo, state: 'all', head: `${repo.owner}:${branch}`, per_page: 10 })).data;
  if (existing.length) {
    requireCondition(existing.length === 1 && existing[0]?.state === 'open' && existing[0].head.sha === head && existing[0].base.ref === metadata.default_branch, 'configuration_pr_requires_manual_attention', 409);
    return existing[0].html_url;
  }
  await beforeWrite?.();
  return (await github.rest.pulls.create({ ...repo, base: metadata.default_branch, head: branch, title: 'Update CodexBot configuration', body: 'Review the policy changes before merging. Configuration takes effect only from the trusted default branch; no credentials are included.' })).data.html_url;
}
