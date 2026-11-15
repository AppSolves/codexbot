import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { AppError } from '../src/core/errors.js';
import { diagnostic } from '../src/core/diagnostics.js';
import { ExecutionDiagnostics, ExecutionError, executionEnvelope, executionFailure } from '../src/core/execution.js';
import { docker } from '../src/runner/docker.js';
import { runCodex } from '../src/runner/engine.js';
import { Rpc } from '../src/runner/rpc.js';
import { reviewJob, waitForRefresh } from '../src/runner/main.js';
import { snapshot, clean } from './fixtures.js';

const sensitive = 'Bearer fixture-private-credential OAuth-code private-source prompt-provider-message';
function child(onWrite: (value: string) => void = () => {}) {
  const result = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) { onWrite(String(chunk)); done(); } }),
    kill() { result.stdout.end(); result.stderr.end(); result.emit('exit', null, 'SIGKILL'); result.emit('close', null, 'SIGKILL'); return true; }
  });
  return result;
}
await test('execution projection discards arbitrary fields/text and never labels local AppError 400 as upstream HTTP', () => {
  const safe = { component: 'provider', code: 'provider_http_failed', upstream_status: 401 };
  const parser = new ExecutionDiagnostics();
  const text = sensitive + '\n' + JSON.stringify({ event: 'codexbot_execution_failure', ...safe, message: sensitive, provider_code: sensitive, provider_param: sensitive }) + '\n';
  for (const letter of text) parser.write(letter);
  assert.deepEqual(parser.last, safe);
  parser.write('x'.repeat(3000) + executionEnvelope({ component: 'turn', code: 'codex_turn_failed' }) + '\n');
  assert.deepEqual(parser.last, safe); // An oversized raw line cannot inject a partial envelope.
  assert.equal(executionFailure({ component: sensitive, code: 'codex_turn_failed' }), null);
  assert.equal(executionFailure({ component: ['turn'], code: 'codex_turn_failed' }), null);
  assert.deepEqual(executionFailure({ component: 'provider', code: 'provider_http_failed', provider_code: ['invalid_api_key'], provider_param: ['model'], upstream_status: '401' }), { component: 'provider', code: 'provider_http_failed' });
  assert.deepEqual(executionFailure({ component: 'docker', code: 'container_exit_failed', exit_code: -1, signal: sensitive, upstream_status: 400.1 }), { component: 'docker', code: 'container_exit_failed' });
  assert.equal(diagnostic(new AppError('isolated_review_failed'), 'analyzing').status, undefined);
  assert.equal(diagnostic(new AppError('github_oidc_request_failed', 503), 'prepare').status, 503);
  const error = new ExecutionError({ component: 'turn', code: 'codex_turn_failed' }); error.proxyFailure = safe;
  assert.deepEqual(diagnostic(error, 'analyzing'), { event: 'review_failed', stage: 'analyzing', code: 'isolated_review_failed', execution: error.detail, proxy_failure: safe });
  assert.ok(!JSON.stringify(parser.last).includes(sensitive));
});
await test('provider response metadata is exact, bounded and survives the envelope and outer diagnostic unchanged', () => {
  for (const category of ['event-stream','json','html','missing','other']) for (const present of [true, false]) {
    const detail = { component: 'provider', code: 'provider_stream_content_type_invalid', upstream_status: 200, content_type_category: category, body_present: present };
    const parser = new ExecutionDiagnostics(); parser.write(executionEnvelope({ ...detail }) + '\n');
    assert.deepEqual(parser.last, detail);
    const error = new ExecutionError({ component: 'turn', code: 'codex_turn_failed' }); error.proxyFailure = detail;
    assert.deepEqual(diagnostic(error, 'analyzing').proxy_failure, detail);
  }
  assert.deepEqual(executionFailure({ component: 'provider', code: 'provider_stream_content_type_invalid', upstream_status: 600,
    content_type_category: sensitive, body_present: 'true', headers: sensitive, body: sensitive }), { component: 'provider', code: 'provider_stream_content_type_invalid' });
  assert.deepEqual(executionFailure({ component: 'provider', code: 'provider_stream_content_type_invalid', upstream_status: 199,
    content_type_category: ['json'], body_present: 1 }), { component: 'provider', code: 'provider_stream_content_type_invalid' });
  assert.deepEqual(executionFailure({ component: 'turn', code: 'codex_turn_failed', upstream_status: 200, content_type_category: 'json', body_present: true }), { component: 'turn', code: 'codex_turn_failed' });
});
await test('Docker diagnostics distinguish startup, exit, output bounds, and sanitized engine failure after stderr drains', async () => {
  for (const [exit, code] of [[125, 'container_start_failed'], [126, 'container_start_failed'], [127, 'container_start_failed'], [137, 'container_exit_failed'], [0, 'container_output_limit'], [1, 'codex_turn_failed'], [2, 'container_exit_failed']] as const) {
    const spawn = mock.method(childProcess, 'spawn', () => {
      const process = child();
      queueMicrotask(() => {
        process.stderr.write(sensitive + '\n');
        process.emit('exit', exit, null);
        if (exit === 1) process.stderr.write(JSON.stringify({ event: 'codexbot_execution_failure', component: 'turn', code, upstream_status: 200, provider_code: 'invalid_api_key', content_type_category: 'json', body_present: true }) + '\n');
        if (exit === 2) process.stderr.write(executionEnvelope({ component: 'provider', code: 'provider_http_failed', upstream_status: 401 }) + '\n');
        if (exit === 0) process.stdout.write('x'.repeat(101));
        process.stdout.end(); process.stderr.end(); process.emit('close', exit, null);
      });
      return process;
    }); syncBuiltinESMExports();
    try { await assert.rejects(docker(['run'], 100), error => { assert.ok(error instanceof ExecutionError); assert.equal(error.detail.code, code); assert.equal(error.detail.upstream_status, undefined); assert.equal(error.detail.provider_code, undefined); assert.equal(error.detail.content_type_category, undefined); assert.equal(error.detail.body_present, undefined); assert.ok(!JSON.stringify(diagnostic(error, 'analyzing')).includes(sensitive)); return true; }); }
    finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  }
});
await test('RPC rejects safe method/code and process exit metadata without stderr, message or error data', async () => {
  const process = child(), rpc = new Rpc(process as unknown as childProcess.ChildProcessWithoutNullStreams);
  const pending = rpc.request('turn/start', {});
  process.stderr.write(sensitive);
  process.stdout.write(JSON.stringify({ id: 1, error: { code: -32602, message: sensitive, data: sensitive } }) + '\n');
  await assert.rejects(pending, error => { assert.ok(error instanceof ExecutionError); assert.deepEqual(error.detail, { component: 'codex_rpc', code: 'codex_rpc_rejected', rpc_method: 'turn/start', rpc_code: -32602 }); return true; });
  const next = rpc.request('model/list', {}); process.emit('close', 7, null);
  await assert.rejects(next, error => { assert.ok(error instanceof ExecutionError); assert.deepEqual(error.detail, { component: 'codex_process', code: 'codex_process_exited', exit_code: 7 }); return true; });
  await assert.rejects(rpc.request('initialize', {}), ExecutionError);
  const draining = child(), finalRpc = new Rpc(draining as unknown as childProcess.ChildProcessWithoutNullStreams);
  const final = finalRpc.request('initialize', {}); draining.emit('exit', 0, null);
  draining.stdout.write(JSON.stringify({ id: 1, result: { accepted: true } }) + '\n'); draining.emit('close', 0, null);
  assert.deepEqual(await final, { accepted: true });
});
await test('RPC rejects every server-side approval/tool/permission request and marks the turn incomplete without exposing params', () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/call', 'unknown/clientTool']) {
    const sent: Record<string, unknown>[] = [], process = child(value => sent.push(JSON.parse(value) as Record<string, unknown>));
    const rpc = new Rpc(process as unknown as childProcess.ChildProcessWithoutNullStreams);
    const notifications: unknown[] = []; rpc.onNotification((method, params) => notifications.push({ method, params }));
    process.stdout.write(JSON.stringify({ id: 7, method, params: { token: sensitive, command: sensitive } }) + '\n');
    assert.equal((sent[0]!.error as { code: number }).code, -32601); assert.equal(sent[0]!.result, undefined);
    assert.deepEqual(notifications, [{ method: 'codexbot/client-request-denied', params: null }]);
    assert.ok(!JSON.stringify({ sent, notifications }).includes(sensitive));
  }
});
await test('Codex model selection, RPC rejection and failed/interrupted turns keep distinct sanitized causes', async () => {
  for (const scenario of ['model', 'rpc', 'failed', 'interrupted', 'invalid-json', 'no-inspection', 'declined']) {
    const request = snapshot(); if (scenario === 'model') request.config.review.model = 'not-in-fixture';
    const spawn = mock.method(childProcess, 'spawn', () => {
      const process = child(line => {
        const message = JSON.parse(line) as { id?: number; method: string; params?: { approvalPolicy?: string } };
        if (!message.id) return;
        if (message.method === 'thread/start') assert.equal(message.params?.approvalPolicy, 'never');
        const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
        queueMicrotask(() => {
          if (message.method === 'turn/start' && scenario === 'rpc') { send({ id: message.id, error: { code: -32602, message: sensitive } }); return; }
          send({ id: message.id, result: message.method === 'model/list' ? { data: [{ model: 'fixture', isDefault: true }], nextCursor: null } : message.method === 'thread/start' ? { thread: { id: 'fixture' } } : {} });
          if (message.method === 'turn/start') {
            if (scenario !== 'no-inspection') send({ method: 'item/completed', params: { item: { type: 'commandExecution', status: scenario === 'declined' ? 'declined' : 'completed', exitCode: scenario === 'declined' ? null : 0 } } });
            send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: sensitive } } });
            send({ method: 'turn/completed', params: { turn: { status: ['invalid-json','no-inspection','declined'].includes(scenario) ? 'completed' : scenario, error: { message: sensitive } } } });
          }
        });
      }); return process;
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(runCodex(request, '{}'), error => {
        assert.ok(error instanceof ExecutionError);
        assert.equal(error.detail.code, ({ model: 'configured_model_not_in_codex_catalog', rpc: 'codex_rpc_rejected', failed: 'codex_turn_failed', interrupted: 'codex_turn_interrupted', 'invalid-json': 'codex_output_not_json', 'no-inspection': 'codex_inspection_not_performed', declined: 'codex_inspection_denied' } as Record<string, string>)[scenario]);
        assert.ok(!JSON.stringify(diagnostic(error, 'analyzing')).includes(sensitive)); return true;
      });
    } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  }
});
await test('actual review job records incomplete fallback, releases acquired lease, and STILL rejects analysis failure', async () => {
  const saved = { ...process.env }, request = snapshot(); request.config.credentials.mode = 'api-key';
  const submissions: Record<string, unknown>[] = [], operations: string[] = [], logs: unknown[][] = [];
  let rejectReporting = false, rejectReadTokenCleanup = false;
  let containerOutput: unknown = null, unavailableContext = false, runs = 0;
  Object.assign(process.env, { CODEXBOT_BACKEND: 'https://broker.invalid', CODEXBOT_REQUEST_ID: request.id, CODEXBOT_API_KEY: sensitive,
    CODEXBOT_CREDENTIAL_OWNER: '5', CODEXBOT_INSTALLATION_ID: '1', CODEXBOT_IMAGE: 'sha256:fixture', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: sensitive });
  delete process.env.CODEXBOT_VAULT_KEY;
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid'), gid = Object.getOwnPropertyDescriptor(process, 'getgid');
  Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true }); Object.defineProperty(process, 'getgid', { value: () => 1000, configurable: true });
  const spawn = mock.method(childProcess, 'spawn', (_file: string, args: string[]) => {
    const process = child();
    queueMicrotask(() => {
      if (args[0] === 'logs' && args.includes('--follow')) { process.stdout.write('codexbot-proxy-ready\n'); return; }
      if (args[0] === 'run') {
        runs++;
        if (containerOutput !== null) process.stdout.write(JSON.stringify(containerOutput));
        else process.stderr.write(executionEnvelope({ component: 'turn', code: 'codex_turn_failed' }) + '\n');
      }
      if (args[0] === 'logs') process.stderr.write(executionEnvelope({ component: 'provider', code: 'provider_http_failed', upstream_status: 401 }) + '\n');
      process.stdout.end(); process.stderr.end(); process.emit('close', args[0] === 'run' && containerOutput === null ? 1 : 0, null);
    }); return process;
  }); syncBuiltinESMExports();
  const fetcher = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.hostname === 'oidc.invalid') return Response.json({ value: sensitive });
    if (url.hostname === 'broker.invalid') {
      const operation = url.pathname.split('/').at(-1)!; operations.push(operation);
      if (operation === 'prepare') return Response.json({ snapshot: request, read_token: sensitive });
      if (operation === 'result' && rejectReporting) return Response.json({ error: 'internal_error', message: sensitive }, { status: 503 });
      if (operation === 'result') submissions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ status: 'recorded' });
    }
    if (url.pathname.endsWith('/installation/token')) return rejectReadTokenCleanup ? Response.json({ message: sensitive }, { status: 503 }) : new Response(null, { status: 204 });
    if (url.pathname.endsWith('/pulls/4')) return Response.json({ head: { sha: request.head }, base: { sha: request.base }, changed_files: 0 });
    if (url.pathname.endsWith('/pulls/4/files')) return Response.json([]);
    if (url.pathname.includes('/git/commits/')) return Response.json({ sha: url.pathname.split('/').at(-1), tree: { sha: 'e'.repeat(40) } });
    if (url.pathname.includes('/git/trees/')) return Response.json({ sha: 'e'.repeat(40), truncated: unavailableContext, tree: [] });
    throw new Error('Unexpected fixture route');
  });
  const logger = mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  try {
    await assert.rejects(reviewJob(), error => { assert.ok(error instanceof ExecutionError); assert.equal(error.detail.code, 'codex_turn_failed'); assert.equal(error.proxyFailure?.upstream_status, 401); return true; });
    assert.equal(submissions.length, 1); assert.equal(submissions[0]!.context_complete, false);
    const output = submissions[0]!.output as Record<string, unknown>; assert.equal(output.complete, false); assert.equal(output.result, 'inconclusive');
    assert.equal((submissions[0]!.failure as Record<string, unknown>).code, 'isolated_review_failed');
    assert.equal((submissions[0]!.failure as Record<string, unknown>).stage, 'analyzing');
    assert.equal(operations.at(-1), 'release'); assert.ok(!JSON.stringify(logs).includes(sensitive));
    rejectReporting = true;
    await assert.rejects(reviewJob(), error => { assert.ok(error instanceof ExecutionError); assert.equal(error.detail.code, 'codex_turn_failed'); return true; });
    assert.equal(operations.at(-1), 'release'); assert.ok(JSON.stringify(logs).includes('failure_reporting_deferred'));
    assert.ok(!JSON.stringify(logs).includes(sensitive));
    rejectReporting = false; containerOutput = clean();
    await reviewJob(); assert.equal(submissions.at(-1)!.context_complete, true);
    assert.equal(submissions.at(-1)!.failure, undefined);
    rejectReadTokenCleanup = true;
    await assert.rejects(reviewJob(), /read_token_cleanup_failed/); assert.equal(operations.at(-1), 'release');
    rejectReadTokenCleanup = false;
    containerOutput = { ...clean(), complete: false, result: 'inconclusive', summary: 'Inspection was insufficient to complete a review; no approval is authorized.' };
    await assert.rejects(reviewJob(), /review_incomplete/);
    assert.equal(submissions.at(-1)!.context_complete, false);
    assert.equal((submissions.at(-1)!.output as { result: string }).result, 'inconclusive');
    assert.equal((submissions.at(-1)!.failure as { code: string }).code, 'review_incomplete');
    containerOutput = { ...clean(), complete: false }; // A clean label cannot override incomplete analysis.
    await assert.rejects(reviewJob(), /review_output_invalid/);
    assert.equal((submissions.at(-1)!.output as { result: string }).result, 'inconclusive');
    const previousRuns = runs; unavailableContext = true; containerOutput = clean();
    await assert.rejects(reviewJob(), /review_context_incomplete/);
    assert.equal(runs, previousRuns); assert.equal(submissions.at(-1)!.context_complete, false);
    assert.equal((submissions.at(-1)!.failure as { code: string }).code, 'review_context_incomplete');
    assert.equal(operations.at(-1), 'release');
  } finally {
    fetcher.mock.restore(); logger.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports();
    if (uid) Object.defineProperty(process, 'getuid', uid); else Reflect.deleteProperty(process, 'getuid');
    if (gid) Object.defineProperty(process, 'getgid', gid); else Reflect.deleteProperty(process, 'getgid');
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
});

await test('runner waits for the provider refresh window without consuming a token early and bounds future waits',async t=>{
  const now=1700000000000;t.mock.timers.enable({apis:['Date','setTimeout'],now});
  try{
    let allowed=false;const waiting=waitForRefresh(now+5*60000).then(()=>{allowed=true;});
    t.mock.timers.tick(5*60000-1);await Promise.resolve();assert.equal(allowed,false);
    t.mock.timers.tick(1);await waiting;assert.equal(allowed,true);assert.equal(Date.now(),now+5*60000);
    await waitForRefresh(now-1);
    for(const earliest of [NaN,Infinity,-1,Date.now()+25*60000+1])await assert.rejects(waitForRefresh(earliest),{code:'oauth_refresh_window_unavailable'});
  }finally{t.mock.timers.reset();}
});
