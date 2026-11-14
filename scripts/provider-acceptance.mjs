import process from 'node:process';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateFile, atomicPrivateFile, withFileLock } from '../dist/src/auth/files.js';
import { OAuth, validateSession } from '../dist/src/auth/oauth.js';
import { isolatedReview, docker } from '../dist/src/runner/docker.js';
import { DEFAULT_CONFIG } from '../dist/src/core/config.js';
import { normalizeReview, validateReview } from '../dist/src/core/review.js';
import { evaluationFixture, evaluationResult, REVIEW_CASES } from '../tests/review-evaluation-fixtures.mjs';
const { values } = parseArgs({ options: { mode: { type: 'string' }, 'credential-file': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, image: { type: 'string', default: 'codexbot-review:local' }, 'allow-live-oauth': { type: 'boolean' }, 'allow-paid-api': { type: 'boolean' }, 'max-requests': { type: 'string' }, case: { type: 'string', default: 'security' }, label: { type: 'string', default: 'revised' }, 'report-file': { type: 'string' } } });
let directory;
try {
  assert.ok(process.platform === 'linux' && process.getuid() !== 0, 'Use a non-root Linux operator runner.');
  assert.ok(values.mode === 'oauth' || values.mode === 'api-key');
  const oauth = values.mode === 'oauth';
  assert.ok(oauth ? values['allow-live-oauth'] && !values['allow-paid-api'] && process.env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true' : values['allow-paid-api'] && !values['allow-live-oauth']);
  assert.ok(REVIEW_CASES.includes(values.case) && ['baseline','revised'].includes(values.label));
  const maxRequests = Number(values['max-requests']); assert.ok(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 3);
  assert.ok(values['credential-file'] && values.model && /^[A-Za-z0-9._-]+$/.test(values.model));
  // Input is a private JSON file: {api_key: ...} or a validated official SIWC OAuthSession.
  let credential;
  await withFileLock(values['credential-file'], async () => {
    const saved = await readPrivateFile(values['credential-file']);
    if (oauth) {
      let session = validateSession(saved);
      assert.ok(!session.hosted, 'Use the authorized workflow for browser-managed sessions; never export hosted credentials.');
      if (session.expires_at - Date.now() < 25 * 60_000) { session = await new OAuth().refresh(session); await atomicPrivateFile(values['credential-file'], session); }
      assert.ok(session.expires_at - Date.now() >= 22 * 60_000); credential = session.access_token;
    } else { assert.ok(typeof saved?.api_key === 'string' && saved.api_key.length > 0); credential = saved.api_key; }
    directory = await mkdtemp(join(tmpdir(), 'codexbot-provider-acceptance-'));
    const context = join(directory, 'context'), sockets = join(directory, 'sockets'), key = join(directory, 'credential');
    await mkdir(context, { mode: 0o700 }); await mkdir(sockets, { mode: 0o700 }); await mkdir(join(context, 'source'), { mode: 0o700 });
    await writeFile(key, credential, { mode: 0o600 });
    const head = 'a'.repeat(40), config = globalThis.structuredClone(DEFAULT_CONFIG); config.credentials.mode = oauth ? 'chatgpt' : 'api-key';
    const request = { head, base: 'b'.repeat(40), config, command: { model: values.model, effort: values.effort ?? null, merge: false, instructions: 'Acceptance review of this synthetic repository only. Inspect the provided diff, both source versions and trusted instructions. Do not execute project code or claim tests passed.' } };
    const fixture = await evaluationFixture(context, request, values.case);
    const image = (await docker(['image','inspect','--format','{{.Id}}',values.image])).trim(); assert.match(image,/^sha256:[a-f0-9]{64}$/);
    const output = validateReview(normalizeReview(await isolatedReview(image, context, key, sockets, { maxRequests, maxInputBytes: 50_000, ...(!oauth ? { maxOutputTokens: 2048 } : {}) }), head), head, fixture.files);
    const score = evaluationResult(output, fixture);
    if (values['report-file']) await atomicPrivateFile(values['report-file'], { ...score, label: values.label, model: values.model, effort: values.effort ?? null, image });
    assert.ok(score.passed);
    process.stdout.write('Real provider fixture acceptance passed; no raw model output or GitHub writes.\n');
    if (oauth) process.stdout.write('Launch gate remains pending until the operator verifies ChatGPT-plan usage and absence of API billing for this request.\n');
  });
} catch { process.stderr.write('Provider acceptance failed or was not explicitly enabled. No raw provider output or credentials printed.\n'); process.exitCode = 1; }
finally { if (directory) await rm(directory, { recursive: true, force: true }); }
