import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {Readable,Writable} from 'node:stream';
import {once} from 'node:events';
import {safeEvents} from '../src/runner/stream.js';
import {inferenceProxy} from '../src/runner/proxy.js';
import {ExecutionDiagnostics,ExecutionError,executionFailure,proxyRequestEnvelope,proxyRequestDiagnostic,transportCode,type ExecutionFailure,type ProxyRequestDiagnostic} from '../src/core/execution.js';
import {diagnostic} from '../src/core/diagnostics.js';
import {normalizeReview,type ReviewRejectionReason} from '../src/core/review.js';
import {clean,HEAD} from './fixtures.js';
const privateText='fixture-private-provider-text OAuth-code source prompt';
const frame=(value:unknown)=>'data: '+JSON.stringify(value)+'\n\n';
const completed=frame({type:'response.completed'}),created=frame({type:'response.created'});
const failure=frame({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:privateText}}});
await test('the proxy reads the host-rotated access token per request and never exposes it to the model',async()=>{
 let token='synthetic-first-token';const sent:string[]=[],reports:ExecutionFailure[]=[];
 const fetcher:typeof fetch=async(_url,options)=>{sent.push(String((options?.headers as Record<string,string>).Authorization));return new Response(completed,{headers:{'content-type':'text/event-stream'}});};
 const server=createServer((req,res)=>{void inferenceProxy(req,res,async()=>token,fetcher,()=>{},failure=>reports.push(failure));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
 const send=async()=>{const response=await fetch(`http://127.0.0.1:${address.port}/v1/responses`,{method:'POST',body:JSON.stringify({model:'fixture',stream:true,store:false,input:[]})});const text=await response.text();assert(!text.includes('synthetic-'));return response.status;};
 try{assert.equal(await send(),200);token='synthetic-renewed-token';assert.equal(await send(),200);assert.deepEqual(sent,['Bearer synthetic-first-token','Bearer synthetic-renewed-token']);token='invalid\r\ncredential';assert.equal(await send(),403);assert.equal(sent.length,2);assert(!JSON.stringify(reports).includes('credential'));}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
function source(chunks:string[],readError?:Error,cancelError?:Error){let index=0;return new ReadableStream<Uint8Array>({pull(c){if(index<chunks.length)c.enqueue(new TextEncoder().encode(chunks[index++]));else if(readError)c.error(readError);else if(!cancelError)c.close();},cancel(){if(cancelError)throw cancelError;}});}
await test('primary provider event and safe cleanup failure remain independent; cleanup never replaces or escapes the primary',async()=>{
 const reports:ExecutionFailure[]=[];let output='';for await(const chunk of safeEvents(source([failure],undefined,new Error(privateText)),'fixture-credential',value=>reports.push(value)))output+=chunk;
 assert.equal(reports.length,2);assert.equal(reports[0]!.provider_code,'subscription_sharing_usage_limit_exceeded');assert.equal(reports[0]!.origin,'upstream_event');assert.equal(reports[1]!.code,'proxy_stream_cleanup_failed');assert.equal(reports[1]!.origin,'cleanup');assert(output.includes('codexbot_inference_error'));assert(!output.includes(privateText));assert(!JSON.stringify(reports).includes(privateText));
});
await test('upstream read failures retain only exact transport codes; EOF and size failures stay distinct',async()=>{
 for(const code of ['ECONNRESET','UND_ERR_SOCKET','UND_ERR_BODY_TIMEOUT','ABORT_ERR']){
  const reports:ExecutionFailure[]=[];const error=new TypeError(privateText,{cause:Object.assign(new Error(privateText),{code})});
  for await(const chunk of safeEvents(source([created],error),'fixture-credential',value=>reports.push(value))){ assert(!chunk.includes(privateText)); }
  assert.equal(reports[0]!.code,'provider_stream_read_failed');assert.equal(reports[0]!.origin,'upstream_read');assert.equal(reports[0]!.transport_code,code);assert.equal(reports[1]!.code,'proxy_stream_cleanup_failed');assert(!JSON.stringify(reports).includes(privateText));
 }
 for(const [chunks,expected]of [[ [created],'provider_stream_incomplete'],[['data: {'],'provider_stream_truncated'],[['data: invalid\n\n'],'invalid_provider_event'],[['data: '+'x'.repeat(4_000_001)],'provider_frame_limit'],[Array.from({length:11},()=>frame({type:'response.output_text.delta',delta:'x'.repeat(2_000_000)})),'provider_stream_limit']] as const){
  const reports:ExecutionFailure[]=[];for await(const chunk of safeEvents(source([...chunks]),'fixture-credential',value=>reports.push(value))){ assert(!chunk.includes(privateText)); }assert.equal(reports[0]!.code,expected);
 }
 assert.equal(transportCode(Object.assign(new Error(privateText),{code:privateText})),undefined);
});
async function proxyCase(options:{data:string;close?:boolean;deadline?:AbortController;cancelError?:Error;readError?:Error;fetchError?:Error}):Promise<ProxyRequestDiagnostic>{
 let finish!:(value:ProxyRequestDiagnostic)=>void;const done=new Promise<ProxyRequestDiagnostic>(resolve=>{finish=resolve;});
 const fetcher:typeof fetch=async(_url,init)=>{if(options.fetchError)throw options.fetchError;return new Response(options.readError?source([options.data],options.readError):new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(options.data));init?.signal?.addEventListener('abort',()=>c.error(init.signal!.reason),{once:true});},cancel(){if(options.cancelError)throw options.cancelError;}}),{headers:{'content-type':'text/event-stream'}});};
 const server=createServer((req,res)=>{void inferenceProxy(req,res,'fixture-credential',fetcher,()=>{},()=>{},value=>{if(value.phase==='finished')finish(value);},7);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
 try{
  await new Promise<void>((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:address.port,path:'/v1/responses',method:'POST'},res=>{res.on('data',()=>{if(options.deadline&&!options.deadline.signal.aborted)options.deadline.abort(new DOMException(privateText,'TimeoutError'));if(options.close){res.destroy();resolve();}});res.on('end',resolve);res.on('close',resolve);res.on('error',()=>resolve());});req.on('error',reject);req.end(JSON.stringify({model:'fixture',store:false,stream:true,input:[]}));});
  const result=await done;assert(!proxyRequestEnvelope(result).includes(privateText));if(options.fetchError){assert.equal(result.upstream_status,undefined);assert.equal(result.content_type_category,undefined);}else{assert.equal(result.upstream_status,200);assert.equal(result.content_type_category,'event-stream');}assert.equal(result.request_index,7);assert(result.elapsed_ms!>=0&&result.elapsed_ms!<=1_320_000);return result;
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
await test('closing after response.completed is not a provider failure; premature closure remains a failure',async()=>{
 const complete=await proxyCase({data:completed,close:true});assert.equal(complete.primary,null);assert.equal(complete.cleanup,null);assert.equal(complete.terminal_event,'completed');assert.equal(complete.abort_origin,'downstream');
 const early=await proxyCase({data:created,close:true});assert.equal(early.primary!.code,'proxy_client_disconnected');assert.equal(early.primary!.origin,'downstream');assert.equal(early.terminal_event,'none');
});
await test('proxy preserves primary HTTP/event information through cleanup, termination and owned deadline abort',async()=>{
 const event=await proxyCase({data:failure,cancelError:new Error(privateText)});assert.equal(event.primary!.provider_code,'subscription_sharing_usage_limit_exceeded');assert.equal(event.primary!.upstream_status,200);assert.equal(event.cleanup!.code,'proxy_stream_cleanup_failed');assert.equal(event.terminal_event,'failed');
 const network=await proxyCase({data:created,readError:new TypeError(privateText,{cause:Object.assign(new Error(privateText),{code:'UND_ERR_SOCKET'})})});assert.equal(network.primary!.code,'provider_stream_read_failed');assert.equal(network.primary!.transport_code,'UND_ERR_SOCKET');assert.equal(network.cleanup!.code,'proxy_stream_cleanup_failed');
 const deadline=new AbortController(),stub=mock.method(AbortSignal,'timeout',()=>deadline.signal);try{const result=await proxyCase({data:created,deadline});assert.equal(result.primary!.code,'proxy_deadline_exceeded');assert.equal(result.abort_origin,'deadline');}finally{stub.mock.restore();}
});
await test('bounded correlated records survive envelopes and outer diagnostics; success clears recovered failures and late records cannot replace it',()=>{
 const primary:ExecutionFailure={component:'provider',code:'provider_stream_failed',provider_code:'rate_limit_exceeded',upstream_status:200};
 const cleanup:ExecutionFailure={component:'proxy',code:'proxy_stream_cleanup_failed',origin:'cleanup'};
 const parser=new ExecutionDiagnostics();parser.write(proxyRequestEnvelope({request_index:1,phase:'finished',primary,cleanup})+'\n');assert.deepEqual(parser.request!.primary,primary);assert.deepEqual(parser.request!.cleanup,cleanup);
 const error=new ExecutionError({component:'engine',code:'review_incomplete',rejection_reason:'model_incomplete'});error.proxyFailure=primary;error.proxyCleanup=cleanup;assert.deepEqual(diagnostic(error,'analyzing').proxy_cleanup,cleanup);
 parser.write(proxyRequestEnvelope({request_index:2,phase:'started',primary:null,cleanup:null})+'\n');assert.equal(parser.last,null);
 parser.write(proxyRequestEnvelope({request_index:2,phase:'finished',primary:null,cleanup:null,terminal_event:'completed'})+'\n');parser.write(proxyRequestEnvelope({request_index:1,phase:'finished',primary,cleanup})+'\n');assert.equal(parser.last,null);assert.equal(parser.request!.request_index,2);assert.equal(parser.request!.primary,null);
 const projected=proxyRequestDiagnostic({request_index:3,phase:'finished',primary:null,cleanup:null,headers:privateText,terminal_event:['completed'],elapsed_ms:19_920_001,stream_bytes:-1,abort_origin:privateText});assert.deepEqual(projected,{request_index:3,phase:'finished',primary:null,cleanup:null});
 for(let index=3;index<=8;index++)parser.write(proxyRequestEnvelope({request_index:index,phase:'finished',primary,cleanup})+'\n');assert.equal(parser.history.length,4);assert.deepEqual(parser.history.map(x=>x.request_index),[5,6,7,8]);
 assert.equal(proxyRequestDiagnostic({request_index:102,phase:'finished',primary:null,cleanup:null}),null);
 assert.deepEqual(executionFailure({component:'engine',code:'review_incomplete',rejection_reason:privateText,upstream_status:401}),{component:'engine',code:'review_incomplete'});
 error.proxyRequest={request_index:2,phase:'finished',primary:null,cleanup:null,terminal_event:'completed'};const recovered=diagnostic(error,'analyzing');assert.equal(recovered.proxy_failure,undefined);assert.equal(recovered.proxy_cleanup,undefined);assert.equal(recovered.proxy_request!.terminal_event,'completed');
 const maximum=proxyRequestEnvelope({request_index:101,phase:'finished',primary:{...primary,request_index:101,elapsed_ms:1_320_000,stream_bytes:20_000_001,stream_frames:1_000_000,terminal_event:'failed',abort_origin:'none'},cleanup});assert(Buffer.byteLength(maximum)<2048);assert(!maximum.includes(privateText));
});
await test('normalization reports explicit fixed rejection enums without changing output or review decisions',()=>{
 const huge={...clean(),result:'findings',findings:Array.from({length:40},(_,i)=>({severity:'high',confidence:1,path:'src/auth.ts',line:2,side:'RIGHT',title:'Finding '+i,explanation:'x'.repeat(4000),remediation:'y'.repeat(2000)}))};
 for(const [value,reason]of [[{unexpected:true},'schema_invalid'],[{...clean(),head_sha:'b'.repeat(40)},'head_mismatch'],[{...clean(),summary:'sk-'+'x'.repeat(40)},'quarantined'],[huge,'output_truncated']] as const){const reasons:ReviewRejectionReason[]=[];const output=normalizeReview(value,HEAD,x=>reasons.push(x));assert(reasons.includes(reason));assert.equal(output.complete,false);assert(!JSON.stringify(reasons).includes(privateText));}
 const reasons:ReviewRejectionReason[]=[];assert.deepEqual(normalizeReview(clean(),HEAD,x=>reasons.push(x)),clean());assert.deepEqual(reasons,[]);
});

await test('an internal pipeline write exception is distinct from a downstream or provider failure',async()=>{
 const records:ProxyRequestDiagnostic[]=[];
 const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({model:'fixture',store:false,stream:true,input:[]}))]),{method:'POST',url:'/v1/responses',headers:{}}) as unknown as IncomingMessage;
 const sink=Object.assign(new Writable({write(_chunk,_encoding,done){done(Object.assign(new Error(privateText),{code:'ERR_STREAM_WRITE_AFTER_END'}));}}),{headersSent:false,writeHead(){this.headersSent=true;return this;}}) as unknown as ServerResponse;
 await inferenceProxy(req,sink,'fixture-credential',async()=>new Response(completed,{headers:{'content-type':'text/event-stream'}}),()=>{},()=>{},value=>records.push(value));
 const result=records.at(-1)!;assert.equal(result.phase,'finished');assert.equal(result.primary!.component,'proxy');assert.equal(result.primary!.code,'proxy_pipeline_failed');assert.equal(result.primary!.transport_code,'ERR_STREAM_WRITE_AFTER_END');assert.equal(result.abort_origin,'pipeline');assert(!proxyRequestEnvelope(result).includes(privateText));
});

await test('transport failures before response headers never invent an upstream status',async()=>{
 const result=await proxyCase({data:'',fetchError:new TypeError(privateText,{cause:Object.assign(new Error(privateText),{code:'ECONNREFUSED'})})});assert.equal(result.primary!.code,'proxy_transport_failed');assert.equal(result.primary!.transport_code,'ECONNREFUSED');assert.equal(result.primary!.upstream_status,undefined);assert.equal(result.primary!.origin,'transport');assert.equal(result.cleanup,null);
});
