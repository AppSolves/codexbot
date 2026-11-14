import process from 'node:process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// Deliberately omit generated Env, node_modules and all local state.
const root = resolve('.local'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'clean-checkout-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run test:clean');
try {
  for (const path of ['src', 'tests', 'scripts', 'migrations', 'docs', 'examples', '.github', 'package.json', 'package-lock.json', 'app-manifest.json', 'tsconfig.json', 'tsconfig.build.json', 'eslint.config.js', 'wrangler.jsonc', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'Dockerfile', '.dockerignore', '.gitignore', '.dev.vars.example']) {
    if (existsSync(path)) cpSync(path, join(directory, path), { recursive: true, dereference: false });
  }
  assert.equal(existsSync(join(directory, 'worker-configuration.d.ts')), false);
  for (const args of [['ci', '--ignore-scripts'], ['run', 'check']]) execFileSync(process.execPath, [npm, ...args], { cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', timeout: 240_000, maxBuffer: 4_000_000 });
  assert.equal(existsSync(join(directory, 'worker-configuration.d.ts')), true);
  process.stdout.write('Clean source checkout: npm ci --ignore-scripts and check passed; Env regenerated.\n');
} catch (error) {
  // This checkout contains no credentials. Surface compiler/test diagnostics, not npm environment.
  if (error.stdout) process.stderr.write(error.stdout);
  process.stderr.write('Clean checkout validation failed.\n'); process.exitCode = 1;
} finally {
  assert.ok(relative(root, directory).startsWith('clean-checkout-'));
  rmSync(directory, { recursive: true, force: true });
}
