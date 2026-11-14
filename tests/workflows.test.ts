import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { record } from '../src/core/errors.js';
await test('reusable workflow has no GitHub write permissions, shared secrets or PR-head checkout', async () => {
  const text = await readFile('.github/workflows/review.yml', 'utf8'), workflow = record(parse(text));
  assert.deepEqual(workflow.permissions, {});
  const jobs = record(workflow.jobs);
  for (const [name, value] of Object.entries(jobs)) {
    const job = record(value), permissions = record(job.permissions);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
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
await test('documentation local links resolve and Apache license is canonical', async () => {
  const documents = ['README.md', 'CHANGELOG.md', 'docs/architecture.md', 'docs/authentication.md', 'docs/configuration.md', 'docs/deployment.md', 'docs/development.md', 'docs/installation.md', 'docs/security.md', 'docs/validation.md', 'docs/operations.md', 'docs/acceptance.md', 'docs/remediation.md', 'SECURITY.md', 'CONTRIBUTING.md'];
  for (const path of documents) {
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!; if (target.includes('://') || target.startsWith('#')) continue;
      await readFile(new URL(target.split('#')[0]!, new URL(`../${path}`, import.meta.url)), 'utf8');
    }
  }
  assert.ok((await readFile('LICENSE', 'utf8')).includes('Version 2.0, January 2004'));
});
