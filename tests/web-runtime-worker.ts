// Test-only entrypoint. External providers are deterministic; application routes and D1 are real.
import worker from '../src/worker/index.js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SCOPES, ISSUER } from '../src/auth/oauth.js';
import { record } from '../src/core/errors.js';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

const BASE = 'b'.repeat(40);
const files = new Map<string,string>(), environments = new Map<string,{ policies: boolean; secrets: Map<string,string> }>();
const commits = new Map<string,{ parents: string[]; files: Map<string,string> }>([[BASE,{parents:[],files}]]), refs = new Map([['main',BASE]]);
const trees = new Map<string,Map<string,string>>(), pulls: { number: number; head: { ref: string; sha: string }; base: {ref: string}; user:{login:string}; html_url:string; state:string }[] = [];
let administrator = true, sequence = 0, failSecret = false, keys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
const secretKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3));
async function external(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
  const body = url.origin === 'https://api.github.com' && init?.body ? record(JSON.parse(String(init.body)) as unknown) : {};
  if (url.origin === 'https://github.com' && path === '/login/oauth/access_token') return Response.json({ token_type:'bearer', access_token:'fixture-github-browser-token', expires_in:3600 });
  if (url.origin === ISSUER) {
    keys ??= await generateKeyPair('RS256', { extractable:true });
    if (path === '/.well-known/openid-configuration') return Response.json({ issuer:ISSUER, authorization_endpoint:`${ISSUER}/authorize`, token_endpoint:`${ISSUER}/token`, jwks_uri:`${ISSUER}/jwks`, revocation_endpoint:`${ISSUER}/revoke` });
    if (path === '/jwks') return Response.json({keys:[{...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256'}]});
    if (path === '/revoke') return new Response(null,{status:200});
    const form = new URLSearchParams(String(init?.body)), nonce = form.get('code')?.slice('fixture-'.length);
    const id_token = await new SignJWT({nonce,approved_workspace:'fixture-workspace'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(ISSUER).setSubject('fixture-openai-user').setAudience('oaiapp_fixture').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    return Response.json({ token_type:'Bearer', access_token:'fixture-openai-access',refresh_token:'fixture-openai-refresh',id_token,expires_in:3600,scope:SCOPES.join(' ') });
  }
  if (url.origin !== 'https://api.github.com') throw new Error('Test fixture forbids real external requests');
  if (path === '/user') return Response.json({id:5,login:'alice',type:'User'});
  if (path === '/user/installations') return Response.json({total_count:1,installations:[{id:1,app_id:42,account:{id:5,login:'alice',type:'User'},suspended_at:null}]});
  if (path === '/user/installations/1/repositories') return Response.json({total_count:1,repositories:[{id:2,full_name:'owner/repo',private:false,permissions:{admin:administrator}}]});
  if (path === '/repositories/2' || path === '/repos/owner/repo') return Response.json({id:2,full_name:'owner/repo',owner:{id:3,login:'owner'},private:false,default_branch:'main',permissions:{admin:administrator}});
  if (path === '/repos/owner/repo/installation') return Response.json({id:1,app_id:42,suspended_at:null,permissions:{workflows:'write',administration:'write',environments:'write'}});
  if (path === '/app/installations/1/access_tokens') return Response.json({token:'fixture-installation-token'},{status:201});
  if (path === '/repos/owner/repo/branches/main') return Response.json({protected:true,commit:{sha:refs.get('main')}});
  if (path === '/repos/owner/repo/environments') return Response.json({total_count:environments.size,environments:[]});
  const environment = /^\/repos\/owner\/repo\/environments\/([^/]+)(.*)$/.exec(path);
  if (environment) {
    const name = decodeURIComponent(environment[1]!), suffix = environment[2]!, existing = environments.get(name);
    if (!suffix && method === 'PUT') { environments.set(name,{policies:false,secrets:new Map()}); return Response.json({},{status:200}); }
    if (!existing) return Response.json({}, {status:404});
    if (!suffix) return Response.json({deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}});
    if (suffix === '/deployment-branch-policies') { if (method === 'POST') existing.policies = true; return Response.json({total_count:existing.policies?1:0,branch_policies:existing.policies?[{name:'main',type:'branch'}]:[]}); }
    if (suffix === '/secrets/public-key') return Response.json({key_id:'fixture-key',key:Buffer.from(secretKey.publicKey).toString('base64')});
    if (suffix === '/secrets') return Response.json({total_count:existing.secrets.size,secrets:[...existing.secrets.keys()].map(name=>({name}))});
    if (suffix.startsWith('/secrets/')) {
      const secret = suffix.slice('/secrets/'.length);
      if (method === 'DELETE') existing.secrets.delete(secret);
      else if (method === 'PUT') {
        const box = Buffer.from(String(body.encrypted_value),'base64'), ephemeral = box.subarray(0,32), nonce = blake2b(Buffer.concat([ephemeral,secretKey.publicKey]),undefined,24);
        const plaintext = nacl.box.open(box.subarray(32),nonce,ephemeral,secretKey.secretKey); if (!plaintext) return Response.json({}, {status:422});
        existing.secrets.set(secret,new TextDecoder().decode(plaintext));
        if (failSecret) { failSecret=false; return Response.json({error:'fixture_ambiguous_write'}, {status:503}); }
      } else throw new Error('Unexpected Environment operation');
      return new Response(null,{status:204});
    }
  }
  if (path.startsWith('/repos/owner/source/contents/')) return Response.json({type:'file',size:20,content:Buffer.from('name: trusted\non: workflow_call').toString('base64')});
  if (path.startsWith('/repos/owner/repo/contents/')) {
    const name = decodeURIComponent(path.slice('/repos/owner/repo/contents/'.length)), ref = url.searchParams.get('ref') ?? refs.get('main')!;
    const value = commits.get(ref)?.files.get(name);
    return value === undefined ? Response.json({}, {status:404}) : Response.json({type:'file',size:Buffer.byteLength(value),content:Buffer.from(value).toString('base64')});
  }
  if (path.startsWith('/repos/owner/repo/git/ref/heads/')) {
    const sha = refs.get(decodeURIComponent(path.slice('/repos/owner/repo/git/ref/heads/'.length))); return sha ? Response.json({object:{sha}}) : Response.json({},{status:404});
  }
  if (path === '/repos/owner/repo/git/refs') { refs.set(String(body.ref).slice('refs/heads/'.length),String(body.sha)); return Response.json({},{status:201}); }
  if (path.startsWith('/repos/owner/repo/git/commits/')) {
    const sha = path.split('/').at(-1)!, commit = commits.get(sha)!;
    return Response.json({sha,tree:{sha},parents:commit.parents.map(sha=>({sha}))});
  }
  if (path === '/repos/owner/repo/git/trees') {
    const sha = (++sequence).toString(16).padStart(40,'0'), entries = new Map(commits.get(String(body.base_tree))?.files ?? trees.get(String(body.base_tree)) ?? files);
    for (const entry of body.tree as {path:string;content:string}[]) entries.set(entry.path,entry.content);
    trees.set(sha,entries); return Response.json({sha},{status:201});
  }
  if (path === '/repos/owner/repo/git/commits') { const sha = (++sequence).toString(16).padStart(40,'0'); commits.set(sha,{parents:body.parents as string[],files:trees.get(String(body.tree))!}); return Response.json({sha},{status:201}); }
  if (path.includes('/compare/')) {
    const [base,head] = path.split('/').at(-1)!.split('...'), previous = commits.get(base!)!.files, current = commits.get(head!)!.files;
    return Response.json({total_commits:1,files:[...current].filter(([path,content])=>previous.get(path)!==content).map(([filename])=>({filename,status:previous.has(filename)?'modified':'added'}))});
  }
  if (path === '/repos/owner/repo/pulls') {
    if (method === 'GET') return Response.json(pulls.filter(pr=>(!url.searchParams.get('head') || url.searchParams.get('head')===`owner:${pr.head.ref}`) && (url.searchParams.get('state')==='all' || pr.state==='open')));
    const ref = String(body.head), number = pulls.length+1, pr = {number,head:{ref,sha:refs.get(ref)!},base:{ref:'main'},user:{login:'codexbot[bot]'},state:'open',html_url:`https://github.com/owner/repo/pull/${number}`};
    pulls.push(pr); return Response.json(pr,{status:201});
  }
  throw new Error('Unexpected test provider request');
}
globalThis.fetch = external;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__fixture/authorize') {
      const openai = url.searchParams.get('kind') === 'openai';
      return new Response(null,{status:303,headers:{Location:`${env.PUBLIC_URL}/auth/${openai?'openai':'github'}/callback?state=${url.searchParams.get('state')}&code=${openai?'fixture-'+url.searchParams.get('nonce'):'fixture-code'}`}});
    }
    if (url.pathname === '/__fixture/merge' && request.method === 'POST') { const pr = pulls.find(pr=>pr.state==='open'); if (pr) { refs.set('main',pr.head.sha); pr.state='closed'; } return Response.json({status:'merged'}); }
    if (url.pathname === '/__fixture/fail-secret' && request.method === 'POST') { failSecret=true; return Response.json({status:'armed'}); }
    if (url.pathname === '/__fixture/revoke' && request.method === 'POST') { administrator=false; return Response.json({status:'revoked'}); }
    if (url.pathname === '/__fixture/state') return Response.json({pulls:pulls.length,credentialEnvironments:environments.size,configured:!!commits.get(refs.get('main')!)?.files.get('.codexbot.yml')});
    const response = await worker.fetch(request,env), location = response.headers.get('location');
    if (location && /^https:\/\/(?:github.com|auth.openai.com)\//.test(location)) {
      const target = new URL(location);
      if (target.searchParams.get('code_challenge_method') !== 'S256' || !target.searchParams.get('code_challenge')) throw new Error('Fixture requires PKCE');
      response.headers.set('Location',`/__fixture/authorize?kind=${target.origin===ISSUER?'openai':'github'}&state=${target.searchParams.get('state')}&nonce=${target.searchParams.get('nonce')??''}`);
    }
    return response;
  }
};
