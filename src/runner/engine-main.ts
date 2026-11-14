import { runCodex } from './engine.js';
import type { RequestSnapshot } from '../worker/store.js';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createSocketRelay } from './relay.js';
import { AppError } from '../core/errors.js';
import { normalizeReview } from '../core/review.js';
const relay = createSocketRelay('/run/proxy/inference.sock');
try {
  await mkdir('/home/codex/.codex', { mode: 0o700 });
  relay.listen(8080, '127.0.0.1'); await once(relay, 'listening');
  const snapshot = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as RequestSnapshot;
  const output = await runCodex(snapshot, await readFile('/workspace/manifest.json', 'utf8'));
  process.stdout.write(JSON.stringify(normalizeReview(output, snapshot.head)));
} catch (error) { process.stderr.write(`Codex review failed: ${error instanceof AppError ? error.code : 'execution_error'}; no approval produced.\n`); process.exitCode = 1; }
finally { relay.closeAllConnections(); relay.close(); }
