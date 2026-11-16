import {test} from 'node:test';
import assert from 'node:assert/strict';
import {maintainCredential,renewableContextClient} from '../src/runner/credentials.js';
import type {OAuthSession} from '../src/auth/oauth.js';
import {AppError} from '../src/core/errors.js';
const session=(now:number):OAuthSession=>({issuer:'https://auth.openai.com',client_id:'oaiapp_synthetic',subject:'fixture',ext_agent_host_id:'urn:uuid:fixture',access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',scopes:['openid'],expires_at:now+10*60000,earliest_refresh_at:now+5*60000});
const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
await test('long reviews serialize rotation, obey eligibility and persist before proxy publication',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const stop=new AbortController(),events:string[]=[];let rotations=0;
 try{const running=maintainCredential(session(Date.now()),async current=>{assert(Date.now()>=current.earliest_refresh_at);events.push('persist');rotations++;return{...current,access_token:'synthetic-'+rotations,expires_at:Date.now()+10*60000,earliest_refresh_at:Date.now()+5*60000};},async()=>{assert.equal(events.at(-1),'persist');events.push('publish');},stop.signal);
 t.mock.timers.tick(8*60000-1);await flush();assert.equal(rotations,0);t.mock.timers.tick(1);await flush();assert.equal(rotations,1);assert.deepEqual(events,['persist','publish']);t.mock.timers.tick(8*60000);await flush();assert.equal(rotations,2);stop.abort();await running;assert.deepEqual(events,['persist','publish','persist','publish']);
 }finally{stop.abort();t.mock.timers.reset();}
});
await test('revoked or uncertain credentials fail the runtime instead of reusing a token or paid fallback',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const stop=new AbortController();let published=0;
 try{const running=maintainCredential(session(Date.now()),async()=>{throw new AppError('oauth_grant_invalid_reconnect_required');},async()=>{published++;},stop.signal);const checked=assert.rejects(running,{code:'oauth_grant_invalid_reconnect_required'});t.mock.timers.tick(8*60000);await checked;assert.equal(published,0);}finally{stop.abort();t.mock.timers.reset();}
});
await test('shutdown joins an in-flight durable rotation and never publishes after cancellation',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const stop=new AbortController();let finish!:(value:OAuthSession)=>void,persisted=false,closed=false,published=false;
 try{const running=maintainCredential(session(Date.now()),async()=>{const next=await new Promise<OAuthSession>(resolve=>{finish=resolve;});persisted=true;return next;},async()=>{published=true;},stop.signal).then(()=>{closed=true;});t.mock.timers.tick(8*60000);await flush();stop.abort();await flush();assert.equal(closed,false);finish(session(Date.now()));await running;assert.equal(persisted,true);assert.equal(published,false);assert.equal(closed,true);}finally{stop.abort();t.mock.timers.reset();}
});
await test('concurrent long-running context requests share one broker renewal and revoke old and final read tokens',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1700000000000});let count=0;const sent:string[]=[],revoked:string[]=[];
 t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{const token=String((options?.headers as Record<string,string>).authorization);if(options?.method==='DELETE'){revoked.push(token);return new Response(null,{status:204});}sent.push(token);return Response.json({id:2});});
 const context=renewableContextClient('synthetic-first',async()=>{count++;await Promise.resolve();return'synthetic-next';});
 try{await context.github.rest.repos.get({owner:'owner',repo:'repo'});t.mock.timers.tick(51*60000);await Promise.all(Array.from({length:3},()=>context.github.rest.repos.get({owner:'owner',repo:'repo'})));assert.equal(count,1);assert.deepEqual(sent,['Bearer synthetic-first','Bearer synthetic-next','Bearer synthetic-next','Bearer synthetic-next']);assert.deepEqual(revoked,['token synthetic-first']);await context.close();assert.deepEqual(revoked,['token synthetic-first','token synthetic-next']);}finally{t.mock.timers.reset();}
});
await test('context renewal denial prevents further reads instead of using an expired credential',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1700000000000});let reads=0;
 t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{if(options?.method==='DELETE')return new Response(null,{status:204});reads++;return Response.json({});});
 const context=renewableContextClient('synthetic-first',async()=>{throw new AppError('review_authorization_revoked',403);});
 try{t.mock.timers.tick(51*60000);await assert.rejects(context.github.rest.repos.get({owner:'owner',repo:'repo'}),/review_authorization_revoked/);assert.equal(reads,0);await context.close();}finally{t.mock.timers.reset();}
});
