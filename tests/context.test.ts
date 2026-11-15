import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectContext, type ContextLookup } from '../src/runner/context.js';
import { snapshot, HEAD, BASE, WORKFLOW, files } from './fixtures.js';

type Options = { source?: string; language?: 'py' | 'rs'; mode?: string; truncated?: boolean; binary?: boolean; corrupt?: boolean; status?: string; patch?: string; apiStatus?: number; missingFiles?: boolean; dependency?: 'present' | 'missing' };
async function fixture(options: Options = {}, exercise?: (lookup: ContextLookup, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'codexbot-context-'));
  const requested: string[] = [], blob = Buffer.from(options.source ?? (options.binary ? 'binary\0data' : options.language === 'py' ? 'from .dep import check\nfixture context text' : options.language === 'rs' ? 'mod dep;\nfixture context text' : options.dependency ? 'import { check } from "./dep.js";\nfixture context text' : 'fixture context text'));
  const blobSha = createHash('sha1').update(`blob ${blob.length}\0`).update(blob).digest('hex');
  const dependency = Buffer.from('export const check = () => true;'), dependencySha = createHash('sha1').update(`blob ${dependency.length}\0`).update(dependency).digest('hex');
  const root = 'e'.repeat(40), src = 'f'.repeat(40);
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
      const sha = url.pathname.split('/').at(-1); assert.ok(sha === root || sha === src, 'Trees endpoint must receive resolved tree SHA, never commit SHA');
      return Response.json({ sha, truncated: options.truncated ?? false, tree: sha === root ? [
        { type: 'tree', mode: '040000', path: 'src', sha: src },
        { type: 'blob', mode: '100644', path: 'AGENTS.md', size: blob.length, sha: blobSha },
        ...Array.from({ length: 1200 }, (_, n) => ({ type: 'blob', mode: '100644', path: `unrelated-${n}.ts`, size: 500_000, sha: '0'.repeat(40) }))
      ] : [...[options.language ? 'auth.' + options.language : 'auth.ts', 'old.ts'].map(path => ({ type: options.mode === '160000' ? 'commit' : 'blob', mode: options.mode ?? '100644', path, size: blob.length, sha: blobSha })),
        ...(options.dependency === 'present' ? [{ type: 'blob', mode: '100644', path: options.language ? 'dep.' + options.language : 'dep.ts', size: dependency.length, sha: dependencySha }] : [])] });
    }
    if (url.pathname.includes('/git/blobs/')) {
      if (url.pathname.endsWith(dependencySha)) return Response.json({ sha: dependencySha, encoding: 'base64', content: dependency.toString('base64') });
      assert.equal(url.pathname.split('/').at(-1), blobSha, 'Unrelated blobs must never be downloaded');
      return Response.json({ sha: blobSha, encoding: 'base64', content: (options.corrupt ? Buffer.from('tampered') : blob).toString('base64') });
    }
    throw new Error(`Unexpected context path ${url.pathname}`);
  };
  try {
    let lookup: ContextLookup | undefined;
    const result = await collectContext(new Octokit({ request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } }), snapshot(), directory, exercise ? reader => { lookup = reader; } : undefined);
    if (exercise) { assert.ok(lookup); await exercise(lookup, directory); }
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
