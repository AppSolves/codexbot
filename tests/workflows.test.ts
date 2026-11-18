import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import { record } from '../src/core/errors.js';
import { callerWorkflow } from '../src/setup.js';
import { RELEASE } from './fixtures.js';
await test('reusable workflow has no GitHub write permissions, shared secrets or PR-head checkout', async () => {
  const text = await readFile('.github/workflows/review.yml', 'utf8'), workflow = record(parse(text));
  assert.deepEqual(workflow.permissions, {});
  const jobs = record(workflow.jobs);
  assert.equal(record(jobs.review)['timeout-minutes'], 360);
  for (const [name, value] of Object.entries(jobs)) {
    const job = record(value), permissions = record(job.permissions);
    assert.equal(job['runs-on'], 'ubuntu-latest');
    for (const [permission, access] of Object.entries(permissions)) assert.ok(access !== 'write' || permission === 'id-token');
    if (name !== 'source') assert.ok(typeof job.environment === 'string');
    for (const value of job.steps as unknown[]) {
      const step = record(value);
      if (typeof step.uses === 'string') assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout')) assert.equal(record(step.with)['persist-credentials'], false);
    }
  }
  assert.ok(!text.includes('pull_request.head')); assert.ok(!text.includes('secrets: inherit')); assert.ok(!text.includes('upload-artifact'));
  assert.equal(record(record(jobs.publish).permissions).contents, 'read');
});
await test('named Environment references require a successful caller scope guard, without credential values or blanket inheritance', async () => {
  const workflow = record(parse(await readFile('.github/workflows/review.yml', 'utf8')));
  const contract = record(record(workflow.on).workflow_call);
  assert.deepEqual(Object.keys(record(contract.secrets)).sort(), ['CODEXBOT_API_KEY', 'CODEXBOT_VAULT_KEY']);
  const caller = record(parse(callerWorkflow('operator/codexbot', RELEASE, 'https://self.invalid')));
  const jobs = record(caller.jobs), review = record(jobs.review), guard = record(jobs['credential-scope']);
  assert.deepEqual(review.secrets, { CODEXBOT_VAULT_KEY: '${{ secrets.CODEXBOT_VAULT_KEY }}', CODEXBOT_API_KEY: '${{ secrets.CODEXBOT_API_KEY }}' });
  assert.deepEqual(review.needs, ['credential-scope']); assert.equal(review.if, undefined);
  assert.equal(guard.environment, undefined); assert.deepEqual(guard.permissions, {}); assert.equal(guard['timeout-minutes'], 1);
  const guardSteps = guard.steps as Record<string, unknown>[]; assert.equal(guardSteps.length, 1);
  assert.deepEqual(guardSteps[0]!.env, { CODEXBOT_SHARED_CREDENTIAL_PRESENT: "${{ secrets.CODEXBOT_VAULT_KEY != '' || secrets.CODEXBOT_API_KEY != '' }}" });
  const guardScript = String(guardSteps[0]!.run).split("<<'JS'\n")[1]!.replace(/\nJS\s*$/, '');
  for (const value of ['false', 'true', '', 'opaque-secret']) {
    const env = Object.assign(Object.create(null) as NodeJS.ProcessEnv, { CODEXBOT_SHARED_CREDENTIAL_PRESENT: value });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', guardScript], { env, encoding: 'utf8' });
    assert.equal(result.status, value === 'false' ? 0 : 1);
    assert.ok(!result.stdout.includes('opaque-secret')); assert.ok(!result.stderr.includes('opaque-secret'));
    if (value !== 'false') assert.equal(JSON.parse(result.stderr).code, 'non_environment_credentials_forbidden');
  }
  assert.ok(!JSON.stringify(caller).includes('secrets: inherit'));
  assert.equal(guard['continue-on-error'], undefined); assert.equal(guardSteps[0]!['continue-on-error'], undefined);
  const manual = record(parse((await readFile('docs/installation.md', 'utf8')).split('```yaml\n')[1]!.split('```')[0]!));
  assert.deepEqual(record(manual.jobs)['credential-scope'], guard);
  assert.deepEqual(record(record(manual.jobs).review).needs, review.needs);
  assert.deepEqual(record(record(manual.jobs).review).secrets, review.secrets);
  const steps = record(record(workflow.jobs).review).steps as Record<string, unknown>[];
  const check = String(steps[0]!.run).split("<<'JS'\n")[1]!.replace(/\nJS\s*$/, '');
  for (const [vault, api, status] of [['', '', 1], ['opaque-vault', '', 0], ['', 'opaque-api', 0], ['opaque-vault', 'opaque-api', 1]] as const) {
    const env = Object.assign(Object.create(null) as NodeJS.ProcessEnv, { CODEXBOT_VAULT_KEY: vault, CODEXBOT_API_KEY: api });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', check], { env, encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr); assert.ok(!result.stdout.includes('opaque-')); assert.ok(!result.stderr.includes('opaque-'));
  }
});
await test('cached builds are opt-in, source/input scoped, pinned and loaded only from the trusted checkout; execution uses a content ID', async () => {
  const workflow = record(parse(await readFile('.github/workflows/review.yml', 'utf8'))), jobs = record(workflow.jobs);
  assert.equal(record(record(record(record(workflow.on).workflow_call).inputs).docker_cache).default, false);
  const steps = record(jobs.review).steps as Record<string, unknown>[];
  const build = steps.find(x => String(x.uses).startsWith('docker/build-push-action@'))!, options = record(build.with);
  assert.match(String(build.if), /inputs.docker_cache/); assert.equal(options.context, '.'); assert.equal(options.load, true); assert.equal(options.push, false);
  for (const key of ['cache-from', 'cache-to']) {
    assert.match(String(options[key]), /needs.source.outputs.ref/); assert.match(String(options[key]), /hashFiles\('Dockerfile', 'package.json', 'package-lock.json', '.dockerignore'\)/);
    assert.ok(!String(options[key]).includes('pull_request')); assert.ok(!String(options[key]).includes('inputs.request_id'));
  }
  assert.equal(options.secrets, undefined); assert.equal(options['build-args'], undefined); assert.equal(build['continue-on-error'], undefined);
  const builder = steps.find(x => String(x.uses).startsWith('docker/setup-buildx-action@'))!;
  assert.match(String(record(builder.with)['driver-opts']), /^image=moby\/buildkit@sha256:[a-f0-9]{64}$/);
  const execute = steps.find(x => String(x.run).includes('main.js review'))!;
  assert.equal(record(execute.env).CODEXBOT_IMAGE, '${{ steps.image.outputs.id }}');
  assert.equal(execute['continue-on-error'], undefined); assert.equal(record(jobs.review)['continue-on-error'], undefined);
  assert.equal(execute.run, 'node dist/src/runner/main.js review');
  const publish = record(jobs.publish); assert.match(String(publish.if), /needs.review.result == 'failure'/);
  const publishSteps = publish.steps as Record<string, unknown>[];
  assert.equal(record(publishSteps.find(x => String(x.run).includes('main.js publish'))!.env).CODEXBOT_REVIEW_JOB_SUCCEEDED, "${{ needs.review.result == 'success' }}");
  assert.match(String(publish.if), /!inputs.credential_check_only/);
});
await test('documentation local links resolve and Apache license is canonical', async () => {
  const documents = ['README.md', 'CHANGELOG.md', 'docs/architecture.md', 'docs/authentication.md', 'docs/configuration.md', 'docs/deployment.md', 'docs/development.md', 'docs/installation.md', 'docs/security.md', 'docs/validation.md', 'docs/review-rollout.md', 'docs/origin-migration.md', 'docs/operations.md', 'docs/acceptance.md', 'docs/remediation.md', 'SECURITY.md', 'CONTRIBUTING.md'];
  for (const path of documents) {
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!; if (target.includes('://') || target.startsWith('#')) continue;
      await readFile(new URL(target.split('#')[0]!, new URL(`../${path}`, import.meta.url)), 'utf8');
    }
  }
  assert.ok((await readFile('LICENSE', 'utf8')).includes('Version 2.0, January 2004'));
});
