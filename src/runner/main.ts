import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { client } from '../worker/github.js';
import type { RequestSnapshot } from '../worker/store.js';
import type { Envelope } from '../core/crypto.js';
import { unseal, seal, sessionBinding } from '../core/crypto.js';
import { record, requireCondition, AppError } from '../core/errors.js';
import { diagnostic, FAILURE_CODES, BROKER_CODES, ReviewCompletionError, type ReviewCompletion } from '../core/diagnostics.js';
import { OAuth, validateSession } from '../auth/oauth.js';
import { broker, backendUrl, checkWorkload } from './broker.js';
import { collectContext } from './context.js';
import { contextServer } from './context-server.js';
import type { ContextLookup } from './context.js';
import { binaryLocations } from '../core/binary.js';
import { reviewImages } from './engine.js';
import { isolatedReview } from './docker.js';
import { failedReview, normalizeReview, validateReview, type ChangedFile } from '../core/review.js';
import { buildReviewPlan, validateExecution } from './orchestration.js';
import { ExecutionError } from '../core/execution.js';

const REFRESH_WINDOW_MS = 25 * 60_000;
export async function waitForRefresh(earliest: number): Promise<void> {
  requireCondition(Number.isFinite(earliest) && earliest >= 0 && earliest - Date.now() <= REFRESH_WINDOW_MS, 'oauth_refresh_window_unavailable');
  // Provider eligibility is a timestamp, not permission to send a premature refresh request.
  while (Date.now() < earliest) await new Promise(resolve => setTimeout(resolve, earliest - Date.now()));
}

export async function reviewJob(): Promise<void> {
  const id = process.env.CODEXBOT_REQUEST_ID ?? '';
  let backend = '', temporary: string | undefined;
  let snapshot: RequestSnapshot | null = null;
  let submission: { output: unknown; context_complete: boolean; failure?: ReturnType<typeof diagnostic> } | null = null;
  let completion:ReviewCompletion|undefined;
  let stage = 'environment';
  let closeContext: (() => Promise<void>) | undefined, revokeContext: (() => Promise<unknown>) | undefined;
  try {
    backend = backendUrl(process.env.CODEXBOT_BACKEND ?? '');
    temporary = await mkdtemp(join(tmpdir(), 'codexbot-'));
    requireCondition(process.env.CODEXBOT_VAULT_KEY || process.env.CODEXBOT_API_KEY, 'missing_environment_credentials');
    requireCondition(!(process.env.CODEXBOT_VAULT_KEY && process.env.CODEXBOT_API_KEY), 'ambiguous_environment_credentials');
    stage = 'prepare';
    const prepared = record(await broker(backend, id, 'prepare'));
    snapshot = prepared.snapshot as RequestSnapshot;
    requireCondition(snapshot.id === id && String(snapshot.actorId) === process.env.CODEXBOT_CREDENTIAL_OWNER && String(snapshot.installationId) === process.env.CODEXBOT_INSTALLATION_ID, 'credential_owner_mismatch');
    requireCondition(typeof prepared.read_token === 'string', 'missing_read_token');
    const github = client(prepared.read_token);
    revokeContext = () => github.rest.apps.revokeInstallationAccessToken();
    const directory = join(temporary, 'context');
    stage = 'context';
    let lookup: ContextLookup | undefined;
    const contextCancellation = new AbortController();
    const manifest = await collectContext(github, snapshot, directory, reader => { lookup = reader; }, contextCancellation.signal);
    requireCondition(manifest.complete, manifest.failureCodes[0] ?? 'review_context_incomplete');
    const plan=await buildReviewPlan(directory,snapshot.head,snapshot.base,manifest.binaryFiles);
    let credential: string;
    stage = 'credentials';
    if (snapshot.config.credentials.mode === 'api-key') {
      requireCondition(process.env.CODEXBOT_API_KEY && !process.env.CODEXBOT_VAULT_KEY, 'api_key_missing_or_ambiguous_credentials');
      credential = process.env.CODEXBOT_API_KEY;
    } else {
      requireCondition(process.env.CODEXBOT_VAULT_KEY && !process.env.CODEXBOT_API_KEY, 'vault_key_missing_or_ambiguous_credentials');
      const saved = record(prepared.session);
      const binding = sessionBinding(backend, snapshot.installationId, snapshot.repositoryId, snapshot.actorId);
      let session = validateSession(await unseal(saved.envelope as Envelope, process.env.CODEXBOT_VAULT_KEY, binding));
      if (session.expires_at - Date.now() < REFRESH_WINDOW_MS) {
        await waitForRefresh(session.earliest_refresh_at);
        if (session.hosted) {
          const renewed = record(await broker(backend, id, 'renew'));
          session = validateSession(await unseal(renewed.envelope as Envelope, process.env.CODEXBOT_VAULT_KEY, binding));
        } else {
          session = await new OAuth().refresh(session);
          // Durably persist rotated credentials before starting inference. A conflict fails closed.
          await broker(backend, id, 'rotate', { version: saved.version, envelope: await seal(session, process.env.CODEXBOT_VAULT_KEY, binding) });
        }
      }
      requireCondition(session.expires_at - Date.now() >= 22 * 60_000, 'session_too_short_reconnect_required');
      credential = session.access_token;
    }
    const credentialPath = join(temporary, 'credential');
    await writeFile(credentialPath, credential, { mode: 0o600 });
    // The container runs as this host uid; the credential file remains owner-readable only.
    await mkdir(directory, { recursive: true });
    // Context is private source, readable only by the dedicated container uid via a read-only bind.
    const image = process.env.CODEXBOT_IMAGE; requireCondition(image, 'review_image_missing');
    const sockets = join(temporary, 'sockets'); await mkdir(sockets, { mode: 0o700 });
    requireCondition(lookup, 'review_context_incomplete');
    closeContext = await contextServer(process.platform === 'win32' ? `\\\\.\\pipe\\codexbot-${crypto.randomUUID()}` : join(sockets, 'context.sock'), lookup, reason => {contextCancellation.abort();if(reason){manifest.complete=false;manifest.requiredContextComplete=false;if(!manifest.failureCodes.includes(reason))manifest.failureCodes.push(reason);}});
    stage = 'analyzing';
    await broker(backend, id, 'stage', { stage: 'analyzing' });
    let partialFailure:ExecutionError|undefined;
    const raw=await isolatedReview(image, directory, credentialPath, sockets,{minimumImages:reviewImages(JSON.stringify(manifest)).length},failure=>{partialFailure=failure;});
    stage = 'result';
    const execution=validateExecution(raw,plan);let output = normalizeReview(execution.review, snapshot.head);
    try { validateReview(output, snapshot.head, JSON.parse(await readFile(join(directory, 'diff.json'), 'utf8')) as ChangedFile[],binaryLocations(manifest.binaryFiles)); }
    catch { throw new AppError('review_output_invalid'); }
    // Keep validated findings even if draining reveals unavailable essential context.
    submission = { output, context_complete: false };
    await closeContext(); closeContext=undefined;
    submission.context_complete=manifest.complete;
    const coverage={planned_units:plan.units.length,completed_units:execution.coverage.filter(c=>c.complete).length,synthesis_complete:execution.synthesis,unfinished_reasons:[...new Set([...execution.reasons,...(manifest.complete?[]:['missing_required_context' as const])])]};
    output=normalizeReview({...output,orchestration:coverage},snapshot.head);
    if(output.output_truncated&&!coverage.unfinished_reasons.includes('output_truncated')){coverage.unfinished_reasons.push('output_truncated');output.orchestration=coverage;}
    submission.output=output;
    completion={
      context_complete:manifest.complete,diff_complete:manifest.diffComplete,required_context_complete:manifest.requiredContextComplete,
      output_complete:output.complete,output_result:output.result,quarantined:output.quarantined===true,output_truncated:output.output_truncated===true,
      orchestration:coverage,
      ...(manifest.failureCodes[0]?{context_failure_code:manifest.failureCodes[0]}:{}),...(manifest.lookups?{context_lookups:manifest.lookups}:{})};
    if(partialFailure||execution.failure)throw partialFailure??new ExecutionError(execution.failure!);
    if(!(manifest.complete&&manifest.diffComplete&&manifest.requiredContextComplete&&output.complete&&output.result!=='inconclusive'&&!output.quarantined&&!output.output_truncated))throw new ReviewCompletionError(completion);
    await broker(backend, id, 'result', submission);
  } catch (error) {
    const report = diagnostic(error, stage,completion); console.error(JSON.stringify(report));
    // Always leave a deterministic non-approving result when preflight succeeded.
    const failure = { ...report, code: report.broker_code ?? (FAILURE_CODES.has(report.code) || BROKER_CODES.has(report.code) ? report.code : 'external_or_execution_failure') };
    try {
      if (snapshot) await broker(backend, id, 'result', { output: submission?.output ?? failedReview(snapshot.head,stage==='context'?report.code:undefined), context_complete: false, failure });
      else await broker(backend, id, 'failure', failure);
    } catch (secondary) { console.error(JSON.stringify({ ...diagnostic(secondary, stage), event: 'failure_reporting_deferred' })); }
    // Recording a safe fallback permits publication; it never makes failed analysis a green check.
    throw error;
  } finally {
    try {
      let contextCleanupFailed = false;
      try { await closeContext?.(); } catch { contextCleanupFailed = true; console.error(JSON.stringify({ event: 'context_service_cleanup_failed', code: 'read_token_cleanup_failed' })); } finally {
        try { await revokeContext?.(); } catch { contextCleanupFailed = true; console.error(JSON.stringify({ event: 'context_token_revocation_failed', code: 'read_token_cleanup_failed' })); }
      }
      try { if (snapshot) await broker(backend, id, 'release'); }
      catch (error) {
        // A durable result must still reach the separately protected publisher.
        // Backend cleanup releases terminal/expired leases; surface the cleanup failure explicitly.
        console.error(JSON.stringify({ ...diagnostic(error, 'release'), event: 'session_release_deferred' }));
      }
      requireCondition(!contextCleanupFailed, 'read_token_cleanup_failed');
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
}
if (process.argv[2] === 'check') {
  try {
    requireCondition(Boolean(process.env.CODEXBOT_VAULT_KEY) !== Boolean(process.env.CODEXBOT_API_KEY), 'missing_environment_credentials');
    const checked = record(await checkWorkload(process.env.CODEXBOT_BACKEND ?? ''));
    requireCondition(checked.status === 'verified' && checked.scope === 'diagnostic_only', 'review_preflight_failed');
    console.info(JSON.stringify({ event: 'workload_diagnostic_verified', scope: 'no_session_no_inference' }));
  } catch (error) { console.error(JSON.stringify(diagnostic(error, 'prepare'))); process.exitCode = 1; }
} else if (process.argv[2] === 'review') {
  try { await reviewJob(); } catch { process.exitCode = 1; }
} else if (process.argv[2] === 'publish') {
  try {
    const result = record(await broker(process.env.CODEXBOT_BACKEND ?? '', process.env.CODEXBOT_REQUEST_ID ?? '', 'publish', { review_job_failed: process.env.CODEXBOT_REVIEW_JOB_SUCCEEDED !== 'true' }));
    requireCondition(result.status !== 'review_failed', 'review_preflight_failed');
    process.stdout.write('CodexBot publication request completed.\n');
  } catch (error) { console.error(JSON.stringify(diagnostic(error, 'publish'))); process.exitCode = 1; }
}
