import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite.js';
import { randomSecret, seal, unseal, sessionBinding } from '../src/core/crypto.js';
import { SCOPES, type OAuthSession } from '../src/auth/oauth.js';
import { Store } from '../src/worker/store.js';
import { renewHosted } from '../src/worker/web-connections.js';
import { withRepositoryOperation } from '../src/worker/web-repositories.js';
import type { WebConfig } from '../src/worker/web-auth.js';
import { snapshot } from './fixtures.js';
await test('hosted refresh is single-owner, tenant-bound, durably rotated and never blindly repeated after a lost response', async () => {
  for (const outcome of ['success','network','lease','persist-lease'] as const) {
    const uncertain = outcome !== 'success';
    const {db,sqlite} = database(), request = snapshot(), vault = randomSecret(), store = new Store(db);
    const env: WebConfig = {DB:db,PUBLIC_URL:'https://web.invalid',GITHUB_APP_ID:'42',GITHUB_APP_SLUG:'codexbot',GITHUB_PRIVATE_KEY:'unused',TRUSTED_WORKFLOW:'unused',
      CHATGPT_DEPLOYMENT_AUTHORIZED:'true',WEB_ENABLED:'true',WEB_SESSION_KEY:randomSecret(),OPENAI_HOSTED_INFERENCE_AUTHORIZED:'true',OPENAI_WEB_CLIENT_ID:'oaiapp_fixture',OPENAI_WEB_SCOPES:SCOPES.join(' '),OPENAI_WEB_AUTH_METHOD:'none',OPENAI_WEB_WORKSPACE_CLAIM:'workspace'};
    const session: OAuthSession = {client_id:'oaiapp_fixture',subject:'user-1',workspace:'workspace-1',issuer:'https://auth.openai.com',ext_agent_host_id:`urn:uuid:${crypto.randomUUID()}`,
      access_token:'fixture-old-access',refresh_token:'fixture-old-refresh',id_token:'fixture-saved-id',scopes:SCOPES,expires_at:Date.now()+1000,earliest_refresh_at:0,hosted:true};
    const binding = sessionBinding(env.PUBLIC_URL,1,2,5);
    await store.saveSession(2,5,await seal(session,vault,binding),1); await store.acquire(request);
    const payload = await seal({vault,subject:session.subject,workspace:session.workspace,clientId:session.client_id,host:session.ext_agent_host_id},env.WEB_SESSION_KEY!,`${env.PUBLIC_URL}|hosted-key|1|2|5`);
    sqlite.prepare('INSERT INTO web_connections VALUES(?,?,?,?,?,?)').run(1,2,5,JSON.stringify(payload),'ready',Date.now());
    let calls = 0;
    const prepare = db.prepare.bind(db);
    const fencedWrite = mock.method(db, 'prepare', (sql: string) => {
      if (outcome === 'persist-lease' && sql.startsWith('UPDATE sessions SET envelope=')) sqlite.prepare("UPDATE web_operations SET lease='successor-owner'").run();
      return prepare(sql);
    });
    const intercepted = mock.method(globalThis,'fetch',async (input: Parameters<typeof fetch>[0],init?: RequestInit) => {
      if (String(input).endsWith('/.well-known/openid-configuration')) return Response.json({issuer:'https://auth.openai.com',authorization_endpoint:'https://auth.openai.com/authorize',token_endpoint:'https://auth.openai.com/token',jwks_uri:'https://auth.openai.com/jwks'});
      assert.equal(String(input),'https://auth.openai.com/token'); calls++;
      const form = new URLSearchParams(String(init?.body)); assert.equal(form.get('refresh_token'),'fixture-old-refresh');
      if (outcome === 'network') throw new Error('Untrusted secret response must not be surfaced');
      if (outcome === 'lease') sqlite.prepare("UPDATE web_operations SET lease='successor-owner'").run();
      return Response.json({token_type:'Bearer',access_token:'fixture-new-access',refresh_token:'fixture-new-refresh',expires_in:3600,scope:SCOPES.join(' ')});
    });
    try {
      const outcomes = await Promise.allSettled([renewHosted(env,request),renewHosted(env,request)]);
      assert.equal(calls,1); assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,uncertain?0:1);
      if (uncertain) {
        assert.equal(sqlite.prepare('SELECT state FROM web_connections').get()!.state,'refreshing');
        assert.equal((await store.session(2,5,1))!.version,1,'A lost owner cannot persist rotated credentials');
        if (outcome === 'lease' || outcome === 'persist-lease') {
          assert.equal(sqlite.prepare('SELECT lease FROM web_operations').get()!.lease,'successor-owner');
          await assert.rejects(renewHosted(env,request),/operation_in_progress/);
          sqlite.prepare('DELETE FROM web_operations').run(); // Only this synthetic in-memory test database.
        } else await assert.rejects(renewHosted(env,request),/refresh_reconnect_required/);
        assert.equal(calls,1);
      } else {
        const saved = await store.session(2,5,1); assert.ok(saved); assert.equal(saved.version,2);
        const renewed = await unseal(saved.envelope,vault,binding) as OAuthSession;
        assert.equal(renewed.access_token,'fixture-new-access'); assert.equal(renewed.refresh_token,'fixture-new-refresh'); assert.equal(renewed.hosted,true);
      }
      await assert.rejects(renewHosted(env,{...request,installationId:9}),/unavailable/);
      await assert.rejects(renewHosted(env,{...request,actorId:6}),/unavailable/);
      await withRepositoryOperation(env,1,2,async()=>{
        await assert.rejects(store.saveSession(2,5,await seal({},vault,binding),1),/session_busy/);
        await assert.rejects(store.deleteSession(2,5,1),/session_busy/);
        await assert.rejects(store.acquire({...request,id:crypto.randomUUID()}),/in_use/);
      });
    } finally { intercepted.mock.restore();fencedWrite.mock.restore();sqlite.close(); }
  }
});
