import type { Octokit } from '@octokit/rest';
import { splitRepo, installationClient, appClient } from './github.js';
import type { Store } from './store.js';
import type { RequestRow, RequestSnapshot } from './store.js';
import { sha256 } from '../core/crypto.js';
import { requireCondition } from '../core/errors.js';

const STATUSES = new Set(['queued','in_progress','completed','requested','waiting','pending']);
const CONCLUSIONS = new Set(['success','failure','cancelled','timed_out','action_required','stale','skipped','neutral','startup_failure']);
function marker(snapshot: RequestSnapshot): string { return `<!-- codexbot-progress:${snapshot.id}:${snapshot.repositoryId}:${snapshot.pr} -->`; }
function phase(row: RequestRow): string {
  if (row.state === 'failed' || (row.state === 'published' && row.failure_code)) return 'failed';
  if (row.state === 'published') return 'completed';
  if (row.state === 'publishing') return 'publishing';
  if (row.state === 'reviewed') return 'awaiting publication';
  if (row.state === 'running') return row.progress_stage === 'analyzing' ? 'analyzing' : 'running';
  if (row.workflow_status === 'in_progress') return 'running';
  return 'queued';
}
export function progressBody(snapshot: RequestSnapshot, row: RequestRow, statusUnavailable = false): string {
  splitRepo(snapshot.repository);
  requireCondition(/^[a-f0-9-]{36}$/.test(snapshot.id) && Number.isSafeInteger(snapshot.pr) && snapshot.pr > 0, 'invalid_progress_identity');
  const counts = Number.isSafeInteger(snapshot.commits) && Number.isSafeInteger(snapshot.changedFiles)
    ? `${snapshot.commits} PR commits; ${snapshot.changedFiles} changed files at acceptance.` : 'Counts were not recorded for this legacy request.';
  const run = row.run_id && /^\d+$/.test(row.run_id) ? `[GitHub Actions run](https://github.com/${snapshot.repository}/actions/runs/${row.run_id})` : 'Awaiting verified GitHub Actions run discovery.';
  const status = row.workflow_status && STATUSES.has(row.workflow_status) ? row.workflow_status : 'not yet confirmed';
  const conclusion = row.workflow_conclusion && CONCLUSIONS.has(row.workflow_conclusion) ? ` / ${row.workflow_conclusion}` : '';
  const review = row.review_id && Number.isSafeInteger(row.review_id) ? `\n\n[Native review](https://github.com/${snapshot.repository}/pull/${snapshot.pr}#pullrequestreview-${row.review_id}).` : '';
  // Every variable is a validated identifier/count or a fixed vocabulary. No prompt,
  // model text, source, remote URL or internal error is part of this public channel.
  return `${marker(snapshot)}\nCodexBot accepted review request \`${snapshot.id.slice(0, 8)}\`.\n\n${counts}\n\n**Stage: ${phase(row)}.**\n\n${statusUnavailable ? 'Workflow details are temporarily unavailable; no current run status is asserted.' : `Workflow: ${status}${conclusion}. ${run}`}${review}${phase(row) === 'failed' ? '\n\nReview processing did not complete. Check the workflow diagnostics, resolve the reported prerequisite and request a new review.' : ''}`;
}
async function observe(github: Octokit, store: Store, snapshot: RequestSnapshot, row: RequestRow, slug: string): Promise<void> {
  if (row.workflow_status === 'completed' || Date.now() - row.workflow_checked_at < 15_000 || !row.dispatch_attempt) return;
  const repo = splitRepo(snapshot.repository);
  const matches = (run: { event: string; head_sha: string; display_title: string; path: string; repository: { id: number; owner: { id: number } }; actor?: { login: string; type: string } | null }) =>
    run.event === 'workflow_dispatch' && run.head_sha === snapshot.workflowSha && run.path === '.github/workflows/codexbot.yml' &&
    run.repository.id === snapshot.repositoryId && run.repository.owner.id === snapshot.ownerId && run.actor?.type === 'Bot' && run.actor.login === `${slug}[bot]` &&
    run.display_title === `CodexBot ${snapshot.id} ${row.dispatch_attempt}`;
  let run;
  if (row.run_id) run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(row.run_id) })).data;
  else {
    const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'codexbot.yml', event: 'workflow_dispatch', branch: snapshot.defaultBranch,
      created: `>=${new Date(snapshot.createdAt - 60_000).toISOString()}`, per_page: 100 });
    run = data.workflow_runs.find(matches);
  }
  if (!run) return;
  requireCondition(matches(run), 'progress_workflow_identity_mismatch', 403);
  requireCondition(run.status && STATUSES.has(run.status) && (!run.conclusion || CONCLUSIONS.has(run.conclusion)), 'progress_unknown_workflow_status');
  if (!await store.observeRun(snapshot.id, String(run.id), run.status, run.conclusion)) return;
  if (run.status === 'completed' && ['created','dispatched','running','reviewed'].includes(row.state)) {
    if (await store.failRun(snapshot.id, String(run.id), 'workflow_ended_before_publication', 'workflow')) await store.release(snapshot);
  }
}
export async function updateProgress(github: Octokit, store: Store, snapshot: RequestSnapshot, slug: string, appId: number): Promise<void> {
  const lease = await store.claimProgress(snapshot.id); if (!lease) return;
  let creating = false;
  try {
    let current = await store.progressRequest(snapshot.id); requireCondition(current, 'request_not_found', 404);
    const repo = splitRepo(snapshot.repository), { data: repository } = await github.rest.repos.get(repo);
    requireCondition(repository.id === snapshot.repositoryId && repository.owner.id === snapshot.ownerId, 'repository_identity_changed', 403);
    let statusUnavailable = false;
    try { await observe(github, store, snapshot, current.row, slug); }
    catch {
      statusUnavailable = true;
      console.error(JSON.stringify({ event: 'workflow_observation_deferred', request_id: snapshot.id }));
    }
    current = await store.progressRequest(snapshot.id); requireCondition(current, 'request_not_found', 404);
    const { row } = current, body = progressBody(snapshot, row, statusUnavailable), hash = await sha256(body);
    const owned = (comment: { user: { type: string; login: string } | null; performed_via_github_app?: { id: number } | null; issue_url: string; body?: string }) =>
      comment.user?.type === 'Bot' && comment.user.login === `${slug}[bot]` && comment.performed_via_github_app?.id === appId &&
      comment.issue_url === `https://api.github.com/repos/${snapshot.repository}/issues/${snapshot.pr}` && comment.body?.startsWith(marker(snapshot));
    let comment;
    if (row.progress_comment_id) {
      try { comment = (await github.rest.issues.getComment({ ...repo, comment_id: row.progress_comment_id })).data; }
      catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) { await store.progressDeferred(snapshot.id, lease, { deleted: true }); return; }
        throw error;
      }
      requireCondition(owned(comment), 'progress_comment_ownership_mismatch', 403);
    } else if (row.progress_phase === 'creating') {
      // A lost POST response is reconciled, never blindly posted again. A crash
      // before POST can therefore require operator attention, rather than spam.
      for (let page = 1; page <= 3 && !comment; page++) {
        const { data } = await github.rest.issues.listComments({ ...repo, issue_number: snapshot.pr, per_page: 100, page });
        comment = data.find(owned); if (data.length < 100) break;
      }
      if (!comment) { await store.progressDeferred(snapshot.id, lease, { failed: true }); return; }
    } else {
      await store.progressCreating(snapshot.id, lease); creating = true;
      comment = (await github.rest.issues.createComment({ ...repo, issue_number: snapshot.pr, body })).data;
      creating = false; // A returned but unverifiable comment is also an ambiguous side effect.
      requireCondition(owned(comment), 'progress_comment_ownership_mismatch', 403);
    }
    if (comment.body !== body) {
      await store.progressWriteAllowed(snapshot.id, lease);
      await github.rest.issues.updateComment({ ...repo, comment_id: comment.id, body });
    }
    await store.progressSaved(snapshot.id, lease, comment.id, hash, phase(row), statusUnavailable);
    if (statusUnavailable) await store.progressDeferred(snapshot.id, lease, { failed: true });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    await store.progressDeferred(snapshot.id, lease, { failed: true, definitive: creating && [400,401,403,404,410,422,429].includes(status) });
    console.error(JSON.stringify({ event: 'progress_update_deferred', request_id: snapshot.id, ...(status >= 400 && status <= 599 ? { status } : {}) }));
  }
}
export async function recoverProgress(env: Env, store: Store): Promise<void> {
  const id = await store.dueProgress(); if (!id) return;
  const current = await store.progressRequest(id); if (!current) return;
  const { snapshot } = current;
  try {
    const { data } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(snapshot.repository));
    requireCondition(data.id === snapshot.installationId && !data.suspended_at, 'installation_no_longer_valid', 403);
    const { github } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: 'read', pull_requests: 'write', actions: 'read' });
    await updateProgress(github, store, snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID));
  } catch {
    const lease = await store.claimProgress(id);
    if (lease) await store.progressDeferred(id, lease, { failed: true });
    console.error(JSON.stringify({ event: 'progress_recovery_deferred', request_id: id }));
  }
}
