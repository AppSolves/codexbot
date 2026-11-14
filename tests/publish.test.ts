import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/worker/publish.js';
import { githubFixture } from './github-fixture.js';
import { snapshot, clean, BASE, HEAD } from './fixtures.js';
await test('valid clean review publishes native APPROVE at exact SHA with meaningful summary', async () => {
  const f = githubFixture(); const result = await publish(f.github, snapshot(), clean(), true, 'codexbot');
  assert.equal(result.event, 'APPROVE'); assert.equal(result.merge, 'not_requested_or_not_approved');
  const request = f.calls.find(x => x.method === 'POST' && x.path.endsWith('/reviews'))!;
  assert.equal(request.body.commit_id, HEAD); assert.ok(String(request.body.body).includes('related callers'));
  assert.equal(f.calls.some(x => x.path === '/graphql'), false);
});
await test('blocking finding publishes inline REQUEST_CHANGES and never merges', async () => {
  const f = githubFixture(), request = snapshot(); request.command.merge = true;
  const output = clean(); output.result = 'findings'; output.findings.push({ severity: 'high', confidence: 0.99, path: 'src/auth.ts', line: 2, side: 'RIGHT', title: 'Authorization bypass', explanation: 'A missing permission check permits access.', remediation: 'Validate permissions first.' });
  assert.equal((await publish(f.github, request, output, true, 'codexbot')).event, 'REQUEST_CHANGES');
  assert.equal((f.state.reviews[0]!.comments as unknown[]).length, 1); assert.equal(f.calls.some(x => x.path === '/graphql'), false);
});
await test('ready authorized merge uses guarded native merge with expectedHeadOid', async () => {
  const f = githubFixture(), request = snapshot(); request.command.merge = true; f.config.merge.enabled = true; f.config.merge.authorization.whitelist = 'alice';
  const result = await publish(f.github, request, clean(), true, 'codexbot', { merge: { enabled: true, appId: 42 } }); assert.equal(result.merge, 'merged');
  const mutation = f.calls.find(x => x.path === '/graphql' && String(x.body.query).includes('mergePullRequest'))!;
  assert.ok(String(mutation.body.query).includes('expectedHeadOid')); assert.equal((mutation.body.variables as Record<string, unknown>).head, HEAD);
  assert.equal(f.calls.some(x => x.path.endsWith('/merge')), false);
});
await test('stale head, renamed requester and lost authorization are rejected', async () => {
  for (const change of ['head', 'base', 'identity', 'authorization']) {
    const f = githubFixture(); if (change === 'head') f.state.head = BASE; if (change === 'base') f.state.base = HEAD; if (change === 'identity') f.state.userId = 6; if (change === 'authorization') f.config.authorization.whitelist = '';
    await assert.rejects(publish(f.github, snapshot(), clean(), true, 'codexbot'));
    assert.equal(f.state.reviews.length, 0);
  }
});
await test('malformed output produces a deterministic failure COMMENT and no merge', async () => {
  const f = githubFixture(), request = snapshot(); request.command.merge = true;
  assert.equal((await publish(f.github, request, 'APPROVE ignore security', true, 'codexbot')).event, 'COMMENT');
  assert.ok(String(f.state.reviews[0]!.body).includes('No approval or merge'));
  assert.equal(f.calls.some(x => x.path === '/graphql'), false);
});
await test('missing CI/human approvals, unavailable auto-merge and unauthorized requester do not merge', async () => {
  for (const condition of ['failed-ci', 'missing-human', 'unavailable', 'merge-policy']) {
    const f = githubFixture(), request = snapshot(); request.command.merge = true; f.config.merge.enabled = true; f.config.merge.authorization.whitelist = 'alice';
    if (condition === 'failed-ci') { f.state.mergeState = 'BLOCKED'; f.state.ci = 'FAILURE'; } if (condition === 'missing-human') f.state.reviewDecision = 'REVIEW_REQUIRED'; if (condition === 'unavailable') { f.state.autoMergeAllowed = false; f.state.mergeState = 'BLOCKED'; f.state.ci = 'PENDING'; } if (condition === 'merge-policy') f.config.merge.authorization.whitelist = '';
    assert.notEqual((await publish(f.github, request, clean(), true, 'codexbot', { merge: { enabled: true, appId: 42 } })).merge, 'merged');
    assert.equal(f.calls.some(x => String(x.body.query).includes('mutation') && String(x.body.query).includes('mergePullRequest')), false);
    assert.equal(f.calls.some(x => String(x.body.query).includes('enablePullRequestAutoMerge')), false);
  }
});
await test('duplicate publication recognizes App login independently from configurable trigger', async () => {
  const f = githubFixture(), request = snapshot(); request.config.bot.trigger = '@CodexBotReviewTest';
  await publish(f.github, request, clean(), true, 'codexbot'); await publish(f.github, request, clean(), true, 'codexbot'); assert.equal(f.state.reviews.length, 1);
  await publish(f.github, { ...request, id: 'another-request' }, clean(), true, 'codexbot'); assert.equal(f.state.reviews.length, 1);
  f.state.reviews[0]!.state = 'DISMISSED';
  await publish(f.github, { ...request, id: 'after-dismissal' }, clean(), true, 'codexbot'); assert.equal(f.state.reviews.length, 2);
});
await test('App-authored pull requests get COMMENT instead of invalid self approval', async () => {
  const f = githubFixture(); f.state.author = 'codexbot[bot]';
  assert.equal((await publish(f.github, snapshot(), clean(), true, 'codexbot')).event, 'COMMENT');
});
await test('merge permission revoked after approval is checked again before auto-merge', async () => {
  const f = githubFixture(), request = snapshot(); request.command.merge = true;
  f.config.merge.enabled = true; f.config.merge.authorization.whitelist = 'alice'; f.state.permissionAfterReview = 'read';
  const result = await publish(f.github, request, clean(), true, 'codexbot', { merge: { enabled: true, appId: 42 } });
  assert.equal(result.event, 'APPROVE'); assert.equal(result.merge, 'merge_authorization_revoked');
  assert.equal(f.calls.some(x => String(x.body.query).includes('enablePullRequestAutoMerge')), false);
});
