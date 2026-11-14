import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook, randomSecret, seal, unseal } from '../src/core/crypto.js';
import { boundedBody } from '../src/worker/index.js';
await test('GitHub HMAC requires authentic bytes, valid secret and sha256 signature', async () => {
  const body = Buffer.from('{"sender":{"login":"alice"}}'), secret = 'fixture-webhook-secret'.repeat(2);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(await verifyWebhook(body, signature, secret), true);
  assert.equal(await verifyWebhook(Buffer.from('{}'), signature, secret), false);
  assert.equal(await verifyWebhook(body, signature, 'wrong'), false);
  const emptySignature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`;
  assert.equal(await verifyWebhook(body, emptySignature, ''), false);
  for (const invalid of ['', 'sha1=abc', 'sha256=' + 'z'.repeat(64)]) assert.equal(await verifyWebhook(body, invalid, secret), false);
});
await test('AES-GCM separates credentials by backend, repository, numeric owner and key', async () => {
  const key = randomSecret(), binding = 'https://self.invalid|1|2', value = { refresh_token: 'fixture-sensitive' };
  const envelope = await seal(value, key, binding);
  assert.ok(!JSON.stringify(envelope).includes('fixture-sensitive'));
  assert.deepEqual(await unseal(envelope, key, binding), value);
  for (const changed of ['https://self.invalid|1|3', 'https://self.invalid|2|2', 'https://other.invalid|1|2']) await assert.rejects(unseal(envelope, key, changed));
  await assert.rejects(unseal(envelope, randomSecret(), binding));
  await assert.rejects(unseal({ ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) }, key, binding));
});
await test('bounded request reading handles streams without trusting Content-Length', async () => {
  assert.equal((await boundedBody(new Request('https://self.invalid', { method: 'POST', body: 'abc' }), 3)).length, 3);
  await assert.rejects(boundedBody(new Request('https://self.invalid', { method: 'POST', body: 'abcd' }), 3));
});
