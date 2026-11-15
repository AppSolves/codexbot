import { Store } from './store.js';
import { ingest } from './webhook.js';
import { AppError, requireCondition } from '../core/errors.js';
import { appClient, installationClient, splitRepo } from './github.js';
import { publish } from './publish.js';
import { invalidateMerge } from './merge.js';
import type { RequestSnapshot } from './store.js';
import { MAX_RECOVERY_ATTEMPTS } from '../core/limits.js';
import { recoverProgress } from './progress.js';
import { getRejection, publishRejection } from './rejections.js';
import { AdmissionError } from './admission.js';

export async function processDelivery(id: string, env: Env): Promise<string> {
  const store = new Store(env.DB), delivery = await store.claimDelivery(id);
  if (!delivery) return 'recovering';
  try {
    const rejection = await getRejection(env.DB,delivery.request_id);
    if (rejection) { await publishRejection(env,rejection.id); await store.finishDelivery(delivery,true); return 'admission_rejected'; }
    const status = await ingest(delivery.event, JSON.parse(delivery.payload) as unknown, delivery.request_id, env);
    await store.finishDelivery(delivery, true); return status;
  } catch (error) {
    const terminal = error instanceof AdmissionError || (error instanceof AppError && error.status < 500 && error.status !== 429);
    if (terminal) delivery.attempts = MAX_RECOVERY_ATTEMPTS;
    await store.finishDelivery(delivery, false, error instanceof AppError ? error.code : 'external_or_storage_failure');
    throw error;
  }
}
export async function recover(env: Env): Promise<void> {
  const store = new Store(env.DB);
  const expired = await store.expiredIntent();
  if (expired) {
    try {
      const { github } = await installationClient(env, expired.snapshot.installationId, expired.snapshot.repositoryId, { pull_requests: 'write', checks: 'write' });
      const merged = await invalidateMerge(github, expired.snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID)); await store.terminateIntent(expired.id, merged);
    } catch {
      await store.expiryFailed(expired.id, expired.lease, expired.attempts);
      console.error(JSON.stringify({ event: 'merge_expiry_reconciliation_deferred' }));
    }
    await store.cleanup(); return;
  }
  const publications = await store.duePublications();
  const deliveries = publications.length ? [] : (await store.dueDeliveries()).slice(0, 1);
  for (const id of deliveries) {
    try { await processDelivery(id, env); } catch { console.error(JSON.stringify({ event: 'delivery_recovery_deferred' })); }
  }
  for (const id of publications) {
    let lease: string | undefined;
    let active: RequestSnapshot | undefined;
    try {
      const { snapshot, row } = await store.get(id);
      active = snapshot;
      lease = await store.claimPublication(id);
      const { data } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(snapshot.repository));
      requireCondition(data.id === snapshot.installationId && !data.suspended_at, 'installation_no_longer_valid', 403);
      requireCondition(snapshot.config.credentials.mode !== 'chatgpt' || env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true', 'chatgpt_deployment_authorization_revoked', 403);
      if (snapshot.config.credentials.mode === 'chatgpt') requireCondition(await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId), 'chatgpt_connection_revoked', 403);
      const { github } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: snapshot.command.merge ? 'write' : 'read', pull_requests: 'write',
        ...(snapshot.command.merge && env.MERGE_DEPLOYMENT_AUTHORIZED === 'true' ? { checks: 'write', administration: 'read' } as const : {}) });
      const result = await publish(github, snapshot, JSON.parse(row.result!) as unknown, row.context_complete === 1, env.GITHUB_APP_SLUG,
        { checkpoint: (reviewId, phase, merge) => store.checkpoint(id, lease!, reviewId, phase, merge), beforeWrite: () => store.heartbeat(id, lease!), merge: { enabled: env.MERGE_DEPLOYMENT_AUTHORIZED === 'true', appId: Number(env.GITHUB_APP_ID) } });
      await store.published(id, result.reviewId, lease);
    } catch (error) {
      if (active?.command.merge && env.MERGE_DEPLOYMENT_AUTHORIZED === 'true') {
        try {
          const { github } = await installationClient(env, active.installationId, active.repositoryId, { pull_requests: 'write', checks: 'write' });
          await invalidateMerge(github, active, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID));
        } catch { console.error(JSON.stringify({ event: 'merge_cancellation_deferred' })); }
      }
      if (lease) {
        try { await store.publicationFailed(id, lease, error instanceof AppError && error.status < 500 && error.status !== 429); }
        catch { console.error(JSON.stringify({ event: 'publication_state_reconciliation_deferred' })); }
      }
      console.error(JSON.stringify({ event: 'publication_recovery_deferred' }));
    }
  }
  await store.cleanup();
  if (!publications.length && !deliveries.length) await recoverProgress(env, store);
}
