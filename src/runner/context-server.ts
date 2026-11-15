import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';
import { record, requireCondition } from '../core/errors.js';
import type { ContextLookup } from './context.js';

/** Only immutable, authorized file lookups; this socket never forwards URLs or credentials. */
export async function contextServer(socket: string, lookup: ContextLookup, abort: () => void = () => {}): Promise<() => Promise<void>> {
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => { const task = (async () => {
    try {
      requireCondition(request.method === 'POST' && (request.url === '/file'||request.url === '/probe'), 'context_request_denied');
      let body = '';
      for await (const chunk of request) { body += String(chunk); requireCondition(Buffer.byteLength(body) <= 1024, 'context_request_too_large'); }
      const input = record(JSON.parse(body) as unknown);
      requireCondition(Object.keys(input).length === 2 && (input.snapshot === 'base' || input.snapshot === 'head') && typeof input.path === 'string', 'context_request_denied');
      const probe=request.url==='/probe';
      const available = probe ? await lookup(input.snapshot,input.path,'probe') : await lookup(input.snapshot,input.path);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(probe?{exists:available}:{available}));
    } catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"context_lookup_unavailable"}'); }
  })().catch(() => { response.destroy(); }).finally(() => { pending.delete(task); }); pending.add(task); });
  server.requestTimeout = 20_000; server.headersTimeout = 5000; server.maxConnections = 2;
  server.listen(socket); await once(server, 'listening'); if (process.platform !== 'win32') await chmod(socket, 0o600);
  return async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    abort(); server.closeAllConnections(); await Promise.allSettled(pending); await closed;
  };
}
