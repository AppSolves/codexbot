import assert from 'node:assert/strict';
import process from 'node:process';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { crc32,deflateSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../dist/src/core/config.js';
import { validateReview, decision } from '../dist/src/core/review.js';
import { ExecutionDiagnostics } from '../dist/src/core/execution.js';
import { cleanupReviewContainers } from '../dist/src/runner/docker.js';
import { writeInspectionFixture } from './inspection-fixture.mjs';
import {buildReviewPlan,validateExecution} from '../dist/src/runner/orchestration.js';
import { assertProviderSchema } from './provider-schema-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const dockerConfig = resolve('.local/docker');
const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
assert.notEqual(uid, 0, 'Use a nonroot Linux runner for the inspection test.');
function docker(args) { return execFileSync('docker', ['--config', dockerConfig, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 }); }
function events(items,inputTokens=1) {
  return [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    ...items.flatMap((item, index) => [{ type: 'response.output_item.added', output_index: index, item }, { type: 'response.output_item.done', output_index: index, item }]),
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items, usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens+1 } } }
  ].map((value, sequence_number) => `data: ${JSON.stringify({ ...value, sequence_number })}\n\n`).join('');
}
// Scripted Responses only; real app-server policy, shell execution, mounts and output validation.
for (const scenario of ['untrusted', 'findings', 'clean', 'incomplete','vision','vision-invalid','schema-invalid','json-invalid','large','continuation','synthesis-incomplete','evidence-tampered','global-budget','cross-group','provider-schema-rejected','reasons-duplicate','synthesis-no-reread','provided-group-evidence','large-compaction']) {
  const id = randomUUID(), proxy = `codexbot-inspection-proxy-${id}`, review = `codexbot-inspection-review-${id}`, volume = `codexbot-inspection-${id}`;
  const root = await mkdtemp(resolve('.local/inspection-')), directory = join(root, 'context'), head = 'a'.repeat(40);
  const config = globalThis.structuredClone(DEFAULT_CONFIG), request = { id, head, base: 'b'.repeat(40), config, command: { merge: false, effort: null, instructions: '' } };
  const fixture = await writeInspectionFixture(directory, request, scenario !== 'clean');
  if(['cross-group','synthesis-incomplete','global-budget','synthesis-no-reread','provided-group-evidence'].includes(scenario)){
    for(let i=1;i<=15;i++){const filename='src/padding-'+String(i).padStart(2,'0')+'.js';fixture.files.push({filename,status:'added',patch:'@@ -0,0 +1 @@\n+export const padding = true;'});await writeFile(join(directory,'source/head',filename),'export const padding = true;');}
    await mkdir(join(directory,'source/head/z-consumer'),{recursive:true});
    const filename='z-consumer/handler.js',consumer="import { canAccess } from '../src/access.js';\nexport const serve = (role, record) => canAccess(role) ? record : null;\n";
    fixture.files.push({filename,status:'added',patch:'@@ -0,0 +1,2 @@\n+'+consumer.trimEnd().split('\n').join('\n+')});await writeFile(join(directory,'source/head',filename),consumer);await writeFile(join(directory,'diff.json'),JSON.stringify(fixture.files));
  }
  if(scenario.startsWith('vision')||scenario.startsWith('large')){
    const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE(crc32(body),out.length-4);return out;};
    const png=index=>scenario==='vision-invalid'?Buffer.from('invalid image'):Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),chunk('IDAT',deflateSync(Buffer.from([0,...[[220,20,20],[20,220,20],[20,20,220],[220,220,20]][index],255]))),chunk('IEND',Buffer.alloc(0))]);
    await mkdir(join(directory,'media/head'),{recursive:true});
    if(scenario.startsWith('large'))for(let i=1;i<89;i++){
      const filename='src/module-'+String(i).padStart(3,'0')+'.js';
      fixture.files.push({filename,status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'});
      await writeFile(join(directory,'source/base',filename),'old');await writeFile(join(directory,'source/head',filename),'new');
    }
    const images=scenario.startsWith('large')?['image.png','second.png','third.png','fourth.png']:['image.png'];
    const imageBytes=images.map((_,index)=>png(index));
    for(const [index,filename]of images.entries()){fixture.files.push({filename,status:'added'});await writeFile(join(directory,'media/head',filename),imageBytes[index]);}
    await writeFile(join(directory,'diff.json'),JSON.stringify(fixture.files));
    await writeFile(join(directory,'manifest.json'),JSON.stringify({complete:true,binaryFiles:images.map((filename,index)=>({filename,format:'png',snapshots:[{side:'head',path:filename,sha:createHash('sha1').update('blob '+imageBytes[index].length+'\0').update(imageBytes[index]).digest('hex'),bytes:imageBytes[index].length}]}))}));
  }
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const plan=await buildReviewPlan(directory,head,request.base,manifest.binaryFiles??[]);
  if(scenario==='evidence-tampered')await writeFile(join(directory,'source/head/src/access.js'),'tampered fixture');
  const evidence = { diff: hash(JSON.stringify(fixture.files)), source: hash(fixture.source), base: hash(fixture.base), instructions: hash(JSON.stringify(fixture.instructions)), caller: hash(fixture.caller), hostile: hash(fixture.injection) };
  const result = { head_sha: head, complete: scenario !== 'incomplete', result: scenario === 'clean' ? 'clean' : 'findings',
    summary: 'Scripted protocol fixture after verified file inspection; not a live AI review.', findings: scenario === 'clean' ? [] : [{
      severity: 'high', confidence: 0.99, path: 'src/access.js', line: 3, side: 'RIGHT', title: 'Reject unauthorized roles',
      explanation: 'The nonempty owner string makes the authorization result truthy for every other role.', remediation: 'Compare role against owner explicitly.' }] };
  const encodedResult=scenario==='json-invalid'?'not-json':JSON.stringify(scenario==='schema-invalid'?{unexpected:true}:result);
  const probe = `import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import {createHash} from 'node:crypto';
    const lookup=(body,path='/file')=>new Promise((resolve,reject)=>{const r=http.request({socketPath:'/run/proxy/context.sock',path,method:'POST'},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>resolve(JSON.parse(text)))});r.on('error',reject);r.end(JSON.stringify(body))});
    assert.deepEqual(await lookup({snapshot:'head',path:'optional-missing.js'},'/probe'),{exists:false});
    assert.deepEqual(await lookup({snapshot:'head',path:'src/caller.js'},'/probe'),{exists:true});
    assert.deepEqual(await lookup({snapshot:'head',path:'src/caller.js'}),{available:true});
    assert.deepEqual(await lookup({snapshot:'head',path:'src/caller.js',url:'https://evil.invalid'}),{error:'context_lookup_unavailable'});
    if(${JSON.stringify(scenario)}==='cross-group')assert.ok(fs.readFileSync('/workspace/source/head/z-consumer/handler.js','utf8').includes('canAccess'));
    for(const [name,path] of Object.entries({diff:'/workspace/diff.json',source:'/workspace/source/head/src/access.js',base:'/workspace/source/base/src/access.js',instructions:'/workspace/trusted-instructions.json',caller:'/workspace/source/head/src/caller.js',hostile:'/workspace/source/head/README.md'})) console.log('fixture_read_'+name+'='+createHash('sha256').update(fs.readFileSync(path)).digest('hex'));
    for(const key of ['GITHUB_TOKEN','OPENAI_API_KEY','ACCESS_TOKEN','CODEXBOT_VAULT_KEY','CODEXBOT_API_KEY']) assert.equal(process.env[key],undefined);
    assert.equal(fs.existsSync('/run/credential'),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);
    assert.throws(()=>fs.writeFileSync('/workspace/source/head/src/access.js','tamper'));assert.throws(()=>fs.writeFileSync('/app/forbidden','tamper'));
    await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(2000,()=>{s.destroy();reject(new Error('Unexpected network timeout'))});s.on('connect',()=>{s.destroy();reject(new Error('Unexpected network access'))});s.on('error',e=>{assert.ok(['ENETUNREACH','EHOSTUNREACH'].includes(e.code));resolve()})});
    console.log('fixture_isolation_verified');`;
  await writeFile(join(directory, 'inspect.mjs'), probe);
  await writeFile(join(root, 'credential'), 'fixture-only', { mode: 0o600 });
  // Native controls change approval policy or force compaction using synthetic token accounting only.
  const preload = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);const write=child.stdin.write.bind(child.stdin);child.stdin.write=(chunk,...rest)=>{const msg=JSON.parse(String(chunk));if(msg.method==='thread/start'){if(${JSON.stringify(scenario)}==='large-compaction')msg.params.config={...msg.params.config,model_context_window:131072,model_auto_compact_token_limit:50000};else msg.params.approvalPolicy='untrusted';}return write(JSON.stringify(msg)+'\\n',...rest)};return child};syncBuiltinESMExports();`;
  await writeFile(join(directory, 'untrusted-control.mjs'), preload);
  const proxyScript = `import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createInferenceServer} from '/app/dist/src/runner/proxy.js';import {contextServer} from '/app/dist/src/runner/context-server.js';import {executionEnvelope,proxyRequestEnvelope} from '/app/dist/src/core/execution.js';import {readFile} from 'node:fs/promises';
    const assertProviderSchema=${assertProviderSchema.toString()};
    await contextServer('/run/proxy/context.sock',async(snapshot,path)=>snapshot==='head'&&path==='src/caller.js');
    const token=(await readFile('/run/credential','utf8')).trim();
    const evidence=${JSON.stringify(evidence)};let calls=0;const unitCalls=new Map();let firstImages=null;
    const events=${events.toString()};
    globalThis.fetch=async(url,init)=>{
      if(url!=='https://api.openai.com/v1/responses'||init.headers.Authorization!=='Bearer fixture-only')throw new Error('Fixture boundary failed');
      try{const format=JSON.parse(init.body).text?.format;if(format?.schema)assert.equal(format.strict,true);if(${JSON.stringify(scenario)}==='provider-schema-rejected')format.schema.properties.unfinished_reasons.uniqueItems=true;if(format?.schema)assertProviderSchema(format.schema);else assert.equal(${JSON.stringify(scenario)},'large-compaction');}catch{return Response.json({error:{code:'invalid_json_schema',param:'text.format.schema',message:'Synthetic schema contract rejection'}},{status:400});}
      if(${JSON.stringify(scenario)}==='synthesis-no-reread'&&JSON.parse(init.body).text.format.schema.properties.unit_id.enum[0]==='synthesis')return new Response(events([{id:'msg_synthesis',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({unit_id:'synthesis',review:${encodedResult},unfinished_reasons:[]}),annotations:[]}]}]),{headers:{'content-type':'text/event-stream'}});
      const body=JSON.parse(init.body);const media=[];const texts=[];const visit=v=>{if(v&&typeof v==='object'){if(v.type==='input_image'&&typeof v.image_url==='string')media.push(createHash('sha256').update(v.image_url).digest('hex'));if(typeof v.text==='string'){try{const item=JSON.parse(v.text);if(item.head_sha&&typeof item.unit_id==='string')texts.push(item)}catch{}}for(const x of Object.values(v))visit(x)}};visit(body.input);const requiredImages=${manifest.binaryFiles?.length??0};if(requiredImages){const unique=[...new Set(media)];if(!firstImages){if(unique.length!==requiredImages)throw new Error('Initial distinct image count incorrect');firstImages=unique;}if(firstImages.some(image=>!unique.includes(image)))throw new Error('A distinct required image was lost across turns');}if(!body.text?.format?.schema){console.log('fixture_compaction_verified');return new Response(events([{id:'msg_compact',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic compaction checkpoint. Continue the next host-assigned group using its verified evidence; preserve the validated finding.',annotations:[]}]}]),{headers:{'content-type':'text/event-stream'}});}const assigned=texts.at(-1);const unitId=assigned?.unit_id;if(unitId&&unitId!=='synthesis'){const payload=JSON.parse(assigned.evidence);const expected=${JSON.stringify(plan.units)}.find(u=>u.id===unitId);if(!expected||createHash('sha256').update(payload.evidence).digest('hex')!==expected.sha256)throw new Error('Unit evidence receipt missing');}if(unitId==='synthesis'&&${JSON.stringify(plan.units)}.some(u=>!unitCalls.has(u.id)))throw new Error('Synthesis skipped a required group');if(!unitId)throw new Error('No host assigned unit');const round=(unitCalls.get(unitId)??0)+1;unitCalls.set(unitId,round);calls++;if(${JSON.stringify(scenario.startsWith('vision'))}&&!JSON.stringify(body.input).includes('data:image/'))throw new Error('Native Codex did not supply image data');if(${JSON.stringify(scenario)}==='provided-group-evidence'&&unitId!=='group-00')return new Response(events([{id:'msg_reuse',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({unit_id:unitId,review:${encodedResult},unfinished_reasons:[]}),annotations:[]}]}]),{headers:{'content-type':'text/event-stream'}});if(round%2===1){const tools=[...(body.tools??[]),...body.input.filter(item=>item.type==='additional_tools').flatMap(item=>item.tools??[])];
        if(!tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools.some(t=>t.type==='custom'&&t.name==='exec'))throw new Error('Pinned code-mode tool missing');console.log('fixture_tool_selected');
        return new Response(events([{id:'fc_fixture_'+calls,call_id:'call_fixture_'+calls,namespace:'functions',name:'exec',type:'custom_tool_call',input:'const r=await tools.exec_command({cmd:"node /workspace/inspect.mjs",yield_time_ms:10000,max_output_tokens:2000});text(r);'}]),{headers:{'content-type':'text/event-stream'}})}
      const output=JSON.stringify(body.input.filter(item=>['function_call_output','custom_tool_call_output'].includes(item.type)));
      if(!Object.entries(evidence).every(([key,value])=>output.includes('fixture_read_'+key+'='+value))||!output.includes('fixture_isolation_verified'))throw new Error('Fixture inspection or isolation failed');
      console.log('fixture_inspection_verified');
      const value=${JSON.stringify(scenario==='json-invalid'?'not-json':JSON.parse(encodedResult))};let finished=value;
      if(${JSON.stringify(scenario)}!=='json-invalid'){
        const incomplete=(${JSON.stringify(['continuation','large','large-compaction'])}.includes(${JSON.stringify(scenario)})&&unitId==='group-00'&&round===2)||(${JSON.stringify(scenario)}==='synthesis-incomplete'&&unitId==='synthesis')||${JSON.stringify(scenario)}==='incomplete';
        if(incomplete&&value&&value.head_sha)value.complete=false;if(${JSON.stringify(scenario)}==='cross-group'&&unitId!=='synthesis'){value.findings=[];value.result='clean';}
        finished=JSON.stringify({unit_id:unitId,review:value,unfinished_reasons:${JSON.stringify(scenario)}==='reasons-duplicate'?['unresolved_analysis','unresolved_analysis']:incomplete?['unreviewed_changes']:[]});
      }
      return new Response(events([{id:'msg_fixture_'+calls,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:finished,annotations:[]}]}],${JSON.stringify(scenario)}==='large-compaction'&&unitId==='group-00'&&round===4?60000:1),{headers:{'content-type':'text/event-stream'}});
    };const finite=globalThis.fetch;globalThis.fetch=async(url,init)=>{const value=await finite(url,init);if(calls%2!==0||!${JSON.stringify(['clean','incomplete'])}.includes(${JSON.stringify(scenario)}))return value;const bytes=new Uint8Array(await value.arrayBuffer());return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}}),{status:value.status,headers:value.headers});};createInferenceServer(token,{minimumImages:${manifest.binaryFiles?.length??0},maxRequests:${scenario==='global-budget'?3:100}},detail=>process.stderr.write(executionEnvelope(detail)+'\\n'),value=>process.stderr.write(proxyRequestEnvelope(value)+'\\n')).listen('/run/proxy/inference.sock',()=>console.log('ready'));`;
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
    const run = spawnSync('docker', ['--config', dockerConfig, 'run', '--name', review, ...common, '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--mount', `type=volume,src=${volume},dst=/run/proxy,readonly`, 'codexbot-review:local', 'node', ...(['untrusted','large-compaction'].includes(scenario) ? ['--import', '/workspace/untrusted-control.mjs'] : []), 'dist/src/runner/engine-main.js'], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 100_000 });
    const observed = new ExecutionDiagnostics(); observed.write(run.stderr ?? '');
    const logs = spawnSync('docker', ['--config', dockerConfig, 'logs', proxy], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    const inspected = (logs.stdout ?? '').includes('fixture_inspection_verified');
    const proxyFailure = new ExecutionDiagnostics(); proxyFailure.write(logs.stderr ?? '');
    if(scenario==='provider-schema-rejected'){
      assert.equal(run.status,1);assert.equal(run.stdout.trim(),'');assert.equal(observed.last?.code,'codex_turn_failed');assert.equal(inspected,false);assert.equal(proxyFailure.last?.code,'provider_http_failed');assert.equal(proxyFailure.last?.upstream_status,400);assert.equal(proxyFailure.last?.request_index,1);assert.equal(proxyFailure.last?.provider_code,'invalid_json_schema');assert.equal(proxyFailure.last?.provider_param,'text.format.schema');
    } else if (['untrusted','vision-invalid','schema-invalid','json-invalid','evidence-tampered','reasons-duplicate'].includes(scenario)) {
      assert.equal(run.status, 1); assert.equal(run.stdout.trim(), '');
      if(scenario!=='vision-invalid')assert.equal(observed.last?.code, scenario==='untrusted' ? 'codex_inspection_denied' : scenario==='json-invalid'?'codex_output_not_json':scenario==='evidence-tampered'?'review_plan_unverifiable':'review_incomplete');
      else assert.equal((logs.stdout??'').includes('fixture_tool_selected'),false,'Invalid images must not reach upstream inference');
      if(['schema-invalid','reasons-duplicate'].includes(scenario))assert.equal(observed.last?.rejection_reason,'schema_invalid');
      assert.equal(inspected, ['incomplete','schema-invalid','json-invalid','reasons-duplicate'].includes(scenario));

    } else {
      assert.equal(run.status, 0, 'Actual Codex inspection failed; raw logs withheld'); assert.equal(inspected, true);
      const execution=validateExecution(JSON.parse(run.stdout),plan);assert.equal(execution.synthesis,!['incomplete','synthesis-incomplete','global-budget'].includes(scenario));assert.equal(execution.coverage.length,plan.units.length);const output = validateReview(execution.review, head, fixture.files); assert.deepEqual(output, ['synthesis-incomplete','global-budget'].includes(scenario)?{...result,complete:false}:result);if(scenario==='cross-group'){assert.equal(execution.coverage.length,2);assert.equal(execution.turns,3);}if(scenario.startsWith('large')){assert.equal(plan.files.length,93);assert.equal(plan.binaries.length,4);assert.equal(execution.coverage.length,6);assert.equal(new Set(plan.binaries.flatMap(b=>b.snapshots.map(s=>s.sha))).size,4);assert.equal(execution.coverage[0].attempts,2);assert.equal(execution.turns,8);assert.equal(proxyFailure.request?.request_index,scenario==='large-compaction'?17:16);if(scenario==='large-compaction')assert.equal((logs.stdout??'').split('\n').filter(line=>line==='fixture_compaction_verified').length,1);}if(scenario==='continuation'){assert.equal(execution.coverage[0].attempts,2);assert.equal(execution.turns,2);}if(scenario==='global-budget'){assert.equal(execution.failure.code,'codex_turn_failed');assert.equal(proxyFailure.last.code,'proxy_request_limit');}
      assert.equal(decision(output, config, true), scenario === 'clean' ? 'APPROVE' : ['incomplete','synthesis-incomplete','global-budget'].includes(scenario)?'COMMENT':'REQUEST_CHANGES');
    }
    if(['clean','incomplete'].includes(scenario)){assert.equal(proxyFailure.request?.request_index,scenario==='clean'?2:6);assert.equal(proxyFailure.request.primary,null);assert.equal(proxyFailure.request.cleanup,null);assert.equal(proxyFailure.request.terminal_event,'completed');assert.equal(proxyFailure.last,null);}
    if(['synthesis-no-reread','provided-group-evidence'].includes(scenario)){const execution=validateExecution(JSON.parse(run.stdout),plan);assert.equal(execution.coverage.length,2);assert.equal(execution.synthesis,true);assert.equal(execution.turns,3);assert.equal(execution.review.complete,true);assert.equal(proxyFailure.request?.request_index,scenario==='synthesis-no-reread'?5:4);}
    console.log(`Actual pinned Codex inspection/isolation scenario passed: ${scenario} (scripted Responses, no live AI inference).`);
  } finally { await cleanupReviewContainers(id); docker(['volume','rm',volume]); assert.equal(dirname(root), resolve('.local')); await rm(root, { recursive:true, force:true }); }
}
