import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { parse } from 'yaml';

export function pinUpgrade(source, sha, configText, testText, callerText) {
  assert.match(source,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/); assert.match(sha,/^[a-f0-9]{40}$/);
  const config = JSON.parse(configText), prefix = `${source}/.github/workflows/review.yml@`, previous = config.vars.TRUSTED_WORKFLOW;
  assert.ok(previous.startsWith(prefix) && /^[a-f0-9]{40}$/.test(previous.slice(prefix.length)));
  assert.equal(config.vars.MERGE_DEPLOYMENT_AUTHORIZED,'false');
  const caller = parse(callerText), current = caller.jobs.review.uses;
  assert.ok(current.startsWith(prefix) && /^[a-f0-9]{40}$/.test(current.slice(prefix.length)));
  assert.deepEqual(caller.jobs.review.secrets,{CODEXBOT_VAULT_KEY:'${{ secrets.CODEXBOT_VAULT_KEY }}',CODEXBOT_API_KEY:'${{ secrets.CODEXBOT_API_KEY }}'});
  assert.ok([caller.jobs.review.needs].flat().includes('credential-scope'));
  const guard = caller.jobs['credential-scope']; assert.ok(guard && !guard.environment && guard.steps.some(step=>step.env?.CODEXBOT_SHARED_CREDENTIAL_PRESENT==="${{ secrets.CODEXBOT_VAULT_KEY != '' || secrets.CODEXBOT_API_KEY != '' }}" && step.run.includes('process.exitCode = 1')));
  const replace = (text,old,value) => { assert.equal(text.split(old).length,2,'Pin must occur exactly once'); return text.replace(old,value); };
  const next = prefix + sha;
  return {config:previous===next?configText:replace(configText,previous,next),test:previous===next?testText:replace(testText,previous,next),caller:current===next?callerText:replace(callerText,current,next)};
}
function api(path, body) {
  return JSON.parse(execFileSync('gh',['api',path,...(body?['--input','-']:[])],{encoding:'utf8',stdio:['pipe','pipe','ignore'],timeout:30_000,...(body?{input:JSON.stringify(body)}:{})}));
}
function content(repository,path,ref) { const file=api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`); assert.equal(file.type,'file'); return Buffer.from(file.content,'base64').toString('utf8'); }
function proposal(repository, files, sha, sourcePr, publicSource, expectedBase) {
  const metadata=api(`repos/${repository}`), repo=`repos/${repository}`, base=api(`${repo}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`).object.sha;
  assert.equal(base,expectedBase,'Default branch changed during pin preparation');
  const changed=Object.entries(files).filter(([path,value])=>content(repository,path,base)!==value);
  if (!changed.length) return {status:'already_pinned',repository};
  const branch=`chore/codexbot-pin-${sha.slice(0,12)}`;
  let head;
  // Listing refs avoids treating an arbitrary API failure as a missing branch.
  const refs=api(`${repo}/git/matching-refs/heads/${encodeURIComponent(branch)}`);
  const existing=refs.find(ref=>ref.ref===`refs/heads/${branch}`);
  if (existing) {
    head=existing.object.sha;
    const commit=api(`${repo}/git/commits/${head}`), compare=api(`${repo}/compare/${base}...${head}`);
    assert.equal(commit.parents.length,1); assert.equal(commit.parents[0].sha,base); assert.equal(compare.total_commits,1);
    assert.equal(compare.files?.length,changed.length); assert.ok(compare.files.every(file=>changed.some(([path])=>path===file.filename)));
    for (const [path,value] of Object.entries(files)) assert.equal(content(repository,path,head),value,'Existing pin branch changed; inspect manually');
  } else {
    const tree=api(`${repo}/git/trees`,{base_tree:api(`${repo}/git/commits/${base}`).tree.sha,tree:changed.map(([path,content])=>({path,content,mode:'100644',type:'blob'}))});
    head=api(`${repo}/git/commits`,{message:'chore: align CodexBot immutable review source',tree:tree.sha,parents:[base]}).sha;
    api(`${repo}/git/refs`,{ref:`refs/heads/${branch}`,sha:head});
  }
  const prs=api(`${repo}/pulls?state=all&head=${encodeURIComponent(repository.split('/')[0]+':'+branch)}&per_page=100`);
  if (prs.length) { assert.equal(prs.length,1); assert.equal(prs[0].state,'open'); assert.equal(prs[0].head.sha,head); assert.equal(prs[0].base.ref,metadata.default_branch); return {pull_request:prs[0].html_url}; }
  return {pull_request:api(`${repo}/pulls`,{title:'chore: align CodexBot immutable review source',base:metadata.default_branch,head:branch,
    body:`Pins the reviewed source merge ${sha} from ${sourcePr}. ${publicSource?'Coordinate repository callers before an operator-approved Worker deployment.':'Coordinate the Worker trust pin to this exact same revision before an authorized credential-only diagnostic.'} No credentials, policy, merge settings or deployment are changed.`}).html_url};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{source:{type:'string',default:'AppSolves/codexbot'},'source-pr':{type:'string'},caller:{type:'string'},'check-only':{type:'boolean',default:false}}});
    assert.match(values.source,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/); assert.match(values.caller??'',/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/); assert.match(values['source-pr']??'',/^\d+$/);
    const pr=api(`repos/${values.source}/pulls/${values['source-pr']}`); assert.equal(pr.merged,true,'Source PR must already be merged'); assert.match(pr.merge_commit_sha,/^[a-f0-9]{40}$/);
    const sha=pr.merge_commit_sha, sourcePr=`https://github.com/${values.source}/pull/${values['source-pr']}`;
    content(values.source,'.github/workflows/review.yml',sha);
    const sourceBranch=api(`repos/${values.source}`).default_branch, callerBranch=api(`repos/${values.caller}`).default_branch;
    const sourceBase=api(`repos/${values.source}/git/ref/heads/${encodeURIComponent(sourceBranch)}`).object.sha, callerBase=api(`repos/${values.caller}/git/ref/heads/${encodeURIComponent(callerBranch)}`).object.sha;
    const upgraded=pinUpgrade(values.source,sha,content(values.source,'wrangler.jsonc',sourceBase),content(values.source,'tests/backend.test.ts',sourceBase),content(values.caller,'.github/workflows/codexbot.yml',callerBase));
    if (values['check-only']) process.stdout.write(JSON.stringify({status:'verified_merged_source',sha})+'\n');
    else {
      process.stdout.write(JSON.stringify(proposal(values.source,{'wrangler.jsonc':upgraded.config,'tests/backend.test.ts':upgraded.test},sha,sourcePr,true,sourceBase))+'\n');
      process.stdout.write(JSON.stringify(proposal(values.caller,{'.github/workflows/codexbot.yml':upgraded.caller},sha,sourcePr,false,callerBase))+'\n');
    }
  } catch { process.stderr.write('Pin preparation stopped: verify a merged source PR, exact existing pins/guards, clean dedicated branches and GitHub permissions. No merge or deployment performed.\n'); process.exitCode=1; }
}
