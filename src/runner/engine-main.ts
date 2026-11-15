import { binaryLocations, type BinaryChange } from '../core/binary.js';
import { runCodex } from './engine.js';
import type { RequestSnapshot } from '../worker/store.js';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createSocketRelay } from './relay.js';
import { ExecutionError, executionEnvelope, executionError } from '../core/execution.js';
import { normalizeReview, validateReview, type ChangedFile, type ReviewRejectionReason } from '../core/review.js';
import { record } from '../core/errors.js';
import { validateExecution, type ReviewPlan } from './orchestration.js';
const relay = createSocketRelay('/run/proxy/inference.sock');
try {
  await mkdir('/home/codex/.codex', { mode: 0o700 });
  relay.listen(8080, '127.0.0.1'); await once(relay, 'listening');
  const snapshot = JSON.parse(await readFile('/workspace/request.json', 'utf8')) as RequestSnapshot;
  const manifest = await readFile('/workspace/manifest.json', 'utf8');
  if(record(JSON.parse(manifest) as unknown).complete!==true)throw new ExecutionError({component:'engine',code:'review_incomplete',rejection_reason:'context_incomplete'});
  let rejection: ReviewRejectionReason | undefined;
  const plan=JSON.parse(await readFile('/workspace/review-plan.json','utf8')) as ReviewPlan;
  const execution=validateExecution(await runCodex(snapshot,manifest,plan),plan);
  const output = normalizeReview(execution.review, snapshot.head,reason=>{rejection=reason;});
  try { validateReview(output, snapshot.head, JSON.parse(await readFile('/workspace/diff.json', 'utf8')) as ChangedFile[],binaryLocations((record(JSON.parse(manifest) as unknown).binaryFiles??[]) as BinaryChange[])); }
  catch { throw new ExecutionError({component:'engine',code:'review_output_invalid',rejection_reason:'output_invalid'}); }
  if((rejection&&rejection!=='output_truncated')||output.quarantined)throw new ExecutionError({component:'engine',code:'review_incomplete',rejection_reason:rejection??'quarantined'});
  process.stdout.write(JSON.stringify({...execution,review:output}));
} catch (error) { process.stderr.write(`${executionEnvelope(executionError(error, 'engine', 'engine_failed').detail)}\n`); process.exitCode = 1; }
finally { relay.closeAllConnections(); relay.close(); }
