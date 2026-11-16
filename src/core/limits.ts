import {requireCondition} from './errors.js';

// One contract from model stdout through transport and persisted publication evidence.
export const MAX_RAW_REVIEW_BYTES = 2_000_000;
export const MAX_REVIEW_BYTES = 60_000;
export const MAX_RESULT_BODY_BYTES = MAX_REVIEW_BYTES + 6_000;
export const DEFAULT_REVIEW_TIMEOUT_MINUTES = 30;
// GitHub-hosted jobs stop at six hours; reserve refresh eligibility and setup/cleanup time.
export const REVIEW_JOB_TIMEOUT_MINUTES = 360;
export const MAX_REVIEW_TIMEOUT_MINUTES = REVIEW_JOB_TIMEOUT_MINUTES-25-5;
export const REVIEW_CLEANUP_MS = 2 * 60_000;
export function reviewTimeoutMs(snapshot:{command:{timeout_minutes?:number};config:{review:{timeout_minutes?:number}}}):number {
  const minutes=snapshot.command.timeout_minutes??snapshot.config.review.timeout_minutes??DEFAULT_REVIEW_TIMEOUT_MINUTES;
  requireCondition(Number.isSafeInteger(minutes)&&minutes>=1,'review_timeout_must_be_positive_minutes');
  requireCondition(minutes<=MAX_REVIEW_TIMEOUT_MINUTES,'review_timeout_exceeds_github_actions_job_limit');
  return minutes*60_000;
}
export const REQUEST_OVERHEAD_MS = 60 * 60_000;
export function requestLifetimeMs(snapshot:Parameters<typeof reviewTimeoutMs>[0]):number {return reviewTimeoutMs(snapshot)+REQUEST_OVERHEAD_MS;}
export const MERGE_INTENT_LIFETIME_MS = 60 * 60_000;
export const RECOVERY_LEASE_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 5;
export const MAX_CONTEXT_REQUESTS = 100;
export const MAX_CONTEXT_PATHS = 24;
