import ts from 'typescript';
import type { Octokit } from '@octokit/rest';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { safePath, completePatch } from '../core/review.js';
import { splitRepo } from '../worker/github.js';
import type { RequestSnapshot } from '../worker/store.js';
import { requireCondition } from '../core/errors.js';

const MAX_BYTES = 3_000_000, MAX_FILE_BYTES = 200_000, MAX_CALLS = 100;
type Entry = { path?: string; type?: string; mode?: string; sha?: string; size?: number };
export interface ContextManifest {
  complete: boolean; diffComplete: boolean; requiredContextComplete: boolean;
  supplementary: { strategy: 'bounded-heuristics'; selected: number; omitted: number }; files: number; bytes: number; apiCalls: number; limitations: string[];
}
export type ContextLookup = (snapshot: 'base' | 'head', path: string) => Promise<boolean>;
export async function collectContext(github: Octokit, snapshot: RequestSnapshot, directory: string, register?: (lookup: ContextLookup) => void, signal?: AbortSignal): Promise<ContextManifest> {
  const repo = { ...splitRepo(snapshot.repository), ...(signal ? { request: { signal } } : {}) };
  const manifest: ContextManifest = { complete: false, diffComplete: true, requiredContextComplete: true,
    supplementary: { strategy: 'bounded-heuristics', selected: 0, omitted: 0 }, files: 0, bytes: 0, apiCalls: 0, limitations: [] };
  const limited = (required: boolean) => {
    if (required) manifest.requiredContextComplete = false; else manifest.supplementary.omitted++;
    const reason = required ? 'Essential source or trusted instructions unavailable.' : 'Supplementary context bounded or unavailable.';
    if (!manifest.limitations.includes(reason)) manifest.limitations.push(reason);
  };
  const call = (final = false) => { requireCondition(!signal?.aborted && manifest.apiCalls < MAX_CALLS - (final ? 0 : 1), 'context_api_budget'); manifest.apiCalls++; };
  call(); const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  requireCondition(pr.head.sha === snapshot.head && pr.base.sha === snapshot.base, 'pr_changed_before_context_collection', 409);
  const changed = [];
  for (let page = 1; page <= 2; page++) {
    call(); const { data } = await github.rest.pulls.listFiles({ ...repo, pull_number: snapshot.pr, per_page: 100, page });
    changed.push(...data); if (data.length < 100) break;
  }
  requireCondition(changed.length === pr.changed_files && changed.length <= 200, 'diff_truncated');
  const encodedDiff = JSON.stringify(changed);
  if (Buffer.byteLength(encodedDiff) > MAX_BYTES || changed.some(file => !completePatch(file))) manifest.diffComplete = false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(snapshot), { mode: 0o600 });
  await writeFile(join(directory, 'diff.json'), Buffer.byteLength(encodedDiff) <= MAX_BYTES ? encodedDiff : '[]', { mode: 0o600 });
  const trees = new Map<string, Entry[]>(), roots = new Map<string, string>(), blobs = new Map<string, Buffer>(), unavailable = new Set<string>();
  const tree = async (sha: string): Promise<Entry[]> => {
    if (!trees.has(sha)) {
      requireCondition(!unavailable.has(`tree:${sha}`), 'tree_unavailable');
      unavailable.add(`tree:${sha}`);
      call(); const { data } = await github.rest.git.getTree({ ...repo, tree_sha: sha });
      requireCondition(data.sha === sha && !data.truncated, 'required_tree_unverifiable');
      requireCondition(data.tree.every(x => x.path && !x.path.includes('/') && safePath(x.path)), 'invalid_tree_entry');
      trees.set(sha, data.tree);
    }
    return trees.get(sha)!;
  };
  const root = async (commit: string): Promise<string> => {
    if (!roots.has(commit)) {
      requireCondition(!unavailable.has(`commit:${commit}`), 'commit_unavailable');
      unavailable.add(`commit:${commit}`);
      call(); const { data } = await github.rest.git.getCommit({ ...repo, commit_sha: commit });
      requireCondition(data.sha === commit && /^[a-f0-9]{40}$/.test(data.tree.sha), 'invalid_commit_tree');
      roots.set(commit, data.tree.sha);
    }
    return roots.get(commit)!;
  };
  const find = async (commit: string, path: string): Promise<Entry | undefined> => {
    requireCondition(safePath(path) && path.split('/').length <= 32, 'invalid_context_path');
    let sha = await root(commit);
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const entry = (await tree(sha)).find(x => x.path === part);
      if (!entry) return undefined;
      if (index === parts.length - 1) return entry;
      requireCondition(entry.type === 'tree' && entry.mode === '040000' && entry.sha, 'unsafe_context_ancestor'); sha = entry.sha;
    }
    return undefined;
  };
  const instructions: { path: string; content: string }[] = [], written = new Map<string, Buffer>();
  const collect = async (label: string, commit: string, path: string, required: boolean, optional = false) => {
    const key = `${label}/${path}`; if (written.has(key)) return;
    try {
      const entry = await find(commit, path);
      if (!entry && optional) return;
      requireCondition(entry?.sha && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode ?? ''), 'required_file_missing_or_special');
      requireCondition(entry.size !== undefined && entry.size <= MAX_FILE_BYTES && manifest.bytes + entry.size <= MAX_BYTES, 'context_byte_budget');
      let bytes = blobs.get(entry.sha);
      if (!bytes) {
        requireCondition(!unavailable.has(`blob:${entry.sha}`), 'blob_unavailable');
        unavailable.add(`blob:${entry.sha}`);
        call(); const { data } = await github.rest.git.getBlob({ ...repo, file_sha: entry.sha });
        requireCondition(data.encoding === 'base64' && data.sha === entry.sha, 'invalid_blob_response');
        bytes = Buffer.from(data.content, 'base64');
        requireCondition(bytes, 'blob_decode_failed');
        requireCondition(bytes.length === entry.size && bytes.length <= MAX_FILE_BYTES && !bytes.includes(0), 'non_text_or_oversized_blob');
        requireCondition(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === entry.sha, 'blob_integrity_failure');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        blobs.set(entry.sha, bytes);
      }
      requireCondition(bytes, 'blob_missing');
      const destination = join(directory, 'source', label, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { mode: 0o600 });
      written.set(key, bytes); manifest.files++; manifest.bytes += bytes.length;
      if (!required) manifest.supplementary.selected++;
      if (label === 'trusted') instructions.push({ path, content: bytes.toString('utf8') });
    } catch { limited(required); }
  };
  // Essential evidence precedes supplementary files; unrelated repository size is immaterial.
  for (const file of changed) {
    if (file.status !== 'added') await collect('base', snapshot.base, file.previous_filename ?? file.filename, true);
    if (file.status !== 'removed') await collect('head', snapshot.head, file.filename, true);
  }
  const instructionPaths = new Set(['AGENTS.md']);
  for (const file of changed) for (const path of file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { instructionPaths.add(`${parts.join('/')}/AGENTS.md`); parts.pop(); }
  }
  for (const path of instructionPaths) await collect('trusted', snapshot.workflowSha, path, true, true);
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
      if (!safePath(path) || dependencies.size >= 24) { limited(true); continue; }
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
    if (!resolved) limited(true);
  }
  for (const path of ['README.md', 'package.json', 'tsconfig.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'pyproject.toml', 'go.mod']) await collect('base', snapshot.base, path, false, true);
  for (const file of changed.slice(0, 20)) {
    const parent = file.filename.includes('/') ? file.filename.slice(0, file.filename.lastIndexOf('/') + 1) : '';
    const stem = file.filename.slice(parent.length).replace(/\.[^.]+$/, '');
    for (const candidate of [`${parent}${stem}.test.ts`, `${parent}${stem}.spec.ts`, `tests/${stem}.test.ts`, `${parent}test_${stem}.py`, `tests/test_${stem}.py`, `${parent}${stem}_test.go`, `${parent}${stem}Test.java`]) await collect('base', snapshot.base, candidate, false, true);
  }
  // Literal sibling modules beyond JS/TS; unresolved language tooling is never executed.
  for (const file of changed.slice(0, 20)) for (const [label, commit, path] of [['base', snapshot.base, file.previous_filename ?? file.filename], ['head', snapshot.head, file.filename]] as const) {
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
    let requests = 0, serial = Promise.resolve();
    register(async (label, path) => {
      requireCondition((label === 'base' || label === 'head') && safePath(path) && ++requests <= 24, 'context_lookup_rejected');
      let available = false;
      const work = serial.then(async () => {
        await collect(label, label === 'head' ? snapshot.head : snapshot.base, path, false);
        available = written.has(`${label}/${path}`);
        if (!available) { manifest.requiredContextComplete = false; manifest.complete = false; }
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      });
      serial = work.catch(() => {}); await work; return available;
    });
    manifest.limitations.push('Additional relevant files: POST {"snapshot":"base"|"head","path":"relative/file"} to /file over /run/proxy/context.sock using node:http. Read /workspace/source/<snapshot>/<path> after available=true. Maximum 24 requests, shared source byte/API budgets; no URLs or execution. A requested file that cannot be obtained makes the review incomplete; use the index rather than probing optional nonexistent paths.');
  }
  call(true); const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: snapshot.pr });
  requireCondition(current.head.sha === snapshot.head && current.base.sha === snapshot.base, 'pr_changed_during_context_collection', 409);
  manifest.complete = manifest.diffComplete && manifest.requiredContextComplete;
  await writeFile(join(directory, 'trusted-instructions.json'), JSON.stringify(instructions), { mode: 0o600 });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}
