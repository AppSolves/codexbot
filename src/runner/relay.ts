import { createServer, request as forward } from 'node:http';
export function createSocketRelay(socketPath: string) {
  return createServer((request, response) => {
    const upstream = forward({ socketPath, path: request.url, method: request.method, headers: { 'Content-Type': 'application/json' } }, result => {
      response.writeHead(result.statusCode ?? 502, { 'Content-Type': result.headers['content-type'] ?? 'application/json' });
      result.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
    response.on('close', () => upstream.destroy());
  });
}
