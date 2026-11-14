import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { DEFAULT_CONFIG } from '../dist/src/core/config.js';
import { cleanupReviewContainers } from '../dist/src/runner/docker.js';
import { ExecutionDiagnostics } from '../dist/src/core/execution.js';

// Runs real pinned Codex and real container isolation with synthetic Responses SSE, no credentials/quota.
const id = randomUUID(), volume = `codexbot-test-${id}`, proxy = `codexbot-test-proxy-${id}`, review = `codexbot-test-review-${id}`;
const directory = resolve('.local', `sandbox-${id}`), head = 'a'.repeat(40);
const dockerConfig = resolve('.local', 'docker'); await mkdir(dockerConfig, { recursive: true });
process.env.DOCKER_CONFIG = dockerConfig;
function docker(args, options = {}) { return execFileSync('docker', ['--config', dockerConfig, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, ...options }); }
const result = { head_sha: head, complete: true, result: 'clean', summary: 'Synthetic protocol fixture; no real review or inference was performed.', findings: [] };
const snapshot = { id, head, base: 'b'.repeat(40), config: DEFAULT_CONFIG, command: { effort: null, instructions: '', merge: false } };
await mkdir(directory, { recursive: true });
for (const [path, value] of [['request.json', snapshot], ['manifest.json', { complete: true }], ['diff.json', []], ['trusted-instructions.json', []]]) await writeFile(join(directory, path), JSON.stringify(value));
await mkdir(join(directory, 'source'));
await writeFile(join(directory, 'source', 'fixture.txt'), 'sandbox-read-only-fixture\n');
const output = JSON.stringify(result);
const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output, annotations: [] }] };
const events = [
  { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: output },
  { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: output },
  { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
  { type: 'response.output_item.done', output_index: 0, item },
  { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
const proxyScript = `import {createInferenceServer} from '/app/dist/src/runner/proxy.js';
import {executionEnvelope} from '/app/dist/src/core/execution.js';
let calls=0;
globalThis.fetch = async (url, init) => {
  if(url !== 'https://api.openai.com/v1/responses' || init.headers.Authorization !== 'Bearer fixture-only') throw new Error('Invalid inference boundary');
  const request=JSON.parse(init.body);
  if(request.store!==false || request.stream!==true || !Array.isArray(request.input) || request.input.some(item=>item.role==='system')) throw new Error('Invalid SIWC request contract');
  if(++calls > 1) return Response.json({error:{code:calls===2?'subscription_sharing_unsupported_capability':'model_not_found',param:calls===2?'tools':'model',message:'private-fixture-provider-body'}},{status:calls===2?400:200});
  return new Response(${JSON.stringify(events)}, {headers:{'content-type':'text/event-stream'}});
};
createInferenceServer('fixture-only',{},detail=>process.stderr.write(executionEnvelope(detail)+'\\n')).listen('/run/proxy/inference.sock',()=>process.stdout.write('ready\\n'));`;
const common = ['--label', `codexbot.run=${id}`, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--user=1000:1000', '--tmpfs=/tmp:rw,noexec,nosuid,size=128m,uid=1000', '--tmpfs=/home/codex:rw,nosuid,size=128m,uid=1000'];
const partial = randomUUID();
try {
  await cleanupReviewContainers(partial); // No accepted create is a successful cleanup.
  docker(['create', '--label', `codexbot.run=${partial}`, '--network=none', 'codexbot-review:local', 'node', '-e', 'process.exit(0)']);
  await cleanupReviewContainers(partial); // A single accepted create is also recoverable.
  assert.equal(docker(['ps', '-a', '--filter', `label=codexbot.run=${partial}`, '--format', '{{.ID}}']).trim(), '');
  docker(['volume', 'create', volume]);
  // Named-volume ownership preparation is confined to this disposable volume.
  docker(['run', '--rm', '--network=none', '--user=0:0', '--mount', `type=volume,src=${volume},dst=/run/proxy`, '--entrypoint=node', 'codexbot-review:local', '-e', "require('fs').chownSync('/run/proxy',1000,1000)"]);
  docker(['create', '--name', proxy, ...common, '--mount', `type=volume,src=${volume},dst=/run/proxy`, 'codexbot-review:local', 'node', '--input-type=module', '-e', proxyScript]);
  docker(['start', proxy]);
  await new Promise((resolveReady, reject) => {
    const logs = spawn('docker', ['--config', dockerConfig, 'logs', '-f', proxy], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { logs.kill(); reject(new Error('Fixture proxy not ready')); }, 15_000);
    logs.stdout.on('data', () => { clearTimeout(timer); resolveReady(); logs.kill(); });
    logs.on('error', reject); logs.on('exit', code => { if (code !== null && code !== 0) reject(new Error('Fixture proxy exited')); });
  });
  const probe = `const assert=require('assert/strict'),fs=require('fs'),net=require('net');
    assert.equal(process.env.OPENAI_API_KEY,undefined); assert.equal(process.env.ACCESS_TOKEN,undefined); assert.equal(process.env.GITHUB_TOKEN,undefined);
    assert.throws(()=>fs.writeFileSync('/app/forbidden','x')); assert.equal(fs.existsSync('/run/credential'),false);
    assert.equal(fs.existsSync('/usr/local/lib/node_modules/npm'),false); assert.equal(fs.existsSync('/usr/local/bin/npm'),false); assert.equal(fs.existsSync('/usr/local/bin/yarn'),false);
    assert.equal(require('child_process').execFileSync('/bin/sh',['-c','cat /workspace/source/fixture.txt'],{encoding:'utf8'}),'sandbox-read-only-fixture\\n');
    const socket=net.connect({host:'1.1.1.1',port:443}); socket.on('error',e=>{assert.ok(['ENETUNREACH','EHOSTUNREACH'].includes(e.code));console.log('Filesystem, credentials and network isolation verified')}); socket.on('connect',()=>process.exit(1));`;
  process.stdout.write(docker(['run', '--rm', ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, 'codexbot-review:local', 'node', '-e', probe]));
  docker(['create', '--name', review, ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=volume,src=${volume},dst=/run/proxy,readonly`, 'codexbot-review:local', 'node', 'dist/src/runner/engine-main.js']);
  let refused = false;
  try { docker(['start', '-a', review]); }
  catch (error) {
    refused = true;
    const safe = new ExecutionDiagnostics(); safe.write(String(error.stderr ?? ''));
    assert.equal(error.status, 1); assert.equal(safe.last?.code, 'codex_inspection_not_performed');
    assert.equal(String(error.stdout ?? '').trim(), '');
  }
  assert.equal(refused, true, 'A valid JSON response without inspection must not succeed.');
  process.stdout.write('Pinned Codex refuses scripted complete JSON without file inspection.\n');
  for (const status of [400, 200]) {
    docker(['rm', review]);
    docker(['create', '--name', review, ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=volume,src=${volume},dst=/run/proxy,readonly`, 'codexbot-review:local', 'node', 'dist/src/runner/engine-main.js']);
    let failed = false;
    try { docker(['start', '-a', review]); }
    catch (error) {
      failed = true;
      assert.equal(error.status, 1);
      const engine = new ExecutionDiagnostics(); engine.write(String(error.stderr ?? ''));
      assert.deepEqual(engine.last, { component: 'turn', code: 'codex_turn_failed' });
      assert.equal(String(error.stdout ?? '').trim(), '');
      assert.ok(!String(error.stderr ?? '').includes('private-fixture-provider-body'));
    }
    assert.equal(failed, true, 'Failed inference must exit nonzero with no review output');
    // Read via Node spawn to collect the safe stderr envelope without printing raw logs.
    const observed = new ExecutionDiagnostics();
    await new Promise((resolveLogs, reject) => {
      const logs = spawn('docker', ['--config', dockerConfig, 'logs', '--tail', '32', proxy], { stdio: ['ignore', 'ignore', 'pipe'] });
      logs.stderr.setEncoding('utf8'); logs.stderr.on('data', chunk => observed.write(chunk));
      logs.on('error', reject); logs.on('close', code => code === 0 ? resolveLogs() : reject(new Error('Synthetic proxy observation failed')));
    });
    assert.deepEqual(observed.last, { component: 'provider', code: status === 400 ? 'provider_http_failed' : 'provider_stream_content_type_invalid',
      upstream_status: status, content_type_category: 'json', body_present: true,
      provider_code: status === 400 ? 'subscription_sharing_unsupported_capability' : 'model_not_found', provider_param: status === 400 ? 'tools' : 'model' });
  }
  process.stdout.write('Pinned Codex failed turns for HTTP 400 and HTTP 200 JSON preserve safe proxy metadata, exit 1 and no review output.\n');
} finally {
  await cleanupReviewContainers(id); await cleanupReviewContainers(partial);
  docker(['volume', 'rm', volume]); await rm(directory, { recursive: true, force: true });
}
await import('./inspection-check.mjs');
