import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { record } from '../core/errors.js';
import { ExecutionError } from '../core/execution.js';

export class Rpc {
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: ExecutionError | null = null;
  private buffer = '';
  private notifications: ((method: string, params: unknown) => void)[] = [];
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.resume(); // Provider diagnostics can contain input or credentials; never forward them.
    child.on('error', () => this.fail(new ExecutionError({ component: 'codex_process', code: 'codex_process_failed' })));
    child.on('close', (code, signal) => this.fail(new ExecutionError({ component: 'codex_process', code: 'codex_process_exited',
      ...(code !== null ? { exit_code: code } : {}), ...(signal ? { signal } : {}) })));
    child.stdin.on('error', () => this.fail(new ExecutionError({ component: 'codex_process', code: 'codex_process_failed' })));
  }
  onNotification(listener: (method: string, params: unknown) => void): void { this.notifications.push(listener); }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.pending.set(id, { method, resolve, reject }); this.send({ id, method, params }); });
  }
  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  private send(value: unknown): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  private fail(error: ExecutionError): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.notifications) listener('codexbot/error', error);
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4_000_000) { this.fail(new ExecutionError({ component: 'codex_rpc', code: 'codex_rpc_message_too_large' })); this.child.kill('SIGKILL'); return; }
    for (;;) {
      const end = this.buffer.indexOf('\n'); if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try {
        const message = record(JSON.parse(line) as unknown);
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            // Never grant command execution, network, permission escalation or tool approvals.
            this.send({ id: message.id, error: { code: -32601, message: 'Client-side tools and permission grants are disabled' } });
            for (const listener of this.notifications) listener('codexbot/client-request-denied', null);
          } else for (const listener of this.notifications) listener(message.method, message.params);
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) {
            const code = record(message.error).code;
            pending.reject(new ExecutionError({ component: 'codex_rpc', code: 'codex_rpc_rejected', rpc_method: pending.method,
              rpc_code: typeof code === 'number' ? code : NaN }));
          } else pending.resolve(message.result);
        }
      } catch { this.fail(new ExecutionError({ component: 'codex_rpc', code: 'invalid_codex_protocol' })); this.child.kill('SIGKILL'); }
    }
  }
}
