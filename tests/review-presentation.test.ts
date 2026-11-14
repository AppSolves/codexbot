import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSummary, decision } from '../src/core/review.js';
import { clean, HEAD, snapshot } from './fixtures.js';
import { publish } from '../src/worker/publish.js';
import { githubFixture } from './github-fixture.js';
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
