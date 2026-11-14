# Workers.dev deployment and rollback

Canonical target: **https://codexbot.appsolves.workers.dev**. The Worker is `codexbot` in the existing account subdomain `appsolves.workers.dev`. The retired custom domain has been detached and its authoritative DNS no longer resolves. It must not be restored by deployment or rollback. Bot Fight Mode for the entire `appsolves.dev` zone stays enabled. No domain purchase, zone change, new database, paid plan or interactive Access login is needed.

## Current state and invariants

Domain removal is authorized and complete; enabling the new endpoint and deploying this PR remain separate operator actions. At removal, Workers.dev was still disabled and the live Worker still had its previous PUBLIC_URL. The backend is unavailable until the reviewed configuration is deployed. Do not interpret deletion or a local dry-run as successful new-origin acceptance.

- `workers_dev: true`, `preview_urls: false`, `routes: []` and `PUBLIC_URL=https://codexbot.appsolves.workers.dev` are the checked-in target. Do not add a legacy/custom-domain route or override PUBLIC_URL to a retired origin.
- Preserve the Worker name, compatibility date/flags, D1 ID/binding, secrets, both cron triggers, logging policy and `MERGE_DEPLOYMENT_AUTHORIZED=false`.
- Keep the Worker trust and caller pin at `AppSolves/codexbot/.github/workflows/review.yml@4ed668864cac0682e09ec49a2515a6e1893a2780`. The reusable workflow takes its backend input as the exact OIDC audience; it needs no change.
- Preserve the caller's required environment-free credential guard, named secret references, actor/installation inputs, concurrency and protected-default-branch Environment policy. Only `with.backend` changes.
- Privileged requests, including webhooks, require PUBLIC_URL's exact origin. Other origins receive 421 without redirects; they cannot borrow the canonical audience. HMAC, signed OIDC and browser Origin checks remain mandatory.
- Drain/reconcile old requests and session leases before replacing credentials. Never replay an old Actions attempt or accept both audiences to hide an origin mismatch.

## Validate and deploy only after authorization

Review the source PR and caller PR through normal branch protections. Record the current deployment version, config, caller commit and App settings. Pause new review commands and automatic reviews, then wait for active runs/publications/merge intents and session leases to finish or recover normally. This release adds no SQL migration.

For remote commands, set CLOUDFLARE_ACCOUNT_ID to the existing AppSolves account and verify `node node_modules/wrangler/bin/wrangler.js whoami`. Its existing Workers subdomain must be `appsolves`. Do not provision a new Worker environment, D1 database or zone.

```sh
npm ci --ignore-scripts
npm run check
npm run test:clean
npm run test:workers
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/worker
# Separate operator-authorized remote action; not run while preparing the PR:
node node_modules/wrangler/bin/wrangler.js deploy
node --input-type=module -e "const r=await fetch('https://codexbot.appsolves.workers.dev/health',{redirect:'error'});if(r.status!==200)process.exitCode=1;console.log('health status',r.status);await r.body?.cancel()"
```

This deploy enables the existing Workers.dev endpoint and sets its canonical origin together. It uploads code, so it requires explicit authorization beyond deleting the retired domain. Verify effective bindings, schedules and disabled merge gate. [Workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) has Cloudflare-managed Browser Integrity Check; verify the actual GitHub runner. Stop on an edge challenge rather than weakening zone protection, impersonating a browser or adding an interactive Access login.

## ChatGPT reconnection

Reconnection **is required**. `sessionBinding()` includes the exact backend origin, installation, repository and actor; the CLI profile filename changes with the backend host. Even the original vault key cannot decrypt old-origin ciphertext with new-origin AAD. Never copy profiles, rewrite AAD, decrypt/re-encrypt stored sessions for transfer or export tokens.

The retired endpoint is gone, so do not attempt CLI revocation through it. Disconnect the old client in [ChatGPT Settings / Usage and app access](https://chatgpt.com/settings/usage), identifying its account/client registration. This is the [documented fallback when revocation cannot be confirmed](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#end-the-renewable-session). Keep reviews paused if revocation cannot be confirmed.

Once the new canonical backend is deployed, complete fresh official sign-in:

```sh
npm run cli -- connect --repository OWNER/REPO --backend https://codexbot.appsolves.workers.dev
```

Use ordinary connect for this new-origin profile, not --new-account against a still-present retired session. A new local vault key and new-origin ciphertext replace the drained, revoked row through authenticated provisioning. No old ciphertext is decrypted or rebound. A lease conflict or provisioning failure blocks acceptance; do not clear leases manually. API-key mode needs no key transfer: retain its existing personal Environment key and update the caller URL.

## Coordinate App settings and caller

During the paused cutover window, temporary audience/URL mismatches fail closed:

1. In [GitHub App settings](https://github.com/settings/apps/codexbot-review), set Webhook URL to `https://codexbot.appsolves.workers.dev/webhook`. Keep Active, the existing webhook secret, App ID/key, permissions and event subscriptions unchanged. Never distribute the App key to a repository.
2. Set Setup URL to `https://codexbot.appsolves.workers.dev/`. Update any homepage pointing to the retired backend; a GitHub source/company homepage is legitimate. The manifest already has new-origin defaults but does not update registered settings automatically. Do not invent a web OAuth callback; OpenAI sign-in continues using the local loopback callback.
3. Merge the caller PR through normal independent approval. Its only change is with.backend to the new origin. Read back the default-branch caller and live Worker PUBLIC_URL/TRUSTED_WORKFLOW and compare exactly.
4. Complete the fresh ChatGPT connection above. Keep merging disabled and do not substitute an API key if OAuth fails.

No App settings, credentials or code deployments are changed automatically by these PRs.

## Verification before inference

1. Check new-origin /health with Node using redirect:error, then authenticated capabilities through the CLI. Do not print tokens or raw responses.
2. In the App's Advanced / Recent Deliveries, send/redeliver a **ping**, not a review command. Verify the actual target is the new /webhook, HMAC validation succeeds and GitHub receives HTTP 200. Keep payloads/signatures out of artifacts; reconcile missed events deliberately.
3. Freshly dispatch the credential-only workflow on main after caller merge and reconnection:

   ```powershell
   gh workflow run codexbot.yml --repo OWNER/REPO --ref main `
     -f request_id=([guid]::NewGuid().Guid) -f dispatch_attempt=([guid]::NewGuid().Guid) `
     -f credential_owner=YOUR_NUMERIC_USER_ID -f installation_id=YOUR_INSTALLATION_ID `
     -f credential_check_only=true
   ```

   Expect the guard, credential_availability_verified and workload_diagnostic_verified with no_session_no_inference to pass; publisher must be skipped. This verifies visibility and read-only OIDC, not OAuth decryption/entitlement or provider inference.
4. Confirm Workers.dev is enabled, previews and automatic merging remain disabled, no custom domain/legacy DNS entry has returned, and zone Bot Fight Mode is unchanged.
5. Only then, with separate owner authorization, request a new advisory/no-merge review. Migration tests do not perform paid or subscription inference.

## Rollback stays on Workers.dev

Pause reviews and reconcile active requests first. Roll back to a reviewed compatible bundle **while preserving the new canonical origin, Workers.dev routing, empty custom-domain routes and strict origin checks**. Keep the same trust pin, disabled merge gate and current D1 data. Do not restore the deleted hostname, old caller/backend URLs, database snapshots or credentials/profile files from another origin.

If a compatible rollback is unavailable, keep reviews paused and fix forward. Use official disconnect/fresh sign-in if a session must be replaced. Do not weaken authentication or zone security to restore availability. Never disable Workers.dev or restore the retired domain as an automatic fallback.
