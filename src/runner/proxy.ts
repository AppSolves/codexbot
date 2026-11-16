import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { safeEvents, type StreamProgress } from './stream.js';
import { record, requireCondition } from '../core/errors.js';
import { executionError, providerFailure, transportCode, type ExecutionFailure, type ProxyRequestDiagnostic } from '../core/execution.js';
// client_metadata is emitted by pinned Codex's Responses transport (core/src/responses_metadata.rs).
const RESPONSE_FIELDS = new Set(['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'include', 'service_tier', 'prompt_cache_key', 'text', 'context_management', 'stream_options', 'client_metadata']);
function checkTools(tools: unknown, depth = 0): void {
  requireCondition(Array.isArray(tools) && tools.length <= 128 && depth <= 8, 'proxy_invalid_tool_list');
  for (const value of tools) {
    const tool = record(value);
    requireCondition(['function', 'custom', 'namespace'].includes(String(tool.type)), 'proxy_hosted_tools_denied');
    if (tool.type === 'namespace') checkTools(tool.tools, depth + 1);
  }
}
function contentTypeCategory(header: string | null): string {
  const type = header?.split(';', 1)[0]?.trim().toLowerCase();
  if (!type) return 'missing';
  if (type === 'text/event-stream') return 'event-stream';
  if (/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(type)) return 'json';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  return 'other';
}
async function responseFailure(upstream: Response): Promise<ExecutionFailure> {
  // Inspect at most 8 KiB; only the existing exact code/parameter projection leaves this function.
  let errorBody: unknown;
  const reader = upstream.body?.getReader();
  if (reader) {
    try {
      const limited: Uint8Array[] = []; let size = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 8192) break; limited.push(chunk.value); }
      if (size <= 8192) errorBody = JSON.parse(Buffer.concat(limited).toString('utf8')) as unknown;
    } catch { /* Non-JSON, oversized or failed reads still retain the observed HTTP metadata. */ }
    finally {
      try { await reader.cancel(); } catch { /* Cancellation failure must not erase the original response diagnosis. */ }
      finally { reader.releaseLock(); }
    }
  }
  return providerFailure(errorBody, upstream.status);
}

/** Only for an absent Content-Type on a successful Responses request.
 * Inspect a bounded prefix on a clone; keep the original stream untouched.
 * The full stream still goes through safeEvents and must reach response.completed.
 */
async function hasEventStreamPrefix(upstream: Response): Promise<boolean> {
  const reader = upstream.clone().body?.getReader();
  if (!reader) return false;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 64) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value.length) continue;
      const count = Math.min(next.value.length, 64 - size);
      parts.push(next.value.subarray(0, count));
      size += count;
      if (size >= 6) break;
    }
    return /^(?:event:|data:)/.test(Buffer.concat(parts).toString('utf8'));
  } catch { return false; }
  finally { void reader.cancel().catch(() => {}); }
}

export function inspectMedia(value:unknown,depth=0,images?:Set<string>,retained?:unknown[]):number {
  requireCondition(depth<=32,'proxy_unsupported_media_input');if(value===null||typeof value!=='object')return 0;
  if(Array.isArray(value))return value.reduce((count,item)=>count+inspectMedia(item,depth+1,images,retained),0);
  const item=value as Record<string,unknown>;
  requireCondition(!['input_audio','input_video','input_file'].includes(String(item.type)),'proxy_unsupported_media_input');
  if(item.type==='input_text'&&typeof item.text==='string'&&item.text.startsWith('Verified PR image: '))retained?.push({type:'input_text',text:item.text});
  if(item.type==='input_image'){requireCondition(typeof item.image_url==='string'&&/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_url),'proxy_image_source_denied');images?.add(createHash('sha256').update(item.image_url).digest('hex'));retained?.push({type:'input_image',image_url:item.image_url,...(item.detail===undefined?{}:{detail:item.detail})});return 1;}
  return Object.values(item).reduce<number>((count,item)=>count+inspectMedia(item,depth+1,images,retained),0);
}

export async function inferenceProxy(request: IncomingMessage, response: ServerResponse, token: string, fetcher: typeof fetch = fetch, enforceSelection: (body: Record<string, unknown>) => void = () => {}, report: (failure: ExecutionFailure) => void = () => {}, onRequest?: (value: ProxyRequestDiagnostic) => void, requestIndex = 1): Promise<void> {
  const disconnected = new AbortController(), started = Date.now();
  const progress: StreamProgress = { bytes: 0, frames: 0, terminal: 'none' };
  let stage: 'validation' | 'transport' | 'stream' = 'validation', deadline: AbortSignal | undefined;
  let primary: ExecutionFailure | null = null, cleanup: ExecutionFailure | null = null, localPipeline = false;
  let metadata: Pick<ExecutionFailure,'upstream_status'|'content_type_category'|'body_present'> = {};
  const recordFailure = (detail: ExecutionFailure) => {
    if(detail.origin==='cleanup'){cleanup??=detail;return;}
    if(detail.origin==='upstream_read'&&(deadline?.aborted||disconnected.signal.aborted)) {
      const origin=deadline?.aborted?'deadline':localPipeline?'pipeline':'downstream';
      const local=transportCode(response.errored);
      primary??=localPipeline&&!deadline?.aborted?{component:'proxy',code:'proxy_pipeline_failed',origin,...(local?{transport_code:local}:{})}:{...detail,component:'proxy',code:origin==='deadline'?'proxy_deadline_exceeded':'proxy_client_disconnected',origin};
    } else primary??=detail;
  };
  const consumerCompleted = () => disconnected.signal.aborted && !localPipeline && !deadline?.aborted && progress.terminal==='completed' && primary===null;
  response.once('close', () => { if(!response.writableFinished){localPipeline=response.errored!==null&&response.errored!==undefined&&!['ECONNRESET','EPIPE','ERR_STREAM_PREMATURE_CLOSE'].includes(transportCode(response.errored)??'');disconnected.abort();} });
  try {
    onRequest?.({request_index:requestIndex,phase:'started',primary:null,cleanup:null});
    requireCondition(request.method === 'POST' && request.url === '/v1/responses', 'proxy_route_denied', 403);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length;
      requireCondition(bytes <= 24_000_000, 'proxy_body_too_large', 413); chunks.push(buffer);
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { recordFailure({ component: 'proxy', code: 'proxy_invalid_json' }); response.writeHead(403); response.end(); return; }
    const body = record(decoded);
    requireCondition(Object.keys(body).every(key => RESPONSE_FIELDS.has(key)), 'proxy_unsupported_request_field');
    requireCondition(body.store === false && body.stream === true && typeof body.model === 'string', 'proxy_requires_private_streaming_request');
    requireCondition(Array.isArray(body.input), 'proxy_requires_explicit_input_array');
    if (body.client_metadata !== undefined) requireCondition(Object.values(record(body.client_metadata)).every(value => typeof value === 'string'), 'proxy_invalid_client_metadata');
    // Only Responses inference. No arbitrary URLs, CONNECT, browser, MCP or web-search egress.
    if (body.tools !== undefined) checkTools(body.tools);
    for (const value of body.input) {
      const item = record(value);
      if (item.type === 'additional_tools') checkTools(item.tools);
    }
    if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string') {
      const choice = record(body.tool_choice);
      if (choice.type === 'allowed_tools') checkTools(choice.tools);
      else requireCondition(['function', 'custom'].includes(String(choice.type)), 'proxy_hosted_tool_choice_denied');
    } else if (body.tool_choice !== undefined) requireCondition(['auto', 'none', 'required'].includes(String(body.tool_choice)), 'proxy_invalid_tool_choice');
    inspectMedia(body.input);
    enforceSelection(body);
    stage = 'transport';
    deadline = AbortSignal.timeout(20 * 60_000);
    const upstream = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json', 'User-Agent': 'CodexBot/0.1.1',
        ...(typeof request.headers['originator'] === 'string' && request.headers['originator'] === 'CodexBot' ? { originator: 'CodexBot' } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([deadline, disconnected.signal])
    });
    metadata = { upstream_status: upstream.status, content_type_category: contentTypeCategory(upstream.headers.get('content-type')), body_present: upstream.body !== null };
    // Headerless success still requires SSE framing and a terminal response.completed event.
    const headerlessSse = upstream.ok && upstream.body && metadata.content_type_category === 'missing' ? await hasEventStreamPrefix(upstream) : false;
    if (!upstream.ok || !upstream.body || (metadata.content_type_category !== 'event-stream' && !headerlessSse)) {
      recordFailure({ ...await responseFailure(upstream), code: upstream.ok ? 'provider_stream_content_type_invalid' : 'provider_http_failed', origin: 'transport' });
      response.writeHead(upstream.ok ? 403 : upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(upstream.ok ? '{"error":"inference_proxy_denied_or_unavailable"}' : '{"error":{"message":"OpenAI inference unavailable; check authentication, entitlement or usage allowance.","type":"codexbot_inference_error"}}');
      return;
    }
    stage = 'stream';
    response.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    await pipeline(Readable.from(safeEvents(upstream.body, token, recordFailure, progress, consumerCompleted)), response);
  } catch (error) {
    if(!consumerCompleted()) {
      const abort = deadline?.aborted ? 'deadline' : localPipeline ? 'pipeline' : disconnected.signal.aborted ? 'downstream' : null;
      const detail = abort ? {component:'proxy',code:abort==='deadline'?'proxy_deadline_exceeded':abort==='pipeline'?'proxy_pipeline_failed':'proxy_client_disconnected'}
        : executionError(error, 'proxy', stage==='stream'?'proxy_pipeline_failed':stage==='transport'?'proxy_transport_failed':'proxy_invalid_json').detail;
      const transport=transportCode(error);
      const observed: ExecutionFailure = { ...detail, origin: abort ?? (stage==='stream'?'pipeline':stage), ...(transport?{transport_code:transport}:{}) };
      // A downstream/pipeline consequence never replaces an already diagnosed upstream failure.
      if(primary)cleanup??=observed;else primary=observed;
    }
    if(!response.destroyed&&!response.writableEnded){if(!response.headersSent)response.writeHead(403, { 'Content-Type': 'application/json' });response.end('{"error":"inference_proxy_denied_or_unavailable"}');}
  } finally {
    const fields = { ...metadata, request_index: requestIndex, elapsed_ms: Math.min(1_320_000,Math.max(0,Date.now()-started)), stream_bytes: progress.bytes, stream_frames: progress.frames, terminal_event: progress.terminal, abort_origin: deadline?.aborted ? 'deadline' as const : localPipeline ? 'pipeline' as const : disconnected.signal.aborted ? 'downstream' as const : 'none' as const };
    const value: ProxyRequestDiagnostic = { ...fields, phase:'finished', primary: primary ? { ...primary, ...fields } : null, cleanup: cleanup ? { ...cleanup, ...fields } : null };
    if(onRequest)onRequest(value);else {if(value.primary)report(value.primary);if(value.cleanup)report(value.cleanup);}
  }
}
export interface InferenceLimits { maxRequests?: number; maxOutputTokens?: number; maxInputBytes?: number; minimumImages?:number }
export function createInferenceServer(token: string, limits: InferenceLimits = {}, report: (failure: ExecutionFailure) => void = () => {}, onRequest?: (value: ProxyRequestDiagnostic) => void) {
  requireCondition(Number.isInteger(limits.maxRequests ?? 100) && (limits.maxRequests ?? 100) >= 1 && (limits.maxRequests ?? 100) <= 100, 'invalid_proxy_request_limit');
  if (limits.maxOutputTokens !== undefined) requireCondition(Number.isInteger(limits.maxOutputTokens) && limits.maxOutputTokens >= 1 && limits.maxOutputTokens <= 2048, 'invalid_acceptance_token_limit');
  requireCondition(Number.isInteger(limits.minimumImages??0)&&(limits.minimumImages??0)>=0&&(limits.minimumImages??0)<=16,'invalid_proxy_image_limit');
  let requests = 0;
  let active = false;
  let selection: string | null = null;
  let requiredImages:Set<string>|null=null;
  let retainedImages:unknown[]=[];
  const enforceSelection = (body: Record<string, unknown>) => {
    const images=new Set<string>(),retained:unknown[]=[];let count=inspectMedia(body.input,0,images,retained);
    // Codex 0.169 compaction drops images; restore only the first verified inputs, never partial replacements.
    if(count===0&&requiredImages!==null){(body.input as unknown[]).push({role:'user',content:retainedImages});count=inspectMedia(retainedImages,0,images);}
    requireCondition(count>=(limits.minimumImages??0)&&(!requiredImages||[...requiredImages].every(image=>images.has(image))),'proxy_image_inputs_missing');
    requireCondition(Buffer.byteLength(JSON.stringify(body)) <= (limits.maxInputBytes ?? 24_000_000), 'proxy_acceptance_input_budget');
    // Only the trusted API-key acceptance harness sets this. OAuth never adds unsupported fields.
    if (limits.maxOutputTokens !== undefined) body.max_output_tokens = limits.maxOutputTokens;
    const next = JSON.stringify({ model: body.model, reasoning: body.reasoning ?? null, serviceTier: body.service_tier ?? null });
    // Tools cannot run until the first trusted Codex inference. Lock that turn's model/budget selection.
    if (selection === null) selection = next;
    requireCondition(selection === next, 'proxy_model_or_effort_change_denied');
    // Lock the first trusted native image inputs; repetition cannot replace missing visual evidence.
    if((limits.minimumImages??0)>0&&requiredImages===null){requiredImages=images;retainedImages=retained;}
  };
  return createServer((request, response) => {
    const index=Math.min(++requests,101);
    const denied=(code:string)=>{const primary:ExecutionFailure={component:'proxy',code,origin:'validation',request_index:index};if(onRequest)onRequest({request_index:index,phase:'finished',primary,cleanup:null});else report(primary);response.writeHead(429);response.end();};
    if (requests > (limits.maxRequests ?? 100)) { denied('proxy_request_limit'); return; }
    if (active) { denied('proxy_concurrent_request_denied'); return; }
    active = true;
    void inferenceProxy(request, response, token, fetch, enforceSelection, report, onRequest, index).then(() => { active = false; }, () => { active = false; response.destroy(); });
  });
}
