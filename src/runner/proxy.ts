import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeEvents } from './stream.js';
import { record, requireCondition } from '../core/errors.js';
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

export async function inferenceProxy(request: IncomingMessage, response: ServerResponse, token: string, fetcher: typeof fetch = fetch, enforceSelection: (body: Record<string, unknown>) => void = () => {}): Promise<void> {
  const disconnected = new AbortController();
  response.once('close', () => disconnected.abort());
  try {
    requireCondition(request.method === 'POST' && request.url === '/v1/responses', 'proxy_route_denied', 403);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length;
      requireCondition(bytes <= 8_000_000, 'proxy_body_too_large', 413); chunks.push(buffer);
    }
    const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
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
    enforceSelection(body);
    const upstream = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'CodexBot/0.1.0',
        ...(typeof request.headers['originator'] === 'string' && request.headers['originator'] === 'CodexBot' ? { originator: 'CodexBot' } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), disconnected.signal])
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"error":{"message":"OpenAI inference unavailable; check authentication, entitlement or usage allowance.","type":"codexbot_inference_error"}}');
      return;
    }
    requireCondition(upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream'), 'provider_stream_content_type_invalid');
    response.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    if (upstream.body) await pipeline(Readable.from(safeEvents(upstream.body, token)), response);
    else response.end();
  } catch { if (!response.headersSent) response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{"error":"inference_proxy_denied_or_unavailable"}'); }
}
export interface InferenceLimits { maxRequests?: number; maxOutputTokens?: number; maxInputBytes?: number }
export function createInferenceServer(token: string, limits: InferenceLimits = {}) {
  requireCondition(Number.isInteger(limits.maxRequests ?? 100) && (limits.maxRequests ?? 100) >= 1 && (limits.maxRequests ?? 100) <= 100, 'invalid_proxy_request_limit');
  if (limits.maxOutputTokens !== undefined) requireCondition(Number.isInteger(limits.maxOutputTokens) && limits.maxOutputTokens >= 1 && limits.maxOutputTokens <= 2048, 'invalid_acceptance_token_limit');
  let requests = 0;
  let active = false;
  let selection: string | null = null;
  const enforceSelection = (body: Record<string, unknown>) => {
    requireCondition(Buffer.byteLength(JSON.stringify(body)) <= (limits.maxInputBytes ?? 8_000_000), 'proxy_acceptance_input_budget');
    // Only the trusted API-key acceptance harness sets this. OAuth never adds unsupported fields.
    if (limits.maxOutputTokens !== undefined) body.max_output_tokens = limits.maxOutputTokens;
    const next = JSON.stringify({ model: body.model, reasoning: body.reasoning ?? null, serviceTier: body.service_tier ?? null });
    // Tools cannot run until the first trusted Codex inference. Lock that turn's model/budget selection.
    if (selection === null) selection = next;
    requireCondition(selection === next, 'proxy_model_or_effort_change_denied');
  };
  return createServer((request, response) => {
    if (++requests > (limits.maxRequests ?? 100)) { response.writeHead(429); response.end(); return; }
    if (active) { response.writeHead(429); response.end(); return; }
    active = true;
    void inferenceProxy(request, response, token, fetch, enforceSelection).then(() => { active = false; }, () => { active = false; response.destroy(); });
  });
}
