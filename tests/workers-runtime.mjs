import process from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';

const root = resolve('.local'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'workers-runtime-')), config = join(directory, 'wrangler.json');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js'), state = join(directory, 'state');
const secret = randomBytes(32).toString('hex');
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const address = socket.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
await new Promise(resolve => socket.close(resolve));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const cli = args => execFileSync(process.execPath, [wrangler, ...args, '--config', config], { encoding: 'utf8', env, stdio: 'pipe', timeout: 60_000 });
let child;
try {
  await writeFile(config, JSON.stringify({ name: 'codexbot-runtime-test', main: resolve('tests/admission-runtime-worker.ts'), compatibility_date: '2026-11-13', compatibility_flags: ['nodejs_compat'],
    vars: { PUBLIC_URL: `http://127.0.0.1:${port}`, GITHUB_WEBHOOK_SECRET: secret, GITHUB_PRIVATE_KEY: 'not-used', GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'codexbot', TRUSTED_WORKFLOW: '', CHATGPT_DEPLOYMENT_AUTHORIZED: 'false', MERGE_DEPLOYMENT_AUTHORIZED: 'false' },
    d1_databases: [{ binding: 'DB', database_name: 'codexbot-runtime-test', database_id: randomUUID(), migrations_dir: resolve('migrations') }] }));
  await writeFile(join(directory, 'empty.env'), '');
  cli(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
  child = spawn(process.execPath, [wrangler, 'dev', '--config', config, '--port', String(port), '--local', '--persist-to', state, '--test-scheduled', '--env-file', join(directory, 'empty.env')], { env, stdio: 'ignore', windowsHide: true });
  const origin = `http://127.0.0.1:${port}`; let ready = false;
  for (let n = 0; n < 150; n++) {
    try { if ((await globalThis.fetch(`${origin}/health`)).ok) { ready = true; break; } } catch { /* Wait only for this owned local test service. */ }
    await setTimeout(200);
  }
  assert.ok(ready, 'Local workerd did not start');
  const body = '{}', delivery = randomUUID();
  const post = signature => globalThis.fetch(`${origin}/webhook`, { method: 'POST', body, headers: { 'x-github-event': 'ping', 'x-github-delivery': delivery, 'x-hub-signature-256': signature } });
  const page = await globalThis.fetch(`${origin}/`); assert.equal(page.status, 200); assert.ok((await page.text()).includes('CLI setup instructions'));
  const foreign = await globalThis.fetch(`${origin}/v1/session`, { headers: { Origin: 'https://retired.invalid' } });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('location'), null);
  assert.equal((await globalThis.fetch(`${origin}/v1/session`)).status, 401);
  assert.equal((await post('sha256=' + '0'.repeat(64))).status, 401);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal((await post(signature)).status, 200); assert.equal((await post(signature)).status, 200);
  const stored = cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', 'SELECT phase,payload FROM deliveries']);
  const rows = JSON.parse(stored); assert.deepEqual(rows[0].results, [{ phase: 'done', payload: null }]);
  const request = randomUUID(), now = Date.now();
  cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command',
    `INSERT INTO requests(id,installation_id,repository_id,actor_id,snapshot,state,created_at,progress_phase) VALUES('${request}',1,2,5,'{}','running',${now - 7_200_000},'disabled');
     INSERT INTO sessions(installation_id,repository_id,actor_id,envelope,lease_request,lease_until) VALUES(1,2,5,'{}','${request}',${now + 3_600_000}),(9,2,5,'{}','other-installation',${now + 3_600_000});`]);
  assert.equal((await globalThis.fetch(`${origin}/cdn-cgi/handler/scheduled`)).status, 200);
  const terminal = JSON.parse(cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', `SELECT state,failure_code FROM requests WHERE id='${request}'`]))[0].results;
  assert.deepEqual(terminal, [{ state: 'failed', failure_code: 'request_expired' }]);
  const leases = JSON.parse(cli(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', 'SELECT installation_id,lease_request FROM sessions ORDER BY installation_id']))[0].results;
  assert.deepEqual(leases, [{ installation_id: 1, lease_request: null }, { installation_id: 9, lease_request: 'other-installation' }]);
  const admission=await (await globalThis.fetch(`${origin}/__admission-contract`)).json();
  assert.deepEqual(admission,{accepted:1,rejected:true,outcomes:[{outcome:'duplicate_review',phase:'pending'}]});
  const automatic=await(await globalThis.fetch(`${origin}/__automatic-contract`)).json();assert.deepEqual(automatic,{rotateDenied:true,publishDenied:true,otherInstallation:null});
  process.stdout.write('Real workerd + D1: owner-consent generation fencing,  atomic admission/outbox, migrations, HMAC, receipts, cron, expired requests and cross-installation lease cleanup passed.\n');
} finally {
  if (child?.pid) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
  assert.ok(relative(root, directory).startsWith('workers-runtime-')); await rm(directory, { recursive: true, force: true });
}
