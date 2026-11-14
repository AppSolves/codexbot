import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/worker/publish.js';
import { githubFixture } from './github-fixture.js';
import { snapshot, clean, HEAD, BASE } from './fixtures.js';
import { checkState, controlMerge } from '../src/worker/merge.js';
const enabled = { merge: { enabled: true, appId: 42 } };
function mergeFixture() { const f = githubFixture(), request = snapshot(); request.command.merge = true; f.config.merge.enabled = true; f.config.merge.authorization.whitelist = 'alice'; return { ...f, request }; }
await test('merge controller independently denies implicit merge even with passing publisher prerequisites', async () => {
  const f = mergeFixture(); f.request.command.merge = false;
  f.state.mergeState = 'BLOCKED'; f.state.ci = 'PENDING'; f.state.guarded = true;
  f.state.reviews.push({ id: 1, state: 'APPROVED', commit_id: HEAD, user: { type: 'Bot', login: 'codexbot[bot]' } });
  assert.equal(await controlMerge(f.github, f.request, f.config, 'codexbot', enabled.merge), 'policy_denied');
  assert.equal(f.state.checks.length, 0); assert.equal(f.state.autoMergeOwner, null);
  assert.equal(f.calls.some(x => String(x.body.query).includes('enablePullRequestAutoMerge')), false);
});
await test('pending checks queue native auto-merge only behind an App-bound required guard', async () => {
  const f = mergeFixture(); f.state.mergeState = 'BLOCKED'; f.state.ci = 'PENDING'; f.state.guarded = true;
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'queued');
  assert.equal(f.state.autoMergeOwner, 'codexbot[bot]'); assert.equal(f.state.checks[0]!.status, 'in_progress');
  assert.equal(f.calls.some(x => String(x.body.query).includes('mutation') && String(x.body.query).includes('mergePullRequest')), false);
  f.state.ci = 'SUCCESS';
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'queued'); assert.equal(f.state.checks[0]!.conclusion, 'success');
  f.state.mergeState = 'CLEAN';
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merged'); assert.equal(f.state.reviews.length, 1);
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merged');
});
await test('missing required human approvals, failed CI or revoked policy cancel owned pending auto-merge', async () => {
  for (const condition of ['humans', 'failure', 'permission', 'blocking-review']) {
    const f = mergeFixture(); f.state.mergeState = 'BLOCKED'; f.state.ci = 'PENDING'; f.state.guarded = true;
    await publish(f.github, f.request, clean(), true, 'codexbot', enabled);
    if (condition === 'humans') f.state.humans = [];
    if (condition === 'failure') f.state.ci = 'FAILURE';
    if (condition === 'permission') f.state.permission = 'read';
    if (condition === 'blocking-review') f.state.reviews.push({ id: 500, state: 'CHANGES_REQUESTED', commit_id: HEAD, user: { type: 'Bot', login: 'codexbot[bot]' } });
    assert.notEqual((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merged');
    assert.equal(f.state.autoMergeOwner, null); assert.equal(f.state.checks[0]!.conclusion, 'failure');
  }
});
await test('bot approval cannot satisfy an extra required human, and stale/author approvals do not count', async () => {
  for (const condition of ['two-required', 'stale', 'author', 'bot']) {
    const f = mergeFixture();
    if (condition === 'two-required') f.state.requiredHumans = 2;
    if (condition === 'stale') f.state.humans[0]!.commit_id = BASE;
    if (condition === 'author') f.state.humans[0]!.user = { type: 'User', login: 'alice' };
    if (condition === 'bot') f.state.humans[0]!.user = { type: 'Bot', login: 'another[bot]' };
    assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'independent_human_approvals_required');
  }
});
await test('every GitHub merge state has an explicit safe outcome and merge queues are never bypassed', async () => {
  for (const state of ['DIRTY', 'UNKNOWN', 'DRAFT', 'HAS_HOOKS', 'BLOCKED', 'BEHIND', 'UNSTABLE']) {
    const f = mergeFixture(); f.state.mergeState = state; f.state.ci = 'PENDING';
    assert.notEqual((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merged');
    assert.equal(f.calls.some(x => String(x.body.query).includes('enablePullRequestAutoMerge')), false);
  }
  const f = mergeFixture(); f.state.rules = [{ type: 'merge_queue' }];
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merge_queue_requires_manual_action');
  const missing = mergeFixture(); missing.state.contextTruncated = true;
  assert.equal((await publish(missing.github, missing.request, clean(), true, 'codexbot', enabled)).merge, 'check_evidence_unavailable');
});
await test('ready native merge does not depend on the optional auto-merge feature, and deployment defaults deny merge', async () => {
  const f = mergeFixture(); f.state.autoMergeAllowed = false;
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot')).merge, 'deployment_merge_acceptance_gate_closed');
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'merged');
});
await test('CI state policy rejects all failure conclusions and treats unknown/neutral as pending', () => {
  for (const conclusion of ['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE','STALE']) assert.equal(checkState([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion }]), 'failed');
  for (const conclusion of [null, 'NEUTRAL', 'SKIPPED', 'FUTURE_STATE']) assert.equal(checkState([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion }]), 'pending');
  assert.equal(checkState([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'passed');
  assert.equal(checkState([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failed');
  assert.equal(checkState([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
});

await test('human approval counts immutable IDs once and live permissions must belong to the reviewed user ID', async () => {
  const f = mergeFixture(); f.state.requiredHumans = 2;
  f.state.humans.push({ id: 81, state: 'APPROVED', commit_id: HEAD, user: { id: 6, login: 'renamed-bob', type: 'User' } });
  assert.equal((await publish(f.github, f.request, clean(), true, 'codexbot', enabled)).merge, 'independent_human_approvals_required');
  const forged = mergeFixture(); forged.state.humans[0]!.user = { id: 999, login: 'bob', type: 'User' };
  await assert.rejects(publish(forged.github, forged.request, clean(), true, 'codexbot', enabled), /permission_identity_changed/);
  assert.equal(forged.calls.some(x => String(x.body.query).includes('mutation') && String(x.body.query).includes('mergePullRequest')), false);
});
