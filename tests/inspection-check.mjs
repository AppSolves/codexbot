import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../dist/src/core/config.js';
import { validateReview, decision } from '../dist/src/core/review.js';
import { ExecutionDiagnostics } from '../dist/src/core/execution.js';
import { cleanupReviewContainers } from '../dist/src/runner/docker.js';
import { writeInspectionFixture } from './inspection-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const dockerConfig = resolve('.local/docker');
const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
assert.notEqual(uid, 0, 'Use a nonroot Linux runner for the inspection test.');
function docker(args) { return execFileSync('docker', ['--config', dockerConfig, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 }); }
function events(items) {
  return [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    ...items.flatMap((item, index) => [{ type: 'response.output_item.added', output_index: index, item }, { type: 'response.output_item.done', output_index: index, item }]),
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ].map((value, sequence_number) => `data: ${JSON.stringify({ ...value, sequence_number })}\n\n`).join('');
}
// Scripted Responses only; real app-server policy, shell execution, mounts and output validation.
for (const scenario of ['untrusted', 'findings', 'clean', 'incomplete']) {
  const id = randomUUID(), proxy = `codexbot-inspection-proxy-${id}`, review = `codexbot-inspection-review-${id}`, volume = `codexbot-inspection-${id}`;
  const root = await mkdtemp(resolve('.local/inspection-')), directory = join(root, 'context'), head = 'a'.repeat(40);
  const config = globalThis.structuredClone(DEFAULT_CONFIG), request = { id, head, base: 'b'.repeat(40), config, command: { merge: false, effort: null, instructions: '' } };
  const fixture = await writeInspectionFixture(directory, request, scenario !== 'clean');
  const evidence = { diff: hash(JSON.stringify(fixture.files)), source: hash(fixture.source), base: hash(fixture.base), instructions: hash(JSON.stringify(fixture.instructions)) };
  const result = { head_sha: head, complete: scenario !== 'incomplete', result: scenario === 'clean' ? 'clean' : scenario === 'incomplete' ? 'inconclusive' : 'findings',
    summary: 'Scripted protocol fixture after verified file inspection; not a live AI review.', findings: scenario === 'clean' || scenario === 'incomplete' ? [] : [{
      severity: 'high', confidence: 0.99, path: 'src/access.js', line: 3, side: 'RIGHT', title: 'Reject unauthorized roles',
      explanation: 'The nonempty owner string makes the authorization result truthy for every other role.', remediation: 'Compare role against owner explicitly.' }] };
  const probe = `import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import {createHash} from 'node:crypto';
    for(const [name,path] of Object.entries({diff:'/workspace/diff.json',source:'/workspace/source/head/src/access.js',base:'/workspace/source/base/src/access.js',instructions:'/workspace/trusted-instructions.json'})) console.log('fixture_read_'+name+'='+createHash('sha256').update(fs.readFileSync(path)).digest('hex'));
    for(const key of ['GITHUB_TOKEN','OPENAI_API_KEY','ACCESS_TOKEN','CODEXBOT_VAULT_KEY','CODEXBOT_API_KEY']) assert.equal(process.env[key],undefined);
    assert.equal(fs.existsSync('/run/credential'),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);
    assert.throws(()=>fs.writeFileSync('/workspace/source/head/src/access.js','tamper'));assert.throws(()=>fs.writeFileSync('/app/forbidden','tamper'));
    await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(2000,()=>{s.destroy();reject(new Error('Unexpected network timeout'))});s.on('connect',()=>{s.destroy();reject(new Error('Unexpected network access'))});s.on('error',e=>{assert.ok(['ENETUNREACH','EHOSTUNREACH'].includes(e.code));resolve()})});
    console.log('fixture_isolation_verified');`;
  await writeFile(join(directory, 'inspect.mjs'), probe);
  await writeFile(join(root, 'credential'), 'fixture-only', { mode: 0o600 });
  // Negative control changes only the actual native thread's approval setting.
  const preload = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk,...rest)=>{const msg=JSON.parse(String(chunk));if(msg.method==='thread/start')msg.params.approvalPolicy='untrusted';return write(JSON.stringify(msg)+'\\n',...rest)};return child};syncBuiltinESMExports();`;
  await writeFile(join(directory, 'untrusted-control.mjs'), preload);
  const proxyScript = `import {createInferenceServer} from '/app/dist/src/runner/proxy.js';import {executionEnvelope} from '/app/dist/src/core/execution.js';import {readFile} from 'node:fs/promises';
    const token=(await readFile('/run/credential','utf8')).trim();
    const evidence=${JSON.stringify(evidence)};let calls=0;
    const events=${events.toString()};
    globalThis.fetch=async(url,init)=>{
      if(url!=='https://api.openai.com/v1/responses'||init.headers.Authorization!=='Bearer fixture-only')throw new Error('Fixture boundary failed');
      const body=JSON.parse(init.body);if(++calls===1){const tools=[...(body.tools??[]),...body.input.filter(item=>item.type==='additional_tools').flatMap(item=>item.tools??[])];
        if(!tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools.some(t=>t.type==='custom'&&t.name==='exec'))throw new Error('Pinned code-mode tool missing');console.log('fixture_tool_selected');
        return new Response(events([{id:'fc_fixture',call_id:'call_fixture',namespace:'functions',name:'exec',type:'custom_tool_call',input:'const r=await tools.exec_command({cmd:"node /workspace/inspect.mjs",yield_time_ms:10000,max_output_tokens:2000});text(r);'}]),{headers:{'content-type':'text/event-stream'}})}
      const output=JSON.stringify(body.input.filter(item=>['function_call_output','custom_tool_call_output'].includes(item.type)));
      if(calls!==2||!Object.entries(evidence).every(([key,value])=>output.includes('fixture_read_'+key+'='+value))||!output.includes('fixture_isolation_verified'))throw new Error('Fixture inspection or isolation failed');
      console.log('fixture_inspection_verified');
      return new Response(events([{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:${JSON.stringify(JSON.stringify(result))},annotations:[]}]}]),{headers:{'content-type':'text/event-stream'}});
    };createInferenceServer(token,{},detail=>process.stderr.write(executionEnvelope(detail)+'\\n')).listen('/run/proxy/inference.sock',()=>console.log('ready'));`;
  const common = ['--label', `codexbot.run=${id}`, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--cpus=2', `--user=${uid}:${gid}`, `--tmpfs=/tmp:rw,noexec,nosuid,size=128m,uid=${uid}`, `--tmpfs=/home/codex:rw,nosuid,size=128m,uid=${uid}`];
  try {
    docker(['volume', 'create', volume]);
    docker(['run', '--rm', '--network=none', '--user=0:0', '--mount', `type=volume,src=${volume},dst=/run/proxy`, '--entrypoint=node', 'codexbot-review:local', '-e', `require('fs').chownSync('/run/proxy',${uid},${gid})`]);
    docker(['create', '--name', proxy, ...common, '--mount', `type=bind,src=${join(root,'credential')},dst=/run/credential,readonly`, '--mount', `type=volume,src=${volume},dst=/run/proxy`, 'codexbot-review:local', 'node', '--input-type=module', '-e', proxyScript]);
    docker(['start', proxy]);
    // A bounded readiness observer; never print raw logs.
    await new Promise((resolveReady, reject) => {
      const logs = spawn('docker', ['--config', dockerConfig, 'logs', '-f', proxy], { stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { logs.kill(); reject(new Error('Inspection fixture proxy unavailable')); }, 15_000);
      logs.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolveReady(); logs.kill(); } });
      logs.on('error', () => { clearTimeout(timer); reject(new Error('Inspection fixture logs unavailable')); });
      logs.on('close', () => { clearTimeout(timer); reject(new Error('Inspection fixture proxy closed')); });
    });
    const run = spawnSync('docker', ['--config', dockerConfig, 'run', '--name', review, ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=volume,src=${volume},dst=/run/proxy,readonly`, 'codexbot-review:local', 'node', ...(scenario === 'untrusted' ? ['--import', '/workspace/untrusted-control.mjs'] : []), 'dist/src/runner/engine-main.js'], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 100_000 });
    const observed = new ExecutionDiagnostics(); observed.write(run.stderr ?? '');
    const logs = spawnSync('docker', ['--config', dockerConfig, 'logs', proxy], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    const inspected = (logs.stdout ?? '').includes('fixture_inspection_verified');
    const proxyFailure = new ExecutionDiagnostics(); proxyFailure.write(logs.stderr ?? '');
    if (run.status !== (['untrusted','incomplete'].includes(scenario) ? 1 : 0) || (scenario === 'untrusted' && observed.last?.code !== 'codex_inspection_denied')) console.error(JSON.stringify({ scenario, failure: observed.last, proxy: proxyFailure.last, selected: (logs.stdout ?? '').includes('fixture_tool_selected'), inspected }));
    if (scenario === 'untrusted' || scenario === 'incomplete') {
      assert.equal(run.status, 1); assert.equal(run.stdout.trim(), '');
      assert.equal(observed.last?.code, scenario === 'untrusted' ? 'codex_inspection_denied' : 'review_incomplete');
      assert.equal(inspected, scenario === 'incomplete');
    } else {
      assert.equal(run.status, 0, 'Actual Codex inspection failed; raw logs withheld'); assert.equal(inspected, true);
      const output = validateReview(JSON.parse(run.stdout), head, fixture.files); assert.deepEqual(output, result);
      assert.equal(decision(output, config, true), scenario === 'clean' ? 'APPROVE' : 'REQUEST_CHANGES');
    }
    console.log(`Actual pinned Codex inspection/isolation scenario passed: ${scenario} (scripted Responses, no live AI inference).`);
  } finally { await cleanupReviewContainers(id); docker(['volume','rm',volume]); assert.equal(dirname(root), resolve('.local')); await rm(root, { recursive:true, force:true }); }
}
