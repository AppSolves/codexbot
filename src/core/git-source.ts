import type { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { requireCondition } from './errors.js';
import { safePath } from './review.js';

export type GitEntry = { path?: string; type?: string; mode?: string; sha?: string; size?: number };
/** Immutable, tenant-local caches shared by text collection and binary verification. */
export function gitSource(github: Octokit, repo: {owner:string;repo:string}, charge: () => void, signal?: AbortSignal) {
  const trees=new Map<string,GitEntry[]>(),roots=new Map<string,string>(),blobs=new Map<string,Buffer>(),failed=new Set<string>();
  const options={...repo,request:{timeout:15_000,...(signal?{signal}:{})}};
  const tree=async(sha:string):Promise<GitEntry[]>=>{
    if(!trees.has(sha)){
      requireCondition(!failed.has('tree:'+sha),'tree_unavailable');failed.add('tree:'+sha);charge();
      const {data}=await github.rest.git.getTree({...options,tree_sha:sha});
      requireCondition(data.sha===sha&&!data.truncated,'required_tree_unverifiable');
      requireCondition(data.tree.every(x=>x.path&&!x.path.includes('/')&&safePath(x.path)),'invalid_tree_entry');trees.set(sha,data.tree);
    }return trees.get(sha)!;
  };
  const root=async(commit:string)=>{
    if(!roots.has(commit)){
      requireCondition(!failed.has('commit:'+commit),'commit_unavailable');failed.add('commit:'+commit);charge();
      const {data}=await github.rest.git.getCommit({...options,commit_sha:commit});
      requireCondition(data.sha===commit&&/^[a-f0-9]{40}$/.test(data.tree.sha),'invalid_commit_tree');roots.set(commit,data.tree.sha);
    }return roots.get(commit)!;
  };
  const find=async(commit:string,path:string):Promise<GitEntry|undefined>=>{
    requireCondition(safePath(path)&&path.split('/').length<=32,'invalid_context_path');let sha=await root(commit);
    const parts=path.split('/');for(const [index,part]of parts.entries()){
      const entry=(await tree(sha)).find(x=>x.path===part);if(!entry)return;
      if(index===parts.length-1)return entry;
      requireCondition(entry.type==='tree'&&entry.mode==='040000'&&entry.sha,'unsafe_context_ancestor');sha=entry.sha;
    }
  };
  const read=async(entry:GitEntry,maximum:number)=>{
    requireCondition(entry.type==='blob'&&entry.sha&&entry.size!==undefined&&entry.size<=maximum,'context_file_size_limit');
    if(!blobs.has(entry.sha)){
      requireCondition(!failed.has('blob:'+entry.sha),'blob_unavailable');failed.add('blob:'+entry.sha);charge();
      const {data}=await github.rest.git.getBlob({...options,file_sha:entry.sha});
      requireCondition(data.encoding==='base64'&&data.sha===entry.sha,'invalid_blob_response');const bytes=Buffer.from(data.content,'base64');
      requireCondition(bytes.length===entry.size&&bytes.length<=maximum,'blob_size_mismatch');
      requireCondition(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===entry.sha,'blob_integrity_failure');blobs.set(entry.sha,bytes);
    }return blobs.get(entry.sha)!;
  };
  return {tree,root,find,read};
}
