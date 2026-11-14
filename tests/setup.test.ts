import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { parse } from 'yaml';
import { callerWorkflow, setupPullRequest, ensureProtectedEnvironment } from '../src/setup.js';
import { RELEASE } from './fixtures.js';
await test('generated caller pins reusable code and guards named Environment credentials', () => {
  const yaml = callerWorkflow('operator/codexbot', RELEASE, 'https://self.invalid');
  const workflow = parse(yaml) as { permissions: unknown; jobs: { review: { uses: string; secrets?: unknown; permissions: unknown; with: { backend: string } } } };
  assert.equal(workflow.jobs.review.uses, `operator/codexbot/.github/workflows/review.yml@${RELEASE}`);
  assert.deepEqual(workflow.jobs.review.secrets, { CODEXBOT_VAULT_KEY: '${{ secrets.CODEXBOT_VAULT_KEY }}', CODEXBOT_API_KEY: '${{ secrets.CODEXBOT_API_KEY }}' });
  assert.deepEqual(workflow.permissions, {}); assert.equal(workflow.jobs.review.with.backend, 'https://self.invalid');
  assert.match(yaml, /dispatch_attempt/); assert.throws(() => callerWorkflow('operator/codexbot', 'main', 'https://self.invalid'));
});
function setupFixture() {
  const writes: { path: string; body: Record<string, unknown> }[] = []; let exists = true, branch = false, pr = false, fail = '';
  let entries: { path: string; content: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== 'GET') writes.push({ path, body });
    let value: unknown = {}, status = 200;
    if (path === '/repos/owner/repo') value = { id: 2, default_branch: 'main', permissions: { admin: true } };
    else if (path.startsWith('/repos/operator/codexbot/contents/')) value = { type: 'file' };
    else if (path.includes('/contents/')) {
      const file = decodeURIComponent(path.split('/contents/')[1]!);
      if (url.searchParams.get('ref') === RELEASE) { const entry = entries.find(x => x.path === file); value = { type: 'file', content: Buffer.from(entry?.content ?? '').toString('base64') }; }
      else status = exists ? 200 : 404;
    } else if (path === '/repos/owner/repo/pulls') {
      if (method === 'POST') { pr = true; status = 201; value = { html_url: 'https://github.com/owner/repo/pull/1' }; }
      else value = pr ? [{ html_url: 'https://github.com/owner/repo/pull/1', head: { sha: RELEASE }, base: { ref: 'main' } }] : [];
    } else if (path.endsWith('/git/ref/heads/codexbot/setup')) { status = branch ? 200 : 404; value = { object: { sha: RELEASE } }; }
    else if (path.endsWith('/git/ref/heads/main')) value = { object: { sha: 'a'.repeat(40) } };
    else if (path.includes('/git/commits/') && method === 'GET') value = { tree: { sha: 'b'.repeat(40) }, parents: [{ sha: 'a'.repeat(40) }] };
    else if (path.endsWith('/git/trees')) { assert.equal(body.base_tree, 'b'.repeat(40)); entries = body.tree as typeof entries; value = { sha: 'e'.repeat(40) }; status = 201; }
    else if (path.endsWith('/git/commits')) { assert.deepEqual(body.parents, ['a'.repeat(40)]); value = { sha: RELEASE }; status = 201; }
    else if (path.endsWith('/git/refs')) { assert.equal(body.ref, 'refs/heads/codexbot/setup'); assert.equal(entries.length, 2); branch = true; status = 201; }
    else if (path.includes('/compare/')) value = { total_commits: 1, files: entries.map(x => ({ filename: x.path, status: 'added' })) };
    else throw new Error(`Unmocked setup path ${method} ${path}`);
    if (fail && path.endsWith(fail) && method === 'POST') { fail = ''; throw new Error('Lost accepted response'); }
    return Response.json(value, { status });
  };
  const github = new Octokit({ auth: 'fixture', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  return { github, writes, setExisting(value: boolean) { exists = value; }, failAfter(path: string) { fail = path; }, isAtomic() { return !branch || entries.length === 2; } };
}
await test('automatic setup preserves existing workflows and creates only a dedicated atomic setup PR', async () => {
  const f = setupFixture(), setup = () => setupPullRequest(f.github, 'owner/repo', 'operator/codexbot', RELEASE, 'https://self.invalid', 'alice');
  await assert.rejects(setup()); assert.equal(f.writes.length, 0);
  f.setExisting(false); assert.equal(await setup(), 'https://github.com/owner/repo/pull/1');
  const tree = f.writes.find(x => x.path.endsWith('/git/trees'))!.body.tree as unknown[]; assert.equal(tree.length, 2);
  assert.ok(JSON.stringify(tree).includes('@CBReview2'));
  assert.equal(f.writes.filter(x => x.path.endsWith('/git/refs')).length, 1); assert.equal(f.writes.some(x => x.body.force === true), false);
  assert.equal(await setup(), 'https://github.com/owner/repo/pull/1'); assert.equal(f.writes.filter(x => x.path.endsWith('/pulls')).length, 1);
});
await test('setup resumes failures after tree, commit, branch and PR effects without partial files or duplicate PRs', async () => {
  for (const phase of ['/git/trees', '/git/commits', '/git/refs', '/pulls']) {
    const f = setupFixture(); f.setExisting(false); f.failAfter(phase);
    const setup = () => setupPullRequest(f.github, 'owner/repo', 'operator/codexbot', RELEASE, 'https://self.invalid', 'alice');
    await assert.rejects(setup()); assert.equal(f.isAtomic(), true);
    assert.equal(await setup(), 'https://github.com/owner/repo/pull/1');
    assert.equal(f.writes.filter(x => x.path.endsWith('/pulls')).length, 1);
  }
});
await test('credential onboarding preserves existing Environment protections and rejects unprotected ones', async () => {
  let mode = 'protected', writes = 0, protectedBranch = true;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/repos/owner/repo') return Response.json({ default_branch: 'main', permissions: { admin: true } });
    if (path.endsWith('/branches/main')) return Response.json({ protected: protectedBranch });
    if (path.endsWith('/environments')) return Response.json({ total_count: 0, environments: [] });
    if (path.endsWith('/deployment-branch-policies')) return Response.json({ total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] });
    if (init?.method === 'PUT') { writes++; return Response.json({}); }
    if (mode === 'missing') return Response.json({}, { status: 404 });
    return Response.json({ deployment_branch_policy: mode === 'protected' ? { protected_branches: false, custom_branch_policies: true } : null, protection_rules: [{ type: 'required_reviewers' }] });
  };
  const github = new Octokit({ auth: 'fixture', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  await ensureProtectedEnvironment(github, 'owner/repo', 'codexbot-5'); assert.equal(writes, 0);
  mode = 'unprotected'; await assert.rejects(ensureProtectedEnvironment(github, 'owner/repo', 'codexbot-5')); assert.equal(writes, 0);
  mode = 'missing'; protectedBranch = false; await assert.rejects(ensureProtectedEnvironment(github, 'owner/repo', 'codexbot-5'), /protect_default_branch/); assert.equal(writes, 0);
  protectedBranch = true; await ensureProtectedEnvironment(github, 'owner/repo', 'codexbot-5'); assert.equal(writes, 1);
});
