import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewTurnSchema } from '../src/runner/orchestration.ts';
import { assertProviderSchema } from './provider-schema-fixture.mjs';

test('all model-facing group and synthesis schemas use the documented Structured Outputs subset', () => {
  for (const id of [...Array.from({ length: 32 }, (_, i) => 'group-' + String(i).padStart(2, '0')), 'synthesis']) {
    const schema = reviewTurnSchema(id);
    assertProviderSchema(schema);
    assert.deepEqual(schema.properties.unit_id.enum, [id]);
    assert.equal(schema.properties.unfinished_reasons.maxItems, 9);
    assert.equal(schema.properties.review.additionalProperties, false);
  }
});

test('schema contract rejects unsupported nested keywords, open objects and optional properties', () => {
  for (const key of ['uniqueItems', 'minLength', 'maxLength', 'contains', 'allOf', 'default']) {
    assert.throws(() => assertProviderSchema({ type: 'array', items: { type: 'string', [key]: true } }), /Unsupported output-schema keyword/);
  }
  for (const schema of [{ type: 'object', properties: {}, required: [], additionalProperties: true }, { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false }]) {
    assert.throws(() => assertProviderSchema(schema));
  }
});
