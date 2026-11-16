import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseConfig} from '../src/core/config.js';
import {parseCommand} from '../src/core/command.js';
import {requestLifetimeMs,MERGE_INTENT_LIFETIME_MS} from '../src/core/limits.js';
import {Store} from '../src/worker/store.js';
import {REQUEST_EXPIRY_SQL} from '../src/worker/admission.js';
import {database} from './sqlite.js';
import {snapshot} from './fixtures.js';

await test('review timeout defaults to thirty minutes and explicit trusted configuration is bounded',()=>{
  assert.equal(parseConfig('').review.timeout_minutes,30);
  for(const minutes of [1,30,40,45,60,120,330])assert.equal(parseConfig(`review: {timeout_minutes: ${minutes}}`).review.timeout_minutes,minutes);
  for(const minutes of ['0','331','1.5','null','"30"','unlimited'])assert.throws(()=>parseConfig(`review: {timeout_minutes: ${minutes}}`));
});
await test('request expiry, concurrency and credential leases follow the selected timeout without extending merge authority',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const {db,sqlite}=database(),store=new Store(db),request=snapshot();
  request.command.timeout_minutes=120;request.config.quotas.cooldown_seconds=0;request.config.quotas.concurrent_repository=1;
  try{
    await store.create(request);await store.saveSession(2,5,{version:1,iv:'synthetic',ciphertext:'synthetic'},1);await store.acquire(request);
    const row=await db.prepare(`SELECT ${REQUEST_EXPIRY_SQL} AS expiry FROM requests WHERE id=?`).bind(request.id).first<{expiry:number}>();
    assert.equal(row!.expiry,request.createdAt+requestLifetimeMs(request));
    assert.equal((await db.prepare('SELECT lease_until FROM sessions WHERE repository_id=2 AND actor_id=5 AND installation_id=1').first<{lease_until:number}>())!.lease_until,row!.expiry);
    assert.equal(MERGE_INTENT_LIFETIME_MS,60*60000);
    t.mock.timers.tick(91*60000);await store.cleanup();assert.equal((await store.get(request.id)).row.state,'created');
    await assert.rejects(store.create({...request,id:crypto.randomUUID(),createdAt:Date.now(),head:'e'.repeat(40)}),/repository_concurrency_exceeded/);
    t.mock.timers.tick(89*60000);await assert.rejects(store.get(request.id),/request_expired/);await store.cleanup();
    await store.create({...request,id:crypto.randomUUID(),createdAt:Date.now(),head:'f'.repeat(40)});
  }finally{sqlite.close();t.mock.timers.reset();}
});
await test('an explicit default timeout cannot bypass same-head idempotency',async()=>{
  const {db,sqlite}=database(),store=new Store(db),request=snapshot();request.config.quotas.cooldown_seconds=0;
  try{await store.create(request);await store.transition(request.id,'created','failed');await assert.rejects(store.create({...request,id:crypto.randomUUID(),command:{...request.command,timeout_minutes:30}}),/duplicate_review/);}finally{sqlite.close();}
});
await test('timeout overrides preserve flag order, quoting and advisory context without accepting ambiguous values',()=>{
  for(const flags of ['--timeout 40 --effort high','--effort high --timeout="40"']){
    const command=parseCommand('@CBReview review '+flags+'\nDo not ignore missing context.','@CBReview')!;
    assert.equal(command.timeout_minutes,40);assert.equal(command.effort,'high');assert.equal(command.instructions,'Do not ignore missing context.');
  }
  assert.equal(parseCommand('@CBReview review','@CBReview')!.timeout_minutes,undefined);
  for(const flags of ['--timeout','--timeout=','--timeout -1','--timeout 0','--timeout 331','--timeout 1.5','--timeout 1e1','--timeout NaN','--timeout 30 --timeout 40'])assert.throws(()=>parseCommand('@CBReview review '+flags,'@CBReview'));
  assert.equal(parseCommand('@CBReview review -- --timeout 40','@CBReview')!.timeout_minutes,undefined);
});
