import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crc32,deflateSync} from 'node:zlib';
import {Octokit} from '@octokit/rest';
import {collectContext} from '../src/runner/context.js';
import {binaryChange} from '../src/core/binary.js';
import {gitSource} from '../src/core/git-source.js';
import {publish} from '../src/worker/publish.js';
import {githubFixture} from './github-fixture.js';
import {snapshot,HEAD,BASE,WORKFLOW,clean,files} from './fixtures.js';
import type {ChangedFile} from '../src/core/review.js';

function chunk(type:string,data:Buffer){const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE(crc32(body),out.length-4);return out;}
const ihdr=Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]);
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
const sha=(b:Buffer)=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
function sourceFixture(before:Record<string,Buffer>,after:Record<string,Buffer>,changed:ChangedFile[],options:{mode?:string;corrupt?:boolean;truncated?:boolean;headMoves?:boolean;apiError?:boolean;partial?:boolean}={}){
  const trees=new Map<string,unknown[]>(),blobs=new Map<string,Buffer>(),roots=new Map<string,string>(),calls:string[]=[];
  const build=(entries:Record<string,Buffer>,prefix=''):string=>{
    const names=[...new Set(Object.keys(entries).map(p=>p.slice(prefix.length).split('/')[0]))];
    const tree=names.map(name=>{
      const path=prefix+name,b=entries[path];
      if(b){const id=sha(b);blobs.set(id,b);return{path:name,type:options.mode==='160000'?'commit':'blob',mode:name==='AGENTS.md'?'100644':options.mode??'100644',sha:id,size:b.length};}
      return{path:name,type:'tree',mode:'040000',sha:build(Object.fromEntries(Object.entries(entries).filter(([p])=>p.startsWith(path+'/'))),path+'/')};
    });
    const id=createHash('sha1').update(JSON.stringify(tree)).digest('hex');trees.set(id,tree);return id;
  };
  before={'AGENTS.md':Buffer.from('Inspect changed behavior, callers and tests. Do not execute project code.'),...before};
  after={'AGENTS.md':before['AGENTS.md']!,...after};
  roots.set(BASE,build(before));roots.set(WORKFLOW,roots.get(BASE)!);roots.set(HEAD,build(after));let reads=0;
  const fetcher:typeof fetch=async input=>{
    const url=new URL(String(input)),path=url.pathname;calls.push(path);
    if(path.endsWith('/pulls/4'))return Response.json({head:{sha:options.headMoves&&++reads>1?BASE:HEAD},base:{sha:BASE},changed_files:changed.length});
    if(path.endsWith('/pulls/4/files')){const page=Number(url.searchParams.get('page'));return Response.json(options.partial?[]:changed.slice((page-1)*100,page*100));}
    const id=path.split('/').at(-1)!;
    if(path.includes('/git/commits/'))return options.apiError?Response.json({message:'Unavailable'},{status:404}):Response.json({sha:id,tree:{sha:roots.get(id)}});
    if(path.includes('/git/trees/')){assert(trees.has(id));assert(!roots.has(id));return Response.json({sha:id,truncated:options.truncated??false,tree:trees.get(id)});}
    if(path.includes('/git/blobs/')){assert(blobs.has(id));return Response.json({sha:id,encoding:'base64',content:(options.corrupt?Buffer.from('tampered'):blobs.get(id)!).toString('base64')});}
    throw Error('Unexpected fixture API path');
  };
  return {github:new Octokit({request:{fetch:fetcher},log:{debug(){},info(){},warn(){},error(){}}}),calls,fetcher};
}
async function context(before:Record<string,Buffer>,after:Record<string,Buffer>,changed:ChangedFile[],options:Parameters<typeof sourceFixture>[3]={}){
  const f=sourceFixture(before,after,changed,options),directory=await mkdtemp(join(tmpdir(),'codexbot-large-'));
  try{const manifest=await collectContext(f.github,snapshot(),directory);return{manifest,calls:f.calls,diff:JSON.parse(await readFile(join(directory,'diff.json'),'utf8')) as unknown,sourcePaths:await readFile(join(directory,'file-index.json'),'utf8')};}
  finally{await rm(directory,{recursive:true,force:true});}
}
const textFile:ChangedFile={filename:'src/a.ts',status:'modified',additions:1,deletions:1,patch:'@@ -1 +1 @@\n-old\n+new'};
await test('93-file / 89-text-patch PR verifies screenshots and exceeds the old 100-operation budget without dropping essential context',async()=>{
  const before:Record<string,Buffer>={},after:Record<string,Buffer>={},changed:ChangedFile[]=[];
  for(let i=0;i<89;i++){
    const path=`src/file-${i}.ts`,lines=Array.from({length:98},(_,n)=>`// text ${i}:${n}`);before[path]=Buffer.from(`// old ${i}\n`);after[path]=Buffer.from(lines.join('\n')+'\n');
    changed.push({filename:path,status:'modified',additions:98,deletions:1,patch:`@@ -1 +1,98 @@\n-// old ${i}\n`+lines.map(x=>'+'+x).join('\n')});
  }
  for(const path of ['docs/reviews/issue-35-status-truth/approval-390.png','docs/reviews/issue-35-status-truth/booked-1366.png','docs/reviews/issue-76-detail-readback/approved-refresh-1366.png','docs/reviews/issue-76-detail-readback/approved-refresh-390.png']){after[path]=png;changed.push({filename:path,status:'added'});}
  const {manifest,calls,diff}=await context(before,after,changed);assert.equal(manifest.complete,true,JSON.stringify(manifest));assert.equal(manifest.diffComplete,true);assert.equal(manifest.requiredContextComplete,true);
  assert(manifest.apiCalls>100);assert(manifest.apiCalls<300);assert.equal(manifest.binaryFiles.length,4);assert.equal((diff as unknown[]).length,93);
  assert(manifest.binaryFiles.every(x=>x.format==='png'&&x.inspection==='requires-model'&&x.snapshots[0]!.sha===sha(png)));
  assert.equal(calls.filter(x=>x.endsWith('/git/blobs/'+sha(png))).length,1);assert.match(manifest.limitations.join(' '),/localImage inputs/);
});
await test('added, modified, deleted and renamed images verify both immutable sides and are not UTF-8 source',async()=>{
  for(const status of ['added','modified','removed','renamed']){
    const before=status==='added'?{}:{[status==='renamed'?'old.png':'image.png']:png},after=status==='removed'?{}:{'image.png':png};
    const result=await context(before,after,[{filename:'image.png',status,...(status==='renamed'?{previous_filename:'old.png'}:{})}]);
    assert.equal(result.manifest.complete,true,status+JSON.stringify(result.manifest));assert.equal(result.manifest.files,1);assert.equal(result.manifest.binaryFiles[0]!.snapshots.length,['added','removed'].includes(status)?1:2);
  }
});
await test('binary verification enforces cumulative bytes, image framing and safe paths independently of extensions',async()=>{
  const f=sourceFixture({}, {'image.png':png},[]),source=gitSource(f.github,{owner:'owner',repo:'repo'},()=>{});
  await assert.rejects(binaryChange({filename:'image.png',status:'added'},BASE,HEAD,source,{bytes:8_000_000,shas:new Set()}),/context_binary_size_limit/);
  await assert.rejects(binaryChange({filename:'../image.png',status:'added'},BASE,HEAD,source,{bytes:0,shas:new Set()}),/invalid_context_path/);
  const corrupted=Buffer.concat([png,Buffer.from('trailing executable payload')]);
  assert.equal((await context({}, {'image.png':corrupted},[{filename:'image.png',status:'added'}])).manifest.complete,false);
});
await test('missing/truncated text, arbitrary binaries, extension spoofing, corruption and special Git modes fail closed',async()=>{
  const variants=[{path:'src/a.ts',bytes:Buffer.from('text'),patch:undefined},{path:'image.png',bytes:Buffer.from('MZ\0executable'),patch:undefined},{path:'src/a.ts',bytes:png,patch:undefined},{path:'archive.zip',bytes:Buffer.from('PK\0binary'),patch:undefined},{path:'src/a.ts',bytes:Buffer.from('text'),patch:'@@ -1 +1,2 @@\n-old\n+new'}];
  for(const v of variants){const result=await context({}, {[v.path]:v.bytes},[{filename:v.path,status:'added',...(v.patch?{patch:v.patch}:{})}]);assert.equal(result.manifest.complete,false,v.path);}
  for(const options of [{mode:'120000'},{mode:'160000'},{mode:'100755'},{corrupt:true},{truncated:true},{apiError:true}])assert.equal((await context({}, {'image.png':png},[{filename:'image.png',status:'added'}],options)).manifest.complete,false);
  await assert.rejects(context({}, {'image.png':png},[{filename:'image.png',status:'added'}],{headMoves:true}),/pr_changed_during/);
  await assert.rejects(context({}, {'image.png':png},[{filename:'image.png',status:'added'}],{partial:true}),/diff_truncated/);
});
await test('source, serialized diff and API hard budgets remain finite with precise failure codes',async()=>{
  const large=await context({'src/a.ts':Buffer.from('x'.repeat(512001))},{'src/a.ts':Buffer.from('new')},[textFile]);assert.equal(large.manifest.complete,false);assert(large.manifest.failureCodes.includes('context_file_size_limit'));
  const diff=await context({'src/a.ts':Buffer.from('old')},{'src/a.ts':Buffer.from('new')},[{...textFile,patch:'@@ -1 +1 @@\n-old\n+'+'x'.repeat(6_000_000)}]);assert(diff.manifest.failureCodes.includes('context_diff_size_limit'));
  const before:Record<string,Buffer>={},after:Record<string,Buffer>={},changed:ChangedFile[]=[];
  for(let i=0;i<100;i++){const path=Array.from({length:10},(_,n)=>`d${i}_${n}`).join('/')+'/file.ts';before[path]=Buffer.from('old');after[path]=Buffer.from('new');changed.push({...textFile,filename:path});}
  const api=await context(before,after,changed);assert.equal(api.manifest.complete,false);assert(api.manifest.failureCodes.includes('context_api_budget'));assert(api.manifest.apiCalls<=768);
});
await test('whole-source and collection-time limits fail closed rather than silently dropping required evidence',async()=>{
  const after:Record<string,Buffer>={},changed:ChangedFile[]=[];
  for(let i=0;i<33;i++){const filename='large-'+i+'.txt';after[filename]=Buffer.from('x'.repeat(500000));changed.push({filename,status:'added',patch:'@@ -0,0 +1 @@\n+'+'x'.repeat(500000),additions:1,deletions:0});}
  // Separate diff and source ceilings: compact fixture patches exercise the source budget alone.
  for(const file of changed)file.patch='@@ -0,0 +1 @@\n+text';
  const result=await context({},after,changed);assert.equal(result.manifest.complete,false);assert(result.manifest.failureCodes.includes('context_byte_budget'));assert(result.manifest.bytes<=16_000_000);
  let tick=0;const clock=mock.method(Date,'now',()=>tick++*120001);
  try{await assert.rejects(context({}, {},[]),/context_collection_timeout/);}finally{clock.mock.restore();}
});
await test('publisher independently verifies binary evidence, accepts completed vision coverage and still requests changes for blocking text findings',async()=>{
  for(const blocking of [false,true,'image'] as const){
    const f=githubFixture(),image={filename:'image.png',status:'added'},images=sourceFixture({}, {'image.png':png},[]);
    const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;
      if(path.includes('/git/'))return images.fetcher(input,init);
      if(path.endsWith('/pulls/4/files'))return Response.json([...files,image]);
      const response=await f.fetcher(input,init);if(path.endsWith('/pulls/4')){const data=await response.json() as Record<string,unknown>;return Response.json({...data,changed_files:2});}return response;
    };
    const github=new Octokit({request:{fetch:fetcher},auth:'fixture',log:{debug(){},info(){},warn(){},error(){}}});
    const output=blocking?{...clean(),result:'findings',findings:[{severity:'high',confidence:1,path:blocking==='image'?'image.png':'src/auth.ts',line:blocking==='image'?null:2,side:'RIGHT',title:'Missing check',explanation:'Access control is removed.',remediation:'Restore the check.'}]}:clean();
    const result=await publish(github,snapshot(),output,true,'codexbot');assert.equal(result.event,blocking?'REQUEST_CHANGES':'APPROVE');assert.equal(f.state.merged,false);
    assert.match(String(f.state.reviews[0]!.body),/vision-capable Codex/);
    if(blocking==='image'){assert.equal((f.state.reviews[0]!.comments as unknown[]).length,0);assert.match(String(f.state.reviews[0]!.body),/image finding/);}
  }
});
