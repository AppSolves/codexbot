import { AppError } from './errors.js';
import { ExecutionError, executionFailure, proxyRequestDiagnostic, UNFINISHED_REASONS, type ProxyRequestDiagnostic, type ExecutionFailure } from './execution.js';
import { MAX_CONTEXT_PATHS, MAX_CONTEXT_REQUESTS } from './limits.js';

export const REVIEW_STAGES = ['environment','prepare','context','credentials','analyzing','result','publish','release'] as const;
export const FAILURE_CODES = new Set(['missing_environment_credentials','ambiguous_environment_credentials','credential_owner_mismatch','missing_read_token',
  'api_key_missing_or_ambiguous_credentials','vault_key_missing_or_ambiguous_credentials','invalid_envelope','invalid_vault_key','invalid_saved_session',
  'review_plan_unverifiable','review_plan_budget','review_coverage_invalid','context_path_missing','context_special_object','context_github_api_failed','context_lookup_rejected','context_lookup_limit','context_request_limit','context_api_budget','context_collection_timeout','context_diff_size_limit','context_text_patch_truncated','context_unsupported_binary','context_binary_unverifiable','context_binary_size_limit','context_non_text_source','context_missing_dependency','context_file_size_limit','context_byte_budget','context_required_evidence_unavailable','required_file_missing_or_special','blob_integrity_failure','required_tree_unverifiable','review_incomplete','review_context_incomplete','review_output_invalid','read_token_cleanup_failed',
  'oauth_refresh_too_early','oauth_refresh_window_unavailable',
  'session_too_short_reconnect_required','session_too_short_for_requested_timeout','review_timeout_must_be_positive_minutes','review_timeout_exceeds_github_actions_job_limit','review_image_missing','isolated_review_failed','proxy_start_failed','docker_unavailable','docker_cleanup_failed_check_runner',
  'oauth_grant_invalid_reconnect_required','chatgpt_plan_usage_permission_missing','oauth_token_endpoint_failed','oauth_token_exchange_uncertain_reconnect_required',
  'invalid_saved_registration','invalid_saved_expiry','oauth_invalid_credential','oauth_invalid_expiry','oauth_invalid_refresh_time',
  'oauth_refresh_account_mismatch','oauth_refresh_authorized_party_mismatch','codex_turn_failed','codex_rpc_rejected','codex_output_not_json',
  'effort_not_supported_by_selected_model','configured_model_not_in_codex_catalog','diff_truncated','pr_changed_during_context_collection',
  'broker_prepare_failed','broker_result_failed','broker_rotate_failed','broker_renew_failed','broker_publish_failed','broker_stage_failed','broker_release_failed',
  'ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOENT','EACCES','EPERM','ENOSPC','EPIPE',
  'session_rotation_conflict_reconnect_required','review_preflight_failed','external_or_execution_failure']);
const OPERATIONS = new Set(['prepare','result','rotate','renew','publish','release','failure','stage','check']);
export const BROKER_CODES = new Set(`
bearer_required request_not_found request_expired invalid_webhook_signature installation_no_longer_valid request_bound_to_another_run repository_admin_required
oidc_repository_mismatch oidc_event_mismatch oidc_caller_workflow_mismatch oidc_reusable_workflow_mismatch oidc_environment_mismatch oidc_subject_mismatch
oidc_run_missing oidc_invalid_run_identity oidc_token_expired oidc_token_invalid oidc_jwks_unavailable
workflow_run_mismatch workflow_not_dispatched_by_this_app workflow_dispatch_attempt_mismatch
automatic_review_authorization_revoked chatgpt_deployment_authorization_revoked use_authorized_rerun_command_instead_of_workflow_rerun request_already_started stale_pull_request
trusted_default_branch_changed_or_unprotected review_authorization_revoked session_missing_or_in_use chatgpt_session_not_connected
hosted_connection_requires_reconnect hosted_refresh_reconnect_required hosted_session_unavailable hosted_session_identity_changed repository_operation_in_progress
hosted_oauth_registration_not_configured hosted_inference_scopes_not_configured hosted_workspace_claim_not_configured oauth_refresh_workspace_mismatch
request_not_running review_result_already_recorded request_not_ready_for_publication publication_busy_or_terminal internal_error
github_actions_oidc_unavailable invalid_oidc_endpoint github_oidc_request_failed github_oidc_missing_token invalid_request_id invalid_broker_operation
`.trim().split(/\s+/));
export class BrokerError extends AppError {
  constructor(public readonly operation: string, status: number, public readonly remoteCode: string | null) { super(`broker_${operation}_failed`, status); }
}
export interface ContextLookupStats { requests:number; paths:number; cache_hits:number; last_failure?:string }
export interface ReviewCompletion {
  context_complete: boolean; diff_complete: boolean; required_context_complete: boolean;
  output_complete: boolean; output_result: 'clean' | 'findings' | 'inconclusive'; quarantined: boolean; output_truncated: boolean;
  context_failure_code?: string;
  context_lookups?: ContextLookupStats;
  orchestration?: { planned_units:number; completed_units:number; synthesis_complete:boolean; unfinished_reasons: typeof UNFINISHED_REASONS[number][] };
}
/** Only fixed completion conditions leave the trusted runner, never paths or model text. */
export class ReviewCompletionError extends AppError {
  readonly completion: ReviewCompletion;
  constructor(value: ReviewCompletion) {
    super('review_incomplete');
    this.completion={context_complete:value.context_complete===true,diff_complete:value.diff_complete===true,required_context_complete:value.required_context_complete===true,
      output_complete:value.output_complete===true,output_result:value.output_result==='clean'?'clean':value.output_result==='findings'?'findings':'inconclusive',quarantined:value.quarantined===true,output_truncated:value.output_truncated===true,
      ...(typeof value.context_failure_code==='string'&&FAILURE_CODES.has(value.context_failure_code)?{context_failure_code:value.context_failure_code}:{})};
    const lookups=value.context_lookups;
    if(lookups&&Number.isInteger(lookups.requests)&&lookups.requests>=0&&lookups.requests<=MAX_CONTEXT_REQUESTS+1&&Number.isInteger(lookups.paths)&&lookups.paths>=0&&lookups.paths<=MAX_CONTEXT_PATHS&&Number.isInteger(lookups.cache_hits)&&lookups.cache_hits>=0&&lookups.cache_hits<=MAX_CONTEXT_REQUESTS)this.completion.context_lookups={requests:lookups.requests,paths:lookups.paths,cache_hits:lookups.cache_hits,...(typeof lookups.last_failure==='string'&&FAILURE_CODES.has(lookups.last_failure)?{last_failure:lookups.last_failure}:{})};
    const coverage=value.orchestration;
    if(coverage&&Number.isInteger(coverage.planned_units)&&coverage.planned_units>=1&&coverage.planned_units<=32&&Number.isInteger(coverage.completed_units)&&coverage.completed_units>=0&&coverage.completed_units<=coverage.planned_units)this.completion.orchestration={planned_units:coverage.planned_units,completed_units:coverage.completed_units,synthesis_complete:coverage.synthesis_complete===true,unfinished_reasons:Array.isArray(coverage.unfinished_reasons)?[...new Set(coverage.unfinished_reasons.filter(r=>UNFINISHED_REASONS.includes(r)))].slice(0,UNFINISHED_REASONS.length):[]};
  }
}
export function diagnostic(error: unknown, stage: string, completion?: ReviewCompletion): { event: string; stage: string; code: string; status?: number; broker_code?: string; execution?: ExecutionFailure; proxy_failure?: ExecutionFailure; proxy_cleanup?: ExecutionFailure; proxy_request?: Omit<ProxyRequestDiagnostic,'primary'|'cleanup'>; completion?: ReviewCompletion } {
  const result: ReturnType<typeof diagnostic> = {
    event: 'review_failed', stage: REVIEW_STAGES.includes(stage as typeof REVIEW_STAGES[number]) ? stage : 'environment', code: 'external_or_execution_failure',...(completion?{completion:new ReviewCompletionError(completion).completion}:{})
  };
  if(error instanceof ReviewCompletionError){result.code=error.code;result.completion=error.completion;return result;}
  if (error instanceof ExecutionError) {
    result.code = error.code;
    result.execution = executionFailure(error.detail)!;
    const request=proxyRequestDiagnostic(error.proxyRequest);
    if(request){const {primary,cleanup,...state}=request;result.proxy_request=state;if(primary)result.proxy_failure=primary;if(cleanup)result.proxy_cleanup=cleanup;}
    else {const proxy=executionFailure(error.proxyFailure),cleanup=executionFailure(error.proxyCleanup);if(proxy)result.proxy_failure=proxy;if(cleanup)result.proxy_cleanup=cleanup;}
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
