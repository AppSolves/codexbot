import { AppError } from './errors.js';
import {MAX_REVIEW_TIMEOUT_MINUTES,REVIEW_CLEANUP_MS} from './limits.js';

// This is a projection, never a redaction of arbitrary process/provider text.
const COMPONENTS = new Set(['docker', 'proxy', 'provider', 'codex_process', 'codex_rpc', 'model', 'turn', 'engine']);
const CODES = new Set(`container_start_failed container_exit_failed container_timeout container_output_limit docker_unavailable
proxy_start_failed proxy_startup_failed proxy_route_denied proxy_body_too_large proxy_invalid_json proxy_unsupported_request_field
proxy_requires_private_streaming_request proxy_requires_explicit_input_array proxy_invalid_client_metadata proxy_invalid_tool_list
proxy_hosted_tools_denied proxy_hosted_tool_choice_denied proxy_invalid_tool_choice proxy_acceptance_input_budget
proxy_model_or_effort_change_denied proxy_request_limit proxy_concurrent_request_denied proxy_transport_failed
proxy_pipeline_failed proxy_client_disconnected proxy_deadline_exceeded proxy_stream_cleanup_failed provider_stream_read_failed provider_http_failed provider_stream_failed provider_stream_content_type_invalid provider_stream_truncated provider_stream_limit
provider_frame_limit invalid_provider_event provider_event_type_missing provider_credential_echo provider_stream_incomplete
codex_process_failed codex_process_exited codex_rpc_message_too_large codex_rpc_rejected invalid_codex_protocol
review_plan_unverifiable review_plan_budget review_coverage_invalid image_context_invalid image_context_limit configured_model_does_not_support_images proxy_unsupported_media_input proxy_image_source_denied proxy_image_inputs_missing configured_model_not_in_codex_catalog effort_not_supported_by_selected_model codex_invalid_model_catalog codex_invalid_model_cursor
codex_thread_id_missing codex_turn_failed codex_turn_interrupted codex_turn_timeout codex_output_not_json codex_inspection_denied codex_inspection_not_performed review_incomplete review_output_invalid engine_failed`.split(/\s+/));
const PROVIDER_CODES = new Set(`subscription_sharing_user_not_eligible subscription_sharing_usage_limit_exceeded
subscription_sharing_usage_unavailable subscription_sharing_unsupported_capability subscription_sharing_route_not_supported
subscription_sharing_invalid_user chatpass_v2_scope_not_authorized chatpass_v2_invalid_authorization_context
subscription_sharing_user_unavailable invalid_api_key insufficient_quota rate_limit_exceeded model_not_found
unsupported_parameter unsupported_value invalid_request_error invalid_json_schema`.split(/\s+/));
const PROVIDER_PARAMS = new Set(['model', 'reasoning.effort', 'tools', 'tool_choice', 'input', 'text.format', 'text.format.schema', 'store', 'stream',
  'max_output_tokens', 'previous_response_id', 'temperature', 'prompt_cache_retention', 'metadata']);
const METHODS = new Set(['initialize', 'model/list', 'thread/start', 'turn/start']);
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGINT']);
const CONTENT_TYPES = new Set(['event-stream', 'json', 'html', 'missing', 'other']);
export type TerminalEvent = 'none' | 'completed' | 'failed' | 'incomplete' | 'error';
const ORIGINS = new Set(['validation','transport','upstream_event','upstream_read','framing','limit','deadline','downstream','pipeline','cleanup']);
const TRANSPORT_CODES = new Set(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EPIPE','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_BODY_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ABORT_ERR','TIMEOUT_ERR','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END']);
const REJECTION_REASONS = ['context_incomplete','schema_invalid','head_mismatch','quarantined','output_truncated','model_incomplete','model_inconclusive','output_invalid'] as const;
export type EngineRejectionReason = typeof REJECTION_REASONS[number];
export const UNFINISHED_REASONS = ['model_incomplete','unreviewed_changes','missing_required_context','unresolved_analysis','visual_evidence_unavailable','continuation_limit','execution_failed','synthesis_incomplete','output_truncated'] as const;
const REJECTIONS = new Set<string>(REJECTION_REASONS);
interface RequestMetadata {
  request_index?: number; elapsed_ms?: number; stream_bytes?: number; stream_frames?: number; terminal_event?: TerminalEvent;
  upstream_status?: number; content_type_category?: string; body_present?: boolean; abort_origin?: 'none' | 'deadline' | 'downstream' | 'pipeline';
}
export interface ProxyRequestDiagnostic extends RequestMetadata { request_index: number; phase: 'started' | 'finished'; primary: ExecutionFailure | null; cleanup: ExecutionFailure | null }
export interface ExecutionFailure extends RequestMetadata {
  component: string; code: string; exit_code?: number; signal?: string; rpc_code?: number; rpc_method?: string;
  provider_code?: string; provider_param?: string; origin?: string; transport_code?: string; rejection_reason?: EngineRejectionReason;
  timeout_scope?:'execution';
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function projectRequestMetadata(source: Record<string, unknown>, result: RequestMetadata): void {
  for (const [key, maximum] of [['request_index',101],['elapsed_ms',MAX_REVIEW_TIMEOUT_MINUTES*60_000+REVIEW_CLEANUP_MS],['stream_bytes',20_000_001],['stream_frames',1_000_000],['upstream_status',599]] as const) {
    const value=source[key]; if(typeof value==='number'&&Number.isInteger(value)&&value>=(key==='request_index'?1:key==='upstream_status'?200:0)&&value<=maximum)result[key]=value;
  }
  if(typeof source.content_type_category==='string'&&CONTENT_TYPES.has(source.content_type_category))result.content_type_category=source.content_type_category;
  if(typeof source.body_present==='boolean')result.body_present=source.body_present;
  if(typeof source.terminal_event==='string'&&['none','completed','failed','incomplete','error'].includes(source.terminal_event))result.terminal_event=source.terminal_event as TerminalEvent;
  if(typeof source.abort_origin==='string'&&['none','deadline','downstream','pipeline'].includes(source.abort_origin))result.abort_origin=source.abort_origin as NonNullable<RequestMetadata['abort_origin']>;
}
/** Only exact machine codes leave the exception chain; never messages or arbitrary names. */
export function transportCode(error: unknown): string | undefined {
  for(let depth=0;depth<4;depth++) {const value=object(error);if(typeof value.code==='string'&&TRANSPORT_CODES.has(value.code))return value.code; if(value.name==='AbortError')return 'ABORT_ERR';if(value.name==='TimeoutError')return 'TIMEOUT_ERR';error=value.cause;}
}
export function proxyRequestDiagnostic(value: unknown): ProxyRequestDiagnostic | null {
  const source=object(value);if(source.phase!=='started'&&source.phase!=='finished')return null;
  const result:ProxyRequestDiagnostic={request_index:0,phase:source.phase,primary:executionFailure(source.primary),cleanup:executionFailure(source.cleanup)};
  projectRequestMetadata(source,result);if(!result.request_index)return null;
  if((source.primary!==null&&!result.primary)||(source.cleanup!==null&&!result.cleanup))return null;
  if([result.primary,result.cleanup].some(detail=>detail&&!['proxy','provider'].includes(detail.component)))return null;
  if([result.primary,result.cleanup].some(detail=>detail?.request_index!==undefined&&detail.request_index!==result.request_index))return null;
  if(result.phase==='started'&&(result.primary||result.cleanup))return null;
  return result;
}
export function proxyRequestEnvelope(value: ProxyRequestDiagnostic): string {return JSON.stringify({event:'codexbot_proxy_request',...proxyRequestDiagnostic(value)});}
export function executionFailure(value: unknown): ExecutionFailure | null {
  const source = object(value);
  const { component, code } = source;
  if (typeof component !== 'string' || !COMPONENTS.has(component) || typeof code !== 'string' || !CODES.has(code)) return null;
  const result: ExecutionFailure = { component, code };
  if((component==='turn'||component==='engine')&&code==='codex_turn_timeout'&&source.timeout_scope==='execution')result.timeout_scope='execution';
  if (Number.isInteger(source.exit_code) && Number(source.exit_code) >= 0 && Number(source.exit_code) <= 255) result.exit_code = Number(source.exit_code);
  if (typeof source.signal === 'string' && SIGNALS.has(source.signal)) result.signal = source.signal;
  if (typeof source.rpc_method === 'string' && METHODS.has(source.rpc_method)) result.rpc_method = source.rpc_method;
  if (Number.isInteger(source.rpc_code) && Number(source.rpc_code) >= -32768 && Number(source.rpc_code) <= -32000) result.rpc_code = Number(source.rpc_code);
  if(typeof source.rejection_reason==='string'&&component==='engine'&&REJECTIONS.has(source.rejection_reason))result.rejection_reason=source.rejection_reason as EngineRejectionReason;
  if((component==='proxy'||component==='provider')&&typeof source.origin==='string'&&ORIGINS.has(source.origin))result.origin=source.origin;
  if((component==='proxy'||component==='provider')&&typeof source.transport_code==='string'&&TRANSPORT_CODES.has(source.transport_code))result.transport_code=source.transport_code;
  if(component==='proxy'||component==='provider')projectRequestMetadata(source,result);
  if (component === 'provider') {
    if (typeof source.provider_code === 'string' && PROVIDER_CODES.has(source.provider_code)) result.provider_code = source.provider_code;
    if (typeof source.provider_param === 'string' && PROVIDER_PARAMS.has(source.provider_param)) result.provider_param = source.provider_param;
  }
  return result;
}
export class ExecutionError extends AppError {
  readonly detail: ExecutionFailure;
  proxyFailure?: ExecutionFailure;
  proxyCleanup?: ExecutionFailure;
  proxyRequest?: ProxyRequestDiagnostic;
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
  request: ProxyRequestDiagnostic | null = null;
  history: ProxyRequestDiagnostic[] = [];
  write(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 64_000) return;
    for (const part of chunk.split(/(\n)/)) {
      if (part === '\n') {
        if (!this.dropping) {
          try { const value = object(JSON.parse(this.line)); if (value.event === 'codexbot_execution_failure') this.last = executionFailure(value) ?? this.last;
            if(value.event==='codexbot_proxy_request'){const request=proxyRequestDiagnostic(value);if(request){if(request.phase==='finished'&&(request.primary||request.cleanup))this.history=[...this.history.filter(x=>x.request_index!==request.request_index),request].slice(-4);if(request.request_index>=(this.request?.request_index??0)){this.request=request;this.last=request.primary;}}} } catch { /* Untrusted stderr is never forwarded. */ }
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
