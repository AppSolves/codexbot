import { chromium } from '@playwright/test';
import { exportPKCS8, generateKeyPair } from 'jose';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import process from 'node:process';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
/* global document, innerWidth, localStorage, sessionStorage, getComputedStyle */
const root = resolve('.local'); await mkdir(root,{recursive:true});
const directory = await mkdtemp(join(root,'web-browser-')), config = join(directory,'wrangler.json'), state = join(directory,'state'), wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const socket = createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening'); const address = socket.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
await new Promise(resolve=>socket.close(resolve));
const origin = `https://localhost:${port}`, env = {...process.env,WRANGLER_SEND_METRICS:'false'};
const cli = args => execFileSync(process.execPath,[wrangler,...args,'--config',config],{encoding:'utf8',env,stdio:'pipe',timeout:60_000});
let child, browser, page;
try {
  const key = await exportPKCS8((await generateKeyPair('RS256',{extractable:true})).privateKey);
  await writeFile(config,JSON.stringify({name:'codexbot-web-browser-test',main:resolve('tests/web-runtime-worker.ts'),compatibility_date:'2026-11-13',compatibility_flags:['nodejs_compat'],
    vars:{PUBLIC_URL:origin,GITHUB_APP_ID:'42',GITHUB_APP_SLUG:'codexbot',GITHUB_PRIVATE_KEY:key,GITHUB_WEBHOOK_SECRET:randomBytes(32).toString('hex'),TRUSTED_WORKFLOW:`owner/source/.github/workflows/review.yml@${'a'.repeat(40)}`,
      WEB_ENABLED:'true',WEB_SESSION_KEY:randomBytes(32).toString('base64url'),GITHUB_CLIENT_ID:'Iv1.fixture',GITHUB_CLIENT_SECRET:'fixture-github-client-secret',
      OPENAI_WEB_CLIENT_ID:'oaiapp_fixture',OPENAI_WEB_AUTH_METHOD:'none',OPENAI_WEB_WORKSPACE_CLAIM:'approved_workspace',OPENAI_WEB_SCOPES:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      OPENAI_HOSTED_INFERENCE_AUTHORIZED:'true',CHATGPT_DEPLOYMENT_AUTHORIZED:'true',MERGE_DEPLOYMENT_AUTHORIZED:'false'},
    d1_databases:[{binding:'DB',database_name:'codexbot-web-browser-test',database_id:randomUUID(),migrations_dir:resolve('migrations')}]}));
  await writeFile(join(directory,'empty.env'),''); cli(['d1','migrations','apply','DB','--local','--persist-to',state]);
  child = spawn(process.execPath,[wrangler,'dev','--config',config,'--port',String(port),'--local','--local-protocol','https','--persist-to',state,'--env-file',join(directory,'empty.env')],{env,stdio:'ignore',windowsHide:true});
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:1440,height:1000}}); page = await context.newPage();
  // Self-signed TLS is accepted only by this local synthetic browser context, never by application clients.
  let ready = false; const deadline=Date.now()+30_000;
  for (let n=0;n<150 && Date.now()<deadline && child.exitCode===null;n++) { try { if ((await context.request.get(origin+'/health',{timeout:1000})).ok()) { ready=true;break; } } catch { /* Owned local workerd startup. */ } await setTimeout(200); }
  assert.ok(ready,'Local web workerd unavailable');
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin); await page.getByRole('heading',{name:/The diff is small/}).waitFor();
  await page.keyboard.press('Tab'); assert.equal(await page.locator(':focus').textContent(),'Skip to content');
  const background = await page.locator('body').evaluate(node=>getComputedStyle(node).backgroundColor);
  await page.getByRole('button',{name:'Switch color theme'}).click(); assert.notEqual(await page.locator('body').evaluate(node=>getComputedStyle(node).backgroundColor),background);
  await page.screenshot({path:join(root,'web-preview-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(root,'web-preview-mobile.png'),fullPage:true}); await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('link',{name:'Get started with GitHub'}).click(); await page.getByRole('heading',{name:'Your installations.'}).waitFor();
  await page.getByRole('link',{name:'alice',exact:true}).click(); await page.getByRole('link',{name:'owner/repo',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Setup required'}).waitFor();
  await page.getByRole('button',{name:'Create setup PR'}).click(); await page.getByRole('heading',{name:'Changes proposed.'}).waitFor();
  const repository = `${origin}/dashboard/repository?installation=1&repository=2`;
  await page.goto(repository); await page.getByRole('button',{name:'Create setup PR'}).click(); await page.getByRole('heading',{name:'Changes proposed.'}).waitFor();
  assert.equal((await (await context.request.get(origin+'/__fixture/state')).json()).pulls,1);
  await context.request.post(origin+'/__fixture/fail-secret');
  await page.goto(repository); await page.getByRole('button',{name:'Continue with ChatGPT'}).click(); await page.getByRole('heading',{name:'Connection needs attention.'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/auth/error'); assert.equal(new URL(page.url()).search,'');
  await page.goto(repository); assert.ok((await page.locator('body').textContent()).includes('Connection: pending'));
  await page.getByRole('button',{name:'Resume pending connection'}).click(); await page.getByRole('status').waitFor();
  assert.ok((await page.locator('body').textContent()).includes('Connection: ready'));
  await context.request.post(origin+'/__fixture/merge'); await page.goto(repository); await page.getByRole('status').filter({hasText:'Ready for reviews'}).waitFor();
  await page.getByText('Review policy & configuration',{exact:true}).click();
  await page.locator('[name="review.model"]').selectOption('gpt-5.5'); await page.locator('[name="review.effort"]').selectOption('ultra');
  await page.getByRole('button',{name:'Propose configuration / workflow update'}).click(); await page.getByRole('alert').filter({hasText:'does not support the selected reasoning effort'}).waitFor();
  assert.equal((await (await context.request.get(origin+'/__fixture/state')).json()).pulls,1);
  await page.goto(repository); await page.getByText('Review policy & configuration',{exact:true}).click();
  await page.locator('[name="review.model"]').selectOption('gpt-6.1-sol'); await page.locator('[name="review.effort"]').selectOption('high'); await page.locator('[name="review.auto_approve"]').uncheck();
  await page.getByRole('button',{name:'Propose configuration / workflow update'}).click(); await page.getByRole('heading',{name:'Changes proposed.'}).waitFor();
  assert.equal((await (await context.request.get(origin+'/__fixture/state')).json()).pulls,2);
  await page.goto(repository); await page.getByText('Review policy & configuration',{exact:true}).click();
  assert.equal(await page.locator('[name="review.auto_approve"]').isChecked(),true,'Policy cannot change before PR merge');
  const csrfRejected = await context.request.post(origin+'/dashboard/setup',{headers:{origin:'https://evil.invalid'},form:{installation:'1',repository:'2',csrf:'forged'}}); assert.equal(csrfRejected.status(),403);
  const foreign = await page.goto(`${origin}/dashboard/repository?installation=9&repository=2`); assert.equal(foreign.status(),403);
  await page.goto(repository); await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true); await page.setViewportSize({width:1440,height:1000});
  const text = await page.content(); assert.ok(!text.includes('fixture-access')&&!text.includes('fixture-github-browser-token')&&!text.includes('fixture-refresh'));
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await context.request.post(origin+'/__fixture/revoke'); const revoked = await page.goto(repository); assert.equal(revoked.status(),403); await page.getByRole('alert').filter({hasText:'administrator access is required'}).waitFor();
  await page.goto(origin+'/dashboard/account'); await page.getByRole('button',{name:'Sign out'}).click();
  const expired = await page.goto(origin+'/dashboard'); assert.equal(expired.status(),401);
  await context.close();
  process.stdout.write('Browser + real workerd/D1: responsive/keyboard/theme, GitHub PKCE, idempotent setup PR, hosted OAuth + encrypted Environment provisioning, readiness, policy PR, CSRF, tenant denial, permission revocation and logout passed. Providers were synthetic; no real credentials or inference.\n');
} catch (error) {
  const path = page ? new URL(page.url()).pathname : 'unavailable';
  const alert = page ? await page.getByRole('alert').textContent({timeout:1000}).catch(()=>null) : null;
  process.stderr.write(JSON.stringify({event:'browser_fixture_failed',path,code:alert && /^[a-z_]{1,100}$/.test(alert) ? alert : null})+'\n');
  await page?.screenshot({path:join(root,'web-browser-failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode===null) {
    if (process.platform==='win32') execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
    else { child.kill('SIGTERM'); await once(child,'exit'); }
  }
  assert.ok(relative(root,directory).startsWith('web-browser-')); await rm(directory,{recursive:true,force:true});
}
