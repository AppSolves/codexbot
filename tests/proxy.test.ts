import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inferenceProxy, createInferenceServer } from '../src/runner/proxy.js';
await test('API-key and ChatGPT adapters inject only their own bearer at the isolated inference boundary', async () => {
  for (const credential of ['fixture-personal-api-key', 'fixture-personal-oauth-token']) {
    const requests: { url: string; auth: string; body: string }[] = [];
    const upstream: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') ?? '', body: String(init?.body) });
      return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const server = createServer((request, response) => { void inferenceProxy(request, response, credential, upstream); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${origin}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer attacker-supplied' }, body: JSON.stringify({ model: 'fixture-model', store: false, stream: true, input: [] }) });
      assert.equal(response.status, 200); assert.ok((await response.text()).includes('response.completed'));
      assert.equal(requests[0]?.url, 'https://api.openai.com/v1/responses'); assert.equal(requests[0]?.auth, `Bearer ${credential}`); assert.ok(!requests[0]?.body.includes(credential));
      for (const [path, body] of [['/v1/models', {}], ['/v1/responses', { model: 'x', store: true, stream: true }], ['/v1/responses', { model: 'x', store: false, stream: true, tools: [{ type: 'web_search' }] }], ['/v1/responses', { model: 'x', store: false, stream: true, tools: [{ type: 'namespace', tools: [{ type: 'web_search' }] }] }], ['http://attacker.invalid/', {}]] as const) {
        const rejected = await fetch(`${origin}${path.startsWith('/') ? path : '/proxy?' + path}`, { method: 'POST', body: JSON.stringify(body) }); assert.equal(rejected.status, 403); await rejected.text();
      }
      assert.equal(requests.length, 1);
    } finally { server.closeAllConnections(); server.close(); }
  }
});
await test('provider authentication errors never forward credential fragments to the model', async () => {
  const upstream: typeof fetch = async () => Response.json({ error: { message: 'Incorrect key: fixture-sensitive-fragment' } }, { status: 401 });
  const server = createServer((request, response) => { void inferenceProxy(request, response, 'fixture-only', upstream); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture', store: false, stream: true, input: [] }) });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('fixture-sensitive-fragment'));
  } finally { server.closeAllConnections(); server.close(); }
});
await test('inference locks model/effort and denies stored prompts and additional hosted tools', async () => {
  const localFetch = globalThis.fetch; let providerCalls = 0;
  const intercepted = mock.method(globalThis, 'fetch', async () => { providerCalls++; return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
  const server = createInferenceServer('fixture-only');
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const input = { model: 'fixture-model', reasoning: { effort: 'low' }, store: false, stream: true, input: [], client_metadata: { fixture: 'safe-metadata' } };
  const post = async (value: unknown) => { const response = await localFetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify(value) }); await response.text(); return response.status; };
  try {
    assert.equal(await post(input), 200);
    assert.equal(await post({ ...input, model: 'more-expensive-model' }), 403);
    assert.equal(await post({ ...input, reasoning: { effort: 'high' } }), 403);
    assert.equal(await post({ ...input, prompt: { id: 'stored-prompt' } }), 403);
    assert.equal(await post({ ...input, input: [{ type: 'additional_tools', tools: [{ type: 'web_search' }] }] }), 403);
    assert.equal(providerCalls, 1);
  } finally { server.closeAllConnections(); server.close(); intercepted.mock.restore(); }
});

await test('explicit API acceptance request/input/output ceilings are enforced without changing OAuth defaults', async () => {
  const localFetch = globalThis.fetch; let calls = 0, outputLimit: unknown;
  const intercepted = mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++; outputLimit = (JSON.parse(String(init?.body)) as Record<string, unknown>).max_output_tokens;
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const server = createInferenceServer('fixture-only', { maxRequests: 1, maxInputBytes: 1000, maxOutputTokens: 32 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const post = () => localFetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture', store: false, stream: true, input: [] }) });
    const first = await post(); assert.equal(first.status, 200); await first.text(); assert.equal(outputLimit, 32);
    const second = await post(); assert.equal(second.status, 429); await second.text(); assert.equal(calls, 1);
    assert.throws(() => createInferenceServer('fixture', { maxRequests: 101 }));
    assert.throws(() => createInferenceServer('fixture', { maxOutputTokens: 2049 }));
  } finally { server.closeAllConnections(); server.close(); intercepted.mock.restore(); }
});
