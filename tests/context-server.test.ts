import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextServer } from '../src/runner/context-server.js';
import { AppError } from '../src/core/errors.js';
await test('context socket exposes only validated immutable file requests and generic errors, never URL forwarding', async () => {
  const root = await mkdtemp(join(tmpdir(),'cb-context-')), socket = process.platform === 'win32' ? `\\\\.\\pipe\\cb-test-${crypto.randomUUID()}` : join(root,'context.sock');
  const calls: unknown[] = [];
  const close = await contextServer(socket, async (snapshot,path,operation) => {if(path==='missing.ts')throw new AppError('context_path_missing');if(path==='api.ts')throw new AppError('context_github_api_failed');if(path==='unsafe.ts')throw new Error('Bearer private-source-code');calls.push(operation?[snapshot,path,operation]:[snapshot,path]); return path === 'src/caller.ts'; });
  const send = (body: string, path = '/file', method = 'POST') => new Promise<{ status: number; body: string }>((resolve,reject) => {
    const req = request({ socketPath:socket, path, method, headers:{'Content-Type':'application/json'} }, response => {
      let body = ''; response.on('data',chunk => { body += String(chunk); }); response.on('end',() => resolve({ status:response.statusCode!, body }));
    }); req.on('error',reject); req.end(body);
  });
  try {
    assert.deepEqual(await send('{"snapshot":"head","path":"src/caller.ts"}'), {status:200,body:'{"available":true}'});
    assert.deepEqual(await send('{"snapshot":"head","path":"optional.ts"}','/probe'),{status:200,body:'{"exists":false}'});
    assert.deepEqual(await send('{"snapshot":"head","path":"src/caller.ts"}','/probe'),{status:200,body:'{"exists":true}'});
    assert.deepEqual(await send('{"snapshot":"head","path":"missing.ts"}'),{status:200,body:'{"available":false,"reason":"context_path_missing"}'});
    assert.deepEqual(await send('{"snapshot":"head","path":"api.ts"}'),{status:400,body:'{"error":"context_github_api_failed"}'});
    assert.deepEqual(await send('{"snapshot":"head","path":"unsafe.ts"}'),{status:400,body:'{"error":"context_lookup_unavailable"}'});
    for (const body of ['{"snapshot":"other","path":"file"}','{"snapshot":"head","path":"file","url":"https://evil.invalid"}','{"snapshot":"head"}','sensitive fixture error','{"snapshot":"head","path":"file","required":false}','{"snapshot":"head","path":"file","operation":"probe"}']) {
      assert.deepEqual(await send(body),{status:400,body:'{"error":"context_lookup_unavailable"}'});
    }
    assert.equal((await send('{"snapshot":"head","path":"file","required":false}','/probe')).status,400);
    assert.equal((await send('{}','/url')).status,400); assert.equal((await send('{}','/file','GET')).status,400); assert.deepEqual(calls,[['head','src/caller.ts'],['head','optional.ts','probe'],['head','src/caller.ts','probe']]);
  } finally { await close(); await rm(root,{recursive:true,force:true}); }
});
await test('the socket bounds all requests, including cache hits and invalid input, and reports cancellation once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cb-context-cap-')),socket=process.platform==='win32'?`\\\\.\\pipe\\cb-cap-${crypto.randomUUID()}`:join(root,'context.sock'),aborted:unknown[]=[];let calls=0;
 const close=await contextServer(socket,async()=>{calls++;return true;},reason=>aborted.push(reason));
 const send=(body='{"snapshot":"head","path":"cached.ts"}')=>new Promise<number>((resolve,reject)=>{const req=request({socketPath:socket,path:'/file',method:'POST'},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});req.on('error',reject);req.end(body);});
 try{for(let i=0;i<99;i++)assert.equal(await send(),200);assert.equal(await send('{}'),400);assert.equal(await send(),429);assert.equal(await send(),429);assert.equal(calls,99);assert.deepEqual(aborted,['context_request_limit']);}
 finally{await close();await rm(root,{recursive:true,force:true});}
});
await test('context shutdown cancels and drains active lookups before temporary source cleanup', async () => {
  const root=await mkdtemp(join(tmpdir(),'cb-context-close-')), socket=process.platform==='win32'?`\\\\.\\pipe\\cb-close-${crypto.randomUUID()}`:join(root,'context.sock');
  let begin!:()=>void, finish!:()=>void, drained=false;
  const started=new Promise<void>(resolve=>{begin=resolve;}), pending=new Promise<void>(resolve=>{finish=resolve;});
  const close=await contextServer(socket,async()=>{begin();await pending;drained=true;return false;},()=>finish());
  const response=new Promise<void>(resolve=>{
    const req=request({socketPath:socket,path:'/file',method:'POST'},response=>{response.resume();response.on('end',resolve);response.on('error',()=>resolve());});
    req.on('error',()=>resolve());req.end('{"snapshot":"head","path":"src/caller.ts"}');
  });
  try {await started;await close();await response;assert.equal(drained,true);}finally{await rm(root,{recursive:true,force:true});}
});
