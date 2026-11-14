import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewModel } from '../src/runner/engine.js';
import { snapshot } from './fixtures.js';
const models = [{ model: 'codex-fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { model: 'codex-deep', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }];
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
