import { requireCondition } from '../core/errors.js';
import { executionError, providerFailure, type ExecutionFailure } from '../core/execution.js';

const FAILURE = 'data: {"type":"error","code":"codexbot_inference_error","message":"OpenAI inference unavailable; check credentials, entitlement and usage allowance.","param":null}\n\n';
/** Responses SSE framing only; never expose provider error text or an injected credential. */
export async function* safeEvents(body: ReadableStream<Uint8Array>, credential: string, report: (failure: ExecutionFailure) => void = () => {}): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, completed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode(); requireCondition(buffer.trim().length === 0, 'provider_stream_truncated');
        requireCondition(completed, 'provider_stream_incomplete'); break;
      }
      bytes += chunk.value.length; requireCondition(bytes <= 20_000_000, 'provider_stream_limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      requireCondition(buffer.length <= 4_000_000, 'provider_frame_limit');
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary || boundary.index === undefined) break;
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue; // Drop comments/unknown side-channel fields.
        if (data === '[DONE]') { requireCondition(completed, 'provider_stream_incomplete'); yield 'data: [DONE]\n\n'; continue; }
        const event: unknown = JSON.parse(data);
        requireCondition(event && typeof event === 'object' && !Array.isArray(event), 'invalid_provider_event');
        const value = event as Record<string, unknown>;
        requireCondition(typeof value.type === 'string', 'provider_event_type_missing');
        const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : null;
        if (data.includes(credential) || value.type === 'error' || value.type === 'response.failed' || value.type === 'response.incomplete' || value.error || response?.error || /^event:\s*error\s*$/m.test(frame)) {
          report(data.includes(credential) ? { component: 'provider', code: 'provider_credential_echo' } : value.type === 'response.incomplete' ? { component: 'provider', code: 'provider_stream_incomplete' } : providerFailure(value));
          yield FAILURE; return;
        }
        if (value.type === 'response.completed') completed = true;
        yield `data: ${JSON.stringify(event)}\n\n`;
      }
    }
  } catch (error) { report(executionError(error, 'provider', 'invalid_provider_event').detail); yield FAILURE; }
  finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
