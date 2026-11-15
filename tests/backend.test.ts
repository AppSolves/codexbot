import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { DEFAULT_BACKEND } from '../src/core/identity.js';
import { callerWorkflow } from '../src/setup.js';
import { backendUrl, checkWorkload } from '../src/runner/broker.js';
import { RELEASE } from './fixtures.js';

await test('hosted config, manifest and generated callers agree on Workers.dev while explicit self-hosted origins remain supported', async () => {
  assert.equal(DEFAULT_BACKEND, 'https://codexbot.appsolves.workers.dev');
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.name, 'codexbot'); assert.equal(config.workers_dev, true); assert.equal(config.preview_urls, false);
  assert.equal(config.vars.PUBLIC_URL, DEFAULT_BACKEND); assert.equal(config.vars.MERGE_DEPLOYMENT_AUTHORIZED, 'true');
  assert.equal(config.vars.TRUSTED_WORKFLOW, 'AppSolves/codexbot/.github/workflows/review.yml@17608a52bde146f03a86f194f48631aa9876140a');
  assert.equal(config.vars.WEB_ENABLED,'false');assert.equal(config.vars.OPENAI_HOSTED_INFERENCE_AUTHORIZED,'false');
  assert.equal(config.vars.ACCEPTANCE_USER_PER_DAY,'');assert.equal(config.vars.MERGE_ACCEPTANCE_REPOSITORY_ID,'');assert.equal(config.vars.MERGE_ACCEPTANCE_INSTALLATION_ID,'');
  assert.deepEqual(config.routes, []);
  const manifest = JSON.parse(await readFile('app-manifest.json', 'utf8'));
  assert.equal(manifest.url, DEFAULT_BACKEND); assert.equal(manifest.hook_attributes.url, `${DEFAULT_BACKEND}/webhook`);
  assert.equal(manifest.setup_url, `${DEFAULT_BACKEND}/dashboard`); assert.equal(manifest.redirect_url, `${DEFAULT_BACKEND}/`);
  assert.deepEqual(manifest.callback_urls, [`${DEFAULT_BACKEND}/auth/github/callback`]);
  const generated = parse(callerWorkflow('operator/codexbot', RELEASE)); assert.equal(generated.jobs.review.with.backend, DEFAULT_BACKEND);
  const independent = parse(callerWorkflow('operator/codexbot', RELEASE, 'https://independent.invalid'));
  assert.equal(independent.jobs.review.with.backend, 'https://independent.invalid');
  assert.deepEqual(independent.jobs['credential-scope'], generated.jobs['credential-scope']);
  assert.deepEqual(independent.jobs.review.secrets, generated.jobs.review.secrets);
  for (const invalid of ['http://plain.invalid', `${DEFAULT_BACKEND}/v1`, `${DEFAULT_BACKEND}?code=fixture`, 'https://user:password@host.invalid']) assert.throws(() => backendUrl(invalid));
});
await test('credential-only broker requests use the exact backend origin as OIDC audience, without redirects or fallback', async () => {
  const saved = { ...process.env }, observed: string[] = [];
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.invalid/token'; process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'fixture-only';
  const intercepted = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(init?.redirect, 'error');
    if (url.origin === 'https://oidc.invalid') { assert.equal(url.searchParams.get('audience'), DEFAULT_BACKEND); return Response.json({ value: 'fixture-jwt' }); }
    observed.push(url.href); assert.equal(init?.method, 'POST'); return Response.json({ status: 'verified', scope: 'diagnostic_only' });
  });
  try { await checkWorkload(DEFAULT_BACKEND); assert.deepEqual(observed, [`${DEFAULT_BACKEND}/v1/workload/check`]); }
  finally { intercepted.mock.restore(); for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
});
