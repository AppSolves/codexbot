import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Rpc } from '../src/runner/rpc.js';
import { record } from '../src/core/errors.js';
await test('pinned official Codex app-server initializes and provides model effort catalog without credentials', { timeout: 30_000 }, async () => {
  const root = tmpdir();
  const directory = await mkdtemp(join(root, 'codexbot-protocol-'));
  const allowed = Object.assign(Object.create(null) as NodeJS.ProcessEnv, { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, CODEX_HOME: directory, SystemRoot: process.env.SystemRoot ?? '', TEMP: directory, TMP: directory });
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = process.platform === 'win32' ? `${architecture}-pc-windows-msvc` : process.platform === 'darwin' ? `${architecture}-apple-darwin` : `${architecture}-unknown-linux-musl`;
  const executable = resolve(`node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/${target}/bin/${process.platform === 'win32' ? 'codex.exe' : 'codex'}`);
  // Execute the official native binary directly: a Windows Node launcher cannot forward SIGKILL.
  const child = spawn(executable, ['app-server', '--listen', 'stdio://',
    '-c','model_provider="codexbot_catalog"','-c','model_providers.codexbot_catalog.name="Local catalog"',
    '-c','model_providers.codexbot_catalog.base_url="http://127.0.0.1:1/v1"',
    '-c','model_providers.codexbot_catalog.wire_api="responses"','-c','model_providers.codexbot_catalog.requires_openai_auth=false'], { env: allowed, cwd: directory, stdio: 'pipe' });
  // Register before any RPC: the process may close before the finally block runs.
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const rpc = new Rpc(child), timer = setTimeout(() => { child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }, 20_000);
  try {
    const initialized = record(await rpc.request('initialize', { clientInfo: { name: 'CodexBot', title: 'CodexBot', version: '0.1.0' } }));
    assert.ok(initialized.userAgent); rpc.notify('initialized');
    const catalog = record(await rpc.request('model/list', { limit: 100, includeHidden: false }));
    assert.ok(Array.isArray(catalog.data) && catalog.data.length > 0);
    for (const item of catalog.data) assert.ok(Array.isArray(record(item).supportedReasoningEfforts));
    const committed=JSON.parse(await readFile('src/core/model-catalog.json','utf8'));
    const installed=JSON.parse(await readFile('node_modules/@openai/codex/package.json','utf8'));
    assert.equal(committed.codexVersion,installed.version,'Regenerate catalog together with a Codex upgrade');
    assert.equal(catalog.nextCursor,null);
    assert.deepEqual(committed.models,catalog.data.map(item=>{const model=record(item);return{model:model.model,isDefault:model.isDefault,efforts:(model.supportedReasoningEfforts as {reasoningEffort:string}[]).map(e=>e.reasoningEffort)};}));
    assert.equal(committed.models.filter((model:{isDefault:boolean})=>model.isDefault).length,1);
  } finally {
    // EOF lets Codex close its SQLite/runtime resources before removing its home.
    // The existing deadline still kills a process that refuses to shut down.
    child.stdin.end(); await closed; clearTimeout(timer);
    child.stdout.destroy(); child.stderr.destroy();
    // fs.rm's bounded EBUSY/EPERM retry covers Windows releasing a terminated native cwd.
    // Other errors still fail this test; the process and its pipes are already closed above.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
