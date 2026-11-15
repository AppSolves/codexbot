import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { checkClaims, verifyWorkload } from '../src/worker/oidc.js';
import { WORKFLOW, RELEASE } from './fixtures.js';
const expected = { repository: 'owner/repo', repositoryId: 2, ownerId: 3, defaultBranch: 'main', workflowSha: WORKFLOW, trustedWorkflow: `operator/codexbot/.github/workflows/review.yml@${RELEASE}`, environment: 'codexbot-1-5' };
const claims = { repository: 'owner/repo', repository_id: '2', repository_owner_id: '3', event_name: 'workflow_dispatch', ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: 'owner/repo/.github/workflows/codexbot.yml@refs/heads/main', workflow_sha: WORKFLOW, job_workflow_ref: expected.trustedWorkflow, job_workflow_sha: RELEASE, runner_environment: 'github-hosted', environment: 'codexbot-1-5', sub: 'repo:owner/repo:environment:codexbot-1-5', run_id: '123', run_attempt: '1', jti: 'fixture-id' };
await test('OIDC claim binding verifies repository, owner, caller, reusable code and stage', () => {
  assert.equal(checkClaims(claims, expected).runId, '123');
  for (const [field, value] of Object.entries({ repository: 'attacker/repo', repository_id: '22', repository_owner_id: '99', event_name: 'pull_request', ref: 'refs/pull/4/merge', workflow_ref: 'owner/repo/.github/workflows/evil.yml@refs/heads/main', workflow_sha: RELEASE, job_workflow_ref: 'evil/code/.github/workflows/review.yml@main', job_workflow_sha: WORKFLOW, runner_environment: 'self-hosted', environment: 'codexbot-1-6', sub: 'repo:attacker/repo:environment:codexbot-1-5', run_id: 'evil' })) assert.throws(() => checkClaims({ ...claims, [field]: value }, expected), field);
  assert.throws(() => checkClaims(claims, { ...expected, environment: 'codexbot-publish-1' }));
});
await test('OIDC cryptographically rejects forged signatures, expiry, issuer and audience', async () => {
  const keys = await generateKeyPair('RS256'), wrong = await generateKeyPair('RS256');
  const jwt = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://token.actions.githubusercontent.com').setAudience('https://broker.invalid').setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
  assert.equal((await verifyWorkload(jwt, 'https://broker.invalid', expected, () => keys.publicKey)).runId, '123');
  await assert.rejects(verifyWorkload(jwt, 'https://other.invalid', expected, () => keys.publicKey), { code: 'oidc_token_invalid', status: 401 });
  await assert.rejects(verifyWorkload(jwt, 'https://broker.invalid', expected, () => wrong.publicKey));
  const expired = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://token.actions.githubusercontent.com').setAudience('https://broker.invalid').setIssuedAt(1).setNotBefore(1).setExpirationTime(2).sign(keys.privateKey);
  await assert.rejects(verifyWorkload(expired, 'https://broker.invalid', expected, () => keys.publicKey), { code: 'oidc_token_expired', status: 401 });
  const wrongIssuer = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://attacker.invalid').setAudience('https://broker.invalid').setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
  await assert.rejects(verifyWorkload(wrongIssuer, 'https://broker.invalid', expected, () => keys.publicKey));
});

await test('immutable default subjects bind both numeric identities and the exact review/publishing Environment',async()=>{
  const keys=await generateKeyPair('RS256');
  for(const environment of ['codexbot-1-5','codexbot-publish-1','production:restricted']){
    const subject=`repo:owner@3/repo@2:environment:${environment.replace(/:/g,'%3A')}`;
    const input={...claims,environment,sub:subject},identity={...expected,environment};
    const jwt=await new SignJWT(input).setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com').setAudience('https://broker.invalid').setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
    assert.equal((await verifyWorkload(jwt,'https://broker.invalid',identity,()=>keys.publicKey)).runId,'123');
    for(const invalid of [subject.replace('owner@3','owner@99'),subject.replace('repo@2','repo@22'),subject.replace('owner@3','other@3'),subject.replace('repo@2','other@2'),subject+':extra',subject.replace(':environment:',':ref:'),subject.replace('@3','@03')])assert.throws(()=>checkClaims({...input,sub:invalid},identity),{code:'oidc_subject_mismatch'});
    assert.throws(()=>checkClaims(input,{...identity,environment:'other'}),{code:'oidc_environment_mismatch'});
    assert.throws(()=>checkClaims({...input,job_workflow_sha:WORKFLOW},identity),{code:'oidc_reusable_workflow_mismatch'});
  }
});
