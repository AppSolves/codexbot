import type { Octokit } from '@octokit/rest';
import { AppError, requireCondition } from '../core/errors.js';
import { authorize } from '../core/policy.js';
import { MAX_RECOVERY_ATTEMPTS, RECOVERY_LEASE_MS } from '../core/limits.js';
import { appClient, installationClient, permission, splitRepo, trustedConfig } from './github.js';
import { retryDelay } from './store.js';
import { getRejection, type RejectionIdentity, type RejectionRow } from './admission.js';
import type { BackendConfig } from './webhook.js';

export function rejectionBody(row: RejectionRow): string {
  const identity = JSON.parse(row.identity) as RejectionIdentity;
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(row.id) && Number.isSafeInteger(identity.pr) && identity.pr > 0 && Number.isSafeInteger(identity.repositoryId), 'invalid_rejection_identity');
  const messages = {
    rerun_limit_exceeded: 'Your explicit rerun allowance has been reached.',
    user_quota_exceeded: 'Your review request quota has been reached.',
    repository_quota_exceeded: 'The repository review request quota has been reached.',
    installation_quota_exceeded: 'The installation review request quota has been reached.',
    repository_concurrency_exceeded: 'The repository already has the maximum number of active reviews. Wait for an active review to finish.',
    installation_concurrency_exceeded: 'The installation already has the maximum number of active reviews. Wait for an active review to finish.',
    cooldown_active: 'The cooldown between your review requests is still active.',
    duplicate_review: 'This review request was already accepted for the same commit and review context. Use an authorized --rerun for an intentional repeat, subject to its separate allowance.',
    invalid_command: 'The command has an invalid, repeated or unsupported option. Check quoting and use review [--model MODEL] [--effort LEVEL] [--rerun] [--merge].',
    merge_not_authorized: 'The requested merge operation is not permitted by the current repository policy or your permissions. Request a review without --merge.',
    rerun_requires_write_permission: 'Explicit reruns require repository write permission. Request a normal review without --rerun.',
    pr_not_reviewable: 'This pull request is closed, a draft, or outside the supported review limits.',
    chatgpt_deployment_not_authorized: 'ChatGPT review execution is not enabled for this deployment. Contact the operator.'
  };
  requireCondition(Object.hasOwn(messages,row.outcome),'invalid_rejection_outcome');
  const quota = row.quota === null ? '' : row.window_ms === 86_400_000 ? ` Limit: ${row.quota} requests in a rolling 24-hour window.`
    : row.outcome === 'cooldown_active' ? ` Cooldown: ${row.window_ms! / 1000} seconds.` : ` Active review limit: ${row.quota}.`;
  const retry = row.retry_at !== null && Number.isSafeInteger(row.retry_at) ? ` For this limit, retry no earlier than **${new Date(row.retry_at).toISOString()} (UTC)**. Other admission checks still apply.` : '';
  return `<!-- codexbot-rejection:${row.id}:${identity.repositoryId}:${identity.pr} -->\n**CodexBot did not start this review.**\n\n${messages[row.outcome]}${quota}${retry}\n\nNo AI inference was started for this command.`;
}
export async function publishRejection(env: BackendConfig, id: string): Promise<void> {
  const lease = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare(`UPDATE review_rejections SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=?
    AND phase IN ('pending','creating') AND lease_until<? AND next_attempt<=? AND attempts<? RETURNING *`)
    .bind(lease,now+RECOVERY_LEASE_MS,id,now,now,MAX_RECOVERY_ATTEMPTS).first<RejectionRow>();
  if (!row) return;
  let posting = false;
  try {
    const identity = JSON.parse(row.identity) as RejectionIdentity, repo = splitRepo(identity.repository);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(repo);
    requireCondition(installation.id === identity.installationId && !installation.suspended_at,'rejection_installation_changed',403);
    const { github } = await installationClient(env,identity.installationId,identity.repositoryId,{contents:'read',pull_requests:'write'});
    const { data: metadata } = await github.rest.repos.get(repo);
    requireCondition(metadata.id === identity.repositoryId && metadata.owner.id === identity.ownerId,'rejection_repository_changed',403);
    const { data: branch } = await github.rest.repos.getBranch({...repo,branch:metadata.default_branch});
    const config = await trustedConfig(github,identity.repository,branch.commit.sha);
    requireCondition(authorize(identity.actor,await permission(github,identity.repository,identity.actor,identity.actorId),config.authorization),'rejection_authorization_revoked',403);
    const { data: pr } = await github.rest.pulls.get({...repo,pull_number:identity.pr});
    requireCondition(pr.base.repo.id === identity.repositoryId,'rejection_pr_changed',403);
    await publishComment(github,env,row,lease);
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    // Only definitive no-write responses allow another POST. A lost response remains reconciliation-only.
    const definitive = posting && [400,401,403,404,410,422,429].includes(status);
    const terminal = error instanceof AppError && [400,403].includes(error.status);
    await env.DB.prepare(`UPDATE review_rejections SET phase=CASE WHEN ? OR attempts>=? THEN 'failed' WHEN ? THEN 'pending' ELSE phase END,
      lease_until=0,next_attempt=? WHERE id=? AND lease=? AND lease_until>?`)
      .bind(terminal ? 1 : 0,MAX_RECOVERY_ATTEMPTS,definitive ? 1 : 0,Date.now()+retryDelay(row.attempts),id,lease,Date.now()).run();
    console.error(JSON.stringify({event:'rejection_publication_deferred',...(status>=400&&status<=599?{status}:{})}));
  }
  async function publishComment(github: Octokit, env: BackendConfig, row: RejectionRow, lease: string): Promise<void> {
    const identity = JSON.parse(row.identity) as RejectionIdentity, repo = splitRepo(identity.repository), body = rejectionBody(row), marker = body.split('\n')[0]!;
    const owned = (comment: { user: {type:string;login:string} | null; performed_via_github_app?: {id:number} | null; issue_url:string;body?:string }) =>
      comment.user?.type === 'Bot' && comment.user.login === `${env.GITHUB_APP_SLUG}[bot]` && comment.performed_via_github_app?.id === Number(env.GITHUB_APP_ID) &&
      comment.issue_url === `https://api.github.com/repos/${identity.repository}/issues/${identity.pr}` && comment.body?.startsWith(marker+'\n');
    let comment;
    if (row.phase === 'creating') {
      // GitHub has no comment idempotency key. Ambiguous POSTs are never repeated.
      for (let page=1;page<=3&&!comment;page++) {
        const {data} = await github.rest.issues.listComments({...repo,issue_number:identity.pr,since:new Date(row.created_at-60_000).toISOString(),per_page:100,page});
        comment=data.find(owned);if(data.length<100)break;
      }
      if (!comment) throw new AppError('rejection_awaiting_reconciliation',503);
    } else {
      const changed=await env.DB.prepare("UPDATE review_rejections SET phase='creating' WHERE id=? AND lease=? AND lease_until>? AND phase='pending'").bind(row.id,lease,Date.now()).run();
      requireCondition(changed.meta.changes===1,'rejection_lease_lost',409);
      posting=true; comment=(await github.rest.issues.createComment({...repo,issue_number:identity.pr,body})).data;posting=false;
      requireCondition(owned(comment),'rejection_comment_ownership_mismatch',403);
    }
    requireCondition(owned(comment),'rejection_comment_ownership_mismatch',403);
    const saved=await env.DB.prepare("UPDATE review_rejections SET phase='done',comment_id=?,lease_until=0 WHERE id=? AND lease=? AND lease_until>?").bind(comment.id,row.id,lease,Date.now()).run();
    requireCondition(saved.meta.changes===1,'rejection_lease_lost',409);
  }
}
export async function recoverRejection(env: BackendConfig): Promise<boolean> {
  const row=await env.DB.prepare("SELECT id FROM review_rejections WHERE phase IN ('pending','creating') AND lease_until<? AND next_attempt<=? AND attempts<? ORDER BY created_at LIMIT 1")
    .bind(Date.now(),Date.now(),MAX_RECOVERY_ATTEMPTS).first<{id:string}>();
  if (!row) return false;await publishRejection(env,row.id);return true;
}
export { getRejection };
