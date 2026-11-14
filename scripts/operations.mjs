import process from 'node:process';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { backendUrl } from '../dist/src/runner/broker.js';
import { splitRepo } from '../dist/src/worker/github.js';
const { values } = parseArgs({ options: { backend: { type: 'string' }, repository: { type: 'string' }, retry: { type: 'string' }, cancel: { type: 'string' }, 'retry-progress': { type: 'string' } } });
try {
  const backend = backendUrl(values.backend ?? ''); splitRepo(values.repository ?? '');
  if ([values.retry, values.cancel, values['retry-progress']].filter(Boolean).length > 1) throw new Error('Choose one recovery operation.');
  const id = values.retry ?? values.cancel ?? values['retry-progress'];
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const response = await globalThis.fetch(`${backend}/v1/operations?repository=${encodeURIComponent(values.repository)}`, {
    method: id ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(id ? { body: JSON.stringify({ id, action: values.cancel ? 'cancel' : values['retry-progress'] ? 'retry-progress' : 'retry' }) } : {}), redirect: 'error', signal: globalThis.AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error('Recovery denied; check live repository-admin access, request age and retry limits.');
  process.stdout.write(JSON.stringify(await response.json(), null, 2) + '\n');
} catch { process.stderr.write('Operation failed. No credential or raw server diagnostics printed.\n'); process.exitCode = 1; }
