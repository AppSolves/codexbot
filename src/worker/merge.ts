import type { Octokit } from '@octokit/rest';
import type { Config } from '../core/config.js';
import type { RequestSnapshot } from './store.js';
import { splitRepo, permission, trustedConfig, verifyActor } from './github.js';
import { authorize } from '../core/policy.js';
import { requireCondition } from '../core/errors.js';
import { mergeDisposition } from '../core/review.js';
import { REQUEST_LIFETIME_MS } from '../core/limits.js';

export interface MergeOptions { enabled: boolean; appId: number }
interface MergeQuery { repository: { autoMergeAllowed: boolean; pullRequest: {
  id: string; headRefOid: string; baseRefOid: string; baseRefName: string; state: string; isDraft: boolean; mergeStateStatus: string; reviewDecision: string | null;
  autoMergeRequest: { enabledBy: { login: string } } | null; mergeQueueEntry: { id: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean }; nodes: Check[] } } | null } }[] };
} } }
interface Check { __typename: string; name?: string; context?: string; state?: string; status?: string; conclusion?: string | null; checkSuite?: { app: { databaseId: number } | null } }
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){autoMergeAllowed pullRequest(number:$number){id headRefOid baseRefOid baseRefName state isDraft mergeStateStatus reviewDecision autoMergeRequest{enabledBy{login}} mergeQueueEntry{id} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion checkSuite{app{databaseId}}} ... on StatusContext{context state}}}}}}}}}}`;
export function checkState(checks: Check[]): 'passed' | 'pending' | 'failed' {
  if (checks.some(x => x.__typename === 'CheckRun' ? ['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE','STALE'].includes(x.conclusion ?? '') : ['FAILURE','ERROR'].includes(x.state ?? ''))) return 'failed';
  return checks.every(x => x.__typename === 'CheckRun' ? x.status === 'COMPLETED' && x.conclusion === 'SUCCESS' : x.state === 'SUCCESS') ? 'passed' : 'pending';
}
export async function invalidateMerge(github: Octokit, snapshot: RequestSnapshot, appSlug: string, appId: number): Promise<boolean> {
  const repo = splitRepo(snapshot.repository);
  const { repository: { pullRequest: pr } } = await github.graphql<MergeQuery>(QUERY, { ...repo, number: snapshot.pr });
  if (pr.state === 'MERGED') return pr.headRefOid === snapshot.head;
  if (pr.autoMergeRequest?.enabledBy.login === `${appSlug}[bot]`) await github.graphql(`mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}`, { id: pr.id });
  const { data } = await github.rest.checks.listForRef({ ...repo, ref: snapshot.head, check_name: snapshot.config.merge.guard_check, per_page: 100 });
  for (const check of data.check_runs.filter(x => x.app?.id === appId && x.external_id === snapshot.id)) {
    await github.rest.checks.update({ ...repo, check_run_id: check.id, status: 'completed', conclusion: 'failure' });
  }
  return false;
}
export async function controlMerge(github: Octokit, snapshot: RequestSnapshot, config: Config, appSlug: string, options: MergeOptions, beforeWrite: () => Promise<void> = async () => {}): Promise<string> {
  if (!options.enabled) return 'deployment_merge_acceptance_gate_closed';
  requireCondition(Date.now() - snapshot.createdAt < REQUEST_LIFETIME_MS, 'merge_intent_expired', 410);
  const repo = splitRepo(snapshot.repository);
  const state = await github.graphql<MergeQuery>(QUERY, { ...repo, number: snapshot.pr }), pr = state.repository.pullRequest;
  if (pr.state === 'MERGED' && pr.headRefOid === snapshot.head) return 'merged';
  const stop = async (reason: string) => { await invalidateMerge(github, snapshot, appSlug, options.appId); return reason; };
  const liveConfig = await trustedConfig(github, snapshot.repository, snapshot.defaultBranch);
  await verifyActor(github, snapshot.actor, snapshot.actorId);
  const role = await permission(github, snapshot.repository, snapshot.actor);
  if (!liveConfig.review.enabled || !liveConfig.review.auto_approve || !liveConfig.merge.enabled || !authorize(snapshot.actor, role, liveConfig.merge.authorization, true)) return stop('merge_authorization_revoked');
  if (JSON.stringify(liveConfig) !== JSON.stringify(config)) return stop('merge_policy_changed');
  if (pr.headRefOid !== snapshot.head || pr.baseRefOid !== snapshot.base || pr.state !== 'OPEN' || pr.isDraft) return stop('stale_or_closed_pull_request');
  if (pr.mergeQueueEntry || !['CLEAN','BLOCKED','UNSTABLE','BEHIND'].includes(pr.mergeStateStatus)) return stop('conflict_unknown_or_merge_queue_requires_manual_action');
  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: pr.baseRefName });
  if (!branch.protected) return stop('protected_branch_required_for_merge');
  const rules = await github.paginate(github.rest.repos.getBranchRules, { ...repo, branch: pr.baseRefName, per_page: 100 }, response => {
    requireCondition(response.data.length < 100, 'branch_rules_require_manual_review'); return response.data;
  });
  if (rules.some(rule => rule.type === 'merge_queue')) return stop('merge_queue_requires_manual_action');
  let protection: Awaited<ReturnType<typeof github.rest.repos.getBranchProtection>>['data'] | undefined;
  try { protection = (await github.rest.repos.getBranchProtection({ ...repo, branch: pr.baseRefName })).data; }
  catch (error) { requireCondition(error && typeof error === 'object' && 'status' in error && error.status === 404 && rules.length > 0, 'branch_protection_not_verifiable', 403); }
  const humanMinimum = Math.max(config.merge.minimum_human_approvals, protection?.required_pull_request_reviews?.required_approving_review_count ?? 0,
    ...rules.filter(x => x.type === 'pull_request').map(x => x.parameters?.required_approving_review_count ?? 0));
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: snapshot.pr, per_page: 100 }, response => {
    requireCondition(response.data.length < 100, 'human_review_history_requires_manual_review'); return response.data;
  });
  const latest = new Map<number, typeof reviews[number]>();
  const latestBot = reviews.filter(x => x.user?.login === `${appSlug}[bot]` && x.commit_id === snapshot.head).at(-1);
  if (latestBot?.state !== 'APPROVED') return stop('bot_approval_no_longer_current');
  for (const review of reviews) if (review.user?.type === 'User' && Number.isSafeInteger(review.user.id) && review.user.id !== pull.user?.id && review.user.login !== pull.user?.login && review.state !== 'COMMENTED') latest.set(review.user.id, review);
  let humans = 0;
  let permissionChecks = 0;
  for (const [userId, review] of [...latest].reverse()) {
    if (review.state !== 'APPROVED' || review.commit_id !== snapshot.head) continue;
    if (++permissionChecks > 8) return stop('human_permission_budget_requires_manual_review');
    if (['write','maintain','admin'].includes(await permission(github, snapshot.repository, review.user!.login, userId))) humans++;
    if (humans >= humanMinimum) break;
  }
  if (humans < humanMinimum || ['CHANGES_REQUESTED','REVIEW_REQUIRED'].includes(pr.reviewDecision ?? '')) return stop('independent_human_approvals_required');
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  if (!contexts || contexts.pageInfo.hasNextPage) return stop('check_evidence_unavailable');
  const checks = contexts.nodes.filter(x => !(x.__typename === 'CheckRun' && x.name === config.merge.guard_check && x.checkSuite?.app?.databaseId === options.appId));
  const status = checkState(checks);
  if (status === 'failed') return stop('known_failed_checks');
  const required = [...(protection?.required_status_checks?.checks ?? []).map(x => ({ name: x.context, app: x.app_id })),
    ...rules.filter(x => x.type === 'required_status_checks').flatMap(x => x.parameters?.required_status_checks ?? []).map(x => ({ name: x.context, app: x.integration_id }))];
  const guarded = required.some(x => x.name === config.merge.guard_check && x.app === options.appId);
  const missing = required.filter(x => x.name !== config.merge.guard_check).some(required => !checks.some(x => (x.name ?? x.context) === required.name && (!required.app || required.app === -1 || x.checkSuite?.app?.databaseId === required.app)));
  const disposition = mergeDisposition({ head: pr.headRefOid, expectedHead: snapshot.head, open: pr.state === 'OPEN', draft: pr.isDraft,
    mergeStateStatus: pr.mergeStateStatus, reviewDecision: pr.reviewDecision, authorized: true, explicitlyRequested: snapshot.command.merge,
    event: 'APPROVE', checks: missing ? 'pending' : status, humans: humans >= humanMinimum, protected: branch.protected, queue: false }, config);
  if (disposition === 'ready') {
    await beforeWrite();
    // A ready PR is merged through GitHub's guarded mutation; no bypass parameter is available here.
    await github.graphql(`mutation($id:ID!,$mergeMethod:PullRequestMergeMethod!,$head:GitObjectID!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$mergeMethod,expectedHeadOid:$head}){pullRequest{merged}}}`, { id: pr.id, mergeMethod: config.merge.method.toUpperCase(), head: snapshot.head });
    return 'merged';
  }
  if (disposition !== 'pending') return stop(disposition);
  if (!guarded || !state.repository.autoMergeAllowed) return stop('pending_checks_require_app_bound_guard_and_native_auto_merge');
  const { data: existing } = await github.rest.checks.listForRef({ ...repo, ref: snapshot.head, check_name: config.merge.guard_check, per_page: 100 });
  requireCondition(existing.total_count <= 100, 'guard_history_requires_manual_review');
  let guard = existing.check_runs.find(x => x.app?.id === options.appId && x.external_id === snapshot.id);
  if (!guard) { await beforeWrite(); guard = (await github.rest.checks.create({ ...repo, name: config.merge.guard_check, head_sha: snapshot.head, external_id: snapshot.id, status: 'in_progress' })).data; }
  if (status !== 'passed' || missing) {
    await beforeWrite();
    if (!pr.autoMergeRequest) await github.graphql(`mutation($id:ID!,$mergeMethod:PullRequestMergeMethod!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$mergeMethod,expectedHeadOid:$head}){pullRequest{id}}}`, { id: pr.id, mergeMethod: config.merge.method.toUpperCase(), head: snapshot.head });
    else if (pr.autoMergeRequest.enabledBy.login !== `${appSlug}[bot]`) return 'another_actor_owns_auto_merge';
    return 'queued';
  }
  // The guard stays pending until the reconciler has rechecked credentials, policy, head and humans.
  // Disable the queued native intent before releasing the guard. The next guarded merge
  // rechecks all live conditions; GitHub cannot race ahead of that final authorization check.
  await beforeWrite();
  if (pr.autoMergeRequest?.enabledBy.login === `${appSlug}[bot]`) await github.graphql(`mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}`, { id: pr.id });
  await github.rest.checks.update({ ...repo, check_run_id: guard.id, status: 'completed', conclusion: 'success' });
  // Native auto-merge may complete immediately. A ready PR with auto-merge disabled is retried safely.
  return 'queued';
}
