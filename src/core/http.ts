import { requireCondition } from './errors.js';
/** Bound before parsing: identity-provider responses must never become diagnostics. */
export async function boundedJson(response: Response, limit = 64_000): Promise<unknown> {
  const reader = response.body?.getReader(); requireCondition(reader, 'oauth_response_body_missing', 502);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) { await reader.cancel(); requireCondition(false, 'oauth_response_too_large', 502); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}
