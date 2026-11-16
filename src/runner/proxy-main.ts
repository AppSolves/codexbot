import { readFile } from 'node:fs/promises';
import { createInferenceServer } from './proxy.js';
import type { InferenceLimits } from './proxy.js';
import { executionEnvelope, proxyRequestEnvelope } from '../core/execution.js';
const report = (failure: Parameters<typeof executionEnvelope>[0]) => process.stderr.write(`${executionEnvelope(failure)}\n`);
try {
  const token=async()=>{const value:unknown=JSON.parse(await readFile('/run/credentials/current','utf8'));if(!value||typeof value!=='object'||!('access_token' in value)||typeof value.access_token!=='string'||!value.access_token||/[\r\n]/.test(value.access_token))throw new Error('invalid_credential');return value.access_token;};
  await token();
  process.umask(0o077);
  const limits = JSON.parse(process.env.CODEXBOT_ACCEPTANCE_LIMITS ?? '{}') as InferenceLimits;
  createInferenceServer(token, limits, report, value => process.stderr.write(proxyRequestEnvelope(value)+'\n')).on('error', () => { report({ component: 'proxy', code: 'proxy_startup_failed' }); process.exitCode = 1; })
    .listen('/run/proxy/inference.sock', () => process.stdout.write('codexbot-proxy-ready\n'));
} catch { report({ component: 'proxy', code: 'proxy_startup_failed' }); process.exitCode = 1; }
