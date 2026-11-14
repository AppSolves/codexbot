import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pinUpgrade } from '../scripts/prepare-pin-upgrade.mjs';
await test('coordinated pin preparation changes only immutable SHA references and rejects weakened secret guards',async()=>{
  const config=await readFile('wrangler.jsonc','utf8'), backend=await readFile('tests/backend.test.ts','utf8'), source='AppSolves/codexbot', old=JSON.parse(config).vars.TRUSTED_WORKFLOW.split('@').at(-1), next='f'.repeat(40);
  const caller=`jobs:\n  credential-scope:\n    steps:\n      - env:\n          CODEXBOT_SHARED_CREDENTIAL_PRESENT: "\${{ secrets.CODEXBOT_VAULT_KEY != '' || secrets.CODEXBOT_API_KEY != '' }}"\n        run: process.exitCode = 1\n  review:\n    needs: [credential-scope]\n    uses: ${source}/.github/workflows/review.yml@${old}\n    secrets:\n      CODEXBOT_VAULT_KEY: \${{ secrets.CODEXBOT_VAULT_KEY }}\n      CODEXBOT_API_KEY: \${{ secrets.CODEXBOT_API_KEY }}\n`;
  const updated=pinUpgrade(source,next,config,backend,caller);
  assert.equal(updated.config.replaceAll(next,old),config); assert.equal(updated.test.replaceAll(next,old),backend); assert.equal(updated.caller.replaceAll(next,old),caller);
  assert.throws(()=>pinUpgrade(source,'main',config,backend,caller));
  assert.throws(()=>pinUpgrade(source,next,config,backend,caller.replace('needs: [credential-scope]','needs: []')));
  assert.throws(()=>pinUpgrade(source,next,config,backend,caller.replace('CODEXBOT_API_KEY: ${{ secrets.CODEXBOT_API_KEY }}','CODEXBOT_API_KEY: ""')));
  assert.deepEqual(pinUpgrade(source,old,config,backend,caller),{config,test:backend,caller});
});
