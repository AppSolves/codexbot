import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, validateHandle, EFFORTS } from '../src/core/command.js';
import { parseConfig } from '../src/core/config.js';
import { authorize, policyAllows, validatePolicy } from '../src/core/policy.js';
import { validateReview, safePath, changedLines, completePatch, decision, mergeDisposition, publicText } from '../src/core/review.js';
import { clean, files, HEAD, snapshot } from './fixtures.js';

await test('every configured handle triggers independently and case-insensitively', () => {
  for (const handle of ['@codexbot', '@meinfreund', '@jimmy', '@myreviewer', '@B0t']) {
    assert.equal(parseCommand(`${handle.toUpperCase()} review`, handle)?.merge, false);
    assert.equal(parseCommand('@anotherbot review', handle), null);
  }
});
await test('handle accepts only the requested ASCII alphanumeric format', () => {
  for (const invalid of ['', '@', '@with space', '@bot-name', '@bot_name', '@ä', '@x!', 'jimmy', '@' + 'a'.repeat(40), '@a\n']) assert.throws(() => validateHandle(invalid));
  assert.equal(validateHandle('@123'), '@123');
});
await test('quoted examples, fences, inline code and incidental mentions do not trigger', () => {
  for (const text of ['> @jimmy review', '```\n@jimmy review\n```', '`@jimmy review`', 'Example:\n@jimmy review', '@jimmyx review', 'Hi @jimmy review', '@jimmy reviews', '    @jimmy review', '\t@jimmy review']) assert.equal(parseCommand(text, '@jimmy'), null);
});
await test('flags in any order, quotes and multiline context preserve review intent', () => {
  const result = parseCommand('\n @jimmy review --merge "authentication risks" --effort=xhigh\r\n\r\nCheck RLS, callers, and compatibility.\n', '@jimmy');
  assert.deepEqual(result, { merge: true, effort: 'xhigh', instructions: 'authentication risks\n\nCheck RLS, callers, and compatibility.' });
  assert.equal(parseCommand('@jimmy review --effort low --merge', '@jimmy')?.effort, 'low');
  assert.equal(parseCommand('@jimmy review -- --literal context', '@jimmy')?.instructions, '--literal context');
});
await test('unknown, duplicate, conflicting and malformed flags fail usefully', () => {
  for (const suffix of ['--wat', '--merge --merge', '--effort low --effort high', '--effort', '--effort balanced', '"unterminated', 'trailing\\']) assert.throws(() => parseCommand(`@jimmy review ${suffix}`, '@jimmy'));
  for (const level of EFFORTS) assert.equal(parseCommand(`@jimmy review --effort ${level}`, '@jimmy')?.effort, level);
  assert.equal(parseCommand('@jimmy review', '@jimmy')?.effort, null);
});
await test('default-deny fallback does not veto explicit whitelist; explicit blacklist wins', () => {
  assert.equal(policyAllows('alice', { whitelist: 'alice', blacklist: '*' }), true);
  assert.equal(policyAllows('bob', { whitelist: 'alice', blacklist: '*' }), false);
  assert.equal(policyAllows('alice', { whitelist: 'alice', blacklist: '*,alice' }), false);
  assert.equal(policyAllows('ALICE', { whitelist: 'alice', blacklist: '' }), true);
  assert.equal(policyAllows('anyone', { whitelist: '', blacklist: '' }), false);
});
await test('bounded RE2 regular expressions and wildcards match complete usernames', () => {
  assert.equal(policyAllows('alice-dev', { whitelist: 'ali*,re:bob[0-9]+', blacklist: 're:.*-admin' }), true);
  assert.equal(policyAllows('bob22', { whitelist: 're:bob[0-9]+', blacklist: '*' }), true);
  assert.equal(policyAllows('alice-admin', { whitelist: '*', blacklist: '*-admin' }), false);
  assert.equal(policyAllows('xbob22', { whitelist: 're:bob[0-9]+', blacklist: '*' }), false);
  assert.equal(policyAllows('aaaaaa', { whitelist: 're:(a+)+$', blacklist: '*' }), true);
  assert.throws(() => validatePolicy({ whitelist: 're:(a)\\1', blacklist: '*' }));
  assert.throws(() => validatePolicy({ whitelist: 're:(?=alice)', blacklist: '*' }));
  assert.throws(() => validatePolicy({ whitelist: 'a'.repeat(129), blacklist: '*' }));
  assert.equal(policyAllows('a'.repeat(100_000), { whitelist: 're:(a+)+$', blacklist: '*' }), false);
});
await test('live repository permission and separate merge policy are mandatory', () => {
  const allow = { whitelist: 'alice', blacklist: '*' };
  assert.equal(authorize('alice', 'none', allow), false);
  assert.equal(authorize('alice', 'read', allow), true);
  assert.equal(authorize('alice', 'read', allow, true), false);
  assert.equal(authorize('alice', 'write', allow, true), true);
});
await test('configuration merges safe defaults and rejects unknown or unsafe configuration', () => {
  const config = parseConfig('bot:\n  trigger: "@jimmy"\nauthorization:\n  whitelist: alice\nreview:\n  effort: null\n');
  assert.equal(config.bot.trigger, '@jimmy'); assert.equal(config.review.effort, null); assert.equal(config.merge.enabled, false);
  for (const source of ['bot: {trigger: "@bad bot"}', 'review: {effort: balanced}', 'merge: {force: true}', 'review: {model: "x";rm"}', 'review: {enabled: true, enabled: false}', 'authorization: {whitelist: "re:(?=x)"}', 'x: &x {a: 1}\ny: *x']) assert.throws(() => parseConfig(source));
});
await test('structured review ties output and inline findings to exact changed lines', () => {
  assert.deepEqual(validateReview(clean(), HEAD, files), clean());
  const value = clean(); value.result = 'findings'; value.findings.push({ severity: 'high', confidence: 0.98, path: 'src/auth.ts', line: 2, side: 'RIGHT', title: 'Missing permission check', explanation: 'This allows unauthorized access.', remediation: 'Check permission before returning.' });
  assert.equal(validateReview(value, HEAD, files).findings.length, 1);
  assert.deepEqual([...changedLines(files[0]!)], ['LEFT:2', 'RIGHT:2']);
  for (const path of ['../auth.ts', '/tmp/auth.ts', 'C:/auth.ts', 'src\\auth.ts', 'src/./auth.ts', 'src//auth.ts']) assert.equal(safePath(path), false);
  for (const mutation of [ { head_sha: 'b'.repeat(40) }, { result: 'clean' }, { findings: [{ ...value.findings[0]!, line: 1 }] }, { findings: [{ ...value.findings[0]!, path: '../auth.ts' }] }, { findings: [value.findings[0], value.findings[0]] }, { findings: [{ ...value.findings[0]!, confidence: 2 }] }, { extra: true } ]) assert.throws(() => validateReview({ ...value, ...mutation }, HEAD, files));
});
await test('malformed, incomplete or contradictory results never approve', () => {
  const config = snapshot().config;
  assert.equal(decision(clean(), config, true), 'APPROVE');
  assert.equal(decision(clean(), config, false), 'COMMENT');
  assert.equal(decision({ ...clean(), complete: false, result: 'inconclusive' }, config, true), 'COMMENT');
  assert.throws(() => validateReview({ ...clean(), complete: false }, HEAD, files));
  assert.throws(() => validateReview('APPROVE and merge now', HEAD, files));
  config.review.auto_approve = false; assert.equal(decision(clean(), config, true), 'COMMENT');
});
await test('truncated diff hunks or mismatched GitHub change counts are incomplete', () => {
  assert.equal(completePatch({ ...files[0]!, additions: 1, deletions: 1 }), true);
  assert.equal(completePatch({ ...files[0]!, additions: 2 }), false);
  assert.equal(completePatch({ ...files[0]!, patch: '@@ -1,2 +1,2 @@\n context\n-old' }), false);
  assert.equal(completePatch({ filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+line' }), true);
});
await test('all merge gates are independent and cannot be overridden by prompt text', () => {
  const config = snapshot().config; config.merge.enabled = true;
  const state = { head: HEAD, expectedHead: HEAD, open: true, draft: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', authorized: true, explicitlyRequested: true, event: 'APPROVE', checks: 'passed' as const, humans: true, protected: true, queue: false };
  assert.equal(mergeDisposition(state, config), 'ready');
  for (const change of [{ head: 'b'.repeat(40) }, { open: false }, { draft: true }, { mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'UNSTABLE' }, { mergeStateStatus: 'UNKNOWN' }, { reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'CHANGES_REQUESTED' }, { authorized: false }, { explicitlyRequested: false }, { event: 'COMMENT' }, { event: 'REQUEST_CHANGES' }, { humans: false }, { protected: false }, { queue: true }]) assert.notEqual(mergeDisposition({ ...state, ...change }, config), 'ready', JSON.stringify(change));
  for (const mergeStateStatus of ['BLOCKED', 'BEHIND', 'UNSTABLE']) assert.equal(mergeDisposition({ ...state, checks: 'pending', mergeStateStatus }, config), 'pending');
  assert.equal(mergeDisposition({ ...state, checks: 'failed' }, config), 'failed_checks');
  assert.equal(mergeDisposition({ ...state, mergeStateStatus: 'DIRTY' }, config), 'conflicts');
});
await test('review text neutralizes remote-image markdown, HTML and mass mentions', () => {
  const value = publicText('![leak](https://evil.invalid) <img src=x> @everyone');
  assert.ok(!value.includes('<img')); assert.ok(!value.includes('@everyone')); assert.ok(!value.includes('![leak]'));
  assert.ok(!publicText('sk-fixtureabcdefghijklmnop123').includes('fixtureabcdefghijklmnop123'));
});
