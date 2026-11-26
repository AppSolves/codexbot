import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewModel,reviewImages } from '../src/runner/engine.js';
import {inspectMedia} from '../src/runner/proxy.js';
import { snapshot } from './fixtures.js';
import catalog from '../src/core/model-catalog.json' with {type:'json'};
import {parseCommand} from '../src/core/command.js';
await test('pinned GPT-6.2 catalog selects the new default and validates CLI overrides without fallback',()=>{
  const native=catalog.models.map(model=>({...model,supportedReasoningEfforts:model.efforts.map(reasoningEffort=>({reasoningEffort}))}));
  for(const mode of ['chatgpt','api-key'] as const){
    const request=snapshot();request.config.credentials.mode=mode;
    assert.deepEqual(selectReviewModel(native,request),{model:'gpt-6.2-sol',effort:null});
    for(const model of ['gpt-6.2-sol','gpt-6.2-astra']){
      request.command=parseCommand(`@CBReview review --model ${model} --effort ultra`,'@CBReview')!;
      assert.deepEqual(selectReviewModel(native,request),{model,effort:'ultra'});
      request.command.effort='none';assert.throws(()=>selectReviewModel(native,request),/effort_not_supported/);
    }
    request.command=parseCommand('@CBReview review --model gpt-6.1-sol','@CBReview')!;
    assert.equal(selectReviewModel(native,request).model,'gpt-6.1-sol');
    request.command.model='gpt-6.2-unknown';assert.throws(()=>selectReviewModel(native,request),/not_in_codex_catalog/);
  }
});
const models = [{ model: 'codex-fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { model: 'codex-deep', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }];
await test('vision attachments are bounded local immutable snapshots; remote media, audio and file uploads are denied',()=>{
  const sha='a'.repeat(40),asset={filename:'image.png',format:'png',snapshots:[{side:'base',path:'old.png',sha},{side:'head',path:'image.png',sha}]};
  const images=reviewImages(JSON.stringify({binaryFiles:[asset]}));assert.equal(images.length,1);assert.equal(images[0]!.path,'/workspace/media/base/old.png');assert.match(images[0]!.label,/head/);
  assert.throws(()=>reviewImages(JSON.stringify({binaryFiles:[{...asset,snapshots:[{side:'head',path:'../credential',sha}]}]})),/image_context_invalid/);
  assert.throws(()=>reviewImages(JSON.stringify({binaryFiles:Array.from({length:17},(_,i)=>({...asset,snapshots:[{side:'head',path:`image-${i}.png`,sha:i.toString(16).padStart(40,'0')}]}))})),/image_context_limit/);
  assert.equal(inspectMedia([{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,AAAA'}]}]),1);
  for(const image_url of ['https://evil.invalid/image.png','file:///run/credential','data:text/html;base64,AAAA'])assert.throws(()=>inspectMedia([{type:'input_image',image_url}]),/proxy_image_source_denied/);
  for(const type of ['input_audio','input_video','input_file'])assert.throws(()=>inspectMedia([{type}]),/proxy_unsupported_media_input/);
});
await test('OAuth and API-key reviews preserve omitted effort and validate explicit model-specific support identically', () => {
  for (const mode of ['chatgpt', 'api-key'] as const) {
    const request = snapshot(); request.config.credentials.mode = mode;
    assert.deepEqual(selectReviewModel(models, request), { model: 'codex-fixture', effort: null });
    request.config.review.effort = 'high'; assert.equal(selectReviewModel(models, request).effort, 'high');
    request.command.effort = 'low'; assert.equal(selectReviewModel(models, request).effort, 'low');
    request.command.effort = 'xhigh'; assert.throws(() => selectReviewModel(models, request), /effort_not_supported/);
    request.config.review.model = 'codex-deep'; assert.deepEqual(selectReviewModel(models, request), { model: 'codex-deep', effort: 'xhigh' });
    request.config.review.model = 'inaccessible-or-unknown'; assert.throws(() => selectReviewModel(models, request), /not_in_codex_catalog/);
  }
  assert.throws(() => selectReviewModel([], snapshot())); assert.throws(() => selectReviewModel([models[0]!, models[0]!], snapshot()));
});
await test('per-review model overrides repository/default model, validates that model effort and never falls back', () => {
  for (const mode of ['chatgpt', 'api-key'] as const) {
    const request = snapshot(); request.config.credentials.mode = mode;
    request.config.review.model = 'codex-fixture'; request.command.model = 'codex-deep';
    assert.deepEqual(selectReviewModel(models, request), { model: 'codex-deep', effort: null });
    request.command.effort = 'low'; assert.throws(() => selectReviewModel(models, request), /effort_not_supported/);
    request.command.effort = 'xhigh'; assert.deepEqual(selectReviewModel(models, request), { model: 'codex-deep', effort: 'xhigh' });
    request.command.model = 'unknown'; assert.throws(() => selectReviewModel(models, request), /not_in_codex_catalog/);
    delete request.command.model; request.command.effort = null;
    assert.equal(selectReviewModel(models, request).model, 'codex-fixture');
    request.config.review.model = null; assert.equal(selectReviewModel(models, request).model, 'codex-fixture');
  }
});
