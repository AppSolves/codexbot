import { spawn } from 'node:child_process';
import { requireCondition, AppError } from '../core/errors.js';
import type { InferenceLimits } from './proxy.js';

export async function docker(args: string[], maxBytes = 100_000): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0;
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 22 * 60_000);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timeout); reject(new AppError('docker_unavailable')); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0 || size > maxBytes) reject(new AppError('isolated_review_failed')); else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function proxyReady(name: string): Promise<void> {
  const child = spawn('docker', ['logs', '--follow', name], { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let output = '';
  return new Promise((resolve, reject) => {
    child.on('error', () => { clearTimeout(timer); reject(new AppError('proxy_start_failed')); });
    child.once('exit', () => { clearTimeout(timer); reject(new AppError('proxy_start_failed')); });
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
  try {
    await docker(['create', '--name', proxy, '--network=bridge', ...common, '--env', `CODEXBOT_ACCEPTANCE_LIMITS=${JSON.stringify(limits)}`, '--mount', `type=bind,src=${credentialFile},dst=/run/credential,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy`, image, 'node', 'dist/src/runner/proxy-main.js']);
    await docker(['start', proxy]);
    await proxyReady(proxy);
    const output = await docker(['run', '--name', review, '--network=none', ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=bind,src=${socketDirectory},dst=/run/proxy,readonly`, image, 'node', 'dist/src/runner/engine-main.js']);
    return JSON.parse(output) as unknown;
  } finally {
    // Cleanup errors surface after the primary operation; no silent leaked credential container.
    await cleanupReviewContainers(id);
  }
}
