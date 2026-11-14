import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { record, AppError } from '../core/errors.js';

export class Rpc {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = '';
  private notifications: ((method: string, params: unknown) => void)[] = [];
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.resume(); // Provider diagnostics can contain input or credentials; never forward them.
    child.on('error', () => this.fail(new AppError('codex_process_failed')));
    child.on('exit', () => this.fail(new AppError('codex_process_exited')));
  }
  onNotification(listener: (method: string, params: unknown) => void): void { this.notifications.push(listener); }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  private send(value: unknown): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.notifications) listener('codexbot/error', { code: error.message });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4_000_000) { this.fail(new AppError('codex_rpc_message_too_large')); this.child.kill('SIGKILL'); return; }
    for (;;) {
      const end = this.buffer.indexOf('\n'); if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try {
        const message = record(JSON.parse(line) as unknown);
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            // Never grant command execution, network, permission escalation or tool approvals.
            this.send({ id: message.id, error: { code: -32601, message: 'Client-side tools and permission grants are disabled' } });
          } else for (const listener of this.notifications) listener(message.method, message.params);
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new AppError('codex_rpc_rejected')); else pending.resolve(message.result);
        }
      } catch { this.fail(new AppError('invalid_codex_protocol')); this.child.kill('SIGKILL'); }
    }
  }
}
