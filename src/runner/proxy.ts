import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeEvents } from './stream.js';
import { record, requireCondition } from '../core/errors.js';
import { executionError, providerFailure, type ExecutionFailure } from '../core/execution.js';
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

export function inspectMedia(value:unknown,depth=0):number {
  requireCondition(depth<=32,'proxy_unsupported_media_input');if(value===null||typeof value!=='object')return 0;
  if(Array.isArray(value))return value.reduce((count,item)=>count+inspectMedia(item,depth+1),0);
  const item=value as Record<string,unknown>;
  requireCondition(!['input_audio','input_video','input_file'].includes(String(item.type)),'proxy_unsupported_media_input');
  if(item.type==='input_image'){requireCondition(typeof item.image_url==='string'&&/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_url),'proxy_image_source_denied');return 1;}
  return Object.values(item).reduce<number>((count,item)=>count+inspectMedia(item,depth+1),0);
}

export async function inferenceProxy(request: IncomingMessage, response: ServerResponse, token: string, fetcher: typeof fetch = fetch, enforceSelection: (body: Record<string, unknown>) => void = () => {}, report: (failure: ExecutionFailure) => void = () => {}): Promise<void> {
  const disconnected = new AbortController();
  let stage: 'validation' | 'transport' | 'stream' = 'validation';
  response.once('close', () => disconnected.abort());
  try {
    requireCondition(request.method === 'POST' && request.url === '/v1/responses', 'proxy_route_denied', 403);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length;
      requireCondition(bytes <= 24_000_000, 'proxy_body_too_large', 413); chunks.push(buffer);
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { report({ component: 'proxy', code: 'proxy_invalid_json' }); response.writeHead(403); response.end(); return; }
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
    const upstream = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'CodexBot/0.1.0',
        ...(typeof request.headers['originator'] === 'string' && request.headers['originator'] === 'CodexBot' ? { originator: 'CodexBot' } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), disconnected.signal])
    });
    const metadata = { upstream_status: upstream.status, content_type_category: contentTypeCategory(upstream.headers.get('content-type')), body_present: upstream.body !== null };
    // A documented Codex SSE success can omit Content-Type. In that one case,
// require an SSE-looking prefix before handing the unmodified stream to
// safeEvents, which enforces bounded frames and terminal response.completed.
// Never accept JSON/HTML/other explicit media types as streaming responses.
    const headerlessSse = upstream.ok && upstream.body && metadata.content_type_category === 'missing'
      ? await hasEventStreamPrefix(upstream) : false;
    if (!upstream.ok || !upstream.body || (metadata.content_type_category !== 'event-stream' && !headerlessSse)) {
      report({ ...await responseFailure(upstream), ...metadata, code: upstream.ok ? 'provider_stream_content_type_invalid' : 'provider_http_failed' });
      response.writeHead(upstream.ok ? 403 : upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(upstream.ok ? '{"error":"inference_proxy_denied_or_unavailable"}' : '{"error":{"message":"OpenAI inference unavailable; check authentication, entitlement or usage allowance.","type":"codexbot_inference_error"}}');
      return;
    }
    stage = 'stream';
    response.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    await pipeline(Readable.from(safeEvents(upstream.body, token, failure => report({ ...failure, ...metadata }))), response);
  } catch (error) {
    report(executionError(error, stage === 'stream' ? 'provider' : 'proxy', stage === 'transport' ? 'proxy_transport_failed' : stage === 'stream' ? 'provider_stream_failed' : 'proxy_invalid_json').detail);
    if (!response.headersSent) response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{"error":"inference_proxy_denied_or_unavailable"}');
  }
}
export interface InferenceLimits { maxRequests?: number; maxOutputTokens?: number; maxInputBytes?: number; minimumImages?:number }
export function createInferenceServer(token: string, limits: InferenceLimits = {}, report: (failure: ExecutionFailure) => void = () => {}) {
  requireCondition(Number.isInteger(limits.maxRequests ?? 100) && (limits.maxRequests ?? 100) >= 1 && (limits.maxRequests ?? 100) <= 100, 'invalid_proxy_request_limit');
  if (limits.maxOutputTokens !== undefined) requireCondition(Number.isInteger(limits.maxOutputTokens) && limits.maxOutputTokens >= 1 && limits.maxOutputTokens <= 2048, 'invalid_acceptance_token_limit');
  requireCondition(Number.isInteger(limits.minimumImages??0)&&(limits.minimumImages??0)>=0&&(limits.minimumImages??0)<=16,'invalid_proxy_image_limit');
  let requests = 0;
  let active = false;
  let selection: string | null = null;
  const enforceSelection = (body: Record<string, unknown>) => {
    requireCondition(inspectMedia(body.input)>=(limits.minimumImages??0),'proxy_image_inputs_missing');
    requireCondition(Buffer.byteLength(JSON.stringify(body)) <= (limits.maxInputBytes ?? 24_000_000), 'proxy_acceptance_input_budget');
    // Only the trusted API-key acceptance harness sets this. OAuth never adds unsupported fields.
    if (limits.maxOutputTokens !== undefined) body.max_output_tokens = limits.maxOutputTokens;
    const next = JSON.stringify({ model: body.model, reasoning: body.reasoning ?? null, serviceTier: body.service_tier ?? null });
    // Tools cannot run until the first trusted Codex inference. Lock that turn's model/budget selection.
    if (selection === null) selection = next;
    requireCondition(selection === next, 'proxy_model_or_effort_change_denied');
  };
  return createServer((request, response) => {
    if (++requests > (limits.maxRequests ?? 100)) { report({ component: 'proxy', code: 'proxy_request_limit' }); response.writeHead(429); response.end(); return; }
    if (active) { report({ component: 'proxy', code: 'proxy_concurrent_request_denied' }); response.writeHead(429); response.end(); return; }
    active = true;
    void inferenceProxy(request, response, token, fetch, enforceSelection, report).then(() => { active = false; }, () => { active = false; response.destroy(); });
  });
}
