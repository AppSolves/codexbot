import { deploymentMergeEnabled } from '../src/core/review.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, validateHandle, EFFORTS } from '../src/core/command.js';
import { parseConfig } from '../src/core/config.js';
import { authorize, policyAllows, validatePolicy } from '../src/core/policy.js';
import { validateReview, safePath, changedLines, completePatch, decision, mergeDisposition, publicText } from '../src/core/review.js';
import { clean, files, HEAD, snapshot } from './fixtures.js';

await test('every configured handle triggers independently and case-insensitively', () => {
  for (const handle of ['@codexbot', '@CodexBotTest', '@CodexBotReviewTest', '@CodexBotAuditTest', '@B0t']) {
    assert.equal(parseCommand(`${handle.toUpperCase()} review`, handle)?.merge, false);
    assert.equal(parseCommand('@anotherbot review', handle), null);
  }
});
await test('the non-Codex alias is exact, preserves legacy opt-in and never aliases native connector commands', () => {
  assert.ok(parseCommand('@cbreview review --effort high', '@CBReview'));
  assert.ok(parseCommand('@codexbot review', '@codexbot'));
  for (const text of ['@codex review', '@codexbot review', '@CBReviewExtra review', '> @CBReview review', '```text\n@CBReview review\n```']) assert.equal(parseCommand(text, '@CBReview'), null);
});
await test('handle accepts only the requested ASCII alphanumeric format', () => {
  for (const invalid of ['', '@', '@with space', '@bot-name', '@bot_name', '@ä', '@x!', 'CodexBotReviewTest', '@' + 'a'.repeat(40), '@a\n']) assert.throws(() => validateHandle(invalid));
  assert.equal(validateHandle('@123'), '@123');
});
await test('quoted examples, fences, inline code and incidental mentions do not trigger', () => {
  for (const text of ['> @CodexBotReviewTest review', '```\n@CodexBotReviewTest review\n```', '`@CodexBotReviewTest review`', 'Example:\n@CodexBotReviewTest review', '@CodexBotReviewTestx review', 'Hi @CodexBotReviewTest review', '@CodexBotReviewTest reviews', '    @CodexBotReviewTest review', '\t@CodexBotReviewTest review']) assert.equal(parseCommand(text, '@CodexBotReviewTest'), null);
});
await test('flags in any order, quotes and multiline context preserve review intent', () => {
  const result = parseCommand('\n @CodexBotReviewTest review --merge "authentication risks" --effort=xhigh\r\n\r\nCheck RLS, callers, and compatibility.\n', '@CodexBotReviewTest');
  assert.deepEqual(result, { merge: true, effort: 'xhigh', instructions: 'authentication risks\n\nCheck RLS, callers, and compatibility.' });
  assert.equal(parseCommand('@CodexBotReviewTest review --effort low --merge', '@CodexBotReviewTest')?.effort, 'low');
  assert.equal(parseCommand('@CodexBotReviewTest review -- --literal context', '@CodexBotReviewTest')?.instructions, '--literal context');
});
await test('unknown, duplicate, conflicting and malformed flags fail usefully', () => {
  for (const suffix of ['--wat', '--merge --merge', '--effort low --effort high', '--effort', '--effort balanced', '"unterminated', 'trailing\\']) assert.throws(() => parseCommand(`@CodexBotReviewTest review ${suffix}`, '@CodexBotReviewTest'));
  for (const level of EFFORTS) assert.equal(parseCommand(`@CodexBotReviewTest review --effort ${level}`, '@CodexBotReviewTest')?.effort, level);
  assert.equal(parseCommand('@CodexBotReviewTest review', '@CodexBotReviewTest')?.effort, null);
});
await test('model overrides accept both flag forms, order and quotes without changing context or legacy commands', () => {
  for (const flags of ['--model codex-fixture --effort high --merge', '--merge --model="codex-fixture" --effort=high', '--effort high --model=codex-fixture --merge']) {
    const result = parseCommand(`@CBReview review ${flags} "security context"\n--model is advisory text here`, '@CBReview')!;
    assert.equal(result.model, 'codex-fixture'); assert.equal(result.effort, 'high'); assert.equal(result.merge, true);
    assert.equal(result.instructions, 'security context\n--model is advisory text here');
  }
  assert.equal(parseCommand('@CBReview review', '@CBReview')!.model, undefined);
  assert.equal(parseCommand('@CBReview review -- --model literal', '@CBReview')!.instructions, '--model literal');
  for (const value of ['--model', '--model=', '--model --merge', '--model "two words"', '--model "x;rm"', '--model "$(cmd)"', '--model ' + 'a'.repeat(101), '--model x --model y', '--model x --model=x']) {
    assert.throws(() => parseCommand('@CBReview review ' + value, '@CBReview'));
  }
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
  const config = parseConfig('bot:\n  trigger: "@CodexBotReviewTest"\nauthorization:\n  whitelist: alice\nreview:\n  effort: null\n');
  assert.equal(config.bot.trigger, '@CodexBotReviewTest'); assert.equal(config.review.effort, null); assert.equal(config.merge.enabled, false);
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

await test('merge mode schema permits zero through six humans and never silently opts into automatic merging',()=>{
  const defaults=parseConfig('');assert.equal(defaults.merge.minimum_human_approvals,0);assert.equal(defaults.merge.auto_merge_on_approval,false);assert.equal(defaults.merge.enabled,false);
  for(let humans=0;humans<=6;humans++)assert.equal(parseConfig(`merge: {enabled: true, auto_merge_on_approval: true, minimum_human_approvals: ${humans}}`).merge.minimum_human_approvals,humans);
  for(const value of [-1,0.5,7])assert.throws(()=>parseConfig(`merge: {minimum_human_approvals: ${value}}`));
});

await test('disposable merge acceptance never enables a foreign repository, installation or the global gate',()=>{
  const env={MERGE_DEPLOYMENT_AUTHORIZED:'false',MERGE_ACCEPTANCE_REPOSITORY_ID:'2',MERGE_ACCEPTANCE_INSTALLATION_ID:'1'};
  assert.equal(deploymentMergeEnabled(env,{repositoryId:2,installationId:1}),true);
  assert.equal(deploymentMergeEnabled(env,{repositoryId:3,installationId:1}),false);assert.equal(deploymentMergeEnabled(env,{repositoryId:2,installationId:9}),false);
  assert.equal(deploymentMergeEnabled({MERGE_DEPLOYMENT_AUTHORIZED:'false'},{repositoryId:2,installationId:1}),false);
  assert.equal(deploymentMergeEnabled({...env,MERGE_ACCEPTANCE_REPOSITORY_ID:''},{repositoryId:2,installationId:1}),false);
  assert.equal(env.MERGE_DEPLOYMENT_AUTHORIZED,'false');
});

await test('verified bot policy identities allow only the literal platform suffix without changing command handles', () => {
  assert.equal(policyAllows('github-actions[bot]',{whitelist:'*',blacklist:'*'}),true);
  assert.equal(policyAllows('github-actions[bot]',{whitelist:'*',blacklist:'re:github-actions\\[bot\\]'}),false);
  for(const login of ['github-actions[other]','github-actions[bot]x','github-actions[bot]\n','github-actions[bot]@other']) assert.equal(policyAllows(login,{whitelist:'*',blacklist:'*'}),false);
  assert.throws(()=>validateHandle('@github-actions[bot]'));
});
