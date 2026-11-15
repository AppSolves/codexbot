import { gitSource } from '../core/git-source.js';
import { binaryChange, binaryLocations, type BinaryChange } from '../core/binary.js';
import type { Octokit } from '@octokit/rest';
import { authorize } from '../core/policy.js';
import { decision, publicText, validateReview, failedReview, completePatch, normalizeReview, findingDisposition, reviewSummary, mergeRequested } from '../core/review.js';
import { sha256 } from '../core/crypto.js';
import { requireCondition, AppError } from '../core/errors.js';
import { splitRepo, permission, trustedConfig, verifyActor } from './github.js';
import type { RequestSnapshot } from './store.js';
import { controlMerge, invalidateMerge } from './merge.js';
import type { MergeOptions } from './merge.js';
import { REQUEST_LIFETIME_MS } from '../core/limits.js';

export interface PublishOptions { merge?: MergeOptions; checkpoint?: (id: number, phase: 'pending' | 'submitted', merge: string) => Promise<void>; beforeWrite?: () => Promise<void> }
export async function discardPendingReview(github: Octokit, snapshot: RequestSnapshot, appSlug: string): Promise<void> {
  const repo = splitRepo(snapshot.repository), marker = `<!-- codexbot:${snapshot.id}:${snapshot.head} -->`;
  let pages = 0;
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: snapshot.pr, per_page: 100 }, response => {
    requireCondition(++pages <= 3, 'pending_review_history_requires_manual_inspection'); return response.data;
  });
  for (const review of reviews.filter(x => x.state === 'PENDING' && x.commit_id === snapshot.head && x.user?.type === 'Bot' && x.user.login === `${appSlug}[bot]` && x.body?.includes(marker))) {
    await github.rest.pulls.deletePendingReview({ ...repo, pull_number: snapshot.pr, review_id: review.id });
  }
}
export async function publish(github: Octokit, snapshot: RequestSnapshot, output: unknown, contextComplete: boolean, appSlug: string, options: PublishOptions = {}): Promise<{ reviewId: number; event: string; merge: string }> {
  const repo = splitRepo(snapshot.repository);
  const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  requireCondition(current.head.sha === snapshot.head && current.base.sha === snapshot.base && (current.state === 'open' || (current.merged && mergeRequested(snapshot))) && !current.draft, 'stale_or_closed_pull_request', 409);
  const { data: repository } = await github.rest.repos.get(repo);
  requireCondition(repository.id === snapshot.repositoryId && repository.owner.id === snapshot.ownerId, 'repository_identity_changed', 403);
  const { data: trustedBranch } = await github.rest.repos.getBranch({ ...repo, branch: repository.default_branch });
  requireCondition(repository.default_branch === snapshot.defaultBranch && trustedBranch.commit.sha === snapshot.workflowSha, 'trusted_policy_or_workflow_revision_changed', 409);
  const config = await trustedConfig(github, snapshot.repository, repository.default_branch);
  await verifyActor(github, snapshot.actor, snapshot.actorId);
  const livePermission = await permission(github, snapshot.repository, snapshot.actor, snapshot.actorId);
  requireCondition(!snapshot.triggerActor || (livePermission==='admin' && config.credentials.automatic_reviewer?.toLowerCase()===snapshot.actor.toLowerCase()),'automatic_review_authorization_revoked',403);
  requireCondition(config.review.enabled && authorize(snapshot.actor, livePermission, config.authorization), 'review_authorization_revoked', 403);
  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: snapshot.pr, per_page: 100 });
  requireCondition(files.length === current.changed_files && files.length <= 200, 'diff_incomplete');
  const binaries=files.filter(file=>!file.patch),verified:BinaryChange[]=[];let binaryVerified=true;
  if(binaries.length){
    let calls=0;const source=gitSource(github,repo,()=>requireCondition(++calls<=32,'binary_publication_budget'));const budget={bytes:0,shas:new Set<string>()};
    try {for(const file of binaries)verified.push(await binaryChange(file,snapshot.base,snapshot.head,source,budget));}catch{binaryVerified=false;}
  }
  let review;
  try { review = validateReview(normalizeReview(output, snapshot.head), snapshot.head, files, binaryLocations(verified)); }
  catch (error) { if (!(error instanceof AppError)) throw error; review = failedReview(snapshot.head); }
  if(!binaryVerified)review={...failedReview(snapshot.head),summary:'Changes without complete textual patches could not be independently verified as supported PNG images. No approval or merge is authorized.'};
  contextComplete = contextComplete && binaryVerified && files.every(file=>!file.patch||completePatch(file));
  const computedEvent = decision(review, config, contextComplete);
  const event = current.user?.login === `${appSlug}[bot]` ? 'COMMENT' : computedEvent;
  const marker = `<!-- codexbot:${snapshot.id}:${snapshot.head} -->`;
  const fingerprint = `<!-- codexbot-result:${await sha256(JSON.stringify({ review, event, contextComplete, mergeIntent: mergeRequested(snapshot) ? {actor:snapshot.actor,mode:snapshot.command.merge?'explicit':'automatic'} : null }))} -->`;
  let historyPages = 0;
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: snapshot.pr, per_page: 100 }, response => {
    requireCondition(++historyPages <= 10, 'review_history_limit_requires_reconciliation');
    return response.data;
  });
  // Only this App's review is evidence of publication. PR text cannot forge a receipt.
  const expectedState = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[event];
  for (const stale of reviews.filter(x => x.state === 'PENDING' && x.commit_id !== snapshot.head && x.user?.type === 'Bot' && x.user.login === `${appSlug}[bot]` && /<!-- codexbot:[a-f0-9-]{36}:[a-f0-9]{40} -->/.test(x.body ?? ''))) {
    await github.rest.pulls.deletePendingReview({ ...repo, pull_number: snapshot.pr, review_id: stale.id });
  }
  const assertPublicationAllowed = async () => {
    requireCondition(Date.now() - snapshot.createdAt < REQUEST_LIFETIME_MS, 'request_expired', 410);
    const { data: latest } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
    requireCondition(latest.head.sha === snapshot.head && latest.base.sha === snapshot.base && latest.state === 'open' && !latest.draft, 'head_changed_before_publish', 409);
    const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: snapshot.defaultBranch });
    requireCondition(branch.commit.sha === snapshot.workflowSha, 'trusted_policy_or_workflow_revision_changed', 409);
    const liveConfig = await trustedConfig(github, snapshot.repository, branch.commit.sha);
    await verifyActor(github, snapshot.actor, snapshot.actorId);
    if (snapshot.triggerActor) requireCondition(await permission(github,snapshot.repository,snapshot.actor,snapshot.actorId)==='admin' && liveConfig.credentials.automatic_reviewer?.toLowerCase()===snapshot.actor.toLowerCase(),'automatic_review_authorization_revoked',403);
    requireCondition(JSON.stringify(liveConfig) === JSON.stringify(config) && liveConfig.review.enabled && authorize(snapshot.actor, await permission(github, snapshot.repository, snapshot.actor, snapshot.actorId), liveConfig.authorization), 'review_authorization_revoked', 403);
  };
  const existing = reviews.find(x => (x.body?.includes(marker) || x.body?.includes(fingerprint)) && [expectedState, 'PENDING'].includes(x.state) && x.user?.type === 'Bot' && x.user?.login === `${appSlug}[bot]` && x.commit_id === snapshot.head);
  let reviewId: number;
  if (existing) {
    reviewId = existing.id;
  } else {
    requireCondition(!current.merged, 'merged_without_reconcilable_review', 409);
    requireCondition(!reviews.some(x => x.body?.includes(marker) && x.user?.login === `${appSlug}[bot]` && x.state !== 'DISMISSED'), 'published_review_policy_changed', 409);
    // Recheck immediately before the write; commit_id always pins this review even across a race.
    await assertPublicationAllowed();
    await options.beforeWrite?.();
    const { data } = await github.rest.pulls.createReview({ ...repo, pull_number: snapshot.pr, commit_id: snapshot.head,
      body: `${marker}\n${fingerprint}\n${reviewSummary(review, event, contextComplete, binaryVerified?binaries.length:0)}${mergeRequested(snapshot) ? `\n\nConditional merge ${snapshot.command.merge ? 'explicitly requested' : 'enabled by repository policy for authorized requester'} ${publicText(snapshot.actor)}.` : ''}`,
      comments: review.findings.flatMap(f => f.line===null ? [] : [{ path: f.path, line: f.line, side: f.side, body: `**${f.severity.toUpperCase()}: ${publicText(f.title)}**\n\n${publicText(f.explanation)}\n\n${publicText(f.remediation)}\n\nConfidence: ${f.confidence}; policy: ${findingDisposition(f, config)}.` }])
    });
    reviewId = data.id;
  }
  await options.checkpoint?.(reviewId, existing?.state === expectedState ? 'submitted' : 'pending', 'pending');
  if (existing?.state !== expectedState) {
    // A pending review is a resumable resource. Lost submit responses reconcile to its final state.
    await assertPublicationAllowed();
    await options.beforeWrite?.();
    await github.rest.pulls.submitReview({ ...repo, pull_number: snapshot.pr, review_id: reviewId, event });
  }
  await options.checkpoint?.(reviewId, 'submitted', 'pending');
  if (current.merged) { await options.checkpoint?.(reviewId, 'submitted', 'merged'); return { reviewId, event, merge: 'merged' }; }
  if (!mergeRequested(snapshot) || event !== 'APPROVE') return { reviewId, event, merge: 'not_requested_or_not_approved' };
  let merge: string;
  try { merge = await controlMerge(github, snapshot, config, appSlug, options.merge ?? { enabled: false, appId: 0 }, async () => {
    await options.checkpoint?.(reviewId, 'submitted', 'arming');
    await options.beforeWrite?.();
  }); }
  catch (error) {
    if (options.merge?.enabled) await invalidateMerge(github, snapshot, appSlug, options.merge.appId);
    throw error;
  }
  await options.checkpoint?.(reviewId, 'submitted', merge);
  return { reviewId, event, merge };
}
