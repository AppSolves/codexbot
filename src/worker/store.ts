import type { Config } from '../core/config.js';
import type { ReviewCommand } from '../core/command.js';
import type { Envelope } from '../core/crypto.js';
import { sha256 } from '../core/crypto.js';
import { requireCondition } from '../core/errors.js';
import { normalizeReview } from '../core/review.js';
import { MAX_REVIEW_BYTES, MAX_RECOVERY_ATTEMPTS, RECOVERY_LEASE_MS, REQUEST_LIFETIME_MS } from '../core/limits.js';

export interface RequestSnapshot {
  id: string; installationId: number; repositoryId: number; ownerId: number; repository: string; defaultBranch: string;
  workflowSha: string; head: string; base: string; pr: number; actor: string; actorId: number; command: ReviewCommand; config: Config; createdAt: number;
  commits?: number; changedFiles?: number;
}
export interface RequestRow {
  id: string; snapshot: string; state: string; run_id: string | null; review_id: number | null; result: string | null; context_complete: number;
  dispatch_attempt: string | null; dispatch_phase: string; dispatch_started: number | null;
  publish_phase: string; publish_attempts: number; publish_lease: string | null; publish_until: number; next_publish: number; review_phase: string; merge_phase: string;
  progress_comment_id: number | null; progress_phase: string; progress_lease: string | null; progress_until: number; progress_attempts: number; progress_next_at: number;
  progress_hash: string | null; progress_reported_stage: string | null; progress_stage: string; failure_code: string | null; failure_stage: string | null; failure_status: number | null;
  workflow_status: string | null; workflow_conclusion: string | null; workflow_checked_at: number;
}
export interface DeliveryRow { id: string; event: string; payload: string; request_id: string; attempts: number; lease: string }
export function retryDelay(attempt: number): number {
  return Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6)) + crypto.getRandomValues(new Uint32Array(1))[0]! % 5000;
}
export class Store {
  constructor(private readonly db: D1Database) {}
  async delivery(id: string, digest: string, event?: string, payload?: string): Promise<boolean> {
    requireCondition(!payload || Buffer.byteLength(payload) <= 80_000, 'webhook_recovery_payload_too_large', 413);
    const result = await this.db.prepare('INSERT OR IGNORE INTO deliveries(id,digest,created_at,event,payload,request_id,phase) VALUES(?,?,?,?,?,?,?)')
      .bind(id, digest, Date.now(), event ?? null, payload ?? null, crypto.randomUUID(), event ? 'pending' : 'done').run();
    return result.meta.changes === 1;
  }
  async claimDelivery(id: string): Promise<DeliveryRow | null> {
    const now = Date.now(), lease = crypto.randomUUID();
    const result = await this.db.prepare(`UPDATE deliveries SET phase='processing',lease=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND phase IN ('pending','retryable','processing') AND lease_until<? AND next_attempt<=? AND attempts<?`)
      .bind(lease, now + RECOVERY_LEASE_MS, id, now, now, MAX_RECOVERY_ATTEMPTS).run();
    return result.meta.changes ? this.db.prepare('SELECT * FROM deliveries WHERE id=? AND lease=?').bind(id, lease).first<DeliveryRow>() : null;
  }
  async finishDelivery(row: DeliveryRow, success: boolean, code = 'external_or_storage_failure'): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET phase=?,lease_until=0,next_attempt=?,error_code=?,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE id=? AND lease=?`)
      .bind(success ? 'done' : row.attempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'retryable', Date.now() + retryDelay(row.attempts), success ? null : code, success ? 1 : 0, row.id, row.lease).run();
  }
  async dueDeliveries(): Promise<string[]> {
    const { results } = await this.db.prepare(`SELECT id FROM deliveries WHERE phase IN ('pending','retryable','processing') AND next_attempt<=? AND lease_until<? AND attempts<? ORDER BY created_at LIMIT 2`)
      .bind(Date.now(), Date.now(), MAX_RECOVERY_ATTEMPTS).all<{ id: string }>();
    return results.map(x => x.id);
  }
  async create(snapshot: RequestSnapshot, trustedWorkflow = ''): Promise<RequestSnapshot> {
    const existing = await this.db.prepare('SELECT snapshot FROM requests WHERE id=?').bind(snapshot.id).first<{ snapshot: string }>();
    if (existing) return JSON.parse(existing.snapshot) as RequestSnapshot;
    const command = { ...snapshot.command }; delete command.rerun;
    const key = await sha256(JSON.stringify({ installation: snapshot.installationId, repository: snapshot.repositoryId, owner: snapshot.ownerId,
      actor: snapshot.actorId, pr: snapshot.pr, head: snapshot.head, base: snapshot.base, branch: snapshot.defaultBranch,
      workflow: snapshot.workflowSha, trustedWorkflow, config: snapshot.config, command, rerun: snapshot.command.rerun ? snapshot.id : null }));
    const q = snapshot.config.quotas, day = Date.now() - 86_400_000, cooldown = Date.now() - q.cooldown_seconds * 1000;
    const result = await this.db.prepare(`INSERT OR IGNORE INTO requests(id,installation_id,repository_id,actor_id,snapshot,created_at,request_key,rerun)
      SELECT ?,?,?,?,?,?,?,? WHERE
      (SELECT count(*) FROM requests WHERE installation_id=? AND actor_id=? AND created_at>?)<? AND
      (SELECT count(*) FROM requests WHERE installation_id=? AND repository_id=? AND created_at>?)<? AND
      (SELECT count(*) FROM requests WHERE installation_id=? AND created_at>?)<? AND
      (SELECT count(*) FROM requests WHERE installation_id=? AND repository_id=? AND state NOT IN ('published','failed') AND created_at>?)<? AND
      (SELECT count(*) FROM requests WHERE installation_id=? AND state NOT IN ('published','failed') AND created_at>?)<? AND
      NOT EXISTS(SELECT 1 FROM requests WHERE installation_id=? AND repository_id=? AND actor_id=? AND created_at>?) AND
      (SELECT count(*) FROM requests WHERE installation_id=? AND actor_id=? AND rerun=1 AND created_at>?)<?`)
      .bind(snapshot.id, snapshot.installationId, snapshot.repositoryId, snapshot.actorId, JSON.stringify(snapshot), snapshot.createdAt, key, snapshot.command.rerun ? 1 : 0,
        snapshot.installationId, snapshot.actorId, day, q.user_per_day, snapshot.installationId, snapshot.repositoryId, day, q.repository_per_day,
        snapshot.installationId, day, q.installation_per_day, snapshot.installationId, snapshot.repositoryId, Date.now() - REQUEST_LIFETIME_MS, q.concurrent_repository,
        snapshot.installationId, Date.now() - REQUEST_LIFETIME_MS, q.concurrent_installation, snapshot.installationId, snapshot.repositoryId, snapshot.actorId, cooldown,
        snapshot.installationId, snapshot.actorId, day, snapshot.command.rerun ? q.reruns_per_day : 1001).run();
    requireCondition(result.meta.changes === 1, 'duplicate_review_or_quota_exceeded', 429);
    return snapshot;
  }
  async get(id: string): Promise<{ row: RequestRow; snapshot: RequestSnapshot }> {
    const row = await this.db.prepare('SELECT * FROM requests WHERE id=?').bind(id).first<RequestRow>(); requireCondition(row, 'request_not_found', 404);
    const snapshot = JSON.parse(row.snapshot) as RequestSnapshot;
    requireCondition(Date.now() - snapshot.createdAt < REQUEST_LIFETIME_MS, 'request_expired', 410); return { row, snapshot };
  }
  async beginDispatch(id: string): Promise<string | null> {
    const attempt = crypto.randomUUID();
    const result = await this.db.prepare(`UPDATE requests SET dispatch_attempt=?,dispatch_phase='sending',dispatch_started=? WHERE id=? AND state='created' AND dispatch_phase='pending'`)
      .bind(attempt, Date.now(), id).run(); return result.meta.changes ? attempt : null;
  }
  async dispatched(id: string): Promise<void> {
    await this.db.prepare(`UPDATE requests SET state=CASE WHEN state='created' THEN 'dispatched' ELSE state END,dispatch_phase='confirmed' WHERE id=? AND state IN ('created','dispatched','running')`).bind(id).run();
  }
  async transition(id: string, from: string, to: string, runId: string | null = null): Promise<boolean> {
    const result = await this.db.prepare('UPDATE requests SET state=?,run_id=COALESCE(run_id,?) WHERE id=? AND state=? AND (run_id IS NULL OR run_id=?)')
      .bind(to, runId, id, from, runId).run(); return result.meta.changes === 1;
  }
  async prepare(id: string, runId: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE requests SET state='running',run_id=COALESCE(run_id,?),prepare_count=prepare_count+1
      WHERE id=? AND state IN ('created','dispatched','running') AND (run_id IS NULL OR run_id=?) AND prepare_count<2 AND result IS NULL`)
      .bind(runId, id, runId).run(); return result.meta.changes === 1;
  }
  async claimPublication(id: string, runId?: string): Promise<string> {
    const lease = crypto.randomUUID(), now = Date.now();
    const result = await this.db.prepare(`UPDATE requests SET state='publishing',publish_phase='publishing',publish_lease=?,publish_until=?,publish_attempts=publish_attempts+1
      WHERE id=? AND (state IN ('reviewed','publishing') OR (state='published' AND merge_phase='queued')) AND publish_until<? AND next_publish<=? AND publish_attempts<? AND (? IS NULL OR run_id=?)`)
      .bind(lease, now + RECOVERY_LEASE_MS, id, now, now, MAX_RECOVERY_ATTEMPTS, runId ?? null, runId ?? null).run();
    requireCondition(result.meta.changes === 1, 'publication_busy_or_terminal', 409); return lease;
  }
  async checkpoint(id: string, lease: string, reviewId: number, phase: 'pending' | 'submitted', merge = 'pending'): Promise<void> {
    const result = await this.db.prepare(`UPDATE requests SET review_id=?,review_phase=?,merge_phase=CASE WHEN ?='pending' AND merge_phase IN ('queued','arming') THEN merge_phase ELSE ? END,publish_until=? WHERE id=? AND publish_lease=? AND publish_until>? AND state='publishing'`)
      .bind(reviewId, phase, merge, merge, Date.now() + RECOVERY_LEASE_MS, id, lease, Date.now()).run();
    requireCondition(result.meta.changes === 1, 'publication_lease_lost', 409);
  }
  async publicationFailed(id: string, lease: string, terminal: boolean): Promise<void> {
    const { row } = await this.get(id);
    await this.db.prepare(`UPDATE requests SET publish_phase=?,state=?,publish_until=0,next_publish=? WHERE id=? AND publish_lease=? AND state='publishing'`)
      .bind(terminal || row.publish_attempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'retryable', terminal || row.publish_attempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'publishing', Date.now() + retryDelay(row.publish_attempts), id, lease).run();
  }
  async heartbeat(id: string, lease: string): Promise<void> {
    const newer = await this.db.prepare(`SELECT 1 FROM requests current JOIN requests newer ON newer.installation_id=current.installation_id AND newer.repository_id=current.repository_id
      AND json_extract(newer.snapshot,'$.pr')=json_extract(current.snapshot,'$.pr') AND newer.created_at>=current.created_at AND newer.id!=current.id WHERE current.id=? LIMIT 1`).bind(id).first();
    requireCondition(!newer, 'review_request_superseded', 409);
    const result = await this.db.prepare(`UPDATE requests SET publish_until=? WHERE id=? AND publish_lease=? AND publish_until>? AND state='publishing'`)
      .bind(Date.now() + RECOVERY_LEASE_MS, id, lease, Date.now()).run(); requireCondition(result.meta.changes === 1, 'publication_lease_lost', 409);
  }
  async published(id: string, reviewId: number, lease: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE requests SET state='published',publish_phase='published',publish_until=0,review_id=?,next_publish=?,publish_attempts=CASE WHEN merge_phase='queued' THEN 0 ELSE publish_attempts END
      WHERE id=? AND state='publishing' AND publish_lease=? AND publish_until>?`).bind(reviewId, Date.now() + 60_000, id, lease, Date.now()).run();
    requireCondition(result.meta.changes === 1, 'publication_lease_lost', 409);
  }
  async duePublications(): Promise<string[]> {
    const { results } = await this.db.prepare(`SELECT id FROM requests WHERE (state='publishing' OR (state='published' AND merge_phase='queued')) AND publish_until<? AND next_publish<=? AND publish_attempts<? AND created_at>? ORDER BY next_publish,created_at LIMIT 1`)
      .bind(Date.now(), Date.now(), MAX_RECOVERY_ATTEMPTS, Date.now() - REQUEST_LIFETIME_MS).all<{ id: string }>(); return results.map(x => x.id);
  }
  async expiredIntent(): Promise<{ id: string; snapshot: RequestSnapshot; lease: string; attempts: number } | null> {
    const lease = crypto.randomUUID(), now = Date.now();
    const row = await this.db.prepare(`UPDATE requests SET publish_lease=?,publish_until=?,publish_attempts=publish_attempts+1 WHERE id=(
      SELECT id FROM requests WHERE merge_phase IN ('queued','arming','cancelling') AND created_at<? AND next_publish<=? AND publish_until<? AND publish_attempts<?
      ORDER BY next_publish,created_at LIMIT 1) RETURNING id,snapshot,publish_attempts`)
      .bind(lease, now + RECOVERY_LEASE_MS, now - REQUEST_LIFETIME_MS, now, now, MAX_RECOVERY_ATTEMPTS).first<{ id: string; snapshot: string; publish_attempts: number }>();
    return row ? { id: row.id, snapshot: JSON.parse(row.snapshot) as RequestSnapshot, lease, attempts: row.publish_attempts } : null;
  }
  async expiryFailed(id: string, lease: string, attempts: number): Promise<void> {
    await this.db.prepare('UPDATE requests SET publish_until=0,next_publish=?,publish_phase=? WHERE id=? AND publish_lease=?')
      .bind(Date.now() + retryDelay(attempts), attempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'retryable', id, lease).run();
  }
  async terminateIntent(id: string, merged = false): Promise<void> {
    await this.db.prepare('UPDATE requests SET merge_phase=?,state=?,publish_phase=? WHERE id=?')
      .bind(merged ? 'merged' : 'cancelled', merged ? 'published' : 'failed', merged ? 'published' : 'failed', id).run();
  }
  async operations(repository: number, installation: number): Promise<unknown> {
    const requests = await this.db.prepare('SELECT id,state,dispatch_phase,publish_phase,merge_phase,publish_attempts,run_id,review_id,progress_comment_id,progress_phase,progress_attempts,failure_code,failure_stage,failure_status FROM requests WHERE repository_id=? AND installation_id=? ORDER BY created_at DESC LIMIT 25').bind(repository, installation).all();
    const deliveries = await this.db.prepare(`SELECT id,phase,attempts,error_code,request_id FROM deliveries WHERE json_extract(payload,'$.repository.id')=? AND json_extract(payload,'$.installation.id')=? ORDER BY created_at DESC LIMIT 25`).bind(repository, installation).all();
    return { requests: requests.results, deliveries: deliveries.results };
  }
  async operatorRetry(id: string, repository: number, installation: number): Promise<void> {
    const result = await this.db.prepare(`UPDATE deliveries SET phase='retryable',attempts=0,lease_until=0,next_attempt=0,operator_retries=operator_retries+1
      WHERE id=? AND phase IN ('failed','retryable') AND operator_retries<2 AND json_extract(payload,'$.repository.id')=? AND json_extract(payload,'$.installation.id')=?`)
      .bind(id, repository, installation).run();
    if (result.meta.changes) return;
    const publication = await this.db.prepare(`UPDATE requests SET state='publishing',publish_phase='retryable',publish_until=0,next_publish=0,publish_attempts=0,operator_retries=operator_retries+1
      WHERE id=? AND repository_id=? AND installation_id=? AND publish_phase IN ('failed','retryable') AND publish_attempts>0 AND merge_phase NOT IN ('cancelled','cancelling') AND operator_retries<2 AND created_at>? AND result IS NOT NULL`)
      .bind(id, repository, installation, Date.now() - REQUEST_LIFETIME_MS).run();
    requireCondition(publication.meta.changes === 1, 'retry_not_allowed_or_limit_reached', 409);
  }
  async operatorRetryProgress(id: string, repository: number, installation: number): Promise<void> {
    // Never reset an ambiguous POST to pending or recreate a deleted comment.
    const result = await this.db.prepare(`UPDATE requests SET progress_attempts=0,progress_next_at=0,operator_retries=operator_retries+1 WHERE id=? AND repository_id=? AND installation_id=?
      AND progress_until<? AND progress_phase!='deleted' AND progress_attempts>=? AND operator_retries<2 AND created_at>?`)
      .bind(id, repository, installation, Date.now(), MAX_RECOVERY_ATTEMPTS, Date.now() - 7 * 86_400_000).run();
    requireCondition(result.meta.changes === 1, 'progress_retry_not_allowed_or_limit_reached', 409);
  }
  async cancellable(id: string, repository: number, installation: number): Promise<RequestSnapshot> {
    // Claim cancellation atomically before remote cleanup; a publisher cannot acquire afterwards.
    const row = await this.db.prepare(`UPDATE requests SET state='failed',publish_phase='failed',merge_phase='cancelling' WHERE id=? AND repository_id=? AND installation_id=? AND publish_until<?
      AND (state IN ('reviewed','publishing','published','failed') OR created_at<?) RETURNING snapshot`)
      .bind(id, repository, installation, Date.now(), Date.now() - REQUEST_LIFETIME_MS).first<{ snapshot: string }>();
    requireCondition(row, 'request_active_missing_or_foreign', 409); return JSON.parse(row.snapshot) as RequestSnapshot;
  }
  async result(id: string, output: unknown, complete: boolean, runId: string): Promise<void> {
    const { snapshot, row } = await this.get(id), encoded = JSON.stringify(normalizeReview(output, snapshot.head));
    requireCondition(Buffer.byteLength(encoded) <= MAX_REVIEW_BYTES, 'review_output_too_large');
    if (row.run_id === runId && row.result === encoded && row.context_complete === (complete ? 1 : 0) && ['reviewed','publishing','published'].includes(row.state)) return;
    const result = await this.db.prepare(`UPDATE requests SET state='reviewed',result=?,context_complete=? WHERE id=? AND state='running' AND run_id=?`)
      .bind(encoded, complete ? 1 : 0, id, runId).run(); requireCondition(result.meta.changes === 1, 'review_result_already_recorded', 409);
  }
  async removeInstallation(id: number): Promise<void> {
    await this.db.batch([this.db.prepare('DELETE FROM sessions WHERE installation_id=?').bind(id), this.db.prepare('DELETE FROM requests WHERE installation_id=?').bind(id), this.db.prepare('DELETE FROM legacy_sessions WHERE installation_id=?').bind(id)]);
  }
  async removeRepository(repositoryId: number, installationId: number): Promise<void> {
    await this.db.batch([this.db.prepare('DELETE FROM sessions WHERE repository_id=? AND installation_id=?').bind(repositoryId, installationId),
      this.db.prepare('DELETE FROM requests WHERE repository_id=? AND installation_id=?').bind(repositoryId, installationId),
      this.db.prepare('DELETE FROM legacy_sessions WHERE repository_id=? AND installation_id=?').bind(repositoryId, installationId)]);
  }
  async session(repositoryId: number, actorId: number, installationId: number): Promise<{ envelope: Envelope; version: number } | null> {
    const row = await this.db.prepare('SELECT envelope,version FROM sessions WHERE repository_id=? AND actor_id=? AND installation_id=?').bind(repositoryId, actorId, installationId).first<{ envelope: string; version: number }>();
    return row ? { envelope: JSON.parse(row.envelope) as Envelope, version: row.version } : null;
  }
  async saveSession(repositoryId: number, actorId: number, envelope: Envelope, installationId: number): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO sessions(repository_id,actor_id,envelope,installation_id) VALUES(?,?,?,?)
      ON CONFLICT(installation_id,repository_id,actor_id) DO UPDATE SET envelope=excluded.envelope,version=sessions.version+1 WHERE sessions.lease_until<?`)
      .bind(repositoryId, actorId, JSON.stringify(envelope), installationId, Date.now()).run(); requireCondition(result.meta.changes === 1, 'session_busy', 409);
  }
  async acquire(snapshot: RequestSnapshot): Promise<void> {
    const result = await this.db.prepare('UPDATE sessions SET lease_request=?,lease_until=? WHERE repository_id=? AND actor_id=? AND installation_id=? AND (lease_until<? OR lease_request=?)')
      .bind(snapshot.id, Date.now() + REQUEST_LIFETIME_MS, snapshot.repositoryId, snapshot.actorId, snapshot.installationId, Date.now(), snapshot.id).run(); requireCondition(result.meta.changes === 1, 'session_missing_or_in_use', 409);
  }
  async rotate(snapshot: RequestSnapshot, version: number, envelope: Envelope): Promise<void> {
    const result = await this.db.prepare('UPDATE sessions SET envelope=?,version=version+1 WHERE repository_id=? AND actor_id=? AND installation_id=? AND version=? AND lease_request=? AND lease_until>?')
      .bind(JSON.stringify(envelope), snapshot.repositoryId, snapshot.actorId, snapshot.installationId, version, snapshot.id, Date.now()).run(); requireCondition(result.meta.changes === 1, 'session_rotation_conflict_reconnect_required', 409);
  }
  async deleteSession(repositoryId: number, actorId: number, installationId: number): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE repository_id=? AND actor_id=? AND installation_id=?').bind(repositoryId, actorId, installationId).run();
  }
  async release(snapshot: RequestSnapshot): Promise<void> {
    await this.db.prepare('UPDATE sessions SET lease_request=NULL,lease_until=0 WHERE repository_id=? AND actor_id=? AND installation_id=? AND lease_request=?')
      .bind(snapshot.repositoryId, snapshot.actorId, snapshot.installationId, snapshot.id).run();
  }
  async progressRequest(id: string): Promise<{ row: RequestRow; snapshot: RequestSnapshot } | null> {
    const row = await this.db.prepare('SELECT * FROM requests WHERE id=?').bind(id).first<RequestRow>();
    return row ? { row, snapshot: JSON.parse(row.snapshot) as RequestSnapshot } : null;
  }
  async stage(id: string, runId: string, stage: 'analyzing'): Promise<void> {
    const result = await this.db.prepare(`UPDATE requests SET progress_stage=? WHERE id=? AND run_id=? AND state='running'`).bind(stage, id, runId).run();
    requireCondition(result.meta.changes === 1, 'request_not_running', 409);
  }
  async failRun(id: string, runId: string, code: string, stage: string, status: number | null = null): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE requests SET state='failed',publish_phase='failed',progress_stage='failed',failure_code=?,failure_stage=?,failure_status=?,run_id=COALESCE(run_id,?)
      WHERE id=? AND state IN ('created','dispatched','running','reviewed') AND (run_id IS NULL OR run_id=?) AND publish_attempts=0`)
      .bind(code, stage, status, runId, id, runId).run(); return result.meta.changes === 1;
  }
  async noteFailure(id: string, runId: string, code: string, stage: string, status: number | null = null): Promise<void> {
    await this.db.prepare(`UPDATE requests SET failure_code=?,failure_stage=?,failure_status=?,context_complete=CASE WHEN ?='review_job_failed' THEN 0 ELSE context_complete END WHERE id=? AND run_id=?`)
      .bind(code, stage, status, code, id, runId).run();
  }
  async observeRun(id: string, runId: string, status: string, conclusion: string | null): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE requests SET run_id=COALESCE(run_id,?),workflow_status=?,workflow_conclusion=?,workflow_checked_at=? WHERE id=? AND (run_id IS NULL OR run_id=?)`)
      .bind(runId, status, conclusion, Date.now(), id, runId).run(); return result.meta.changes === 1;
  }
  async claimProgress(id: string): Promise<string | null> {
    const lease = crypto.randomUUID(), now = Date.now();
    const result = await this.db.prepare(`UPDATE requests SET progress_lease=?,progress_until=? WHERE id=? AND progress_until<? AND progress_next_at<=? AND progress_attempts<? AND progress_phase NOT IN ('deleted','disabled')`)
      .bind(lease, now + RECOVERY_LEASE_MS, id, now, now, MAX_RECOVERY_ATTEMPTS).run();
    return result.meta.changes === 1 ? lease : null;
  }
  async progressCreating(id: string, lease: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE requests SET progress_phase='creating' WHERE id=? AND progress_lease=? AND progress_until>? AND progress_comment_id IS NULL AND progress_phase='pending'`)
      .bind(id, lease, Date.now()).run(); requireCondition(result.meta.changes === 1, 'progress_creation_lease_lost', 409);
  }
  async progressWriteAllowed(id: string, lease: string): Promise<void> {
    const row = await this.db.prepare('SELECT 1 FROM requests WHERE id=? AND progress_lease=? AND progress_until>?').bind(id, lease, Date.now()).first();
    requireCondition(row, 'progress_update_lease_lost', 409);
  }
  async progressSaved(id: string, lease: string, commentId: number, hash: string, stage: string, keepFailures = false): Promise<void> {
    const result = await this.db.prepare(`UPDATE requests SET progress_comment_id=?,progress_phase='ready',progress_hash=?,progress_reported_stage=?,progress_attempts=CASE WHEN ? THEN progress_attempts ELSE 0 END,progress_until=0,progress_next_at=? WHERE id=? AND progress_lease=? AND progress_until>?`)
      .bind(commentId, hash, stage, keepFailures ? 1 : 0, Date.now() + 15_000, id, lease, Date.now()).run(); requireCondition(result.meta.changes === 1, 'progress_update_lease_lost', 409);
  }
  async progressDeferred(id: string, lease: string, options: { deleted?: boolean; definitive?: boolean; failed?: boolean } = {}): Promise<void> {
    await this.db.prepare(`UPDATE requests SET progress_phase=CASE WHEN ? THEN 'deleted' WHEN ? AND progress_comment_id IS NULL THEN 'pending' ELSE progress_phase END,
      progress_until=0,progress_attempts=progress_attempts+?,progress_next_at=? WHERE id=? AND progress_lease=?`)
      .bind(options.deleted ? 1 : 0, options.definitive ? 1 : 0, options.failed ? 1 : 0, Date.now() + (options.failed ? 60_000 : 15_000), id, lease).run();
  }
  async dueProgress(): Promise<string | null> {
    const row = await this.db.prepare(`SELECT id FROM requests WHERE progress_until<? AND progress_next_at<=? AND progress_attempts<? AND progress_phase NOT IN ('deleted','disabled')
      AND created_at>? AND NOT (state IN ('published','failed') AND progress_phase='ready' AND progress_reported_stage=CASE WHEN state='failed' OR failure_code IS NOT NULL THEN 'failed' ELSE 'completed' END
        AND (COALESCE(workflow_status,'')='completed' OR (run_id IS NULL AND created_at<?)))
      ORDER BY progress_next_at,created_at LIMIT 1`).bind(Date.now(), Date.now(), MAX_RECOVERY_ATTEMPTS, Date.now() - 7 * 86_400_000, Date.now() - REQUEST_LIFETIME_MS).first<{ id: string }>();
    return row?.id ?? null;
  }
  async cleanup(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE deliveries SET phase='failed',lease_until=0 WHERE phase='processing' AND lease_until<? AND attempts>=?`).bind(Date.now(), MAX_RECOVERY_ATTEMPTS),
      this.db.prepare(`UPDATE requests SET state='failed',publish_phase='failed' WHERE state='publishing' AND publish_until<? AND publish_attempts>=?`).bind(Date.now(), MAX_RECOVERY_ATTEMPTS),
      this.db.prepare(`UPDATE requests SET state='failed',publish_phase='failed',failure_code=COALESCE(failure_code,'request_expired') WHERE state IN ('created','dispatched','running','reviewed','publishing') AND created_at<? AND merge_phase NOT IN ('queued','arming','cancelling')`).bind(Date.now() - REQUEST_LIFETIME_MS),
      this.db.prepare(`UPDATE sessions SET lease_request=NULL,lease_until=0 WHERE lease_request IS NOT NULL AND (lease_until<? OR EXISTS(SELECT 1 FROM requests WHERE requests.id=sessions.lease_request AND requests.state IN ('published','failed')))`)
        .bind(Date.now()),
      this.db.prepare('DELETE FROM deliveries WHERE created_at<?').bind(Date.now() - 7 * 86_400_000),
      this.db.prepare("DELETE FROM requests WHERE created_at<? AND merge_phase NOT IN ('queued','arming','cancelling')").bind(Date.now() - 7 * 86_400_000), this.db.prepare('DELETE FROM legacy_sessions')]);
  }
}
