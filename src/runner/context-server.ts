import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';
import { AppError, record, requireCondition } from '../core/errors.js';
import { FAILURE_CODES } from '../core/diagnostics.js';
import { MAX_CONTEXT_REQUESTS } from '../core/limits.js';
import type { ContextLookup } from './context.js';

/** Only immutable, authorized file lookups; this socket never forwards URLs or credentials. */
export async function contextServer(socket: string, lookup: ContextLookup, abort: (reason?:'context_request_limit') => void = () => {}): Promise<() => Promise<void>> {
  const pending = new Set<Promise<void>>();
  let requests=0;
  const server = createServer((request, response) => { const task = (async () => {
    try {
      if(++requests>MAX_CONTEXT_REQUESTS){if(requests===MAX_CONTEXT_REQUESTS+1)abort('context_request_limit');throw new AppError('context_request_limit');}
      requireCondition(request.method === 'POST' && (request.url === '/file'||request.url === '/probe'), 'context_request_denied');
      let body = '';
      for await (const chunk of request) { body += String(chunk); requireCondition(Buffer.byteLength(body) <= 1024, 'context_request_too_large'); }
      const input = record(JSON.parse(body) as unknown);
      requireCondition(Object.keys(input).length === 2 && (input.snapshot === 'base' || input.snapshot === 'head') && typeof input.path === 'string', 'context_request_denied');
      const probe=request.url==='/probe';
      const available = probe ? await lookup(input.snapshot,input.path,'probe') : await lookup(input.snapshot,input.path);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(probe?{exists:available}:{available}));
    } catch(error) {
      const code=error instanceof AppError&&FAILURE_CODES.has(error.code)&&(error.code.startsWith('context_')||['blob_integrity_failure','required_tree_unverifiable','required_file_missing_or_special'].includes(error.code))?error.code:'context_lookup_unavailable';
      response.writeHead(code==='context_path_missing'?200:code==='context_request_limit'||code==='context_lookup_limit'?429:400,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify(code==='context_path_missing'?{available:false,reason:code}:{error:code}));
    }
  })().catch(() => { response.destroy(); }).finally(() => { pending.delete(task); }); pending.add(task); });
  server.requestTimeout = 20_000; server.headersTimeout = 5000; server.maxConnections = 2;
  server.listen(socket); await once(server, 'listening'); if (process.platform !== 'win32') await chmod(socket, 0o600);
  return async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    abort(); server.closeAllConnections(); await Promise.allSettled(pending); await closed;
  };
}
