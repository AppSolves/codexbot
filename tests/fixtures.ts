import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { RequestSnapshot } from '../src/worker/store.js';
import type { Review } from '../src/core/review.js';
export const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), WORKFLOW = 'c'.repeat(40), RELEASE = 'd'.repeat(40);
export function snapshot(): RequestSnapshot {
  const config = structuredClone(DEFAULT_CONFIG); config.authorization.whitelist = 'alice';
  return { id: '12345678-1234-4123-8123-123456789012', installationId: 1, repositoryId: 2, ownerId: 3, repository: 'owner/repo',
    defaultBranch: 'main', workflowSha: WORKFLOW, head: HEAD, base: BASE, pr: 4, actor: 'alice', actorId: 5,
    command: { merge: false, effort: null, instructions: '' }, config, createdAt: Date.now() };
}
export function clean(): Review { return { head_sha: HEAD, result: 'clean', complete: true, summary: 'Reviewed the changed code, related callers and tests; no actionable defects were found.', findings: [] }; }
export const files = [{ filename: 'src/auth.ts', status: 'modified', patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new' }];
