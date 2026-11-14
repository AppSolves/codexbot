import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
const target = { win32: `${process.arch}-pc-windows-msvc`, linux: `${process.arch}-unknown-linux-musl`, darwin: `${process.arch}-apple-darwin` }[process.platform]?.replace(/^x64-/, 'x86_64-').replace(/^arm64-/, 'aarch64-');
assert.ok(target, 'Unsupported catalog generation platform');
const executable = resolve(`node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/${target}/bin/codex${process.platform === 'win32' ? '.exe' : ''}`);
const home = await mkdtemp(join(tmpdir(), 'codexbot-catalog-'));
let stopped = Promise.resolve();
try {
  const models = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server','--listen','stdio://','-c','model_provider="codexbot_catalog"','-c','model_providers.codexbot_catalog.name="Local catalog"', '-c','model_providers.codexbot_catalog.base_url="http://127.0.0.1:1/v1"','-c','model_providers.codexbot_catalog.wire_api="responses"','-c','model_providers.codexbot_catalog.requires_openai_auth=false'],
      { stdio: ['pipe','pipe','ignore'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CODEX_HOME: home } });
    stopped = new Promise(resolve => child.once('close', resolve));
    let buffer = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill(); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => finish(new Error('Catalog query timeout')), 20_000);
    child.on('error', () => finish(new Error('Codex unavailable'))); child.on('exit', () => finish(new Error('Codex exited before catalog response')));
    child.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 2_000_000) return finish(new Error('Catalog response too large'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { return finish(new Error('Invalid catalog protocol')); }
        if (message.id === 1) { child.stdin.write('{"method":"initialized"}\n'); child.stdin.write('{"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}}\n'); }
        if (message.id === 2) {
          if (!Array.isArray(message.result?.data) || message.result.nextCursor) return finish(new Error('Incomplete catalog'));
          finish(null, message.result.data.map(model => ({ model: model.model, isDefault: model.isDefault, efforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort) })));
        }
      }
    });
    child.stdin.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"CodexBotCatalog","version":"0.1.0"}}}\n');
  });
  const version = JSON.parse(await readFile('node_modules/@openai/codex/package.json', 'utf8')).version;
  const encoded = JSON.stringify({ codexVersion: version, models }, null, 2) + '\n', destination = 'src/core/model-catalog.json';
  if (process.argv.includes('--check')) assert.equal(await readFile(destination, 'utf8'), encoded, 'Regenerate pinned catalog with node scripts/model-catalog.mjs');
  else await writeFile(destination, encoded);
  process.stdout.write(`Pinned Codex ${version}: ${models.length} catalog entries, no inference.\n`);
} finally { await stopped; await rm(home, { recursive: true, force: true }); }
