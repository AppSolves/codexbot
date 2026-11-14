import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, JWTPayload } from 'jose';
import { requireCondition } from '../core/errors.js';

export interface WorkflowIdentity {
  repository: string; repositoryId: number; ownerId: number; defaultBranch: string;
  workflowSha: string; trustedWorkflow: string; environment: string;
}
export interface Workload { runId: string; attempt: string; jti: string }
const githubKeys = createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'));
export async function verifyWorkload(token: string, audience: string, expected: WorkflowIdentity, keys?: JWTVerifyGetKey): Promise<Workload> {
  const resolver = keys ?? githubKeys;
  const { payload } = await jwtVerify(token, resolver, {
    issuer: 'https://token.actions.githubusercontent.com', audience, algorithms: ['RS256'],
    maxTokenAge: '10m', requiredClaims: ['exp', 'iat', 'nbf', 'jti', 'sub']
  });
  return checkClaims(payload, expected);
}
export function checkClaims(claims: JWTPayload, expected: WorkflowIdentity): Workload {
  const workflowRef = `${expected.repository}/.github/workflows/codexbot.yml@refs/heads/${expected.defaultBranch}`;
  requireCondition(claims.repository === expected.repository && claims.repository_id === String(expected.repositoryId) && claims.repository_owner_id === String(expected.ownerId), 'oidc_repository_mismatch', 403);
  requireCondition(claims.event_name === 'workflow_dispatch' && claims.ref === `refs/heads/${expected.defaultBranch}` && claims.ref_type === 'branch', 'oidc_event_mismatch', 403);
  requireCondition(claims.workflow_ref === workflowRef && claims.workflow_sha === expected.workflowSha, 'oidc_caller_workflow_mismatch', 403);
  requireCondition(/@[a-f0-9]{40}$/.test(expected.trustedWorkflow) && claims.job_workflow_ref === expected.trustedWorkflow && claims.job_workflow_sha === expected.trustedWorkflow.split('@')[1], 'oidc_reusable_workflow_mismatch', 403);
  requireCondition(claims.runner_environment === 'github-hosted' && claims.environment === expected.environment, 'oidc_environment_mismatch', 403);
  requireCondition(claims.sub === `repo:${expected.repository}:environment:${expected.environment.replace(/:/g, '%3A')}`, 'oidc_subject_mismatch', 403);
  requireCondition(typeof claims.run_id === 'string' && /^\d+$/.test(claims.run_id) && typeof claims.run_attempt === 'string' && /^\d+$/.test(claims.run_attempt) && typeof claims.jti === 'string', 'oidc_run_missing', 403);
  requireCondition(Number.isSafeInteger(Number(claims.run_id)) && Number(claims.run_id) > 0 && Number.isSafeInteger(Number(claims.run_attempt)) && Number(claims.run_attempt) > 0 && claims.jti.length > 0 && claims.jti.length <= 200, 'oidc_invalid_run_identity', 403);
  return { runId: claims.run_id, attempt: claims.run_attempt, jti: claims.jti };
}
