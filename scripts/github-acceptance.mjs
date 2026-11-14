import process from 'node:process';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { client, splitRepo, trustedConfig } from '../dist/src/worker/github.js';
import { backendUrl } from '../dist/src/runner/broker.js';
const { values } = parseArgs({ options: { repository: { type: 'string' }, backend: { type: 'string' }, pr: { type: 'string' }, 'run-id': { type: 'string' }, 'advisory-smoke': { type: 'boolean' }, 'allow-github-write': { type: 'boolean' }, 'allow-review-usage': { type: 'boolean' }, disposable: { type: 'string' } } });
try {
  const repo = splitRepo(values.repository ?? ''), backend = backendUrl(values.backend ?? ''), prNumber = Number(values.pr);
  assert.ok(Number.isSafeInteger(prNumber) && prNumber > 0);
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), github = client(token);
  const metadata = (await github.rest.repos.get(repo)).data; assert.ok(metadata.permissions?.admin);
  const capability = await globalThis.fetch(`${backend}/v1/capabilities?repository=${encodeURIComponent(values.repository)}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: globalThis.AbortSignal.timeout(20_000) }); assert.ok(capability.ok);
  const pr = (await github.rest.pulls.get({ ...repo, pull_number: prNumber })).data;
  for (const sha of [pr.base.sha, pr.head.sha]) {
    const commit = (await github.rest.git.getCommit({ ...repo, commit_sha: sha })).data; assert.equal(commit.sha, sha);
    const tree = (await github.rest.git.getTree({ ...repo, tree_sha: commit.tree.sha })).data; assert.equal(tree.sha, commit.tree.sha); assert.equal(tree.truncated, false);
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: prNumber, per_page: 100 });
  process.stdout.write(JSON.stringify({ commitTreeContract: 'passed', head: pr.head.sha, verdicts: reviews.filter(x => x.user?.type === 'Bot' && x.body?.includes('<!-- codexbot:')).map(x => ({ id: x.id, sha: x.commit_id, state: x.state })) }) + '\n');
  if (values['run-id']) {
    const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(values['run-id']) })).data;
    assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.path, '.github/workflows/codexbot.yml'); assert.equal(run.repository.id, metadata.id); assert.equal(run.actor?.type, 'Bot');
    assert.match(run.display_title, /^CodexBot [a-f0-9-]{36} [a-f0-9-]{36}$/);
    process.stdout.write(JSON.stringify({ runId: run.id, status: run.status, conclusion: run.conclusion }) + '\n');
  }
  if (values['advisory-smoke']) {
    assert.ok(values['allow-github-write'] && values['allow-review-usage'] && values.disposable === values.repository, 'Explicit write/usage opt-in and exact disposable repository confirmation required.');
    const config = await trustedConfig(github, metadata.full_name, metadata.default_branch);
    assert.equal(config.merge.enabled, false); assert.equal(config.review.auto_approve, false); assert.equal(config.review.request_changes, false);
    await github.rest.issues.createComment({ ...repo, issue_number: prNumber, body: `${config.bot.trigger} review --effort low\n\nSecurity acceptance smoke: advisory only. Inspect the small fixture diff; report actual completeness and do not claim tests were executed.` });
    process.stdout.write('Advisory smoke requested. Inspect the run once it completes; this script does not poll or authorize merge.\n');
  } else assert.ok(!values['allow-github-write'], 'Write flag requires explicit advisory smoke.');
} catch { process.stderr.write('GitHub acceptance preflight failed; no raw responses or credentials printed. See docs/acceptance.md.\n'); process.exitCode = 1; }
