import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from '../src/core/dlp.js';
import { normalizeReview, decision, findingDisposition } from '../src/core/review.js';
import type { Finding } from '../src/core/review.js';
import { MAX_REVIEW_BYTES } from '../src/core/limits.js';
import { sessionBinding, seal, unseal, randomSecret } from '../src/core/crypto.js';
import { Store, retryDelay } from '../src/worker/store.js';
import { database } from './sqlite.js';
import { snapshot, clean, HEAD } from './fixtures.js';
import { githubFixture } from './github-fixture.js';
import { publish } from '../src/worker/publish.js';
import { dispatchRequest } from '../src/worker/dispatch.js';
import { repositoryCapabilities } from '../src/capabilities.js';
import { Octokit } from '@octokit/rest';
import { parseConfig } from '../src/core/config.js';
import { parseCommand } from '../src/core/command.js';

const finding: Finding = { severity: 'high', confidence: 0.99, path: 'src/auth.ts', line: 2, side: 'RIGHT', title: 'Missing permission check', explanation: 'Untrusted callers can access the record.', remediation: 'Check repository permission.' };
const secrets = ['AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----', 'postgresql://alice:private-password@db.example/db', 'Bearer abcdefghijklmnopqrstuvwxyz', 'ghp_' + 'a'.repeat(36), 'sk-proj-' + 'a'.repeat(32), 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.abcdefghijklmnopqrstuvwx', 'xoxb-1234567890123456-abcdef', 'password = supersecretsample', '![image](https://exfil.invalid/token)', '<https://exfil.invalid/token>'];
await test('per-review model is persisted and included in same-head idempotency without bypassing quotas', async () => {
  const { db, sqlite } = database(), store = new Store(db), first = snapshot();
  first.config.quotas.cooldown_seconds = 0; first.config.quotas.concurrent_repository = 2;
  first.command.model = 'codex-fixture';
  try {
    await store.create(first);
    const other = structuredClone(first); other.id = crypto.randomUUID(); other.command.model = 'codex-other';
    await store.create(other);
    assert.equal((await store.get(other.id)).snapshot.command.model, 'codex-other');
    await store.transition(first.id, 'created', 'failed');
    await assert.rejects(store.create({ ...first, id: crypto.randomUUID() }), /duplicate_review/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM requests').get()!.n, 2);
  } finally { sqlite.close(); }
});
await test('DLP quarantines credentials, PEM, DSNs, bearer, vendor secrets and external URLs in every public field', async () => {
  for (const secret of secrets) {
    for (const candidate of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      assert.ok(scanSecrets(candidate).length > 0, 'Expected a secret category without printing the candidate');
      for (const field of ['summary', 'title', 'explanation', 'remediation', 'path']) {
        const value = { ...clean(), result: 'findings', findings: [{ ...finding }] };
        if (field === 'summary') value.summary = candidate; else Object.assign(value.findings[0]!, { [field]: candidate });
        const output = normalizeReview(value, HEAD); assert.equal(output.quarantined, true); assert.equal(decision(output, snapshot().config, true), 'COMMENT');
        assert.equal(JSON.stringify(output).includes(candidate), false);
      }
    }
  }
  for (const benign of ['The authentication check rejects unknown users.', 'AKIA is a prefix, not a complete key.', 'password validation requires at least eight characters.', 'src/login.ts', 'a'.repeat(40)]) assert.deepEqual(scanSecrets(benign), []);
  assert.ok(scanSecrets({ summary: ('AKIA' + 'A'.repeat(16)).split('').join(' \n') }).length > 0);
  const f = githubFixture(), output = { ...clean(), summary: 'Review text with ' + secrets[0] };
  assert.equal((await publish(f.github, snapshot(), output, true, 'codexbot')).event, 'COMMENT');
  assert.equal(JSON.stringify(f.calls).includes(secrets[0]!), false);
});
await test('40 near-maximum findings fit transport/storage after explicit non-approving information loss', () => {
  const value = { ...clean(), result: 'findings', findings: Array.from({ length: 40 }, (_, n) => ({ ...finding, line: n + 1, title: 'T'.repeat(200), explanation: '説明'.repeat(2000), remediation: 'R'.repeat(2000) })) };
  const output = normalizeReview(value, HEAD);
  assert.equal(output.output_truncated, true); assert.equal(output.complete, false); assert.equal(output.findings.length, 40);
  assert.equal(output.findings.every(x => x.severity === 'high'), true); assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_REVIEW_BYTES);
  assert.equal(decision(output, snapshot().config, true), 'COMMENT');
  assert.equal(normalizeReview({ ...clean(), findings: Array(41).fill(finding) }, HEAD).complete, false);
});
await test('full severity/confidence/completeness table never turns uncertain findings into approval', () => {
  const config = snapshot().config;
  for (const severity of ['critical', 'high', 'medium', 'low'] as const) for (const confidence of [0, 0.01, 0.69, 0.7, 0.89, 0.9, 1]) for (const complete of [false, true]) for (const contextComplete of [false, true]) {
    const value = { ...clean(), result: 'findings' as const, complete, findings: [{ ...finding, severity, confidence }] };
    const blocking = complete && contextComplete && ['critical', 'high'].includes(severity) && confidence >= config.review.blocking_confidence;
    assert.equal(decision(value, config, contextComplete), blocking ? 'REQUEST_CHANGES' : 'COMMENT');
    assert.equal(findingDisposition(value.findings[0]!, config), ['critical','high'].includes(severity) ? confidence >= 0.9 ? 'blocking' : 'manual verification' : confidence < 0.7 ? 'manual verification' : 'advisory');
  }
  config.review.blocking_confidence = 0.95; assert.equal(decision({ ...clean(), result: 'findings', findings: [{ ...finding, confidence: 0.94 }] }, config, true), 'COMMENT');
  assert.throws(() => parseConfig('review: {blocking_confidence: 0.8, advisory_confidence: 0.9}'));
});
await test('sessions and encryption AAD separate old/new installation for the same repository and actor', async () => {
  const { db, sqlite } = database(), store = new Store(db), first = snapshot(), second = { ...snapshot(), installationId: 9, id: crypto.randomUUID() }, key = randomSecret();
  const binding = sessionBinding('https://backend.invalid', first.installationId, first.repositoryId, first.actorId);
  const encrypted = await seal({ refresh_token: 'fixture-only' }, key, binding);
  try {
    await store.saveSession(2, 5, encrypted, 1); assert.equal(await store.session(2, 5, 9), null);
    await assert.rejects(store.acquire(second)); await store.saveSession(2, 5, encrypted, 9);
    await assert.rejects(unseal(encrypted, key, sessionBinding('https://backend.invalid', 9, 2, 5)));
    await store.acquire(first); await store.acquire(second);
    await store.rotate(first, 1, encrypted); assert.equal((await store.session(2, 5, 9))!.version, 1);
    await store.removeInstallation(1); assert.equal(await store.session(2, 5, 1), null); assert.ok(await store.session(2, 5, 9));
  } finally { sqlite.close(); }
});
await test('atomic quotas, same-head idempotency, bounded rerun and tenant isolation survive concurrent admissions', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot(); request.config.quotas.cooldown_seconds = 0;
  try {
    const attempts = await Promise.allSettled([store.create(request), store.create({ ...request, id: crypto.randomUUID() })]); assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
    const admitted = attempts.find(x => x.status === 'fulfilled'); assert.ok(admitted);
    assert.equal(await store.transition(admitted.value.id, 'created', 'failed'), true);
    await assert.rejects(store.create({ ...request, id: crypto.randomUUID() }), /duplicate_review/);
    const rerun = { ...request, id: crypto.randomUUID(), command: { ...request.command, rerun: true } };
    await store.create(rerun); await store.transition(rerun.id, 'created', 'failed');
    const twice = { ...rerun, id: crypto.randomUUID() }; await store.create(twice); await store.transition(twice.id, 'created', 'failed');
    await assert.rejects(store.create({ ...rerun, id: crypto.randomUUID() }), /rerun_limit_exceeded/);
    await store.create({ ...request, id: crypto.randomUUID(), installationId: 2 });
    const other = { ...request, id: crypto.randomUUID(), command: { ...request.command, instructions: 'Different task context' } };
    await store.create(other);
  } finally { sqlite.close(); }
});
await test('dispatch response loss reconciles exact attempt/run identity and never changes the attempt', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot(), f = githubFixture();
  const real = f.github.rest.actions.createWorkflowDispatch;
  const failing = mock.method(f.github.rest.actions, 'createWorkflowDispatch', async (...args: Parameters<typeof real>) => { await real(...args); throw new Error('lost response'); });
  try {
    await store.create(request); await assert.rejects(dispatchRequest(f.github, store, request, 'codexbot'));
    const attempt = (await store.get(request.id)).row.dispatch_attempt; assert.ok(attempt);
    failing.mock.restore(); await dispatchRequest(f.github, store, request, 'codexbot');
    assert.equal((await store.get(request.id)).row.state, 'dispatched'); assert.equal((await store.get(request.id)).row.dispatch_attempt, attempt);
    assert.equal(f.calls.filter(x => x.path.endsWith('/dispatches')).length, 1);
  } finally { failing.mock.restore(); sqlite.close(); }
});
await test('delivery and publication leases recover crashes, reject concurrent ownership and bound retries', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot();
  try {
    await store.delivery('fixture-delivery', 'digest', 'ping', '{}');
    const claims = await Promise.all([store.claimDelivery('fixture-delivery'), store.claimDelivery('fixture-delivery')]); assert.equal(claims.filter(Boolean).length, 1);
    await store.finishDelivery(claims.find(Boolean)!, false); assert.equal(await store.claimDelivery('fixture-delivery'), null);
    sqlite.prepare('UPDATE deliveries SET next_attempt=0').run(); assert.ok(await store.claimDelivery('fixture-delivery'));
    await store.create(request); await store.transition(request.id, 'created', 'running', '1'); await store.result(request.id, clean(), true, '1');
    const lease = await store.claimPublication(request.id, '1'); await assert.rejects(store.claimPublication(request.id, '1'));
    await assert.rejects(store.checkpoint(request.id, 'wrong', 9, 'pending'));
    await store.checkpoint(request.id, lease, 9, 'pending');
    sqlite.prepare('UPDATE requests SET publish_until=0').run(); const recovered = await store.claimPublication(request.id, '1');
    await assert.rejects(store.checkpoint(request.id, lease, 9, 'submitted'));
    await store.checkpoint(request.id, recovered, 9, 'submitted', 'not_requested'); await store.published(request.id, 9, recovered);
    assert.equal((await store.get(request.id)).row.review_phase, 'submitted');
    for (let n = 0; n < 100; n++) { const delay = retryDelay(n); assert.ok(delay >= 5000 && delay < 305000); }
  } finally { sqlite.close(); }
});
await test('lost pending-review creation and lost submit response resume the same review without duplicate approval', async () => {
  for (const operation of ['createReview', 'submitReview'] as const) {
    const f = githubFixture(), original = f.github.rest.pulls[operation];
    // Simulate GitHub accepting the write followed by a transport failure.
    const intercepted = mock.method(f.github.rest.pulls, operation, async (parameters: never) => { await original(parameters); throw new Error('lost response'); });
    await assert.rejects(publish(f.github, snapshot(), clean(), true, 'codexbot')); intercepted.mock.restore();
    const result = await publish(f.github, snapshot(), clean(), true, 'codexbot'); assert.equal(result.event, 'APPROVE');
    assert.equal(f.state.reviews.length, 1); assert.equal(f.state.reviews[0]!.state, 'APPROVED');
  }
});
await test('capability probes distinguish supported public/private environments from denied Free-private access', async () => {
  for (const visibility of ['public', 'private']) for (const available of [false, true]) {
    const github = new Octokit({ request: { fetch: async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/repos/o/r') ? Response.json({ private: visibility === 'private', permissions: { admin: true } }) : Response.json({ environments: [] }, { status: available ? 200 : 403 }) }, log: { debug() {}, info() {}, warn() {}, error() {} } });
    if (available) assert.equal((await repositoryCapabilities(github, 'o/r')).environmentSecrets, true);
    else await assert.rejects(repositoryCapabilities(github, 'o/r'), visibility === 'private' ? /Pro_Team_Enterprise/ : /admin_access/);
  }
});
await test('aliases are validated text triggers; rerun is explicit and quoted examples never invoke', () => {
  const config = parseConfig('bot: {trigger: "@codexbot", aliases: ["@CodexBotReviewTest", "@CodexBotAuditTest"]}'); assert.equal(config.bot.aliases.length, 2);
  assert.throws(() => parseConfig('bot: {trigger: "@CodexBotReviewTest", aliases: ["@CODEXBOTREVIEWTEST"]}'));
  assert.throws(() => parseConfig('bot: {aliases: ["@invalid-handle"]}'));
  assert.equal(parseCommand('@CodexBotReviewTest review --rerun --effort high', '@CodexBotReviewTest')!.rerun, true);
  assert.throws(() => parseCommand('@CodexBotReviewTest review --rerun --rerun', '@CodexBotReviewTest'));
  for (const text of ['> @CodexBotReviewTest review', '```text\n@CodexBotReviewTest review\n```', '    @CodexBotReviewTest review', '@CodexBotReviewTest2 review', 'Someone said @CodexBotReviewTest review']) assert.equal(parseCommand(text, '@CodexBotReviewTest'), null);
});

await test('strict provider schema declares all fields as required and reserves transport provenance for the host', async () => {
  const { REVIEW_SCHEMA } = await import('../src/core/review.js');
  assert.deepEqual([...REVIEW_SCHEMA.required].sort(), Object.keys(REVIEW_SCHEMA.properties).sort());
  const item = REVIEW_SCHEMA.properties.findings.items;
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
  assert.equal('quarantined' in REVIEW_SCHEMA.properties, false); assert.equal('output_truncated' in REVIEW_SCHEMA.properties, false);
});

await test('cancellation is repository/installation scoped, refuses a live publication lease and cannot be retried into merge', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot();
  try {
    await store.create(request); await store.prepare(request.id, '1'); await store.result(request.id, clean(), true, '1');
    const lease = await store.claimPublication(request.id, '1');
    await assert.rejects(store.cancellable(request.id, 2, 1));
    await assert.rejects(store.cancellable(request.id, 2, 9));
    sqlite.prepare('UPDATE requests SET publish_until=0').run();
    await store.cancellable(request.id, 2, 1); await assert.rejects(store.heartbeat(request.id, lease));
    await assert.rejects(store.claimPublication(request.id, '1')); await assert.rejects(store.operatorRetry(request.id, 2, 1));
    await store.terminateIntent(request.id); assert.equal((await store.get(request.id)).row.merge_phase, 'cancelled');
  } finally { sqlite.close(); }
});

await test('a newer same-PR rereview supersedes an older queued merge before any subsequent privileged write', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot(); request.config.quotas.cooldown_seconds = 0;
  try {
    await store.create(request); await store.prepare(request.id, '1'); await store.result(request.id, clean(), true, '1');
    const first = await store.claimPublication(request.id, '1'); await store.checkpoint(request.id, first, 99, 'submitted', 'queued'); await store.published(request.id, 99, first);
    await store.create({ ...request, id: crypto.randomUUID(), createdAt: request.createdAt + 1, command: { ...request.command, rerun: true } });
    sqlite.prepare('UPDATE requests SET next_publish=0').run(); const lease = await store.claimPublication(request.id, '1');
    await assert.rejects(store.heartbeat(request.id, lease), /review_request_superseded/);
    await store.checkpoint(request.id, lease, 99, 'submitted', 'pending'); assert.equal((await store.get(request.id)).row.merge_phase, 'queued');
  } finally { sqlite.close(); }
});

await test('environment namespaces isolate API keys and OAuth vault keys across installations and actors', async () => {
  const { credentialEnvironment, publishingEnvironment } = await import('../src/core/identity.js');
  assert.equal(credentialEnvironment(1, 5), 'codexbot-1-5');
  assert.notEqual(credentialEnvironment(1, 5), credentialEnvironment(9, 5));
  assert.notEqual(credentialEnvironment(1, 5), credentialEnvironment(1, 6));
  assert.notEqual(publishingEnvironment(1), publishingEnvironment(9));
  for (const invalid of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => credentialEnvironment(invalid, 5));
});
await test('expired merge cleanup is leased, backs off and exhausts instead of starving other tenants', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot(); request.createdAt = Date.now() - 3_600_001;
  try {
    await store.create(request); sqlite.prepare("UPDATE requests SET merge_phase='queued',state='published'").run();
    const first = await store.expiredIntent(); assert.ok(first); assert.equal(await store.expiredIntent(), null);
    await store.expiryFailed(first.id, first.lease, first.attempts); assert.equal(await store.expiredIntent(), null);
    for (let n = 1; n < 5; n++) {
      sqlite.prepare('UPDATE requests SET next_publish=0,publish_until=0').run(); const next = await store.expiredIntent(); assert.ok(next);
      await store.expiryFailed(next.id, next.lease, next.attempts);
    }
    sqlite.prepare('UPDATE requests SET next_publish=0,publish_until=0').run(); assert.equal(await store.expiredIntent(), null);
  } finally { sqlite.close(); }
});
