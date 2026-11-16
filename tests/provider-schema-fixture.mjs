import assert from 'node:assert/strict';

// Deliberately only the documented Responses subset used by our output schemas.
// https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
export function assertProviderSchema(schema, depth = 0) {
  assert(schema && typeof schema === 'object' && !Array.isArray(schema));
  assert(depth <= 10);
  const keywords = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'pattern', 'minimum', 'maximum', 'maxItems']);
  for (const key of Object.keys(schema)) assert(keywords.has(key), `Unsupported output-schema keyword: ${key}`);
  assert(schema.type || Array.isArray(schema.enum));
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    for (const child of Object.values(schema.properties)) assertProviderSchema(child, depth + 1);
  }
  if (schema.type === 'array') assertProviderSchema(schema.items, depth + 1);
}
