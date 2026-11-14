import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { broker } from '../src/runner/broker.js';
import { diagnostic, BrokerError } from '../src/core/diagnostics.js';
import { reviewJob } from '../src/runner/main.js';
import { snapshot } from './fixtures.js';

const id = snapshot().id, secret = 'opaque-oauth-code fixture-access-token Authorization: Bearer fixture-secret';
await test('external HTTP and Node failures retain safe status/errno without request or exception text', () => {
  const http = Object.assign(new Error(secret), { status: 403, request: { headers: { authorization: secret } }, response: { data: secret } });
  assert.deepEqual(diagnostic(http, 'context'), { event: 'review_failed', stage: 'context', code: 'external_or_execution_failure', status: 403 });
  const network = new Error(secret, { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) });
  assert.equal(diagnostic(network, 'prepare').code, 'ECONNRESET');
  assert.ok(!JSON.stringify(diagnostic({ status: secret, code: secret }, 'prepare')).includes(secret));
});
async function fixture(action: (calls: string[], logs: unknown[][]) => Promise<void>, response: () => Response = () => Response.json({ error: 'oidc_environment_mismatch', message: secret }, { status: 403 })) {
  const env = { ...process.env }, calls: string[] = [], logs: unknown[][] = [];
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.invalid/token'; process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = secret;
  process.env.CODEXBOT_BACKEND = 'https://broker.invalid'; process.env.CODEXBOT_REQUEST_ID = id;
  process.env.CODEXBOT_CREDENTIAL_OWNER = '5'; process.env.CODEXBOT_INSTALLATION_ID = '1';
  const fetcher = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input)); if (url.hostname === 'oidc.invalid') return Response.json({ value: secret });
    calls.push(url.pathname); return response();
  });
  const logger = mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  try { await action(calls, logs); }
  finally { fetcher.mock.restore(); logger.mock.restore(); for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); }
}
await test('broker keeps only HTTP status and known remote codes, never credentials, headers or response bodies', async () => fixture(async () => {
  await assert.rejects(broker('https://broker.invalid', id, 'prepare'), error => {
    assert.ok(error instanceof BrokerError); assert.equal(error.status, 403); assert.equal(error.remoteCode, 'oidc_environment_mismatch');
    const text = JSON.stringify(diagnostic(error, 'prepare')); assert.ok(!text.includes(secret)); assert.ok(!text.includes('fixture-access-token')); return true;
  });
}));
await test('oversized or nonstandard broker errors cannot become diagnostic codes', async () => fixture(async () => {
  await assert.rejects(broker('https://broker.invalid', id, 'prepare'), error => {
    assert.ok(error instanceof BrokerError); assert.equal(error.remoteCode, null); assert.equal(error.status, 502); return true;
  });
}, () => new Response(JSON.stringify({ error: secret, extra: secret.repeat(1000) }), { status: 502 })));
await test('missing or ambiguous Environment credentials fail closed, report failure, and never release a lease that was not acquired', async () => fixture(async (calls, logs) => {
  delete process.env.CODEXBOT_VAULT_KEY; delete process.env.CODEXBOT_API_KEY;
  await assert.rejects(reviewJob(), /missing_environment_credentials/);
  assert.ok(!calls.some(path => path.endsWith('/prepare') || path.endsWith('/release')));
  assert.ok(logs.some(args => String(args[0]).includes('missing_environment_credentials')));
  process.env.CODEXBOT_VAULT_KEY = 'fixture-vault'; process.env.CODEXBOT_API_KEY = 'fixture-api';
  await assert.rejects(reviewJob(), /ambiguous_environment_credentials/);
  assert.ok(!JSON.stringify(logs).includes('fixture-access-token'));
}));
await test('broker/OIDC rejection preserves its primary failure and does not pretend preparation acquired a session', async () => fixture(async (calls, logs) => {
  process.env.CODEXBOT_VAULT_KEY = 'fixture-vault'; delete process.env.CODEXBOT_API_KEY;
  await assert.rejects(reviewJob(), /broker_prepare_failed/);
  assert.ok(calls.some(path => path.endsWith('/prepare'))); assert.ok(!calls.some(path => path.endsWith('/release')));
  assert.ok(logs.some(args => String(args[0]).includes('oidc_environment_mismatch')));
  assert.ok(!JSON.stringify(logs).includes('fixture-access-token'));
}));
