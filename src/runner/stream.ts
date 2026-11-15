import { requireCondition } from '../core/errors.js';
import { executionError, providerFailure, transportCode, type ExecutionFailure, type TerminalEvent } from '../core/execution.js';

const FAILURE = 'data: {"type":"error","code":"codexbot_inference_error","message":"OpenAI inference unavailable; check credentials, entitlement and usage allowance.","param":null}\n\n';
export interface StreamProgress { bytes: number; frames: number; terminal: TerminalEvent }
/** Responses SSE framing only; never expose provider error text or an injected credential. */
export async function* safeEvents(body: ReadableStream<Uint8Array>, credential: string, report: (failure: ExecutionFailure) => void = () => {}, progress: StreamProgress = { bytes: 0, frames: 0, terminal: 'none' }, consumerCompleted: () => boolean = () => false): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, completed = false, phase: 'upstream_read' | 'framing' = 'upstream_read';
  try {
    for (;;) {
      phase = 'upstream_read';
      const chunk = await reader.read();
      phase = 'framing';
      if (chunk.done) {
        buffer += decoder.decode(); requireCondition(buffer.trim().length === 0, 'provider_stream_truncated');
        requireCondition(completed, 'provider_stream_incomplete'); break;
      }
      bytes += chunk.value.length; progress.bytes = Math.min(bytes, 20_000_001);
      requireCondition(bytes <= 20_000_000, 'provider_stream_limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      requireCondition(buffer.length <= 4_000_000, 'provider_frame_limit');
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary || boundary.index === undefined) break;
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        progress.frames = Math.min(progress.frames + 1, 1_000_000);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue; // Drop comments/unknown side-channel fields.
        if (data === '[DONE]') { requireCondition(completed, 'provider_stream_incomplete'); yield 'data: [DONE]\n\n'; continue; }
        const event: unknown = JSON.parse(data);
        requireCondition(event && typeof event === 'object' && !Array.isArray(event), 'invalid_provider_event');
        const value = event as Record<string, unknown>;
        requireCondition(typeof value.type === 'string', 'provider_event_type_missing');
        const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : null;
        if (data.includes(credential) || value.type === 'error' || value.type === 'response.failed' || value.type === 'response.incomplete' || value.error || response?.error || /^event:\s*error\s*$/m.test(frame)) {
          progress.terminal = value.type === 'response.incomplete' ? 'incomplete' : value.type === 'response.failed' ? 'failed' : 'error';
          report({ ...(data.includes(credential) ? { component: 'provider', code: 'provider_credential_echo' } : value.type === 'response.incomplete' ? { component: 'provider', code: 'provider_stream_incomplete' } : providerFailure(value)), origin: 'upstream_event' });
          yield FAILURE; return;
        }
        if (value.type === 'response.completed') { completed = true; progress.terminal = 'completed'; }
        yield `data: ${JSON.stringify(event)}\n\n`;
      }
    }
  } catch (error) {
    // Codex may close HTTP after consuming the terminal SSE event; nothing remains to deliver.
    if (!consumerCompleted()) {
      const detail = executionError(error, 'provider', phase === 'upstream_read' ? 'provider_stream_read_failed' : 'invalid_provider_event').detail;
      const transport = transportCode(error);
      report({ ...detail, origin: ['provider_stream_limit','provider_frame_limit'].includes(detail.code) ? 'limit' : phase, ...(transport?{transport_code:transport}:{}) });
      yield FAILURE;
    }
  } finally {
    const cleanupFailure=(error:unknown)=>{const transport=transportCode(error);if(!consumerCompleted())report({component:'proxy',code:'proxy_stream_cleanup_failed',origin:'cleanup',...(transport?{transport_code:transport}:{})});};
    try { await reader.cancel(); } catch(error) { cleanupFailure(error); }
    finally { try { reader.releaseLock(); } catch(error) { cleanupFailure(error); } }
  }
}
