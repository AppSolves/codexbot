import { AppError } from './errors.js';
import { ExecutionError, executionFailure, type ExecutionFailure } from './execution.js';

export const REVIEW_STAGES = ['environment','prepare','context','credentials','analyzing','result','publish','release'] as const;
export const FAILURE_CODES = new Set(['missing_environment_credentials','ambiguous_environment_credentials','credential_owner_mismatch','missing_read_token',
  'api_key_missing_or_ambiguous_credentials','vault_key_missing_or_ambiguous_credentials','invalid_envelope','invalid_vault_key','invalid_saved_session',
  'review_incomplete','review_context_incomplete','review_output_invalid',
  'session_too_short_reconnect_required','review_image_missing','isolated_review_failed','proxy_start_failed','docker_unavailable','docker_cleanup_failed_check_runner',
  'oauth_grant_invalid_reconnect_required','chatgpt_plan_usage_permission_missing','oauth_token_endpoint_failed','oauth_token_exchange_uncertain_reconnect_required',
  'invalid_saved_registration','invalid_saved_expiry','oauth_invalid_credential','oauth_invalid_expiry','oauth_invalid_refresh_time',
  'oauth_refresh_account_mismatch','oauth_refresh_authorized_party_mismatch','codex_turn_failed','codex_rpc_rejected','codex_output_not_json',
  'effort_not_supported_by_selected_model','configured_model_not_in_codex_catalog','diff_truncated','pr_changed_during_context_collection',
  'broker_prepare_failed','broker_result_failed','broker_rotate_failed','broker_publish_failed','broker_stage_failed','broker_release_failed',
  'ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOENT','EACCES','EPERM','ENOSPC','EPIPE',
  'session_rotation_conflict_reconnect_required','review_preflight_failed','external_or_execution_failure']);
const OPERATIONS = new Set(['prepare','result','rotate','publish','release','failure','stage','check']);
export const BROKER_CODES = new Set(`
bearer_required request_not_found request_expired invalid_webhook_signature installation_no_longer_valid request_bound_to_another_run repository_admin_required
oidc_repository_mismatch oidc_event_mismatch oidc_caller_workflow_mismatch oidc_reusable_workflow_mismatch oidc_environment_mismatch oidc_subject_mismatch
oidc_run_missing oidc_invalid_run_identity oidc_token_expired oidc_token_invalid oidc_jwks_unavailable
workflow_run_mismatch workflow_not_dispatched_by_this_app workflow_dispatch_attempt_mismatch
chatgpt_deployment_authorization_revoked use_authorized_rerun_command_instead_of_workflow_rerun request_already_started stale_pull_request
trusted_default_branch_changed_or_unprotected review_authorization_revoked session_missing_or_in_use chatgpt_session_not_connected
request_not_running review_result_already_recorded request_not_ready_for_publication publication_busy_or_terminal internal_error
github_actions_oidc_unavailable invalid_oidc_endpoint github_oidc_request_failed github_oidc_missing_token invalid_request_id invalid_broker_operation
`.trim().split(/\s+/));
export class BrokerError extends AppError {
  constructor(public readonly operation: string, status: number, public readonly remoteCode: string | null) { super(`broker_${operation}_failed`, status); }
}
export function diagnostic(error: unknown, stage: string): { event: string; stage: string; code: string; status?: number; broker_code?: string; execution?: ExecutionFailure; proxy_failure?: ExecutionFailure } {
  const result: ReturnType<typeof diagnostic> = {
    event: 'review_failed', stage: REVIEW_STAGES.includes(stage as typeof REVIEW_STAGES[number]) ? stage : 'environment', code: 'external_or_execution_failure'
  };
  if (error instanceof ExecutionError) {
    result.code = error.code;
    result.execution = executionFailure(error.detail)!;
    const proxy = executionFailure(error.proxyFailure);
    if (proxy) result.proxy_failure = proxy;
    return result;
  }
  if (error instanceof BrokerError && OPERATIONS.has(error.operation)) {
    result.code = error.code;
    if (error.remoteCode && BROKER_CODES.has(error.remoteCode)) result.broker_code = error.remoteCode;
  } else if (error instanceof AppError && (FAILURE_CODES.has(error.code) || BROKER_CODES.has(error.code))) result.code = error.code;
  else {
    const codes = new Set(['ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOENT','EACCES','EPERM','ENOSPC','EPIPE']);
    let cause: unknown = error;
    for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && typeof cause.code === 'string' && codes.has(cause.code)) { result.code = cause.code; break; }
      cause = 'cause' in cause ? cause.cause : null;
    }
  }
  // AppError's default 400 is a local validation status, not an upstream HTTP response.
  if ((error instanceof BrokerError || !(error instanceof AppError) || error.code === 'github_oidc_request_failed') && error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) result.status = error.status;
  return result;
}
