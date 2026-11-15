import type { Octokit } from '@octokit/rest';
import { parseCommand } from '../core/command.js';
import { authorize } from '../core/policy.js';
import { record, requireCondition } from '../core/errors.js';
import { appClient, installationClient, permission, splitRepo, trustedConfig } from './github.js';
import type { GitHubCredentials } from './github.js';
import { Store } from './store.js';
import type { RequestSnapshot } from './store.js';
import { dispatchRequest } from './dispatch.js';
import { updateProgress } from './progress.js';
import { AdmissionError, recordRejection, type RejectionCode, type RejectionIdentity } from './admission.js';
import { publishRejection } from './rejections.js';

export interface BackendConfig extends GitHubCredentials { DB: D1Database; PUBLIC_URL: string; GITHUB_APP_SLUG: string; TRUSTED_WORKFLOW: string; CHATGPT_DEPLOYMENT_AUTHORIZED: string; MERGE_ACCEPTANCE_REPOSITORY_ID?:string; MERGE_ACCEPTANCE_INSTALLATION_ID?:string; ACCEPTANCE_USER_PER_DAY?:string }
/** Persist only fields needed for recovery; never copy issue/PR bodies or unrelated metadata. */
export function compactWebhook(event: string, payload: unknown): unknown {
  const input = record(payload);
  if (!['issue_comment','pull_request','installation','installation_repositories'].includes(event)) return {};
  const installation = record(input.installation);
  const base = { action: input.action, installation: { id: installation.id } };
  if (event === 'installation') return base;
  if (event === 'installation_repositories') return { ...base, repositories_removed: Array.isArray(input.repositories_removed) ? input.repositories_removed.map(value => {
    const repo = record(value); return { id: repo.id, full_name: repo.full_name };
  }) : [] };
  const repository = record(input.repository), sender = record(input.sender);
  const common = { ...base, repository: { id: repository.id, full_name: repository.full_name }, sender: { id: sender.id, login: sender.login, type: sender.type } };
  if (event === 'pull_request') {
    const pull = record(input.pull_request);
    return { ...common, number: input.number, pull_request: { updated_at: pull.updated_at, head: { sha: record(pull.head).sha } } };
  }
  const comment = record(input.comment), issue = record(input.issue);
  requireCondition(typeof comment.body === 'string' && comment.body.length <= 16_384, 'comment_too_long');
  return { ...common, issue: { number: issue.number, ...(issue.pull_request ? { pull_request: {} } : {}) },
    comment: { id: comment.id, body: comment.body, created_at: comment.created_at, user: { id: record(comment.user).id } } };
}
async function verifiedInstallation(app: Octokit, repository: string, installationId: number): Promise<void> {
  const { data } = await app.rest.apps.getRepoInstallation(splitRepo(repository));
  requireCondition(data.id === installationId && !data.suspended_at, 'installation_mismatch_or_suspended', 403);
}
export async function ingest(event: string, payload: unknown, requestId: string, env: BackendConfig): Promise<string> {
  const input = record(payload);
  const store = new Store(env.DB);
  if (event === 'installation_repositories' && input.action === 'removed') {
    const app = await appClient(env), installation = record(input.installation);
    requireCondition(Array.isArray(input.repositories_removed) && input.repositories_removed.length <= 100, 'invalid_removed_repositories');
    for (const value of input.repositories_removed) {
      const repository = record(value);
      try {
        const { data } = await app.rest.apps.getRepoInstallation(splitRepo(String(repository.full_name)));
        if (data.id === installation.id && !data.suspended_at) continue;
      } catch (error) { requireCondition(error && typeof error === 'object' && 'status' in error && error.status === 404, 'installation_status_unavailable', 502); }
      await store.removeRepository(Number(repository.id), Number(installation.id));
    }
    return 'repositories_removed';
  }
  if (event === 'installation' && ['deleted', 'suspend'].includes(String(input.action))) {
    const installation = record(input.installation);
    // A replayed lifecycle webhook must not delete credentials for a currently active installation.
    const app = await appClient(env);
    try {
      const { data } = await app.rest.apps.getInstallation({ installation_id: Number(installation.id) });
      if (!data.suspended_at) return 'ignored_active_installation';
    } catch (error) { requireCondition(error && typeof error === 'object' && 'status' in error && error.status === 404, 'installation_status_unavailable', 502); }
    await store.removeInstallation(Number(installation.id)); return 'installation_removed';
  }
  const manual = event === 'issue_comment' && input.action === 'created';
  const automatic = event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(String(input.action));
  if (!manual && !automatic) return 'ignored';
  if (manual) {
    const comment = record(input.comment);
    // Custom handles require policy lookup, but ordinary discussion can be rejected without any GitHub calls.
    if (typeof comment.body !== 'string' || !/^@[a-zA-Z0-9]{1,39}\s+review(?=\s|$)/i.test(comment.body.trimStart().split(/\r?\n/, 1)[0] ?? '')) return 'no_command';
  }
  const sender = record(input.sender), repository = record(input.repository), installation = record(input.installation);
  requireCondition((sender.type === 'User' || (automatic && sender.type === 'Bot')) && Number.isSafeInteger(sender.id) && typeof sender.login === 'string', 'human_sender_required', 403);
  const fullName = String(repository.full_name), repo = splitRepo(fullName);
  await verifiedInstallation(await appClient(env), fullName, Number(installation.id));
  const { github } = await installationClient(env, Number(installation.id), Number(repository.id), { contents: 'read', pull_requests: 'write', actions: 'write' });
  const { data: liveRepo } = await github.rest.repos.get(repo);
  requireCondition(liveRepo.id === repository.id, 'repository_mismatch', 403);
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: liveRepo.default_branch });
  const config = await trustedConfig(github, fullName, branch.commit.sha);
  if (!config.review.enabled || (!manual && !config.review.auto_review)) return 'disabled';
  requireCondition(sender.type === 'User' || Boolean(config.credentials.automatic_reviewer), 'human_sender_required', 403);
  let livePermission = await permission(github, fullName, sender.login, Number(sender.id), sender.type as 'User' | 'Bot');
  // Public non-collaborators can read the repository even when the collaborator API returns none.
  if (livePermission==='none' && automatic && config.credentials.automatic_reviewer && liveRepo.private===false) livePermission='read';
  requireCondition(authorize(sender.login, livePermission, config.authorization), 'review_not_authorized', 403);
  let actor=sender.login,actorId=Number(sender.id),automaticGrantId:string|undefined;
  if (automatic && config.credentials.automatic_reviewer) {
    const grant=await store.automaticGrant(liveRepo.id,Number(installation.id));
    if (!grant || grant.actor.toLowerCase()!==config.credentials.automatic_reviewer.toLowerCase() || grant.credential_mode!==config.credentials.mode) return 'automatic_credential_not_authorized';
    actor=grant.actor;actorId=grant.actor_id;automaticGrantId=grant.id;
    livePermission=await permission(github,fullName,actor,actorId);
    requireCondition(livePermission==='admin' && authorize(actor,livePermission,config.authorization),'automatic_reviewer_not_authorized',403);
    if (config.credentials.mode==='chatgpt' && !await store.session(liveRepo.id,actorId,Number(installation.id))) return 'automatic_credential_not_connected';
  }
  let prNumber: number;
  let command;
  const reject = async (code: RejectionCode): Promise<string> => {
    if (!manual) return 'admission_rejected';
    const comment = record(input.comment);
    const identity: RejectionIdentity = {id:requestId,installationId:Number(installation.id),repositoryId:liveRepo.id,ownerId:liveRepo.owner.id,repository:liveRepo.full_name,pr:prNumber,actor:sender.login as string,actorId:Number(sender.id),...(Number.isSafeInteger(comment.id)?{commandId:Number(comment.id)}:{})};
    const row = await recordRejection(env.DB,identity,code); await publishRejection(env,row.id); return 'command_rejected';
  };
  if (manual) {
    const comment = record(input.comment), issue = record(input.issue);
    if (!issue.pull_request) return 'not_a_pull_request';
    const user = record(comment.user);
    requireCondition(user.id === sender.id, 'comment_sender_mismatch', 403);
    requireCondition(typeof comment.created_at === 'string' && Math.abs(Date.now() - Date.parse(comment.created_at)) < 600_000, 'old_comment_replay', 403);
    requireCondition(typeof comment.body === 'string', 'invalid_comment');
    prNumber = Number(issue.number);
    requireCondition(Number.isSafeInteger(prNumber) && prNumber > 0, 'invalid_pr_number');
    // Only parse an exact configured first token; malformed commands for another bot stay silent.
    const first = comment.body.trimStart().split(/\s+/,1)[0]?.toLowerCase();
    const handle = [config.bot.trigger,...config.bot.aliases].find(value=>value.toLowerCase()===first);
    if (!handle) return 'no_command';
    try { command = parseCommand(comment.body,handle); }
    catch { return reject('invalid_command'); }
    if (!command) return 'no_command';
  } else {
    const pull = record(input.pull_request);
    requireCondition(typeof pull.updated_at === 'string' && Math.abs(Date.now() - Date.parse(pull.updated_at)) < 600_000, 'old_pr_event_replay', 403);
    prNumber = Number(input.number); command = { merge: false, effort: null, instructions: '' };
  }
  requireCondition(Number.isSafeInteger(prNumber) && prNumber > 0, 'invalid_pr_number');
  if (command.merge && !(config.merge.enabled && authorize(sender.login, livePermission, config.merge.authorization, true))) return reject('merge_not_authorized');
  if (command.rerun && !['write','maintain','admin'].includes(livePermission)) return reject('rerun_requires_write_permission');
  if (config.credentials.mode === 'chatgpt' && env.CHATGPT_DEPLOYMENT_AUTHORIZED !== 'true') return reject('chatgpt_deployment_not_authorized');
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (automatic) requireCondition(record(record(input.pull_request).head).sha === pr.head.sha, 'stale_pr_event_head', 409);
  requireCondition(pr.base.repo.id === liveRepo.id,'pr_repository_mismatch',403);
  if (pr.state !== 'open' || pr.draft || pr.changed_files > 200) return reject('pr_not_reviewable');
  requireCondition(Number.isSafeInteger(pr.commits) && pr.commits > 0 && Number.isSafeInteger(pr.changed_files) && pr.changed_files >= 0, 'invalid_pr_counts');
  let snapshot: RequestSnapshot = {
    id: requestId, installationId: Number(installation.id), repositoryId: liveRepo.id, ownerId: liveRepo.owner.id,
    ...(!command.merge && config.merge.enabled && config.merge.auto_merge_on_approval && authorize(actor,livePermission,config.merge.authorization,true) ? {mergeIntent:'automatic' as const} : {}),
    repository: liveRepo.full_name, defaultBranch: liveRepo.default_branch, workflowSha: branch.commit.sha,
    head: pr.head.sha, base: pr.base.sha, pr: prNumber, actor, actorId, ...(automaticGrantId ? {triggerActor:{login:sender.login,id:Number(sender.id),...(sender.type==='Bot'?{type:'Bot' as const}:{})},automaticGrantId} : {}), command, config, createdAt: Date.now(), ...(manual && Number.isSafeInteger(record(input.comment).id) ? {commandId:Number(record(input.comment).id)} : {}), commits: pr.commits, changedFiles: pr.changed_files
  };
  const scopedQuota=env.MERGE_ACCEPTANCE_REPOSITORY_ID===String(snapshot.repositoryId) && env.MERGE_ACCEPTANCE_INSTALLATION_ID===String(snapshot.installationId) ? env.ACCEPTANCE_USER_PER_DAY : undefined;
  requireCondition(!scopedQuota || (/^[1-9]\d{0,3}$/.test(scopedQuota) && Number(scopedQuota)<=1000),'invalid_operator_request_quota',503);
  try { snapshot = await store.create(snapshot, env.TRUSTED_WORKFLOW, manual, scopedQuota ? Number(scopedQuota) : undefined); }
  catch (error) {
    if (!(error instanceof AdmissionError)) throw error;
    if (manual) await publishRejection(env,error.rejection.id);
    return 'admission_rejected';
  }
  requireCondition(snapshot.head === pr.head.sha && snapshot.base === pr.base.sha && snapshot.workflowSha === branch.commit.sha, 'request_context_changed', 409);
  try { await updateProgress(github, store, snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID)); }
  catch { console.error(JSON.stringify({ event: 'progress_update_deferred', request_id: snapshot.id })); }
  await dispatchRequest(github, store, snapshot, env.GITHUB_APP_SLUG);
  return 'dispatched';
}
