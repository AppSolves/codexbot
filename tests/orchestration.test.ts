import { test } from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewPlan, unitEvidence, orchestrateReview, validateExecution, type ReviewPlan } from '../src/runner/orchestration.js';
import { ExecutionError } from '../src/core/execution.js';
import { decision } from '../src/core/review.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { HEAD, BASE, files, clean } from './fixtures.js';
const finding = { severity: 'high' as const, confidence: 0.99, path: 'src/auth.ts', line: 2, side: 'RIGHT' as const, title: 'Synthetic race', explanation: 'A stale result overwrites a newer state.', remediation: 'Validate identity before updating.' };
const plan = (count = 2): ReviewPlan => ({ head: HEAD, base: BASE, files, binaries: [], units: Array.from({ length: count }, (_, i) => ({ id: 'group-' + String(i).padStart(2, '0'), input: 'review-units/group-' + String(i).padStart(2, '0') + '.json', sha256: 'a'.repeat(64), paths: files.map(f => f.filename) })) });
const response = (id: string, complete = true, findings: typeof finding[] = []) => ({ unit_id: id, review: { ...clean(), complete, result: findings.length ? 'findings' : complete ? 'clean' : 'inconclusive', findings }, unfinished_reasons: complete ? [] : ['unreviewed_changes'] });
await test('added, modified, removed and renamed images retain every immutable side without being decoded as source',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 for(const status of ['added','modified','removed','renamed']){const directory=await mkdtemp(join(tmpdir(),'cb-plan-png-'));try{
  const snapshots=(status==='added'?['head']:status==='removed'?['base']:['base','head']).map(side=>({side:side as 'base'|'head',path:status==='renamed'&&side==='base'?'before.png':'image.png',sha,bytes:bytes.length}));
  for(const image of snapshots){await mkdir(join(directory,'media',image.side),{recursive:true});await writeFile(join(directory,'media',image.side,image.path),bytes);}
  await writeFile(join(directory,'trusted-instructions.json'),'[]');await writeFile(join(directory,'diff.json'),JSON.stringify([{filename:'image.png',status,...(status==='renamed'?{previous_filename:'before.png'}:{})}]));
  const p=await buildReviewPlan(directory,HEAD,BASE,[{filename:'image.png',status,format:'png',inspection:'requires-model',snapshots}]),data=JSON.parse(await unitEvidence(directory,p.units[0]!));assert.equal(data.evidence.length,snapshots.length);assert(data.evidence.every((e:object)=>!('text' in e)));
  await writeFile(join(directory,'media',snapshots[0]!.side,snapshots[0]!.path),Buffer.alloc(bytes.length));await assert.rejects(unitEvidence(directory,p.units[0]!),/review_plan_unverifiable/);
 }finally{await rm(directory,{recursive:true,force:true});}}
});
await test('unrepresentable essential instructions fail before any model request instead of silently omitting them',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cb-plan-budget-'));try{await writeFile(join(directory,'diff.json'),'[]');await writeFile(join(directory,'trusted-instructions.json'),JSON.stringify([{path:'AGENTS.md',content:'a'.repeat(1_000_000)}]));await assert.rejects(buildReviewPlan(directory,HEAD,BASE,[]),/review_plan_budget/);}finally{await rm(directory,{recursive:true,force:true});}
});
await test('host planner supplies every changed base/head file, shared instructions and source inventory in bounded immutable groups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-plan-'));
  try {
    await mkdir(join(directory, 'source/head/src'), { recursive: true });
    await mkdir(join(directory, 'source/base/src'), { recursive: true });
    const changed = Array.from({ length: 93 }, (_, i) => ({ filename: `src/module-${String(i).padStart(3, '0')}.ts`, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }));
    for (const f of changed)
      for (const side of ['base', 'head'])
        await writeFile(join(directory, 'source', side, f.filename), side === 'base' ? 'old' : 'new');
    await writeFile(join(directory, 'source/base/src/caller.ts'), 'shared caller');
    await writeFile(join(directory, 'diff.json'), JSON.stringify(changed));
    await writeFile(join(directory, 'trusted-instructions.json'), '[{"path":"AGENTS.md","content":"Inspect callers"}]');
    const actual = await buildReviewPlan(directory, HEAD, BASE, []);
    assert.equal(actual.units.length, 6);
    assert.deepEqual(actual.units.flatMap(u => u.paths).sort(), changed.map(f => f.filename).sort());
    for (const unit of actual.units) {
      const data = JSON.parse(await unitEvidence(directory, unit));
      assert(data.changes.length <= 16);
      assert.equal(data.evidence.length, data.changes.length * 2);
      assert(data.available_source.includes('source/base/src/caller.ts'));
      assert(data.trusted_instructions.includes('Inspect callers'));
    }
    await writeFile(join(directory, 'source/head', changed[20]!.filename), 'tampered');
    await unitEvidence(directory,actual.units[0]!);
    await assert.rejects(unitEvidence(directory,actual.units[1]!),/review_plan_unverifiable/);
    await writeFile(join(directory, 'source/head', changed[0]!.filename), 'tampered');
    await assert.rejects(unitEvidence(directory, actual.units[0]!), /review_plan_unverifiable/);
    await rm(join(directory, 'source/head', changed[0]!.filename));
    await assert.rejects(buildReviewPlan(directory, HEAD, BASE, []), /review_plan_unverifiable/);
  }
  finally {
    await rm(directory, { recursive: true, force: true });
  }
});
await test('targeted continuation finishes only unfinished work; synthesis retains original findings, deduplicates and keeps cross-file context', async () => {
  const p = plan(), calls: string[] = [];
  let first = true;
  const result = await orchestrateReview(p, async (u) => 'verified input ' + u.id, async (id, input) => { calls.push(id); const data = JSON.parse(input); if (id === 'synthesis') {
    assert.equal(data.coverage.length, 2);
    assert.equal(data.unit_reviews.length, 3);
    assert(data.unit_reviews.some((r: {
      findings: unknown[];
    }) => r.findings.length === 1));
    return response(id, true, [finding]);
  } assert(data.evidence.includes('verified input')); if (id === 'group-00' && first) {
    first = false;
    return response(id, false, [finding]);
  } return response(id); });
  assert.deepEqual(calls, ['group-00', 'group-00', 'group-01', 'synthesis']);
  assert.equal(result.review.complete, true);
  assert.equal(result.review.findings.length, 1);
  assert.deepEqual(result.review.findings[0], finding);
  assert.equal(decision(result.review, DEFAULT_CONFIG, true), 'REQUEST_CHANGES');
  validateExecution(result, p);
});
await test('global continuation cap and explicit synthesis cannot waive unfinished groups or convert partial findings to approval', async () => {
  const p = plan(4), calls: string[] = [];
  const result = await orchestrateReview(p, async () => '', async (id) => { calls.push(id); return response(id, id === 'synthesis', [finding]); });
  assert.equal(calls.length, 7);
  assert.equal(calls.filter(id => id === 'group-00').length, 3);
  assert.equal(result.coverage.reduce((sum, c) => sum + c.attempts - 1, 0), 2);
  assert.equal(result.review.complete, false);
  assert.equal(result.review.findings.length, 1);
  assert(result.reasons.includes('continuation_limit'));
  assert.equal(decision(result.review, DEFAULT_CONFIG, true), 'COMMENT');
  validateExecution(result, p);
});
await test('incomplete synthesis preserves its summary and valid findings and cannot approve an otherwise complete set of units', async () => {
  const p = plan(2), result = await orchestrateReview(p, async () => '', async (id) => id === 'synthesis' ? { ...response(id, false, [finding]), review: { ...response(id, false, [finding]).review, summary: 'An unresolved cross-file question prevents a complete review.' } } : response(id));
  assert.equal(result.synthesis, false);
  assert.equal(result.review.complete, false);
  assert.match(result.review.summary, /unresolved cross-file/);
  assert.deepEqual(result.review.findings, [finding]);
  assert.equal(decision(result.review, DEFAULT_CONFIG, true), 'COMMENT');
  validateExecution(result, p);
});
await test('a model cannot waive its missing essential or visual evidence by claiming a later complete synthesis', async () => {
  for (const reason of ['missing_required_context', 'visual_evidence_unavailable']) {
    const p = plan(2);
    let calls = 0;
    const result = await orchestrateReview(p, async () => '', async (id) => { calls++; return id === 'synthesis' ? response(id) : { ...response(id, false, [finding]), unfinished_reasons: [reason] }; });
    assert.equal(calls, 1);
    assert.equal(result.synthesis,false);
    assert.deepEqual(result.review.findings,[finding]);
    assert.equal(result.review.complete, false);
    assert.equal(result.coverage[0]!.complete, false);
    assert(result.reasons.includes(reason as typeof result.reasons[number]));
    validateExecution(result, p);
  }
});
await test('unavailable essential evidence stops further groups and synthesis while preserving validated findings',async()=>{
 const p=plan(6),calls:string[]=[];const result=await orchestrateReview(p,async()=>'',async id=>{calls.push(id);return{...response(id,false,[finding]),unfinished_reasons:['missing_required_context']};});
 assert.deepEqual(calls,['group-00']);assert.equal(result.synthesis,false);assert.equal(result.review.complete,false);assert.deepEqual(result.review.findings,[finding]);assert(result.reasons.includes('unreviewed_changes'));assert.equal(decision(result.review,DEFAULT_CONFIG,true),'COMMENT');validateExecution(result,p);
});
await test('modified-file evidence keeps the complete diff and verified base without retransmitting the full old source',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cb-lean-evidence-'));try{
  for(const side of['base','head']){await mkdir(join(directory,'source',side,'src'),{recursive:true});await writeFile(join(directory,'source',side,'src','auth.ts'),side==='base'?'old source':'new source');}
  await writeFile(join(directory,'diff.json'),JSON.stringify([{filename:'src/auth.ts',status:'modified',patch:'@@ -1 +1 @@\n-old source\n+new source'}]));await writeFile(join(directory,'trusted-instructions.json'),'[]');
  const p=await buildReviewPlan(directory,HEAD,BASE,[]),data=JSON.parse(await unitEvidence(directory,p.units[0]!));assert.equal(data.evidence.length,2);assert.equal(data.evidence[0].text,undefined);assert.equal(data.evidence[1].text,'new source');assert(data.changes[0].patch.includes('-old source'));
  await writeFile(join(directory,'source/base/src/auth.ts'),'tampered');await assert.rejects(unitEvidence(directory,p.units[0]!),/review_plan_unverifiable/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
await test('malformed, wrongly scoped, unsafe and fabricated unit outputs never satisfy coverage', async () => {
  for (const bad of [{ unexpected: true }, response('group-99'), { ...response('group-00'), review: { ...clean(), head_sha: BASE } }, { ...response('group-00'), review: { ...clean(), summary: 'Bearer sk-proj-' + 'x'.repeat(45) } }, { ...response('group-00'), all_groups_inspected: true }])
    await assert.rejects(orchestrateReview(plan(1), async () => '', async () => bad));
});
await test('a later provider/process failure retains previously validated partial evidence without resetting budgets', async () => {
  const p = plan(2);
  let calls = 0;
  const result = await orchestrateReview(p, async () => '', async (id) => { if (++calls > 1)
    throw new ExecutionError({ component: 'turn', code: 'codex_turn_failed' }); return response(id, false, [finding]); });
  assert.equal(calls, 2);
  assert.equal(result.review.complete, false);
  assert.deepEqual(result.review.findings, [finding]);
  assert.equal(result.failure?.code, 'codex_turn_failed');
  assert.equal(result.synthesis, false);
  validateExecution(result, p);
});
await test('host independently rejects skipped/reordered units, changed evidence receipts and inflated retry claims', async () => {
  const p = plan(2), valid = await orchestrateReview(p, async () => '', async (id) => response(id));
  validateExecution(valid, p);
  for (const mutate of [(r: typeof valid) => { r.coverage.pop(); }, (r: typeof valid) => { r.coverage.reverse(); }, (r: typeof valid) => { r.coverage[0]!.sha256 = 'b'.repeat(64); }, (r: typeof valid) => { r.coverage[0]!.attempts = 4; }, (r: typeof valid) => { r.synthesis = false; }, (r: typeof valid) => { r.coverage[0]!.reasons = ['missing_required_context']; }]) {
    const bad = structuredClone(valid);
    mutate(bad);
    assert.throws(() => validateExecution(bad, p), /review_coverage_invalid/);
  }
});
await test('more than forty findings retain highest severity with explicit incompleteness instead of approving truncated output', async () => {
  const p = plan(2);
  const result = await orchestrateReview(p, async () => '', async (id) => response(id, true, Array.from({ length: 25 }, (_, i) => ({ ...finding, title: id + ' issue ' + i }))));
  assert.equal(result.review.findings.length, 40);
  assert.equal(result.review.complete, false);
  assert.equal(result.review.output_truncated, true);
  assert(result.reasons.includes('output_truncated'));
  assert.equal(decision(result.review, DEFAULT_CONFIG, true), 'COMMENT');
  validateExecution(result, p);
});
await test('a genuinely complete clean analysis is distinguishable from inconclusive work', async () => {
  const p = plan(1);let calls=0;const result = await orchestrateReview(p, async () => '', async (id,input) => {calls++;assert.equal(id,'group-00');assert.equal(JSON.parse(input).final_whole_pr_check,true);assert.match(JSON.parse(input).instructions,/final whole-PR/);return response(id);});
  assert.equal(calls,1);assert.equal(result.turns,1);assert.equal(result.synthesis,true);
  assert.throws(()=>validateExecution({...result,turns:2},p),/review_coverage_invalid/);
  assert.equal(result.review.complete, true);
  assert.equal(result.review.result, 'clean');
  assert.equal(decision(result.review, DEFAULT_CONFIG, true), 'APPROVE');
  validateExecution(result, p);
});
await test('a sole group retains the global continuation cap and cannot skip an unfinished integrated final check',async()=>{
 const p=plan(1);let calls=0;const result=await orchestrateReview(p,async()=>'',async id=>{calls++;return response(id,false,[finding]);});assert.equal(calls,3);assert.equal(result.turns,3);assert.equal(result.synthesis,false);assert.equal(result.review.complete,false);assert.equal(decision(result.review,DEFAULT_CONFIG,true),'COMMENT');validateExecution(result,p);
});
await test('provider schema projection never weakens host uniqueness or review string bounds',async()=>{
 for(const value of [
  {...response('group-00',false),unfinished_reasons:['unresolved_analysis','unresolved_analysis']},
  {...response('group-00'),review:{...clean(),summary:'short'}},
  {...response('group-00'),review:{...clean(),summary:'s'.repeat(8001)}}
 ])await assert.rejects(orchestrateReview(plan(1),async()=>'',async()=>value),error=>error instanceof ExecutionError&&error.detail.rejection_reason==='schema_invalid');
 const result=await orchestrateReview(plan(2),async()=>'',async id=>id==='synthesis'?{...response(id,false),unfinished_reasons:['unresolved_analysis','unresolved_analysis']}:response(id,true,[finding]));
 assert.equal(result.failure?.rejection_reason,'schema_invalid');assert.equal(result.review.complete,false);assert.deepEqual(result.review.findings,[finding]);assert.equal(decision(result.review,DEFAULT_CONFIG,true),'COMMENT');
});
