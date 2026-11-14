import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluationFixture,evaluationResult,REVIEW_CASES} from './review-evaluation-fixtures.mjs';
await test('prompt evaluation fixtures distinguish clean, arithmetic, security and unchanged-caller regression evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cb-evaluation-'));
  try{for(const name of REVIEW_CASES){const fixture=await evaluationFixture(join(root,name),{head:'a'.repeat(40)},name);
    const diff=JSON.parse(await readFile(join(root,name,'diff.json'),'utf8'));assert.equal(diff[0].filename,fixture.path);assert.ok(diff[0].patch.includes('@@ -1,4 +1,4 @@'));
    const review={complete:true,result:name==='clean'?'clean':'findings',findings:name==='clean'?[]:[{path:fixture.path,line:3,side:'RIGHT',confidence:0.99}]};
    assert.equal(evaluationResult(review,fixture).passed,true);assert.equal(evaluationResult({...review,complete:false},fixture).passed,false);
    if(name==='multi-file'){assert.match(await readFile(join(root,name,'source/head/src/caller.js'),'utf8'),/unit_amount:quote\(dollars\)/);assert.match(await readFile(join(root,name,`source/head/${fixture.path}`),'utf8'),/return Math.round\(amount\)/);}
  }}finally{await rm(root,{recursive:true,force:true});}
});
