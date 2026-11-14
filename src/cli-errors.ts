import { AppError } from './core/errors.js';
import { getSystemErrorMap } from 'node:util';

// Only known diagnostic codes are public. Messages, stacks, headers and arbitrary
// provider fields can contain credentials, even when an SDK has already masked them.
const APP_CODES = new Set(`
usage_setup_connect_connect_api_key_or_disconnect_with_repository_and_backend
invalid_repository backend_requires_https_origin repository_admin_required invalid_object
github_cli_failed_check_auth_and_permissions app_setup_failed_workflows_permission_required_or_use_setup_as_user
capability_preflight_failed_check_plan_environment_permissions_or_GitHub_availability
chatgpt_deployment_authorization_required_before_sign_in invalid_live_installation
set_CODEXBOT_API_KEY_in_process_environment cannot_load_latest_session_for_revocation disconnect_failed
cannot_list_credential_secrets_for_disconnect disconnect_current_account_before_switching
session_provisioning_failed_check_backend_deployment_authorization
callback_not_ready callback_listener_failed oauth_attempt_expired oauth_client_id_mismatch
windows_acl_system_root_missing cannot_secure_windows_credential_acl credential_file_locked_close_other_process_or_recover_lock
protect_default_branch_before_storing_credentials protect_existing_credential_environment_before_connecting
credential_environment_must_allow_only_trusted_default_branch repository_admin_required_for_capability_probe
environment_capability_temporarily_unavailable private_repository_environments_require_Pro_Team_Enterprise_and_admin_access
environment_capability_probe_failed_check_admin_access workflow_ref_must_be_full_commit_sha repository_identity_unavailable
setup_file_already_exists_or_unreadable existing_setup_branch_requires_manual_inspection
existing_setup_branch_has_unexpected_changes existing_setup_branch_content_differs existing_setup_pr_changed
invalid_envelope invalid_vault_key invalid_configuration_file
oauth_discovery_failed oauth_discovery_issuer_mismatch oauth_discovery_endpoint_mismatch invalid_host_id
oauth_requires_loopback_callback invalid_saved_client_id oauth_attempt_expired_or_consumed oauth_callback_mismatch
duplicate_oauth_parameter oauth_state_mismatch oauth_consent_denied oauth_missing_issued_client_id oauth_code_missing
oauth_nonce_or_subject_invalid oauth_account_mismatch oauth_authorized_party_mismatch
oauth_token_exchange_uncertain_reconnect_required oauth_token_endpoint_failed oauth_grant_invalid_reconnect_required
chatgpt_plan_usage_permission_missing oauth_invalid_credential oauth_invalid_expiry oauth_invalid_refresh_time
oauth_invalid_token_response oauth_id_token_missing oauth_refresh_too_early oauth_refresh_account_mismatch
oauth_refresh_authorized_party_mismatch invalid_saved_session invalid_saved_registration invalid_saved_expiry
`.trim().split(/\s+/));
// https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#validation-failed
const GITHUB_CODES = new Set(['missing', 'missing_field', 'invalid', 'already_exists', 'unprocessable', 'custom']);
const GITHUB_REASONS = new Set(['Bad credentials', 'Resource not accessible by integration', 'Resource not accessible by personal access token']);
const ROUTE_WORDS = new Set(['user', 'repos', 'branches', 'environments', 'deployment-branch-policies', 'git', 'ref', 'refs', 'commits', 'trees', 'contents', 'pulls']);
const SYSTEM_CODES = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const NODE_HINTS: Record<string, string> = {
  ENOENT: 'Required file or executable not found; check the GitHub CLI installation and local profile files.',
  EACCES: 'Permission denied; check local file and directory permissions.',
  EPERM: 'Operation not permitted; check local file permissions and credential-file ACLs.',
  EADDRINUSE: 'The local callback address is already in use; close the conflicting process.',
  ENOTFOUND: 'DNS lookup failed; check network, DNS and proxy settings.',
  ECONNREFUSED: 'Connection refused; check service availability and proxy settings.',
  ECONNRESET: 'Connection reset; check network and service availability before retrying.',
  ETIMEDOUT: 'Connection timed out; check network and service availability before retrying.',
  UND_ERR_CONNECT_TIMEOUT: 'Connection timed out; check network and proxy settings.',
  CERT_HAS_EXPIRED: 'The TLS certificate has expired; check the system clock and certificate chain.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verification failed; check the trusted certificate chain and proxy configuration.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS hostname verification failed; check the service and proxy configuration.',
  ERR_INVALID_URL: 'Invalid URL; check the backend HTTPS origin.',
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Unknown CLI option; check the supported command flags.',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'Invalid CLI option value; check the supplied arguments.',
  ERR_JWT_EXPIRED: 'The identity token expired; reconnect through the official sign-in flow.'
};
const HTTP_HINTS: Record<number, string> = {
  401: 'Authentication rejected; check gh auth status or reconnect the affected account.',
  403: 'Access denied; verify the permissions and policy for this specific operation.',
  404: 'Resource unavailable; verify that it exists and that the authenticated account can access it.',
  409: 'Resource state conflicts with this operation; inspect the current state before retrying.',
  422: 'Request validation failed; check the operation parameters and existing resource configuration.',
  429: 'Rate limited; wait before retrying.'
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function requireCliResponse(response: Response, code: string): void {
  if (!response.ok) throw Object.assign(new AppError(code, response.status), { response: { status: response.status } });
}
export function formatCliError(error: unknown, operation: string): string {
  const input = object(error), response = object(input.response), details: string[] = [];
  const status = response.status ?? input.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) details.push(`${response.status === undefined ? 'status' : 'HTTP'} ${status}`);
  if (input.name === 'HttpError') {
    const request = object(input.request);
    if (typeof request.method === 'string' && ['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(request.method)) {
      let route = '';
      if (typeof request.url === 'string' && request.url.length <= 4096) {
        try { route = new URL(request.url).pathname.split('/').slice(0, 12).map(part => !part || ROUTE_WORDS.has(part) ? part : '{value}').join('/'); }
        catch { /* An invalid request URL is never printed. */ }
      }
      details.push(`GitHub ${request.method}${route ? ` ${route}` : ''}`);
    }
    const data = object(response.data), errors = Array.isArray(data.errors) ? data.errors.slice(0, 6) : [];
    const codes = [data.code, ...errors.map(value => object(value).code)].filter((code): code is string => typeof code === 'string' && GITHUB_CODES.has(code));
    if (codes.length) details.push(`GitHub code: ${[...new Set(codes)].join(', ')}`);
    if (typeof data.message === 'string' && GITHUB_REASONS.has(data.message)) details.push(data.message);
  }
  if (error instanceof AppError && APP_CODES.has(error.code)) details.push(error.code);
  let cause = input, nodeHint: string | undefined;
  for (let depth = 0; depth < 4; depth++, cause = object(cause.cause)) {
    if (typeof cause.code === 'string' && (SYSTEM_CODES.has(cause.code) || Object.hasOwn(NODE_HINTS, cause.code))) { details.push(cause.code); nodeHint = NODE_HINTS[cause.code]; break; }
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') { details.push(cause.name); nodeHint = 'Operation timed out or was cancelled; check service availability before retrying.'; break; }
  }
  if (!details.length) details.push(typeof input.name === 'string' && ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'URIError', 'AggregateError'].includes(input.name) ? input.name : 'unrecognized error', 'unsafe diagnostic text withheld');
  const hint = nodeHint ?? (typeof status === 'number' ? HTTP_HINTS[status] ?? (status >= 500 ? 'Service unavailable; check its status before retrying.' : undefined) : undefined)
    ?? 'Check the configuration and prerequisites for this operation.';
  return `CodexBot failed while ${operation} (${details.join('; ')}). ${hint}`;
}
