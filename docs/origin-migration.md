# Hosted origin cutover and rollback

Canonical target: **https://codexbot.appsolves.workers.dev**. The Worker is `codexbot` in the existing account subdomain `appsolves.workers.dev`. The old `codexbot.appsolves.dev` custom domain is retained initially for controlled cutover, not as another authentication identity. Bot Fight Mode for the entire `appsolves.dev` zone stays enabled. No domain purchase, zone change, new database, paid plan or interactive Access login is part of this migration.

This is a prepared, operator-authorized rollout, not evidence of deployment. The last read-only account check found Workers.dev disabled. A Node health request returned 404 without a challenge while disabled; this does not prove the deployed route, webhook or OIDC works. [Workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and the project's pinned Wrangler define the configuration. Workers.dev also has Cloudflare-managed Browser Integrity Check: verify the actual GitHub runner, not just a browser. Stop on an edge challenge; do not disable zone protection, impersonate a browser or relax application authentication.

## Invariants

- Preserve the Worker name, compatibility date/flags, D1 ID/binding, secrets, both cron triggers, logging policy and `MERGE_DEPLOYMENT_AUTHORIZED=false`.
- Keep `TRUSTED_WORKFLOW` and the repository caller at `AppSolves/codexbot/.github/workflows/review.yml@4ed668864cac0682e09ec49a2515a6e1893a2780`. The reusable workflow needs no change: it takes the backend input as its exact OIDC audience. A backend-only bundle update does not require changing this pin.
- Preserve the caller's mandatory environment-free credential guard, named secret references, actor/installation inputs, concurrency and protected default-branch Environment policy. Only its `with.backend` changes.
- The Worker accepts privileged requests, including webhooks, **only on `PUBLIC_URL`'s exact origin**. Noncanonical aliases return HTTP 421 without redirects, even with a valid canonical token or forwarded-host header. Only unauthenticated GET `/` and `/health` remain public on retained aliases; cross-origin browser requests still fail.
- All old in-flight workflows must drain or expire before the caller/default branch and canonical audience change. Never replay an old Actions attempt to borrow a new origin or credential. There is no dual-audience grace period.

## Stage 0: prepare and pause

Review the source PR and separate caller PR using normal branch protections. Record the currently deployed Worker version, config, exact caller commit, GitHub App webhook/setup values and the existing D1 ID. Preserve secrets in their current stores; do not export them. Pause new review commands and automatic reviews, inspect operations, and wait for active runs/session leases/publications/merge intents to finish or recover normally. Keep automatic merging disabled. This release adds no SQL migration.

For remote commands, explicitly select the existing AppSolves Cloudflare account with `CLOUDFLARE_ACCOUNT_ID` and verify `node node_modules/wrangler/bin/wrangler.js whoami`. Its existing Workers subdomain must be `appsolves`; do not select another account, create a Worker environment or provision another D1 database. This account selection is not needed for local dry-runs.

Read-only verification and local validation:

```sh
npm ci --ignore-scripts
npm run check
npm run test:clean
npm run test:workers
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/worker
```

## Stage 1: enable the hostname while preserving the old canonical identity

Only after explicit deployment authorization, deploy the reviewed bundle with Workers.dev enabled but the **old canonical origin explicitly overridden**. The checked-in config retains the existing custom-domain route. The CLI override changes only PUBLIC_URL; verify the dry-run's effective bindings first.

```sh
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --var PUBLIC_URL:https://codexbot.appsolves.dev --outdir .local/worker-stage1
# Operator-authorized remote action, not executed by this PR:
node node_modules/wrangler/bin/wrangler.js deploy --var PUBLIC_URL:https://codexbot.appsolves.dev
node --input-type=module -e "const r=await fetch('https://codexbot.appsolves.workers.dev/health',{redirect:'error'});if(r.status!==200)process.exitCode=1;console.log('health status',r.status);await r.body?.cancel()"
```

The new hostname's `/health` may succeed, but its privileged endpoints must return 421 until stage 2. Health is public and proves transport/liveness only. `preview_urls` remains false. Do not modify the account subdomain or any zone-wide protection. If verification fails, stop here with the old canonical identity intact.

## ChatGPT reconnection

Reconnection **is required**. `sessionBinding()` includes the exact backend origin, installation, repository and actor. The CLI profile filename also changes with the backend host. The same old vault key cannot decrypt old ciphertext under new-origin AAD. Do not copy the old profile to the new filename, rewrite AAD, decrypt/re-encrypt a stored session for transfer, export tokens or reuse a session across identities.

Preferred path, while old-origin access still works and all runs are drained:

```sh
npm run cli -- disconnect --repository OWNER/REPO --backend https://codexbot.appsolves.dev
```

This explicitly addresses the retired origin (do not omit `--backend` now that the CLI defaults to Workers.dev). The supported disconnect path loads the latest rotated session, revokes it using OpenAI's discovered revocation endpoint, removes its backend session/owning Environment secrets and clears local tokens. Do not treat a failed or unconfirmed disconnect as revocation success.

If Bot Fight Mode prevents this old-origin CLI request, **leave it enabled**. Disconnect the old client in [ChatGPT Settings / Usage and app access](https://chatgpt.com/settings/usage), identifying the old registration by its client/account metadata. This is the [official fallback when remote revocation cannot be confirmed](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#end-the-renewable-session). If revocation cannot be confirmed, keep reviews paused. No origin alias or manual ciphertext transfer is needed.

After stage 2, sign in freshly using the new-origin profile:

```sh
npm run cli -- connect --repository OWNER/REPO --backend https://codexbot.appsolves.workers.dev
```

Use ordinary `connect` for this new profile, not `--new-account` against a still-present retired session. Official OAuth validates the new registration/session; a new local vault key and new-origin ciphertext replace the drained, revoked old row through the existing authenticated provisioning path. No old ciphertext is decrypted or rebound. The database must have no live session lease; a lease conflict is a stop/recovery condition, not permission to reset it manually. Confirm the CLI reports success; provisioning failure leaves acceptance blocked. API-key mode has no origin-bound OAuth ciphertext and needs no key transfer: keep its existing personal Environment key and only update the caller URL.

## Stage 2: canonical cutover, App settings and caller

After operator approval, deploy the reviewed config without the stage-1 override:

```sh
node node_modules/wrangler/bin/wrangler.js deploy
```

This sets `PUBLIC_URL=https://codexbot.appsolves.workers.dev`. Keep existing D1/secrets and all authorization gates. Old-origin privileged requests now return 421. Coordinate these manual changes during the paused window; temporary URL/audience mismatch fails closed:

1. Open [GitHub App settings](https://github.com/settings/apps/codexbot-review), then **Webhook → Webhook URL**: set `https://codexbot.appsolves.workers.dev/webhook`. Leave Active, the existing webhook secret, App ID/key, permissions and event subscriptions unchanged. Do not copy the App key to any repository.
2. Set the App's **Setup URL** to `https://codexbot.appsolves.workers.dev/`. If its homepage points to the retired backend, update it to the new landing page. A homepage pointing to the GitHub source repository is legitimate and can stay. The checked-in manifest uses the new homepage/setup/manifest-redirect defaults; manifest changes do not update a registered App automatically. GitHub user OAuth is not used here: do not invent a web OAuth callback. OpenAI sign-in retains its local loopback callback.
3. Merge the caller PR using ordinary protection/independent approval. Its only change is `with.backend: https://codexbot.appsolves.workers.dev`; preserve the trusted SHA, credential guard and named references. Read back the actual default-branch workflow and Worker PUBLIC_URL/TRUSTED_WORKFLOW values.
4. If the GitHub repository's About website still points to the retired backend, update it after the hostname passes health: `gh repo edit AppSolves/codexbot --homepage https://codexbot.appsolves.workers.dev`. Keep source/documentation links that are not backend URLs. No repository setting is changed by this PR.
5. Complete the fresh ChatGPT connection above. Do not mix modes or silently use an API key when OAuth fails.

The required [GitHub App settings changes](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration) are manual operator actions. No App registration/settings, production credentials or deployment is modified while preparing the PRs.

## Verification gates before inference

1. Check new-origin `/health` using Node with `redirect: 'error'`, then GET `/v1/capabilities` through the CLI's authenticated preflight. Do not print the GitHub token or raw responses.
2. In the App's **Advanced → Recent Deliveries**, send/redeliver a **ping**, not a review command. Confirm its actual target is the new `/webhook`, HMAC validation succeeds and GitHub receives HTTP 200. Keep webhook secrets/signatures and payloads out of artifacts. Resolve missed deliveries deliberately; do not guess delivery order.
3. After reconnection and caller merge, dispatch a fresh credential-only run on `main`. In PowerShell:

   ```powershell
   gh workflow run codexbot.yml --repo OWNER/REPO --ref main `
     -f request_id=([guid]::NewGuid().Guid) -f dispatch_attempt=([guid]::NewGuid().Guid) `
     -f credential_owner=YOUR_NUMERIC_USER_ID -f installation_id=YOUR_INSTALLATION_ID `
     -f credential_check_only=true
   ```

   Expect `credential-scope` success, `credential_availability_verified` and `workload_diagnostic_verified` with `no_session_no_inference`; publishing must be skipped. Verify the actual runner reaches the Worker without a Cloudflare challenge. The diagnostic checks availability and read-only OIDC only, not ciphertext decryption, OAuth entitlement or provider inference.
4. Confirm old-host `/v1/*` and `/webhook` cannot act as alternate entry points (421 from the Worker or an existing zone challenge, no redirect). Confirm `MERGE_DEPLOYMENT_AUTHORIZED=false`, `preview_urls=false` and unchanged zone Bot Fight Mode. Keep the old custom-domain route in config until a separate explicit removal is authorized; remaining alias access is only public landing/health.
5. Only after these gates pass and the owner separately authorizes using their allowance, request a **new advisory/no-merge review**. Confirm its progress comment, exact head and native COMMENT review. No paid or subscription inference is performed by the migration tests.

## Rollback

Pause reviews and drain/reconcile active new-origin requests first. Before reverting, use supported new-origin disconnect or the provider's Settings fallback to revoke new-origin renewable sessions. D1 is shared: old-origin ciphertext is not preserved by a Worker version rollback, and credentials/profile files must never be copied or restored across origins.

Deploy the reviewed origin-enforcing bundle with `--var PUBLIC_URL:https://codexbot.appsolves.dev`, preserving both routes initially. Revert the caller URL through normal branch protection and restore the recorded App webhook/setup URLs. Keep the immutable review pin unchanged and merging disabled. Reconnect on the restored canonical origin using fresh OAuth; old revoked sessions do not become valid again. A rollback does **not** fix the original Bot Fight Mode challenge: keep reviews paused if machine access remains blocked. Do not roll back to pre-origin-check code while two routable aliases exist.

Disable the new Workers.dev route only after separately approving that routing change and aligning `workers_dev: false` in config; dashboard-only changes can be undone by Wrangler. Keep additive D1 schema and current data; no database restore or global-security change belongs to this rollback.
