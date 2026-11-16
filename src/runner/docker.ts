import { spawn } from 'node:child_process';
import {dirname} from 'node:path';
import { requireCondition } from '../core/errors.js';
import type { InferenceLimits } from './proxy.js';
import { ExecutionDiagnostics, ExecutionError, executionError, executionFailure, proxyRequestEnvelope } from '../core/execution.js';
import {DEFAULT_REVIEW_TIMEOUT_MINUTES,MAX_REVIEW_TIMEOUT_MINUTES,REVIEW_CLEANUP_MS} from '../core/limits.js';

export async function docker(args: string[], maxBytes = 100_000, diagnostics = new ExecutionDiagnostics(),timeoutMs=DEFAULT_REVIEW_TIMEOUT_MINUTES*60_000+REVIEW_CLEANUP_MS,signal?:AbortSignal): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => diagnostics.write(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timeout);signal?.removeEventListener('abort',abort); reject(new ExecutionError({ component: 'docker', code: 'docker_unavailable' })); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort',abort);
      // The unprivileged reviewer cannot attest to provider HTTP; only separate proxy logs can.
      const engine = diagnostics.last && ['engine','codex_process','codex_rpc','model','turn'].includes(diagnostics.last.component)
        ? executionFailure({ ...diagnostics.last, upstream_status: null, provider_code: null, provider_param: null }) : null;
      if (code !== 0 || size > maxBytes || timedOut) reject(new ExecutionError((!timedOut && size <= maxBytes ? engine : null) ?? { component: 'docker',
        code: timedOut ? 'container_timeout' : size > maxBytes ? 'container_output_limit' : code !== null && [125,126,127].includes(code) ? 'container_start_failed' : 'container_exit_failed',
        ...(code !== null ? { exit_code: code } : {}), ...(exitSignal ? { signal:exitSignal } : {}) }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function proxyReady(name: string): Promise<void> {
  const child = spawn('docker', ['logs', '--follow', name], { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let output = '';
  return new Promise((resolve, reject) => {
    child.on('error', () => { clearTimeout(timer); reject(new ExecutionError({ component: 'proxy', code: 'proxy_start_failed' })); });
    child.once('exit', () => { clearTimeout(timer); reject(new ExecutionError({ component: 'proxy', code: 'proxy_start_failed' })); });
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-256);
      if (output.includes('codexbot-proxy-ready')) { clearTimeout(timer); resolve(); child.kill(); }
    });
  });
}
export async function cleanupReviewContainers(id: string): Promise<void> {
  requireCondition(/^[a-f0-9-]{36}$/.test(id), 'invalid_container_cleanup_scope');
  // Discover accepted creates even after a lost CLI response, without treating an
  // absent second container as a cleanup failure or touching another run's containers.
  const listed = await docker(['ps', '-a', '--filter', `label=codexbot.run=${id}`, '--format', '{{.ID}}']);
  const containers = listed.trim().split(/\r?\n/).filter(Boolean);
  requireCondition(containers.length <= 2 && containers.every(value => /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(value)), 'container_cleanup_scope_unverifiable');
  const cleanup = await Promise.allSettled(containers.map(container => docker(['rm', '-f', container])));
  requireCondition(cleanup.every(result => result.status === 'fulfilled'), 'docker_cleanup_failed_check_runner');
}
export async function isolatedReview(image: string, directory: string, credentialFile: string, socketDirectory: string, limits: InferenceLimits = {}, onPartialFailure: (failure: ExecutionError)=>void = failure=>{throw failure;},signal?:AbortSignal): Promise<unknown> {
  const minutes=limits.timeoutMinutes??DEFAULT_REVIEW_TIMEOUT_MINUTES;requireCondition(Number.isInteger(minutes)&&minutes>=1&&minutes<=MAX_REVIEW_TIMEOUT_MINUTES,'review_timeout_exceeds_github_actions_job_limit');
  requireCondition(/^[a-zA-Z0-9._:/@-]+$/.test(image), 'invalid_review_image');
  const id = crypto.randomUUID(), proxy = `codexbot-proxy-${id}`, review = `codexbot-review-${id}`;
  const uid = process.getuid?.(), gid = process.getgid?.();
  requireCondition(uid !== undefined && uid !== 0 && gid !== undefined, 'review_requires_nonroot_linux_runner');
  const common = ['--label', `codexbot.run=${id}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--cpus=2', `--user=${uid}:${gid}`, `--tmpfs=/tmp:rw,noexec,nosuid,size=128m,uid=${uid}`, `--tmpfs=/home/codex:rw,nosuid,size=128m,uid=${uid}`];
  let primary: unknown, result: unknown, partial:ExecutionError|undefined;
  const observe=async(failure:ExecutionError)=>{
    // Only this run's separate credential proxy can attest to provider HTTP or cleanup.
    const observed = new ExecutionDiagnostics();
    try { observed.write(await docker(['logs', '--tail', '32', proxy], 64_000, observed)); } catch { /* Keep the real primary failure if diagnostics are unavailable. */ }
    for(const request of observed.history)console.error(proxyRequestEnvelope(request));
    if(observed.request&&!observed.history.some(x=>x.request_index===observed.request!.request_index))console.error(proxyRequestEnvelope(observed.request));
    if(observed.request){failure.proxyRequest=observed.request;if(observed.request.primary)failure.proxyFailure=observed.request.primary;if(observed.request.cleanup)failure.proxyCleanup=observed.request.cleanup;}else if(observed.last)failure.proxyFailure=observed.last;
  };
  try {
    await docker(['create', '--name', proxy, '--network=bridge', ...common, '--env', `CODEXBOT_ACCEPTANCE_LIMITS=${JSON.stringify(limits)}`, '--mount', `type=bind,src=${dirname(credentialFile)},dst=/run/credentials,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy`, image, 'node', 'dist/src/runner/proxy-main.js']);
    await docker(['start', proxy]);
    await proxyReady(proxy);
    const output = await docker(['run', '--name', review, '--network=none', ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy,readonly`, image, 'node', 'dist/src/runner/engine-main.js'],100_000,new ExecutionDiagnostics(),minutes*60_000+REVIEW_CLEANUP_MS,signal);
    try { result = JSON.parse(output) as unknown; } catch { throw new ExecutionError({ component: 'engine', code: 'codex_output_not_json' }); }
    if(result&&typeof result==='object'&&'failure' in result&&result.failure!==null){const detail=executionFailure(result.failure);requireCondition(detail&&['engine','turn','model','codex_rpc','codex_process'].includes(detail.component),'review_coverage_invalid');partial=new ExecutionError(detail);await observe(partial);}
    else if(result&&typeof result==='object'&&'review' in result&&result.review&&typeof result.review==='object'&&'complete' in result.review&&result.review.complete===false)await observe(new ExecutionError({component:'engine',code:'review_incomplete',rejection_reason:'model_incomplete'}));
  } catch (error) {
    const failure = executionError(error, 'docker', 'container_exit_failed');
    await observe(failure);
    primary = failure;
  } finally {
    try { await cleanupReviewContainers(id); }
    catch (error) {
      if(primary||partial)console.error(JSON.stringify({ event: 'container_cleanup_failed', code: 'docker_cleanup_failed_check_runner' }));
      else if(result!==undefined)partial=executionError(error,'docker','container_exit_failed');
      else primary=error;
    }
  }
  if (primary) throw primary;
  if(partial)onPartialFailure(partial);
  return result;
}
