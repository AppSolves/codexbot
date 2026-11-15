import { AppError, requireCondition } from '../core/errors.js';
import { sha256 } from '../core/crypto.js';
import { REQUEST_LIFETIME_MS } from '../core/limits.js';
import type { RequestSnapshot } from './store.js';

export const QUOTA_WINDOW_MS = 86_400_000;
export type RejectionCode = 'rerun_limit_exceeded' | 'user_quota_exceeded' | 'repository_quota_exceeded' | 'installation_quota_exceeded' |
  'repository_concurrency_exceeded' | 'installation_concurrency_exceeded' | 'cooldown_active' | 'duplicate_review' |
  'invalid_command' | 'merge_not_authorized' | 'rerun_requires_write_permission' | 'pr_not_reviewable' | 'chatgpt_deployment_not_authorized';
export interface RejectionIdentity {
  id: string; installationId: number; repositoryId: number; ownerId: number; repository: string; pr: number; actor: string; actorId: number; commandId?: number;
}
export interface RejectionRow {
  id: string; request_id: string; identity: string; outcome: RejectionCode; quota: number | null; window_ms: number | null; retry_at: number | null;
  created_at: number; phase: string; comment_id: number | null; lease: string | null; lease_until: number; attempts: number;
}
export class AdmissionError extends AppError {
  constructor(public readonly rejection: RejectionRow) { super(rejection.outcome, 429); }
}
export async function rejectionId(identity: RejectionIdentity): Promise<string> {
  return sha256(JSON.stringify([identity.installationId, identity.repositoryId, identity.actorId, identity.commandId ?? identity.id]));
}
export function rejectionIdentity(value: RejectionIdentity): RejectionIdentity {
  return { id: value.id, installationId: value.installationId, repositoryId: value.repositoryId, ownerId: value.ownerId,
    repository: value.repository, pr: value.pr, actor: value.actor, actorId: value.actorId, ...(value.commandId ? { commandId: value.commandId } : {}) };
}
/** Run immediately after the guarded INSERT in the SAME D1 batch/transaction. */
export async function admissionRejection(db: D1Database, snapshot: RequestSnapshot, key: string, now: number, feedback: boolean): Promise<D1PreparedStatement> {
  const q = snapshot.config.quotas, day = now - QUOTA_WINDOW_MS;
  const candidates: { code: RejectionCode; where: string; args: number[]; limit: number | 'unlimited'; window: number | null }[] = [
    ...(snapshot.command.rerun ? [{ code: 'rerun_limit_exceeded' as const, where: 'installation_id=? AND actor_id=? AND rerun=1 AND created_at>?', args: [snapshot.installationId,snapshot.actorId,day], limit: q.reruns_per_day, window: QUOTA_WINDOW_MS }] : []),
    { code: 'user_quota_exceeded', where: 'installation_id=? AND actor_id=? AND created_at>?', args: [snapshot.installationId,snapshot.actorId,day], limit: q.user_per_day, window: QUOTA_WINDOW_MS },
    { code: 'repository_quota_exceeded', where: 'installation_id=? AND repository_id=? AND created_at>?', args: [snapshot.installationId,snapshot.repositoryId,day], limit: q.repository_per_day, window: QUOTA_WINDOW_MS },
    { code: 'installation_quota_exceeded', where: 'installation_id=? AND created_at>?', args: [snapshot.installationId,day], limit: q.installation_per_day, window: QUOTA_WINDOW_MS },
    { code: 'repository_concurrency_exceeded', where: "installation_id=? AND repository_id=? AND state NOT IN ('published','failed') AND created_at>?", args: [snapshot.installationId,snapshot.repositoryId,now-REQUEST_LIFETIME_MS], limit: q.concurrent_repository, window: null },
    { code: 'installation_concurrency_exceeded', where: "installation_id=? AND state NOT IN ('published','failed') AND created_at>?", args: [snapshot.installationId,now-REQUEST_LIFETIME_MS], limit: q.concurrent_installation, window: null },
    { code: 'cooldown_active', where: 'installation_id=? AND repository_id=? AND actor_id=? AND created_at>?', args: [snapshot.installationId,snapshot.repositoryId,snapshot.actorId,now-q.cooldown_seconds*1000], limit: 1, window: q.cooldown_seconds*1000 }
  ];
  // VALUES avoids D1's small compound-SELECT limit; all policy predicates stay in the admission transaction.
  const args: (string | number | null)[] = [], choices = candidates.flatMap((candidate,index) => {
    if(candidate.limit==='unlimited')return [];

    const retry = candidate.window === null ? 'NULL' : `(SELECT created_at+? FROM requests WHERE ${candidate.where} ORDER BY created_at DESC LIMIT 1 OFFSET ?)`;
    if (candidate.window !== null) args.push(candidate.window,...candidate.args,candidate.limit-1);
    args.push(...candidate.args,candidate.limit);
    return [`(${index+1},'${candidate.code}',${candidate.limit},${candidate.window ?? 'NULL'},${retry},(SELECT count(*) FROM requests WHERE ${candidate.where})>=?)`];
  });
  // Duplicate identity wins even if other limits also apply; no time-based promise can unblock it.
  choices.unshift("(0,'duplicate_review',NULL,NULL,NULL,EXISTS(SELECT 1 FROM requests WHERE request_key=?))");
  args.unshift(key);
  return db.prepare(`WITH checks(priority,outcome,quota,window_ms,retry_at,blocked) AS (VALUES ${choices.join(',')})
    INSERT OR IGNORE INTO review_rejections(id,request_id,installation_id,repository_id,identity,outcome,quota,window_ms,retry_at,created_at,phase)
    SELECT ?,?,?,?,?,outcome,quota,window_ms,retry_at,?,? FROM checks
    WHERE blocked AND NOT EXISTS(SELECT 1 FROM requests WHERE id=? OR (installation_id=? AND repository_id=? AND actor_id=? AND json_extract(snapshot,'$.commandId')=?)) ORDER BY priority LIMIT 1`)
    .bind(...args,await rejectionId(snapshot),snapshot.id,snapshot.installationId,snapshot.repositoryId,JSON.stringify(rejectionIdentity(snapshot)),now,feedback ? 'pending' : 'done',snapshot.id,snapshot.installationId,snapshot.repositoryId,snapshot.actorId,snapshot.commandId ?? null);
}
export async function getRejection(db: D1Database, id: string): Promise<RejectionRow | null> {
  return db.prepare('SELECT * FROM review_rejections WHERE id=? OR request_id=?').bind(id,id).first<RejectionRow>();
}
export async function recordRejection(db: D1Database, identity: RejectionIdentity, outcome: RejectionCode): Promise<RejectionRow> {
  const id = await rejectionId(identity);
  await db.prepare('INSERT OR IGNORE INTO review_rejections(id,request_id,installation_id,repository_id,identity,outcome,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id,identity.id,identity.installationId,identity.repositoryId,JSON.stringify(rejectionIdentity(identity)),outcome,Date.now()).run();
  const row = await getRejection(db,id); requireCondition(row,'admission_outcome_missing',503); return row;
}
