import { readFile } from 'node:fs/promises';
import { createInferenceServer } from './proxy.js';
import type { InferenceLimits } from './proxy.js';
import { executionEnvelope, proxyRequestEnvelope } from '../core/execution.js';
const report = (failure: Parameters<typeof executionEnvelope>[0]) => process.stderr.write(`${executionEnvelope(failure)}\n`);
try {
  const token = (await readFile('/run/credential', 'utf8')).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('invalid_credential');
  process.umask(0o077);
  const limits = JSON.parse(process.env.CODEXBOT_ACCEPTANCE_LIMITS ?? '{}') as InferenceLimits;
  createInferenceServer(token, limits, report, value => process.stderr.write(proxyRequestEnvelope(value)+'\n')).on('error', () => { report({ component: 'proxy', code: 'proxy_startup_failed' }); process.exitCode = 1; })
    .listen('/run/proxy/inference.sock', () => process.stdout.write('codexbot-proxy-ready\n'));
} catch { report({ component: 'proxy', code: 'proxy_startup_failed' }); process.exitCode = 1; }
