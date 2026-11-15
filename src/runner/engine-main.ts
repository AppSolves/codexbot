import { binaryLocations, type BinaryChange } from '../core/binary.js';
import { runCodex } from './engine.js';
import type { RequestSnapshot } from '../worker/store.js';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createSocketRelay } from './relay.js';
import { executionEnvelope, executionError } from '../core/execution.js';
import { normalizeReview, validateReview, type ChangedFile } from '../core/review.js';
import { AppError, record, requireCondition } from '../core/errors.js';
const relay = createSocketRelay('/run/proxy/inference.sock');
try {
  await mkdir('/home/codex/.codex', { mode: 0o700 });
  relay.listen(8080, '127.0.0.1'); await once(relay, 'listening');
  const snapshot = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as RequestSnapshot;
  const manifest = await readFile('/workspace/manifest.json', 'utf8');
  requireCondition(record(JSON.parse(manifest) as unknown).complete === true, 'review_incomplete');
  const output = normalizeReview(await runCodex(snapshot, manifest), snapshot.head);
  try { validateReview(output, snapshot.head, JSON.parse(await readFile('/workspace/diff.json', 'utf8')) as ChangedFile[],binaryLocations((record(JSON.parse(manifest) as unknown).binaryFiles??[]) as BinaryChange[])); }
  catch { throw new AppError('review_output_invalid'); }
  requireCondition(output.complete && output.result !== 'inconclusive' && !output.quarantined && !output.output_truncated, 'review_incomplete');
  process.stdout.write(JSON.stringify(output));
} catch (error) { process.stderr.write(`${executionEnvelope(executionError(error, 'engine', 'engine_failed').detail)}\n`); process.exitCode = 1; }
finally { relay.closeAllConnections(); relay.close(); }
