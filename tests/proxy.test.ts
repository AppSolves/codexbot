import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inferenceProxy, createInferenceServer } from '../src/runner/proxy.js';
import type { ExecutionFailure } from '../src/core/execution.js';
function rejectionMetadata(value: ExecutionFailure) {
  assert(Number.isInteger(value.elapsed_ms)&&value.elapsed_ms!>=0&&value.elapsed_ms!<=1_320_000);
  return {request_index:1,elapsed_ms:value.elapsed_ms,stream_bytes:0,stream_frames:0,terminal_event:'none',abort_origin:'none'};
}
await test('required distinct image evidence stays bound across requests; duplicates, loss and substitution are rejected',async()=>{
 const localFetch=globalThis.fetch;let calls=0;const intercepted=mock.method(globalThis,'fetch',async()=>{calls++;return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}});});
 const server=createInferenceServer('fixture-only',{minimumImages:4}),images=['AAAA','BBBB','CCCC','DDDD'].map(value=>({type:'input_image',image_url:'data:image/png;base64,'+value}));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
 const post=async(input:unknown[])=>{const response=await localFetch(`http://127.0.0.1:${address.port}/v1/responses`,{method:'POST',body:JSON.stringify({model:'fixture',store:false,stream:true,input:[{role:'user',content:input}]})});await response.text();return response.status;};
 try{assert.equal(await post(images),200);assert.equal(await post([...images,...images]),200);assert.equal(await post([images[0],images[0],images[0],images[0]]),403);assert.equal(await post(images.slice(0,3)),403);assert.equal(await post([...images.slice(0,3),{type:'input_image',image_url:'data:image/png;base64,EEEE'}]),403);assert.equal(await post(images),200);assert.equal(calls,3);}finally{server.closeAllConnections();server.close();intercepted.mock.restore();}
});
await test('identical native encodings are not mistaken for missing Git images when present in the trusted first input',async()=>{
 const localFetch:typeof fetch=globalThis.fetch;const intercepted=mock.method(globalThis,'fetch',async()=>new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}}));const server=createInferenceServer('fixture-only',{minimumImages:4});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
 try{for(const count of [4,4,3]){const response:Response=await localFetch(`http://127.0.0.1:${address.port}/v1/responses`,{method:'POST',body:JSON.stringify({model:'fixture',store:false,stream:true,input:Array.from({length:count},()=>({type:'input_image',image_url:'data:image/jpeg;base64,AAAA'}))})});assert.equal(response.status,count===4?200:403);await response.text();}}finally{server.closeAllConnections();server.close();intercepted.mock.restore();}
});
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
await test('proxy diagnostics retain only proven HTTP status and exact provider codes/params; validation never calls provider', async () => {
  const secret = 'Bearer fixture-secret OAuth-code source prompt private-provider-message';
  for (const [status, code, param] of [[401, 'subscription_sharing_invalid_user', null], [403, 'subscription_sharing_user_not_eligible', null],
    [403, 'chatpass_v2_scope_not_authorized', null], [429, 'subscription_sharing_usage_limit_exceeded', null],
    [400, 'subscription_sharing_unsupported_capability', 'tools'], [404, 'model_not_found', 'model'], [503, secret, secret], [502, 'oversized', null]] as const) {
    const diagnostics: ExecutionFailure[] = []; let calls = 0;
    const upstream: typeof fetch = async () => {
      calls++; return new Response(code === 'oversized' ? secret.repeat(1000) : JSON.stringify({ error: { code, param, message: secret, body: secret }, detail: secret }), { status });
    };
    const server = createServer((request, response) => { void inferenceProxy(request, response, 'fixture-only', upstream, () => {}, value => diagnostics.push(value)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
      const body = { model: 'fixture', store: false, stream: true, input: [] };
      const post = (value: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify(value) });
      const result = await post(body); assert.equal(result.status, status); assert.ok(!(await result.text()).includes(secret));
      assert.deepEqual(diagnostics[0], { component: 'provider', code: 'provider_http_failed', upstream_status: status,
        content_type_category: 'other', body_present: true,
        origin:'transport',...rejectionMetadata(diagnostics[0]!),...(!['oversized', secret].includes(code) ? { provider_code: code } : {}), ...(param && param !== secret ? { provider_param: param } : {}) });
      const denied = await post({ ...body, [secret]: secret }); assert.equal(denied.status, 403); await denied.text();
      assert.deepEqual(diagnostics[1], { component: 'proxy', code: 'proxy_unsupported_request_field',origin:'validation',...rejectionMetadata(diagnostics[1]!) });
      assert.equal(calls, 1); assert.ok(!JSON.stringify(diagnostics).includes(secret));
    } finally { server.closeAllConnections(); server.close(); }
  }
});
await test('upstream 2xx requires a real SSE body; only classified response metadata and approved JSON codes escape', async () => {
  const secret = 'Bearer fixture-private-token OAuth-code prompt source user-data';
  const json = JSON.stringify({ error: { code: 'model_not_found', param: 'model', message: secret, headers: secret }, detail: secret });
  const cases: { status: number; type: string | null; body: string | null; category: string; approvedCode?: boolean }[] = [
    { status: 200, type: 'text/event-stream', body: 'data: {"type":"response.completed"}\n\n', category: 'event-stream' },
    { status: 201, type: 'Text/Event-Stream; charset=utf-8', body: 'data: {"type":"response.completed"}\n\n', category: 'event-stream' },
    { status: 200, type: null, body: 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', category: 'missing' },
    { status: 200, type: 'application/json; charset=utf-8', body: json, category: 'json', approvedCode: true },
    { status: 202, type: 'application/problem+json', body: json, category: 'json', approvedCode: true },
    { status: 200, type: 'application/json', body: JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: secret }] }] }), category: 'json' },
    { status: 200, type: 'application/json', body: JSON.stringify({ error: { code: secret, param: secret }, detail: secret }), category: 'json' },
    { status: 200, type: 'application/json', body: JSON.stringify({ response: { error: { code: ['model_not_found'], param: ['model'] } } }), category: 'json' },
    { status: 200, type: 'application/json', body: '{"detail":"' + secret + '"}', category: 'json' },
    { status: 200, type: 'application/json', body: json + ' '.repeat(8192), category: 'json' },
    { status: 200, type: 'application/json', body: 'invalid-json ' + secret, category: 'json' },
    { status: 200, type: 'text/html; private=' + secret, body: '<html>' + secret + '</html>', category: 'html' },
    { status: 200, type: 'application/xhtml+xml', body: '<html>' + secret + '</html>', category: 'html' },
    { status: 204, type: 'text/event-stream', body: null, category: 'event-stream' },
    { status: 200, type: 'application/json', body: null, category: 'json' },
    { status: 200, type: null, body: null, category: 'missing' },
    { status: 200, type: null, body: json, category: 'missing', approvedCode: true },
    { status: 200, type: 'text/event-stream-private-' + secret, body: secret, category: 'other' }
  ];
  for (const input of cases) {
    const diagnostics: ExecutionFailure[] = [];
    const upstream: typeof fetch = async () => {
      const response = new Response(input.body, { status: input.status });
      if (input.type === null) response.headers.delete('content-type'); else response.headers.set('content-type', input.type);
      response.headers.set('x-private-header', secret); return response;
    };
    const server = createServer((request, response) => { void inferenceProxy(request, response, 'fixture-only', upstream, () => {}, value => diagnostics.push(value)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
      const result = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture', store: false, stream: true, input: [] }) });
      const output = await result.text(), valid = (input.category === 'event-stream' || (input.category === 'missing' && input.body?.startsWith('event:'))) && input.body !== null;
      assert.equal(result.status, valid ? input.status : 403);
      if (valid) { assert.match(output, /response.completed/); assert.deepEqual(diagnostics, []); }
      else assert.deepEqual(diagnostics, [{ component: 'provider', code: 'provider_stream_content_type_invalid', upstream_status: input.status,
        content_type_category: input.category, body_present: input.body !== null, origin:'transport',...rejectionMetadata(diagnostics[0]!),...(input.approvedCode ? { provider_code: 'model_not_found', provider_param: 'model' } : {}) }]);
      assert.ok(!output.includes(secret)); assert.ok(!JSON.stringify(diagnostics).includes(secret));
      assert.equal(result.headers.get('x-private-header'), null);
    } finally { server.closeAllConnections(); server.close(); }
  }
});
await test('unreadable/cancellation-failed upstream bodies preserve only observed response metadata', async () => {
  const secret = 'fixture-private-body-error';
  const diagnostics: ExecutionFailure[] = [];
  const upstream: typeof fetch = async () => new Response(new ReadableStream({ pull() { throw new Error(secret); } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const server = createServer((request, response) => { void inferenceProxy(request, response, 'fixture-only', upstream, () => {}, value => diagnostics.push(value)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const result = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture', store: false, stream: true, input: [] }) });
    assert.equal(result.status, 403); assert.ok(!(await result.text()).includes(secret));
    assert.deepEqual(diagnostics, [{ component: 'provider', code: 'provider_stream_content_type_invalid', upstream_status: 200, content_type_category: 'json', body_present: true,origin:'transport',...rejectionMetadata(diagnostics[0]!) }]);
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
