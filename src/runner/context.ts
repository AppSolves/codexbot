import ts from 'typescript';
import type { Octokit } from '@octokit/rest';
import { mkdir, writeFile } from 'node:fs/promises';
import { gitSource } from '../core/git-source.js';
import { binaryChange, MAX_BINARY_FILE_BYTES, type BinaryChange } from '../core/binary.js';
import { AppError } from '../core/errors.js';
import { dirname, join, posix } from 'node:path';
import { safePath, completePatch } from '../core/review.js';
import { splitRepo } from '../worker/github.js';
import type { RequestSnapshot } from '../worker/store.js';
import { requireCondition } from '../core/errors.js';
import { MAX_CONTEXT_PATHS, MAX_CONTEXT_REQUESTS } from '../core/limits.js';
import type { ContextLookupStats } from '../core/diagnostics.js';

const MAX_BYTES = 16_000_000, MAX_DIFF_BYTES = 6_000_000, MAX_FILE_BYTES = 512_000, MAX_CALLS = 768, COLLECTION_MS = 120_000;
export interface ContextManifest {
  complete: boolean; diffComplete: boolean; requiredContextComplete: boolean;
  supplementary: { strategy: 'bounded-heuristics'; selected: number; omitted: number }; files: number; bytes: number; apiCalls: number; limitations: string[]; failureCodes:string[]; binaryFiles:BinaryChange[];
  lookups?:ContextLookupStats;
}
export type ContextLookup = (snapshot: 'base' | 'head', path: string, operation?: 'probe') => Promise<boolean>;
export async function collectContext(github: Octokit, snapshot: RequestSnapshot, directory: string, register?: (lookup: ContextLookup) => void, signal?: AbortSignal): Promise<ContextManifest> {
  const repo = { ...splitRepo(snapshot.repository), request: {timeout:15_000,...(signal?{signal}:{})} };
  const manifest: ContextManifest = { complete: false, diffComplete: true, requiredContextComplete: true,
    supplementary: { strategy: 'bounded-heuristics', selected: 0, omitted: 0 }, files: 0, bytes: 0, apiCalls: 0, limitations: [], failureCodes:[], binaryFiles:[] };
  const limited = (required: boolean, error?:unknown) => {
    const code=error instanceof AppError?error.code:error&&typeof error==='object'&&'status' in error&&typeof error.status==='number'&&error.status>=400&&error.status<=599?'context_github_api_failed':'context_required_evidence_unavailable';
    if(required&&!manifest.failureCodes.includes(code))manifest.failureCodes.push(code);
    if (required) manifest.requiredContextComplete = false; else manifest.supplementary.omitted++;
    const reason = required ? 'Essential source or trusted instructions unavailable.' : 'Supplementary context bounded or unavailable.';
    if (!manifest.limitations.includes(reason)) manifest.limitations.push(reason);
    return code;
  };
  const deadline=Date.now()+COLLECTION_MS;let collected=false;
  const call = (final = false) => { requireCondition(!signal?.aborted && (collected||Date.now()<deadline),'context_collection_timeout');requireCondition(manifest.apiCalls < MAX_CALLS - (final||collected?0:1),'context_api_budget'); manifest.apiCalls++; };
  call(); const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  requireCondition(pr.head.sha === snapshot.head && pr.base.sha === snapshot.base, 'pr_changed_before_context_collection', 409);
  const changed = [];
  for (let page = 1; page <= 2; page++) {
    call(); const { data } = await github.rest.pulls.listFiles({ ...repo, pull_number: snapshot.pr, per_page: 100, page });
    changed.push(...data.map(file=>({filename:file.filename,status:file.status,...(file.previous_filename?{previous_filename:file.previous_filename}:{}),additions:file.additions,deletions:file.deletions,...(file.patch!==undefined?{patch:file.patch}:{})})));  if (data.length < 100) break;
  }
  requireCondition(changed.length === pr.changed_files && changed.length <= 200 && new Set(changed.map(file=>file.filename)).size===changed.length, 'diff_truncated');
  const encodedDiff = JSON.stringify(changed);
  if (Buffer.byteLength(encodedDiff) > MAX_DIFF_BYTES || changed.some(file => Boolean(file.patch)&&!completePatch(file))) {manifest.diffComplete = false;limited(true,new AppError(Buffer.byteLength(encodedDiff)>MAX_DIFF_BYTES?'context_diff_size_limit':'context_text_patch_truncated'));}
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(snapshot), { mode: 0o600 });
  await writeFile(join(directory, 'diff.json'), Buffer.byteLength(encodedDiff) <= MAX_DIFF_BYTES ? encodedDiff : '[]', { mode: 0o600 });
  const source=gitSource(github,repo,()=>call(),signal),{find,root,tree}=source;
  const instructions: { path: string; content: string }[] = [], written = new Map<string, Buffer>();
  const collect = async (label: string, commit: string, path: string, required: boolean, optional = false) => {
    const key = `${label}/${path}`; if (written.has(key)) return;
    try {
      const entry = await find(commit, path);
      if (!entry && optional) return;
      requireCondition(entry, 'context_path_missing');
      requireCondition(entry.sha && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode ?? ''), 'context_special_object');
      requireCondition(entry.size !== undefined && entry.size <= MAX_FILE_BYTES, 'context_file_size_limit');
      requireCondition(manifest.bytes + entry.size <= MAX_BYTES, 'context_byte_budget');
      const bytes=await source.read(entry,MAX_FILE_BYTES);
      requireCondition(!bytes.includes(0),'context_non_text_source');
      try {new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('context_non_text_source');}
      const destination = join(directory, 'source', label, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { mode: 0o600 });
      written.set(key, bytes); manifest.files++; manifest.bytes += bytes.length;
      if (!required) manifest.supplementary.selected++;
      if (label === 'trusted') instructions.push({ path, content: bytes.toString('utf8') });
    } catch(error) { return new AppError(limited(required,error)); }
  };
  // Essential evidence precedes supplementary files; unrelated repository size is immaterial.
  for (const file of changed.filter(file=>Boolean(file.patch))) {
    if (file.status !== 'added') await collect('base', snapshot.base, file.previous_filename ?? file.filename, true);
    if (file.status !== 'removed') await collect('head', snapshot.head, file.filename, true);
  }
  const instructionPaths = new Set(['AGENTS.md']);
  for (const file of changed) for (const path of file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { instructionPaths.add(`${parts.join('/')}/AGENTS.md`); parts.pop(); }
  }
  for (const path of instructionPaths) await collect('trusted', snapshot.workflowSha, path, true, true);
  const binaryBudget={bytes:0,shas:new Set<string>()};
  for(const file of changed.filter(file=>!file.patch)){
    try {const binary=await binaryChange(file,snapshot.base,snapshot.head,source,binaryBudget);manifest.binaryFiles.push(binary);
      for(const image of binary.snapshots){const entry=await find(image.side==='head'?snapshot.head:snapshot.base,image.path);requireCondition(entry,'context_binary_unverifiable');const target=join(directory,'media',image.side,image.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,await source.read(entry,MAX_BINARY_FILE_BYTES),{mode:0o600});}
    }
    catch(error){manifest.diffComplete=false;limited(true,error);}
  }
  if(manifest.binaryFiles.length)manifest.limitations.push('Binary PNG changes have verified Git blob identities and framing. Their base/head images are supplied as localImage inputs to a vision-capable Codex model. Review the images with the code and report incomplete if relevant visual evidence cannot be assessed. The collector itself does not visually inspect images.');
  const dependencies = new Map<string, { label: string; commit: string; path: string }>();
  for (const file of changed) for (const [label, commit, filename] of [['base', snapshot.base, file.previous_filename ?? file.filename], ['head', snapshot.head, file.filename]] as const) {
    if (!/\.[cm]?[jt]sx?$/.test(filename)) continue;
    const text = written.get(`${label}/${filename}`)?.toString('utf8') ?? '';
    // The compiler distinguishes imports (including type queries) from generated strings/comments.
    for (const {fileName:specifier} of ts.preProcessFile(text, true, true).importedFiles) {
      if (!/^\.{1,2}\//.test(specifier)) continue;
      const path = posix.normalize(posix.join(posix.dirname(filename!), specifier));
      if (posix.extname(path) && !/\.(?:[cm]?[jt]sx?|json)$/.test(path)) continue;
      if (dependencies.has(`${label}/${path}`)) continue;
      if (!safePath(path) || dependencies.size >= 256) { limited(true); continue; }
      dependencies.set(`${label}/${path}`, { label: label!, commit: commit!, path });
    }
  }
  // Direct literal local dependencies are essential on BOTH sides, including newly added imports.
  // Unknown resolvers and a missing/oversized dependency fail closed rather than guessing coverage.
  for (const { label, commit, path } of dependencies.values()) {
    let resolved = false;
    for (const candidate of new Set([path, path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx'), path.replace(/\.mjs$/, '.mts'), path.replace(/\.cjs$/, '.cts'), ...['.ts','.tsx','.js','.jsx','/index.ts','/index.js'].map(suffix => path + suffix)])) {
      try {
        const entry = await find(commit, candidate); if (!entry || entry.type === 'tree') continue;
        await collect(label, commit, candidate, true); resolved = true; break;
      } catch { break; }
    }
    if (!resolved) limited(true,new AppError('context_missing_dependency'));
  }
  // Literal sibling modules beyond JS/TS; unresolved language tooling is never executed.
  for (const file of changed) for (const [label, commit, path] of [['base', snapshot.base, file.previous_filename ?? file.filename], ['head', snapshot.head, file.filename]] as const) {
    const text = written.get(`${label}/${path}`)?.toString('utf8') ?? '', parent = posix.dirname(path);
    const modules = path.endsWith('.py') ? [...text.matchAll(/^\s*from\s+\.([A-Za-z_]\w*)\s+import\s/gm)].map(match => [match[1] + '.py', match[1] + '/__init__.py'])
      : path.endsWith('.rs') ? [...text.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)].map(match => [match[1] + '.rs', match[1] + '/mod.rs']) : [];
    if (modules.length > 8) limited(true);
    for (const candidates of modules.slice(0, 8)) {
      let resolved = false;
      for (const candidate of candidates) {
        const target = posix.join(parent, candidate);
        try { if (await find(commit, target)) { await collect(label, commit, target, true); resolved = true; break; } } catch { break; }
      }
      if (!resolved) limited(true);
    }
  }
  for (const path of ['README.md', 'package.json', 'tsconfig.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'pyproject.toml', 'go.mod']) await collect('base', snapshot.base, path, false, true);
  for (const file of changed.slice(0, 20)) {
    const parent = file.filename.includes('/') ? file.filename.slice(0, file.filename.lastIndexOf('/') + 1) : '';
    const stem = file.filename.slice(parent.length).replace(/\.[^.]+$/, '');
    for (const candidate of [`${parent}${stem}.test.ts`, `${parent}${stem}.spec.ts`, `tests/${stem}.test.ts`, `${parent}test_${stem}.py`, `tests/test_${stem}.py`, `${parent}${stem}_test.go`, `${parent}${stem}Test.java`]) await collect('base', snapshot.base, candidate, false, true);
  }
  // A bounded directory index costs no blob reads and is explicitly supplementary.
  const index: string[] = [], queue: { sha: string; prefix: string }[] = [];
  let indexedDirectories = 0, indexComplete = true;
  try { queue.push({ sha: await root(snapshot.head), prefix: '' }); } catch { indexComplete = false; limited(false); }
  while (queue.length && indexedDirectories < 12 && index.length < 5000) {
    const next = queue.shift()!; indexedDirectories++;
    try {
      for (const entry of await tree(next.sha)) {
        const path = next.prefix + entry.path;
        if (!safePath(path) || index.length >= 5000) break;
        if (entry.type === 'blob' && ['100644','100755'].includes(entry.mode ?? '')) index.push(path);
        else if (entry.type === 'tree' && entry.mode === '040000' && entry.sha && queue.length < 100) queue.push({ sha: entry.sha, prefix: path + '/' });
      }
    } catch { indexComplete = false; limited(false); }
  }
  await writeFile(join(directory, 'file-index.json'), JSON.stringify({ paths: index, complete: indexComplete && queue.length === 0 && index.length < 5000 }), { mode: 0o600 });
  if (register) {
    let serial = Promise.resolve();const paths=new Set<string>();
    const stats=manifest.lookups={requests:0,paths:0,cache_hits:0} as ContextLookupStats;
    register(async (label, path, operation) => {
      const required=operation!=='probe';
      const request=stats.requests=Math.min(stats.requests+1,MAX_CONTEXT_REQUESTS+1);
      let available = false;
      const work = serial.then(async () => {
        let invalidate=required;
        try{
          requireCondition(request<=MAX_CONTEXT_REQUESTS,'context_request_limit');
          requireCondition((operation===undefined||operation==='probe')&&(label==='base'||label==='head')&&safePath(path),'context_lookup_rejected');
          const key=`${label}/${path}`;
          if(written.has(key)){stats.cache_hits++;available=true;}
          else{
            if(!paths.has(key)){requireCondition(paths.size<MAX_CONTEXT_PATHS,'context_lookup_limit');paths.add(key);stats.paths=paths.size;}
            if(operation==='probe'){
              try{available=Boolean(await find(label==='head'?snapshot.head:snapshot.base,path));if(!available)manifest.supplementary.omitted++;}
              catch(error){invalidate=true;throw error;}
            }else{const failure=await collect(label,label==='head'?snapshot.head:snapshot.base,path,true);if(failure)throw failure;available=written.has(key);requireCondition(available,'context_required_evidence_unavailable');}
          }
        }catch(error){stats.last_failure=limited(invalidate,error);if(invalidate)manifest.complete=false;await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest),{mode:0o600});throw new AppError(stats.last_failure);}
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      });
      serial = work.catch(() => {}); await work; return available;
    });
    manifest.limitations.push('Read already supplied source directly under /workspace/source/<snapshot>/<path>; do not request it again. Context socket /run/proxy/context.sock: POST {"snapshot":"base"|"head","path":"relative/file"} to /file for REQUIRED contents; then read the supplied file. For OPTIONAL existence exploration use /probe: {exists:false} means verified absence. Both share 24 distinct snapshot/path lookups and 100 total requests; cached contents need no new repository lookup. Existing byte/API budgets apply. API/verification errors are not absence. A failed essential retrieval permanently invalidates completeness; /probe cannot clear it. No URLs or execution.');
  }
  call(true); const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  requireCondition(current.head.sha === snapshot.head && current.base.sha === snapshot.base, 'pr_changed_during_context_collection', 409);
  collected=true;
  manifest.complete = manifest.diffComplete && manifest.requiredContextComplete;
  await writeFile(join(directory, 'trusted-instructions.json'), JSON.stringify(instructions), { mode: 0o600 });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}
