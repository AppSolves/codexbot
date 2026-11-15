import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSummary, decision, normalizeReview, type Review, REVIEW_SCHEMA } from '../src/core/review.js';
import { clean, HEAD, snapshot } from './fixtures.js';
import { publish } from '../src/worker/publish.js';
import { githubFixture } from './github-fixture.js';
await test('incomplete reports expose bounded orchestration state without raw diagnostics and preserve the native COMMENT',async()=>{
 const review:Review={...clean(),complete:false,result:'findings',summary:'A valid finding was identified; another analysis question remains unresolved.',findings:[{severity:'high',confidence:0.99,path:'src/auth.ts',line:2,side:'RIGHT',title:'Verify authorization',explanation:'An introduced missing check exposes records.',remediation:'Require repository permission.'}],orchestration:{planned_units:6,completed_units:3,synthesis_complete:false,unfinished_reasons:['unresolved_analysis','continuation_limit']}};
 const fixture=githubFixture(),result=await publish(fixture.github,snapshot(),review,false,'codexbot');assert.equal(result.event,'COMMENT');const body=fixture.calls.find(c=>c.method==='POST'&&c.path.endsWith('/reviews'))!.body;assert(String(body.body).includes(review.summary));assert.match(String(body.body),/Analysis coverage: 3\/6 groups completed\. Final synthesis: incomplete/);assert.match(String(body.body),/`unresolved_analysis`/);assert.equal((body.comments as unknown[]).length,1);
 assert.equal(Object.hasOwn(REVIEW_SCHEMA.properties,'orchestration'),false,'Models cannot supply host status');assert.equal(decision({...review,orchestration:{planned_units:1,completed_units:1,synthesis_complete:true,unfinished_reasons:[]}},snapshot().config,true),'COMMENT','Metadata cannot promote an incomplete review');
 for(const orchestration of [{...review.orchestration,planned_units:33},{...review.orchestration,completed_units:7},{...review.orchestration,unfinished_reasons:['private/source.ts OAuth-private-code']},{...review.orchestration,path:'private/source.ts OAuth-private-code'}]){const unsafe={...review,orchestration} as unknown as Review;assert(!reviewSummary(unsafe,'COMMENT',false).includes('private/source.ts'));assert(!reviewSummary(unsafe,'COMMENT',false).includes('Analysis coverage:'));assert.equal(normalizeReview(unsafe,HEAD).complete,false);}
});
await test('human-readable summaries preserve native event semantics across severity, confidence and completeness', () => {
  const config = snapshot().config;
  for (const severity of ['critical','high','medium','low'] as const) for (const confidence of [0.01,0.7,0.9,1]) for (const complete of [false,true]) {
    const review = { ...clean(), complete, result:'findings' as const, findings:[{severity,confidence,path:'src/auth.ts',line:3,side:'RIGHT' as const,title:'Check permissions',explanation:'Unauthorized caller can access private data.',remediation:'Reject unauthorized callers.'}] };
    const event = decision(review, config, complete), body = reviewSummary(review,event,complete);
    assert.ok(body.includes('**CodexBot Review**')); assert.ok(!body.includes('Merge intent:')); assert.ok(!body.includes('Completeness:'));
    if (!complete || confidence < 0.9 && ['critical','high'].includes(severity)) assert.equal(event,'COMMENT');
    if (complete && confidence >= 0.9 && ['critical','high'].includes(severity)) { assert.equal(event,'REQUEST_CHANGES'); assert.ok(body.includes('Changes requested.')); }
    if (!complete) assert.ok(body.includes('Review incomplete.'));
    assert.ok(body.includes('Tests were not executed'));
  }
  assert.equal(reviewSummary(clean(),'APPROVE',true), `**CodexBot Review**\n\nReview complete. No actionable issues found.\n\n${clean().summary}\n\nTests were not executed in the isolated review environment.`);
  assert.ok(reviewSummary({...clean(),head_sha:HEAD,complete:false,result:'inconclusive'},'COMMENT',false).includes('No approval is authorized.'));
  assert.ok(reviewSummary(clean(),'COMMENT',true).includes('This review is advisory.'));
});
await test('publisher submits real native events and their corresponding readable summaries without duplicate reviews', async () => {
  for (const outcome of ['clean','advisory','blocking','incomplete'] as const) {
    const fixture = githubFixture(), review = clean();
    if (outcome === 'incomplete') { review.complete=false; review.result='inconclusive'; }
    if (outcome === 'advisory' || outcome === 'blocking') {
      review.result='findings'; review.findings=[{severity:outcome==='blocking'?'high':'medium',confidence:0.99,path:'src/auth.ts',line:2,side:'RIGHT',title:'Verify authorization',explanation:'An introduced missing check exposes records.',remediation:'Require repository permission.'}];
    }
    const expected = outcome==='clean'?'APPROVE':outcome==='blocking'?'REQUEST_CHANGES':'COMMENT';
    const request=snapshot(), first=await publish(fixture.github,request,review,outcome!=='incomplete','codexbot');
    assert.equal(first.event,expected); const submitted=fixture.calls.find(call=>call.path.endsWith('/events'))!; assert.equal(submitted.body.event,expected);
    const created=fixture.calls.find(call=>call.method==='POST'&&call.path.endsWith('/reviews'))!;
    const body=String(created.body.body); assert.ok(body.includes('**CodexBot Review**')); assert.ok(!body.includes('Merge intent: not requested'));
    assert.ok(body.includes(outcome==='blocking'?'Changes requested.':outcome==='incomplete'?'Review incomplete.':'Review complete.'));
    await publish(fixture.github,request,review,outcome!=='incomplete','codexbot'); assert.equal(fixture.state.reviews.length,1);
  }
});
