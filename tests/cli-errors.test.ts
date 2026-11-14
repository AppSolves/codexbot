import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { formatCliError } from '../src/cli-errors.js';
import { AppError } from '../src/core/errors.js';
import { client } from '../src/worker/github.js';

const secrets = ['ghp_' + 'a'.repeat(36), 'github_pat_' + 'b'.repeat(60), 'sk-proj-' + 'c'.repeat(60), 'opaque-oauth-code', 'opaque-refresh-token'];
const sensitive = secrets.join(' ') + ' Authorization: Bearer password-value\n-----BEGIN PRIVATE KEY-----\u001b[31m';
function noSecrets(text: string): void {
  for (const secret of [...secrets, 'password-value', 'PRIVATE KEY', 'sensitive-response-field']) assert.equal(text.includes(secret), false);
  assert.equal(text.includes('\u001b'), false);
}
async function githubFailure(status: number, data: unknown): Promise<unknown> {
  const request = client(secrets[0]!).request.defaults({ request: { fetch: async () => Response.json(data, { status, headers: { 'x-github-request-id': secrets[3]! } }) } });
  try { await request('PUT /repos/{owner}/{repo}/environments/{environment_name}', { owner: secrets[3]!, repo: secrets[4]!, environment_name: secrets[2]! }); }
  catch (error) { return error; }
  assert.fail('Expected Octokit to reject the fixture response');
}
await test('actual Octokit errors expose operation, HTTP status and documented codes without body/header/path secrets', async () => {
  const error = await githubFailure(422, { message: sensitive, documentation_url: `https://example.invalid/?code=${secrets[3]}`, code: secrets[0],
    errors: [{ code: 'already_exists', field: sensitive, message: sensitive }, { code: 'invalid' }, { code: secrets[4] }, sensitive], 'sensitive-response-field': sensitive });
  const result = formatCliError(error, 'configuring the protected credential Environment');
  assert.match(result, /configuring the protected credential Environment/);
  assert.match(result, /HTTP 422; GitHub PUT \/repos\/\{value\}\/\{value\}\/environments\/\{value\}/);
  assert.match(result, /GitHub code: already_exists, invalid/);
  assert.match(result, /check the operation parameters/i); noSecrets(result);
  for (const status of [401, 403, 404, 409, 429, 503]) {
    const text = formatCliError(await githubFailure(status, { message: sensitive }), 'reading repository metadata');
    assert.ok(text.includes(`HTTP ${status}`)); noSecrets(text);
  }
  assert.match(formatCliError(await githubFailure(403, { message: 'Resource not accessible by integration' }), 'reading an Environment'), /Resource not accessible by integration/);
});
await test('Node errors and nested network causes report safe codes and useful next steps', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOSPC', 'EIO', 'ERR_PARSE_ARGS_UNKNOWN_OPTION']) {
    const error = Object.assign(new Error(sensitive), { code, path: sensitive, syscall: sensitive, stdout: sensitive, stderr: sensitive });
    const result = formatCliError(error, 'reading GitHub CLI authentication');
    assert.ok(result.includes(code)); noSecrets(result);
  }
  const network = new TypeError(sensitive, { cause: Object.assign(new Error(sensitive), { code: 'ENOTFOUND' }) });
  assert.match(formatCliError(network, 'checking backend repository capabilities'), /ENOTFOUND.*DNS lookup failed/);
  noSecrets(formatCliError(network, 'checking backend repository capabilities'));
  const timeout = formatCliError(new DOMException(sensitive, 'TimeoutError'), 'checking backend repository capabilities');
  assert.match(timeout, /TimeoutError.*timed out/); noSecrets(timeout);
});
await test('known AppError codes survive, while arbitrary messages, codes, malformed metadata and cyclic causes stay private', () => {
  assert.match(formatCliError(new AppError('repository_admin_required', 403), 'checking repository access'), /status 403; repository_admin_required/);
  assert.doesNotMatch(formatCliError(new AppError('github_cli_failed_check_auth_and_permissions'), 'reading authentication'), /HTTP/);
  assert.match(formatCliError(new AppError('oauth_state_mismatch'), 'validating the OAuth callback'), /oauth_state_mismatch/);
  for (const error of [new AppError(secrets[3]!), new Error(sensitive), sensitive, null, { code: secrets[4], status: sensitive, message: sensitive },
    { name: 'HttpError', status: NaN, request: { method: sensitive, url: sensitive }, response: { data: sensitive } }]) noSecrets(formatCliError(error, 'connecting'));
  const cycle: { cause?: unknown; code: string } = { code: sensitive }; cycle.cause = cycle;
  assert.ok(formatCliError(cycle, 'connecting').length < 400);
  const encoded = secrets.map(value => Buffer.from(value).toString('base64'));
  const url = `https://${secrets[3]}:${secrets[4]}@api.github.com/repos/${encoded[0]}/${encoded[1]}/environments/${secrets[2]}?code=${encoded[2]}#${encoded[3]}`;
  const result = formatCliError({ name: 'HttpError', status: 403, request: { method: 'PUT', url, headers: { authorization: sensitive }, body: sensitive }, response: { data: { message: sensitive } } }, 'connecting');
  noSecrets(result); for (const value of encoded) assert.equal(result.includes(value), false);
});

// Run the actual CLI in a separate process. All HTTP is intercepted and gh is
// replaced with an inert child; no local account, provider or repository is used.
const preload = `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const spawn = childProcess.spawn, scenario = process.env.CODEXBOT_TEST_SCENARIO;
childProcess.spawn = (file, args, options) => {
  if (file !== 'gh') return spawn(file, args, options);
  if (scenario === 'missing-gh') throw Object.assign(new Error(${JSON.stringify(sensitive)}), {code:'ENOENT'});
  if (args.join(' ') === 'auth token') return spawn(process.execPath, ['-e', 'process.stdout.write("fixture-github-token")'], options);
  if (scenario === 'api-key-success' && args[0] === 'secret' && args[1] === 'set') return spawn(process.execPath, ['-e', 'process.stdin.resume()'], options);
  throw new Error('Unexpected fixture gh operation');
};
syncBuiltinESMExports();
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
  if (url.origin === 'https://broker.invalid' && url.pathname === '/v1/capabilities') {
    if (scenario === 'backend-failure') return Response.json({error:${JSON.stringify(sensitive)}},{status:503});
    return Response.json({environmentSecrets:true,installation_id:123,chatgpt_deployment_authorized:true});
  }
  if (scenario === 'oauth-discovery-failure' && url.origin === 'https://auth.openai.com') throw new TypeError(${JSON.stringify(sensitive)}, {cause:Object.assign(new Error('fixture DNS failure'),{code:'ENOTFOUND'})});
  if (url.origin !== 'https://api.github.com') throw new Error('Fixture denied external network');
  if (url.pathname === '/user') return Response.json({id:5,login:'fixtureuser'});
  if (url.pathname === '/repos/owner/repo') return Response.json({id:2,default_branch:'main',permissions:{admin:true},private:true});
  if (url.pathname === '/repos/owner/repo/environments') return Response.json({environments:[],total_count:0});
  if (url.pathname === '/repos/owner/repo/branches/main') return Response.json({protected:true});
  if (url.pathname.startsWith('/repos/owner/repo/environments/')) {
    if (scenario === 'api-key-success' || scenario === 'oauth-discovery-failure') return Response.json({deployment_branch_policy:{protected_branches:true}});
    if (init.method === 'GET') return Response.json({message:'Not Found'},{status:404});
    return Response.json({message:${JSON.stringify(sensitive)},errors:[{code:'invalid',message:${JSON.stringify(sensitive)}}]},{status:422});
  }
  throw new Error('Unexpected fixture HTTP operation');
};`;
function runCli(scenario: string, command = 'connect') {
  const root = resolve('.local'); mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'cli-errors-'));
  const env = Object.assign(Object.create(null) as NodeJS.ProcessEnv, { CODEXBOT_TEST_SCENARIO: scenario, CODEXBOT_API_KEY: secrets[2]!, HOME: home, USERPROFILE: home });
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP']) if (process.env[name]) env[name] = process.env[name]!;
  try { return spawnSync(process.execPath, ['--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/cli.ts', command, '--repository', 'owner/repo', '--backend', 'https://broker.invalid'], { encoding: 'utf8', env, timeout: 20_000 }); }
  finally { assert.equal(dirname(home), root); rmSync(home, { recursive: true, force: true }); }
}
await test('actual connect reports Environment failure after successful capability preflight, with exit 1 and no secret output', () => {
  const result = runCli('environment-failure');
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
  assert.match(result.stderr, /configuring the protected credential Environment.*HTTP 422.*GitHub PUT.*GitHub code: invalid/);
  assert.doesNotMatch(result.stderr, /CodexBot setup failed; check prerequisites/); noSecrets(result.stderr);
});
await test('actual CLI preserves backend HTTP status, Node spawn diagnostics and successful API-key behavior', () => {
  const backend = runCli('backend-failure'); assert.equal(backend.status, 1, backend.stderr);
  assert.match(backend.stderr, /checking backend repository capabilities.*HTTP 503/); noSecrets(backend.stderr);
  const node = runCli('missing-gh'); assert.equal(node.status, 1, node.stderr);
  assert.match(node.stderr, /reading GitHub CLI authentication.*ENOENT/); noSecrets(node.stderr);
  const success = runCli('api-key-success', 'connect-api-key'); assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /API key saved in codexbot-123-5/); assert.equal(success.stderr, ''); noSecrets(success.stdout);
});
await test('OAuth discovery failure closes the callback listener and exits with a redacted diagnostic', () => {
  const result = runCli('oauth-discovery-failure');
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /discovering OpenAI OAuth configuration.*ENOTFOUND/);
  assert.equal(result.stdout, ''); noSecrets(result.stderr);
});
