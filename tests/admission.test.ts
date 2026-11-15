import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { database } from './sqlite.js';
import { snapshot } from './fixtures.js';
import { githubFixture } from './github-fixture.js';
import { Store } from '../src/worker/store.js';
import { AdmissionError, getRejection, recordRejection, rejectionId, QUOTA_WINDOW_MS } from '../src/worker/admission.js';
import { publishRejection, rejectionBody } from '../src/worker/rejections.js';
import { processDelivery } from '../src/worker/recovery.js';
import type { BackendConfig } from '../src/worker/webhook.js';

await test('atomic admissions classify duplicate, every quota, cooldown and concurrency without weakening limits',async()=>{
  for(const [field,code] of [['user_per_day','user_quota_exceeded'],['repository_per_day','repository_quota_exceeded'],['installation_per_day','installation_quota_exceeded'],['concurrent_repository','repository_concurrency_exceeded'],['concurrent_installation','installation_concurrency_exceeded'],['cooldown_seconds','cooldown_active'],['reruns_per_day','rerun_limit_exceeded'],['duplicate','duplicate_review']] as const){
    const {db,sqlite}=database(),store=new Store(db),first=snapshot();
    Object.assign(first.config.quotas,{cooldown_seconds:0,concurrent_repository:10,concurrent_installation:10});
    if(field!=='duplicate') first.config.quotas[field]=field==='cooldown_seconds'?60:1;
    if(field==='reruns_per_day')first.command.rerun=true;
    try{
      await store.create(first);
      if(!field.startsWith('concurrent'))await store.transition(first.id,'created','failed');
      const second={...first,id:crypto.randomUUID(),command:{...first.command,instructions:field==='duplicate'?'':'Different context'}};
      await assert.rejects(store.create(second,'',true),error=>{assert.ok(error instanceof AdmissionError);assert.equal(error.code,code);return true;});
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM requests').get()!.n,1);
      const row=await getRejection(db,second.id);assert.ok(row);assert.equal(row.phase,'pending');
      assert.match(rejectionBody(row),/No AI inference was started/);
      if(field.startsWith('concurrent')||field==='duplicate')assert.equal(row.retry_at,null);
      const original=JSON.stringify(row);
      await store.transition(first.id,'created','failed');
      await assert.rejects(store.create(second,'',true),AdmissionError);assert.equal(JSON.stringify(await getRejection(db,second.id)),original);
    }finally{sqlite.close();}
  }
});
await test('rolling-window retry uses the limiting newest timestamp, exact boundary and persisted scope',async()=>{
  const {db,sqlite}=database(),store=new Store(db),now=1_900_000_000_000,clock=mock.method(Date,'now',()=>now),first=snapshot();
  Object.assign(first.config.quotas,{cooldown_seconds:0,concurrent_repository:10,reruns_per_day:3});first.command.rerun=true;
  try{
    const offsets=[-QUOTA_WINDOW_MS+1000,-QUOTA_WINDOW_MS+2000,-QUOTA_WINDOW_MS+3000];
    for(const offset of offsets){const request={...first,id:crypto.randomUUID(),createdAt:now+offset};await store.create(request);await store.transition(request.id,'created','failed');}
    first.config.quotas.reruns_per_day=2;const rejected={...first,id:crypto.randomUUID()};
    await assert.rejects(store.create(rejected,'',true),AdmissionError);
    const row=await getRejection(db,rejected.id);assert.equal(row!.retry_at,now+2000);assert.equal(row!.window_ms,QUOTA_WINDOW_MS);assert.equal(row!.quota,2);
    clock.mock.mockImplementation(()=>now+2000);
    const next={...first,id:crypto.randomUUID(),createdAt:now+2000};await store.create(next);
    await store.create({...first,id:crypto.randomUUID(),installationId:9});
    assert.ok(!rejectionBody(row!).includes('1900000000000'));
  }finally{clock.mock.restore();sqlite.close();}
});
await test('two Store instances atomically admit exactly one and retain the rejected outcome; rollback never fabricates a denial',async()=>{
  const {db,sqlite}=database(),request=snapshot();request.config.quotas.cooldown_seconds=0;
  try{
    const calls=await Promise.allSettled([new Store(db).create(request,'',true),new Store(db).create({...request,id:crypto.randomUUID()},'',true)]);
    assert.equal(calls.filter(result=>result.status==='fulfilled').length,1);
    const rejected=calls.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.status==='rejected');assert.ok(rejected.reason instanceof AdmissionError);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM requests').get()!.n,1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM review_rejections').get()!.n,1);
    const batch=mock.method(db,'batch',async()=>{throw new Error('synthetic D1 failure');});
    await assert.rejects(new Store(db).create({...request,id:crypto.randomUUID(),installationId:8}),/synthetic D1 failure/);batch.mock.restore();
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM review_rejections').get()!.n,1);
  }finally{sqlite.close();}
});
const pem=await exportPKCS8((await generateKeyPair('RS256',{extractable:true})).privateKey);
await test('feedback leases, definite failures, lost responses, ownership checks and terminal delivery recovery never duplicate posts',async()=>{
  for(const failure of ['none','network','429','503','save','spoof','revoked','expired-lease'] as const){
    const {db,sqlite}=database(),f=githubFixture(),identity={...snapshot(),commandId:777},row=await recordRejection(db,identity,'invalid_command');
    const env:BackendConfig={DB:db,PUBLIC_URL:'https://broker.invalid',GITHUB_APP_ID:'42',GITHUB_PRIVATE_KEY:pem,GITHUB_APP_SLUG:'codexbot',TRUSTED_WORKFLOW:'unused',CHATGPT_DEPLOYMENT_AUTHORIZED:'false'};
    let attempted=0;const base=f.fetcher;
    const fetcher=mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      if(init?.method==='POST'&&String(input).endsWith('/issues/4/comments')){
        attempted++;
        if(attempted===1&&failure==='429')return Response.json({message:'sensitive response'},{status:429});
        const response=await base(input,init);
        if(attempted===1&&(failure==='network'||failure==='503')){
          if(failure==='network')throw new Error('sensitive transport text');return Response.json({message:'sensitive response'},{status:503});
        }
        if(failure==='spoof')f.state.comments[0]!.performed_via_github_app={id:999};
        if(failure==='expired-lease')sqlite.prepare('UPDATE review_rejections SET lease_until=0').run();
        return failure==='spoof'?Response.json(f.state.comments[0]):response;
      }
      return base(input,init);
    });
    const logs:unknown[]=[];const logger=mock.method(console,'error',(...args:unknown[])=>logs.push(args));
    const prepare=db.prepare.bind(db);let saveFailed=false;
    const storage=mock.method(db,'prepare',(sql:string)=>{
      if(failure==='save'&&!saveFailed&&sql.startsWith("UPDATE review_rejections SET phase='done'")){saveFailed=true;throw new Error('synthetic lost D1 response');}
      return prepare(sql);
    });
    try{
      if(failure==='revoked')f.config.authorization.whitelist='';
      await Promise.all([publishRejection(env,row.id),publishRejection(env,row.id)]);
      assert.ok(f.state.comments.length<=1);
      if(failure==='spoof'||failure==='revoked')assert.equal((await getRejection(db,row.id))!.phase,'failed');
      else{
        sqlite.prepare('UPDATE review_rejections SET next_attempt=0,lease_until=0').run();
        await publishRejection(env,row.id);
        assert.equal((await getRejection(db,row.id))!.phase,'done');assert.equal(f.state.comments.length,1);
        await publishRejection(env,row.id);assert.equal(f.state.comments.length,1);
      }
      assert.ok(!JSON.stringify(logs).includes('sensitive'));
      // Already-recorded denial recovery never re-enters admission, even with an expired original payload.
      await new Store(db).delivery('fixture-delivery','digest','issue_comment',JSON.stringify({comment:{created_at:'2000-01-01'}}));
      sqlite.prepare("UPDATE deliveries SET request_id=? WHERE id='fixture-delivery'").run(identity.id);
      await processDelivery('fixture-delivery',env as Env);
      assert.equal(sqlite.prepare('SELECT phase FROM deliveries').get()!.phase,'done');assert.equal(f.state.reviews.length,0);
      assert.equal(f.calls.filter(call=>call.path.endsWith('/dispatches')).length,0);
      const replay=await recordRejection(db,{...identity,id:crypto.randomUUID()},'invalid_command');assert.equal(replay.id,row.id);assert.equal(await rejectionId({...identity,installationId:9})===row.id,false);
    }finally{storage.mock.restore();logger.mock.restore();fetcher.mock.restore();sqlite.close();}
  }
});
await test('ambiguous POST with no App-owned match exhausts bounded reconciliation without another POST',async()=>{
  const {db,sqlite}=database(),f=githubFixture(),row=await recordRejection(db,snapshot(),'invalid_command');
  const env:BackendConfig={DB:db,PUBLIC_URL:'https://broker.invalid',GITHUB_APP_ID:'42',GITHUB_PRIVATE_KEY:pem,GITHUB_APP_SLUG:'codexbot',TRUSTED_WORKFLOW:'unused',CHATGPT_DEPLOYMENT_AUTHORIZED:'false'};
  const fetcher=mock.method(globalThis,'fetch',f.fetcher),logger=mock.method(console,'error',()=>{});
  try{
    sqlite.prepare("UPDATE review_rejections SET phase='creating'").run();
    f.state.comments.push({id:100,user:{type:'User',login:'alice'},performed_via_github_app:{id:42},issue_url:'https://api.github.com/repos/owner/repo/issues/4',body:rejectionBody(row)});
    for(let n=0;n<7;n++){sqlite.prepare('UPDATE review_rejections SET next_attempt=0').run();await publishRejection(env,row.id);}
    assert.equal((await getRejection(db,row.id))!.phase,'failed');assert.equal((await getRejection(db,row.id))!.attempts,5);
    assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/comments')).length,0);
  }finally{logger.mock.restore();fetcher.mock.restore();sqlite.close();}
});

await test('concurrent redeliveries of an accepted command reuse its admission, never publish a misleading denial or spend a second rerun',async()=>{
  const {db,sqlite}=database(),first={...snapshot(),commandId:123};first.command.rerun=true;first.config.quotas.cooldown_seconds=0;
  try{
    const outcomes=await Promise.all([new Store(db).create(first,'',true),new Store(db).create({...first,id:crypto.randomUUID()},'',true)]);
    assert.equal(outcomes[0].id,outcomes[1].id);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM requests').get()!.n,1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM review_rejections').get()!.n,0);
  }finally{sqlite.close();}
});
