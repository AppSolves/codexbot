import { spawn } from 'node:child_process';
import { requireCondition } from '../core/errors.js';
import type { InferenceLimits } from './proxy.js';
import { ExecutionDiagnostics, ExecutionError, executionError, executionFailure } from '../core/execution.js';

export async function docker(args: string[], maxBytes = 100_000, diagnostics = new ExecutionDiagnostics()): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => diagnostics.write(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 22 * 60_000);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timeout); reject(new ExecutionError({ component: 'docker', code: 'docker_unavailable' })); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      // The unprivileged reviewer cannot attest to provider HTTP; only separate proxy logs can.
      const engine = diagnostics.last && ['engine','codex_process','codex_rpc','model','turn'].includes(diagnostics.last.component)
        ? executionFailure({ ...diagnostics.last, upstream_status: null, provider_code: null, provider_param: null }) : null;
      if (code !== 0 || size > maxBytes || timedOut) reject(new ExecutionError((!timedOut && size <= maxBytes ? engine : null) ?? { component: 'docker',
        code: timedOut ? 'container_timeout' : size > maxBytes ? 'container_output_limit' : code !== null && [125,126,127].includes(code) ? 'container_start_failed' : 'container_exit_failed',
        ...(code !== null ? { exit_code: code } : {}), ...(signal ? { signal } : {}) }));
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
export async function isolatedReview(image: string, directory: string, credentialFile: string, socketDirectory: string, limits: InferenceLimits = {}): Promise<unknown> {
  requireCondition(/^[a-zA-Z0-9._:/@-]+$/.test(image), 'invalid_review_image');
  const id = crypto.randomUUID(), proxy = `codexbot-proxy-${id}`, review = `codexbot-review-${id}`;
  const uid = process.getuid?.(), gid = process.getgid?.();
  requireCondition(uid !== undefined && uid !== 0 && gid !== undefined, 'review_requires_nonroot_linux_runner');
  const common = ['--label', `codexbot.run=${id}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--cpus=2', `--user=${uid}:${gid}`, `--tmpfs=/tmp:rw,noexec,nosuid,size=128m,uid=${uid}`, `--tmpfs=/home/codex:rw,nosuid,size=128m,uid=${uid}`];
  let primary: unknown, result: unknown;
  try {
    await docker(['create', '--name', proxy, '--network=bridge', ...common, '--env', `CODEXBOT_ACCEPTANCE_LIMITS=${JSON.stringify(limits)}`, '--mount', `type=bind,src=${credentialFile},dst=/run/credential,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy`, image, 'node', 'dist/src/runner/proxy-main.js']);
    await docker(['start', proxy]);
    await proxyReady(proxy);
    const output = await docker(['run', '--name', review, '--network=none', ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy,readonly`, image, 'node', 'dist/src/runner/engine-main.js']);
    try { result = JSON.parse(output) as unknown; } catch { throw new ExecutionError({ component: 'engine', code: 'codex_output_not_json' }); }
  } catch (error) {
    const failure = executionError(error, 'docker', 'container_exit_failed');
    // Only this run's credential proxy can report an actual upstream HTTP status.
    const observed = new ExecutionDiagnostics();
    try { observed.write(await docker(['logs', '--tail', '32', proxy], 64_000, observed)); } catch { /* The primary failure remains authoritative when logs are unavailable. */ }
    if (observed.last) failure.proxyFailure = observed.last;
    primary = failure;
  } finally {
    try { await cleanupReviewContainers(id); }
    catch (error) {
      if (!primary) primary = error;
      else console.error(JSON.stringify({ event: 'container_cleanup_failed', code: 'docker_cleanup_failed_check_runner' }));
    }
  }
  if (primary) throw primary;
  return result;
}
