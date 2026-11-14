import type { Octokit } from '@octokit/rest';
import type { Store } from './store.js';
import type { RequestSnapshot } from './store.js';
import { splitRepo } from './github.js';
import { requireCondition } from '../core/errors.js';

export async function dispatchRequest(github: Octokit, store: Store, snapshot: RequestSnapshot, appSlug: string): Promise<void> {
  const { row } = await store.get(snapshot.id);
  if (row.state !== 'created' || row.dispatch_phase === 'confirmed') return;
  const repo = splitRepo(snapshot.repository);
  let attempt = await store.beginDispatch(snapshot.id);
  if (!attempt) {
    const current = await store.get(snapshot.id);
    if (current.row.state !== 'created') return;
    attempt = current.row.dispatch_attempt;
    requireCondition(attempt, 'dispatch_claim_conflict', 409);
    // An ambiguous POST is reconciled by an App-authored, immutable, attempt-bound run name.
    let exhaustive = false;
    for (let page = 1; page <= 3; page++) {
      const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'codexbot.yml', event: 'workflow_dispatch',
        branch: snapshot.defaultBranch, created: `>=${new Date(snapshot.createdAt - 60_000).toISOString()}`, per_page: 100, page });
      const match = data.workflow_runs.find(run => run.display_title === `CodexBot ${snapshot.id} ${attempt}` && run.head_sha === snapshot.workflowSha &&
        run.event === 'workflow_dispatch' && run.repository.id === snapshot.repositoryId && run.actor?.type === 'Bot' && run.actor.login === `${appSlug}[bot]`);
      if (match) { await store.dispatched(snapshot.id); return; }
      if (data.workflow_runs.length < 100) { exhaustive = true; break; }
    }
    // Allow GitHub's run listing to converge before a bounded retry of the SAME attempt.
    // At prepare, a run-ID CAS admits exactly one runner even if GitHub accepted both POSTs.
    requireCondition(exhaustive && Date.now() - (row.dispatch_started ?? Date.now()) > 120_000, 'dispatch_awaiting_reconciliation', 503);
  }
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'codexbot.yml', ref: snapshot.defaultBranch,
    inputs: { request_id: snapshot.id, credential_owner: String(snapshot.actorId), installation_id: String(snapshot.installationId), dispatch_attempt: attempt } });
  await store.dispatched(snapshot.id);
}
