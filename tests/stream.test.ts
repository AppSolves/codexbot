import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEvents } from '../src/runner/stream.js';
function stream(chunks: string[]): ReadableStream<Uint8Array> { return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }); }
async function text(chunks: string[]): Promise<string> { let result = ''; for await (const chunk of safeEvents(stream(chunks), 'fixture-access-credential')) result += chunk; return result; }
await test('SSE parses chunk boundaries, CRLF and multiline data without exposing side-channel comments', async () => {
  const input = ': private comment\r\nevent: response.created\r\ndata: {"type":\r\ndata: "response.created"}\r\n\r\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  const output = await text([...input]); assert.match(output, /response.created/); assert.match(output, /\[DONE\]/); assert.equal(output.includes('private comment'), false);
});
await test('stream diagnostics distinguish provider usage errors from incomplete/framing failures without inventing HTTP status', async () => {
  for (const [input, code] of [
    ['data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"private-provider-message"}}}\n\n', 'provider_stream_failed'],
    ['data: {"type":"response.incomplete"}\n\n', 'provider_stream_incomplete'],
    ['data: {"type":"response.created"}\n\n', 'provider_stream_incomplete'], ['data: partial-private-provider-message', 'provider_stream_truncated']
  ]) {
    const diagnostics: unknown[] = []; let output = '';
    for await (const chunk of safeEvents(stream([input!]), 'fixture-access-credential', value => diagnostics.push(value))) output += chunk;
    assert.equal((diagnostics[0] as { code: string }).code, code); assert.match(output, /codexbot_inference_error/);
    assert.ok(!JSON.stringify(diagnostics).includes('private-provider-message')); assert.ok(!JSON.stringify(diagnostics).includes('status'));
    if (input!.includes('usage_limit_exceeded')) assert.equal((diagnostics[0] as { provider_code: string }).provider_code, 'subscription_sharing_usage_limit_exceeded');
  }
});
await test('streamed provider errors, credential echoes, malformed JSON and truncation fail without raw diagnostics', async () => {
  for (const input of ['data: {"type":"error","message":"secret-fragment-in-provider-error"}\n\n', 'data: {"type":"response.failed","response":{"error":{"message":"secret-fragment-in-provider-error"}}}\n\n', 'data: {"type":"response.output_text.delta","delta":"fixture-access-credential"}\n\n', 'data: malformed-secret-fragment-in-provider-error\n\n', 'data: {"type":"response.completed"}']) {
    const output = await text([input]); assert.match(output, /codexbot_inference_error/); assert.equal(output.includes('secret-fragment-in-provider-error'), false); assert.equal(output.includes('fixture-access-credential'), false);
  }
});
await test('stream frame and total budgets fail closed instead of forwarding oversized provider text', async () => {
  const output = await text(['data: ' + 'x'.repeat(4_000_001)]); assert.match(output, /codexbot_inference_error/); assert.ok(output.length < 1000);
});
