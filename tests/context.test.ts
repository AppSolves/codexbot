import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectContext, type ContextLookup } from '../src/runner/context.js';
import { snapshot, HEAD, BASE, WORKFLOW, files } from './fixtures.js';

type Options = { source?: string; language?: 'py' | 'rs'; mode?: string; truncated?: boolean; binary?: boolean; corrupt?: boolean; status?: string; patch?: string; apiStatus?: number; missingFiles?: boolean; dependency?: 'present' | 'missing'; candidate?:boolean; candidateMode?:string; candidateOversized?:boolean; candidateCorrupt?:boolean; candidateApiStatus?:number; probeFailure?:number|'truncated'|'integrity' };
async function fixture(options: Options = {}, exercise?: (lookup: ContextLookup, directory: string, manifest: Awaited<ReturnType<typeof collectContext>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'codexbot-context-'));
  const requested: string[] = [], blob = Buffer.from(options.source ?? (options.binary ? 'binary\0data' : options.language === 'py' ? 'from .dep import check\nfixture context text' : options.language === 'rs' ? 'mod dep;\nfixture context text' : options.dependency ? 'import { check } from "./dep.js";\nfixture context text' : 'fixture context text'));
  const blobSha = createHash('sha1').update(`blob ${blob.length}\0`).update(blob).digest('hex');
  const dependency = Buffer.from('export const check = () => true;'), dependencySha = createHash('sha1').update(`blob ${dependency.length}\0`).update(dependency).digest('hex');
  const root = 'e'.repeat(40), src = 'f'.repeat(40),unexplored='d'.repeat(40),branches=Array.from({length:12},(_,n)=>(n+1).toString(16).padStart(40,'0'));
  const candidate=Buffer.from(options.candidateOversized?'x'.repeat(512001):'candidate fixture source'),candidateSha=createHash('sha1').update('blob '+candidate.length+'\0').update(candidate).digest('hex');
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requested.push(url.pathname);
    if (url.pathname.endsWith('/pulls/4')) return Response.json({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: options.missingFiles ? 2 : 1 });
    if (url.pathname.endsWith('/pulls/4/files')) return Response.json([{ ...files[0], ...(options.language ? { filename: 'src/auth.' + options.language } : {}), status: options.status ?? 'modified', ...(options.status === 'renamed' ? { previous_filename: 'src/old.ts' } : {}), ...(options.patch !== undefined ? { patch: options.patch } : {}) }]);
    if (url.pathname.includes('/git/commits/')) {
      if (options.apiStatus) return Response.json({ message: 'Unavailable' }, { status: options.apiStatus });
      const commit = url.pathname.split('/').at(-1); assert.ok([HEAD, BASE, WORKFLOW].includes(commit!));
      return Response.json({ sha: commit, tree: { sha: root } });
    }
    if (url.pathname.includes('/git/trees/')) {
      assert.equal(url.searchParams.has('recursive'), false);
      const sha = url.pathname.split('/').at(-1);
      if(options.probeFailure&&sha===unexplored)return typeof options.probeFailure==='number'?Response.json({message:'private API detail'},{status:options.probeFailure}):Response.json({sha:options.probeFailure==='integrity'?root:sha,truncated:options.probeFailure==='truncated',tree:[]});
      if(options.probeFailure&&branches.includes(sha!))return Response.json({sha,truncated:false,tree:[]});
      assert.ok(sha === root || sha === src, 'Trees endpoint must receive resolved tree SHA, never commit SHA');
      return Response.json({ sha, truncated: options.truncated ?? false, tree: sha === root ? [
        { type: 'tree', mode: '040000', path: 'src', sha: src },
        { type: 'blob', mode: '100644', path: 'AGENTS.md', size: blob.length, sha: blobSha },
        ...(options.candidate?[{type:options.candidateMode==='160000'?'commit':options.candidateMode==='040000'?'tree':'blob',mode:options.candidateMode??'100644',path:'candidate.ts',sha:candidateSha,size:candidate.length}]:[]),
        ...(options.probeFailure?[...branches.map((sha,n)=>({type:'tree',mode:'040000',path:'branch'+n,sha})),{type:'tree',mode:'040000',path:'unexplored',sha:unexplored}]:[]),
        ...Array.from({ length: 1200 }, (_, n) => ({ type: 'blob', mode: '100644', path: `unrelated-${n}.ts`, size: 500_000, sha: '0'.repeat(40) }))
      ] : [...[options.language ? 'auth.' + options.language : 'auth.ts', 'old.ts'].map(path => ({ type: options.mode === '160000' ? 'commit' : 'blob', mode: options.mode ?? '100644', path, size: blob.length, sha: blobSha })),
        ...(options.dependency === 'present' ? [{ type: 'blob', mode: '100644', path: options.language ? 'dep.' + options.language : 'dep.ts', size: dependency.length, sha: dependencySha }] : [])] });
    }
    if (url.pathname.includes('/git/blobs/')) {
      if(url.pathname.endsWith(candidateSha))return options.candidateApiStatus?Response.json({message:'private blob detail'},{status:options.candidateApiStatus}):Response.json({sha:candidateSha,encoding:'base64',content:(options.candidateCorrupt?Buffer.alloc(candidate.length,120):candidate).toString('base64')});
      if (url.pathname.endsWith(dependencySha)) return Response.json({ sha: dependencySha, encoding: 'base64', content: dependency.toString('base64') });
      assert.equal(url.pathname.split('/').at(-1), blobSha, 'Unrelated blobs must never be downloaded');
      return Response.json({ sha: blobSha, encoding: 'base64', content: (options.corrupt ? Buffer.from('tampered') : blob).toString('base64') });
    }
    throw new Error(`Unexpected context path ${url.pathname}`);
  };
  try {
    let lookup: ContextLookup | undefined;
    const result = await collectContext(new Octokit({ request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } }), snapshot(), directory, exercise ? reader => { lookup = reader; } : undefined);
    if (exercise) { assert.ok(lookup); await exercise(lookup, directory,result); }
    const instructions = await readFile(join(directory, 'trusted-instructions.json'), 'utf8');
    return { result, requested, instructions };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
await test('one-file PR in 1200-file repo resolves commits to trees and deduplicates immutable blobs', async () => {
  const { result, requested, instructions } = await fixture();
  assert.equal(result.complete, true); assert.equal(result.diffComplete, true); assert.equal(result.requiredContextComplete, true);
  assert.ok(result.apiCalls < 15, `Measured ${result.apiCalls} API calls`);
  assert.equal(requested.filter(x => x.includes('/git/blobs/')).length, 1);
  assert.equal(requested.filter(x => x.includes('/git/trees/')).length, 2); assert.match(instructions, /AGENTS.md/);
});
await test('bounded file index and on-demand lookups reach unchanged immutable files without credentials or unrelated blob reads', async () => {
  const { result, requested } = await fixture({}, async (lookup, directory) => {
    const index = JSON.parse(await readFile(join(directory, 'file-index.json'), 'utf8')) as { paths: string[] };
    assert.ok(index.paths.includes('src/old.ts')); assert.ok(index.paths.length <= 5000);
    assert.equal(await lookup('head','src/old.ts'), true);
    assert.equal(await readFile(join(directory,'source/head/src/old.ts'),'utf8'), 'fixture context text');
    assert.equal(await lookup('base','src/missing.ts'), false);
    for (const path of ['../secret','src/../../secret','/etc/passwd','src\\old.ts','https://evil.invalid']) await assert.rejects(lookup('head',path));
    await assert.rejects(lookup('trusted' as 'head','AGENTS.md'));
    const remaining = await Promise.allSettled(Array.from({ length: 25 }, () => lookup('head','src/old.ts')));
    assert.ok(remaining.some(item => item.status === 'rejected'));
  });
  assert.equal(result.complete,false); assert.equal(result.requiredContextComplete,false);
  assert.equal(requested.filter(path => path.includes('/git/blobs/')).length,1);
  await fixture({ mode:'120000' }, async lookup => { assert.equal(await lookup('head','src/old.ts'),false); });
});
await test('direct local dependencies on base and head are essential, with TypeScript .js import resolution', async () => {
  const found = await fixture({ dependency: 'present' }); assert.equal(found.result.complete, true); assert.equal(found.result.files, 5);
  assert.equal(found.requested.filter(x => x.includes('/git/blobs/')).length, 2);
  const absent = await fixture({ dependency: 'missing' }); assert.equal(absent.result.requiredContextComplete, false); assert.equal(absent.result.complete, false);
});
await test('Python relative imports and Rust sibling modules load immutable dependencies on both sides', async () => {
  for (const language of ['py','rs'] as const) {
    assert.equal((await fixture({language,dependency:'present'})).result.complete,true);
    assert.equal((await fixture({language,dependency:'missing'})).result.requiredContextComplete,false);
  }
});
await test('essential binary, symlink, submodule, unknown mode, corrupt and truncated evidence fails closed', async () => {
  for (const options of [{ binary: true }, { mode: '120000' }, { mode: '160000' }, { mode: '100664' }, { corrupt: true }, { truncated: true }]) {
    const { result } = await fixture(options); assert.equal(result.complete, false); assert.equal(result.requiredContextComplete, false);
  }
});
await test('renamed, deleted, added and executable files preserve required evidence', async () => {
  for (const options of [{ status: 'renamed' }, { status: 'removed' }, { status: 'added' }, { mode: '100755' }]) assert.equal((await fixture(options)).result.complete, true);
});
await test('missing or oversized diffs are explicitly incomplete even with complete source', async () => {
  for (const patch of ['', '@@ -1 +1 @@\n-old\n+' + 'x'.repeat(6_000_001)]) {
    const { result } = await fixture({ patch }); assert.equal(result.diffComplete, false); assert.equal(result.complete, false);
  }
  await assert.rejects(fixture({ missingFiles: true }), /diff_truncated/);
});
await test('404 and rate-limit commit resolution cannot yield a complete context', async () => {
  for (const apiStatus of [404, 403, 429]) assert.equal((await fixture({ apiStatus })).result.complete, false);
});

await test('literal imports inside generated code, templates and comments are not essential dependencies',async()=>{
  const source=`const generated = "import {check} from './missing.js';";
const template = \`require('./missing.cjs')\`;
// export {check} from './missing.ts';
/* import('./missing.mjs'); */
export const fixture = {generated,template};`;
  const result=await fixture({source});assert.equal(result.result.complete,true);assert.equal(result.result.requiredContextComplete,true);
  for(const source of ["type X = import('./missing.js').X;","export {check} from './missing.js';","const x = import('./missing.js');","const x = require('./missing.js');","import x = require('./missing.js');"]){
    const missing=await fixture({source});assert.equal(missing.result.complete,false,source);assert.equal(missing.result.requiredContextComplete,false,source);
  }
});

await test('initially complete context becomes incomplete after an essential on-demand miss, with a safe durable reason',async()=>{
 const {result}=await fixture({},async(lookup,directory,manifest)=>{
  assert.equal(manifest.complete,true);assert.equal(manifest.diffComplete,true);
  assert.equal(await lookup('head','src/private-missing-name.ts'),false);
  assert.equal(manifest.complete,false);assert.equal(manifest.requiredContextComplete,false);assert(manifest.failureCodes.includes('context_path_missing'));
  const persisted=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  assert.equal(persisted.complete,false);assert.equal(persisted.requiredContextComplete,false);assert(!JSON.stringify(persisted.failureCodes).includes('private-missing-name'));
  assert.equal(await lookup('head','src/old.ts'),true);assert.equal(manifest.complete,false,'A later success must not erase missing essential evidence');
 });assert.equal(result.complete,false);
});
await test('exhausting on-demand lookup allowance cannot leave an approving context flag',async()=>{
 await fixture({},async(lookup,_directory,manifest)=>{for(let n=0;n<24;n++)assert.equal(await lookup('head','src/old.ts'),true);assert.equal(manifest.complete,true);await assert.rejects(lookup('head','src/old.ts'),/context_lookup_rejected/);assert.equal(manifest.complete,false);assert.equal(manifest.requiredContextComplete,false);assert(manifest.failureCodes.includes('context_lookup_rejected'));});
});

await test('optional probes verify absence without source reads or completeness loss; required misses stay sticky',async()=>{
 await fixture({},async(lookup,directory,manifest)=>{
  assert.equal(await lookup('head','src/speculative-name.ts','probe'),false);assert.equal(manifest.complete,true);assert.equal(manifest.requiredContextComplete,true);assert.equal(manifest.failureCodes.length,0);
  assert.equal(await lookup('head','src/old.ts','probe'),true);await assert.rejects(readFile(join(directory,'source/head/src/old.ts')));
  assert.equal(await lookup('head','src/speculative-name.ts'),false);assert.equal(manifest.complete,false);assert(manifest.failureCodes.includes('context_path_missing'));
  assert.equal(await lookup('head','src/speculative-name.ts','probe'),false);assert.equal(await lookup('head','src/old.ts'),true);assert.equal(manifest.complete,false);
  assert.equal(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')).complete,false);
 });
 await fixture({dependency:'missing'},async(lookup,_directory,manifest)=>{assert.equal(manifest.complete,false);assert.equal(await lookup('head','src/dep.ts','probe'),false);assert.equal(manifest.complete,false);assert(manifest.failureCodes.includes('context_missing_dependency'));});
 const {requested}=await fixture({candidate:true},async(lookup,directory,manifest)=>{assert.equal(await lookup('head','candidate.ts','probe'),true);assert.equal(manifest.complete,true);await assert.rejects(readFile(join(directory,'source/head/candidate.ts')));});assert.equal(requested.filter(path=>path.includes('/git/blobs/')).length,1,'An existence probe must not fetch source blobs');
});
await test('API failures, truncated and inconsistent trees are never converted into optional path absence',async()=>{
 for(const probeFailure of [404,403,429,500,'truncated','integrity'] as const)await fixture({probeFailure},async(lookup,_directory,manifest)=>{
  assert.equal(manifest.complete,true);await assert.rejects(lookup('head','unexplored/candidate.ts','probe'));assert.equal(manifest.complete,false);assert.equal(manifest.requiredContextComplete,false);assert(manifest.failureCodes.includes(typeof probeFailure==='number'?'context_github_api_failed':'required_tree_unverifiable'));
 });
});
await test('mandatory content distinguishes missing paths, special objects, size limits, API errors and blob verification',async()=>{
 const cases=[{options:{candidate:true,candidateMode:'120000'},code:'context_special_object'},{options:{candidate:true,candidateMode:'160000'},code:'context_special_object'},{options:{candidate:true,candidateMode:'100664'},code:'context_special_object'},{options:{candidate:true,candidateOversized:true},code:'context_file_size_limit'},{options:{candidate:true,candidateCorrupt:true},code:'blob_integrity_failure'},{options:{candidate:true,candidateApiStatus:404},code:'context_github_api_failed'},{options:{candidate:true,candidateApiStatus:429},code:'context_github_api_failed'}];
 for(const {options,code}of cases)await fixture(options,async(lookup,_directory,manifest)=>{assert.equal(manifest.complete,true);assert.equal(await lookup('head','candidate.ts','probe'),true,'Probe means existence only, never readable/verified contents');assert.equal(manifest.complete,true);assert.equal(await lookup('head','candidate.ts'),false);assert.equal(manifest.complete,false);assert(manifest.failureCodes.includes(code),JSON.stringify(manifest.failureCodes));});
});
await test('optional probes share the original lookup cap without invalidating coverage; required calls cannot bypass it',async()=>{
 await fixture({},async(lookup,directory,manifest)=>{for(let n=0;n<24;n++)assert.equal(await lookup('head','src/missing-'+n+'.ts','probe'),false);await assert.rejects(lookup('head','src/no-more.ts','probe'),/context_lookup_rejected/);assert.equal(manifest.complete,true);assert.equal(manifest.failureCodes.length,0);await assert.rejects(lookup('head','src/old.ts'),/context_lookup_rejected/);assert.equal(manifest.complete,false);assert(manifest.failureCodes.includes('context_lookup_rejected'));assert.equal(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')).complete,false);});
});
await test('concurrent optional exploration and required reads serialize immutable state and never erase a required failure',async()=>{
 const {requested}=await fixture({candidate:true},async(lookup,directory,manifest)=>{
  const optional=await Promise.all([lookup('head','missing-a.ts','probe'),lookup('base','missing-b.ts','probe'),lookup('head','candidate.ts','probe')]);assert.deepEqual(optional,[false,false,true]);assert.equal(manifest.complete,true);
  const mixed=await Promise.all([lookup('head','candidate.ts'),lookup('head','required-missing.ts'),lookup('base','missing-c.ts','probe'),lookup('head','candidate.ts')]);assert.deepEqual(mixed,[true,false,false,true]);assert.equal(manifest.complete,false);assert(manifest.failureCodes.includes('context_path_missing'));assert.equal(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')).complete,false);
 });assert.equal(requested.filter(path=>path.includes('/git/blobs/')).length,2,'Concurrent content requests must reuse verified blobs');
});
