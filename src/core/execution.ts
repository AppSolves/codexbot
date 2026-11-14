import { AppError } from './errors.js';

// This is a projection, never a redaction of arbitrary process/provider text.
const COMPONENTS = new Set(['docker', 'proxy', 'provider', 'codex_process', 'codex_rpc', 'model', 'turn', 'engine']);
const CODES = new Set(`container_start_failed container_exit_failed container_timeout container_output_limit docker_unavailable
proxy_start_failed proxy_startup_failed proxy_route_denied proxy_body_too_large proxy_invalid_json proxy_unsupported_request_field
proxy_requires_private_streaming_request proxy_requires_explicit_input_array proxy_invalid_client_metadata proxy_invalid_tool_list
proxy_hosted_tools_denied proxy_hosted_tool_choice_denied proxy_invalid_tool_choice proxy_acceptance_input_budget
proxy_model_or_effort_change_denied proxy_request_limit proxy_concurrent_request_denied proxy_transport_failed
provider_http_failed provider_stream_failed provider_stream_content_type_invalid provider_stream_truncated provider_stream_limit
provider_frame_limit invalid_provider_event provider_event_type_missing provider_credential_echo provider_stream_incomplete
codex_process_failed codex_process_exited codex_rpc_message_too_large codex_rpc_rejected invalid_codex_protocol
configured_model_not_in_codex_catalog effort_not_supported_by_selected_model codex_invalid_model_catalog codex_invalid_model_cursor
codex_thread_id_missing codex_turn_failed codex_turn_interrupted codex_turn_timeout codex_output_not_json engine_failed`.split(/\s+/));
const PROVIDER_CODES = new Set(`subscription_sharing_user_not_eligible subscription_sharing_usage_limit_exceeded
subscription_sharing_usage_unavailable subscription_sharing_unsupported_capability subscription_sharing_route_not_supported
subscription_sharing_invalid_user chatpass_v2_scope_not_authorized chatpass_v2_invalid_authorization_context
subscription_sharing_user_unavailable invalid_api_key insufficient_quota rate_limit_exceeded model_not_found
unsupported_parameter unsupported_value invalid_request_error`.split(/\s+/));
const PROVIDER_PARAMS = new Set(['model', 'reasoning.effort', 'tools', 'tool_choice', 'input', 'text.format', 'store', 'stream',
  'max_output_tokens', 'previous_response_id', 'temperature', 'prompt_cache_retention', 'metadata']);
const METHODS = new Set(['initialize', 'model/list', 'thread/start', 'turn/start']);
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGINT']);
const CONTENT_TYPES = new Set(['event-stream', 'json', 'html', 'missing', 'other']);
export interface ExecutionFailure {
  component: string; code: string; exit_code?: number; signal?: string; rpc_code?: number; rpc_method?: string;
  upstream_status?: number; content_type_category?: string; body_present?: boolean; provider_code?: string; provider_param?: string;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function executionFailure(value: unknown): ExecutionFailure | null {
  const source = object(value);
  const { component, code } = source;
  if (typeof component !== 'string' || !COMPONENTS.has(component) || typeof code !== 'string' || !CODES.has(code)) return null;
  const result: ExecutionFailure = { component, code };
  if (Number.isInteger(source.exit_code) && Number(source.exit_code) >= 0 && Number(source.exit_code) <= 255) result.exit_code = Number(source.exit_code);
  if (typeof source.signal === 'string' && SIGNALS.has(source.signal)) result.signal = source.signal;
  if (typeof source.rpc_method === 'string' && METHODS.has(source.rpc_method)) result.rpc_method = source.rpc_method;
  if (Number.isInteger(source.rpc_code) && Number(source.rpc_code) >= -32768 && Number(source.rpc_code) <= -32000) result.rpc_code = Number(source.rpc_code);
  if (component === 'provider') {
    if (Number.isInteger(source.upstream_status) && Number(source.upstream_status) >= 200 && Number(source.upstream_status) <= 599) result.upstream_status = Number(source.upstream_status);
    if (typeof source.content_type_category === 'string' && CONTENT_TYPES.has(source.content_type_category)) result.content_type_category = source.content_type_category;
    if (typeof source.body_present === 'boolean') result.body_present = source.body_present;
    if (typeof source.provider_code === 'string' && PROVIDER_CODES.has(source.provider_code)) result.provider_code = source.provider_code;
    if (typeof source.provider_param === 'string' && PROVIDER_PARAMS.has(source.provider_param)) result.provider_param = source.provider_param;
  }
  return result;
}
export class ExecutionError extends AppError {
  readonly detail: ExecutionFailure;
  proxyFailure?: ExecutionFailure;
  constructor(detail: ExecutionFailure) {
    const safe = executionFailure(detail) ?? { component: 'engine', code: 'engine_failed' };
    super('isolated_review_failed'); this.detail = safe;
  }
}
export function executionError(error: unknown, component: string, fallback: string): ExecutionError {
  return error instanceof ExecutionError ? error : new ExecutionError({ component, code: error instanceof AppError && CODES.has(error.code) ? error.code : fallback });
}
export function executionEnvelope(detail: ExecutionFailure): string {
  return JSON.stringify({ event: 'codexbot_execution_failure', ...executionFailure(detail) });
}
/** Bounded line reader for our own envelope. Arbitrary stderr is discarded, including oversized lines. */
export class ExecutionDiagnostics {
  private line = '';
  private dropping = false;
  private bytes = 0;
  last: ExecutionFailure | null = null;
  write(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 64_000) return;
    for (const part of chunk.split(/(\n)/)) {
      if (part === '\n') {
        if (!this.dropping) {
          try { const value = object(JSON.parse(this.line)); if (value.event === 'codexbot_execution_failure') this.last = executionFailure(value) ?? this.last; } catch { /* Untrusted stderr is never forwarded. */ }
        }
        this.line = ''; this.dropping = false;
      } else if (!this.dropping) {
        this.line += part;
        if (this.line.length > 2048) { this.line = ''; this.dropping = true; }
      }
    }
  }
}
/** Inspect only documented, exact error codes/parameter names, never message/detail text. */
export function providerFailure(value: unknown, upstreamStatus?: number): ExecutionFailure {
  const source = object(value), response = object(source.response);
  const error = object(source.error ?? response.error ?? source);
  return executionFailure({ component: 'provider', code: upstreamStatus === undefined ? 'provider_stream_failed' : 'provider_http_failed',
    upstream_status: upstreamStatus, provider_code: error.code, provider_param: error.param })!;
}
