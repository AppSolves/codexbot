# Deployment checklist

Hosted canonical origin: **https://codexbot.appsolves.workers.dev**. Use the [staged origin migration](origin-migration.md) for the existing App/Worker; it records the historical origin-bound credential cutover. The current production origin is Workers.dev; merging or a dry-run does not deploy new browser functionality.

For Worker/reusable-workflow upgrades, follow [the coordinated immutable-pin upgrade](review-rollout.md), apply required migrations and set the caller pin and Worker TRUSTED_WORKFLOW to the same actual merged commit. The prior caller-only Environment-secret correction preserved its then-current pin. New runner/context/hosted-renew changes require the coordinated final source SHA described below. Keep merge disabled. Report validation before any production change; a temporary pin mismatch fails closed.

The shared setup generator is bundled into `/v1/setup`. Publishing its corrected templates for future hosted installations requires a separately authorized Worker bundle deployment, with the existing trusted review pin preserved. The existing caller can be repaired independently; no backend deployment is performed by the fix PR.

This document is operator instructions, not evidence of an existing hosted deployment. Do not register, deploy, publish a release or use paid inference without your own authorization.

## GitHub App

Register a public GitHub App with installation access for any account, selecting repositories narrowly. [app-manifest.json](../app-manifest.json) contains the hosted URL defaults; independent operators replace all four origin-bearing fields with their own backend. Manifest-code conversion is not implemented: use GitHub's App settings or your own approved registration tooling.

| Setting | Required value |
|---|---|
| Homepage / setup / OAuth callback | `/` / `/dashboard` / `/auth/github/callback` on the exact backend origin |
| Webhook | https://codexbot.appsolves.workers.dev/webhook (or the independent backend) |
| Secret | Cryptographically random, at least 32 bytes |
| Default permissions | Metadata read; Actions write; Contents write; Pull requests write |
| Browser setup | Workflows write; Administration write; Environments write, with installation consent and live administrator checks |
| Optional automatic merge inspection/guard | Checks write and Administration read, explicit installer consent |
| Events | Issue comment, Pull request; installation lifecycle is delivered automatically |

Contents write permits merge/setup; individual runtime tokens are downscoped to one numeric repository and operation. Context tokens have only Contents/Pull requests read and are revoked after the bounded immutable-context service stops. Review/publish workflows have no GitHub write permission. Optional Administration **read** is used only to inspect branch protection for merge; ordinary review/publish tokens have no administrative write, Environment-secret access or ruleset bypass. Browser Environment operations use only the signed-in administrator’s intersection-scoped App user token; setup installation tokens remain Contents/Pull requests/Workflows only. Default review-only installations do not need the optional merge permissions.

Keep the RSA App private key exclusively in Worker secrets. Convert a PKCS#1 download locally to PKCS#8 when needed:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app.pem -out github-app-pkcs8.pem
```

Do not commit either file. Record the numeric App ID and real slug, independently of textual command aliases.

## Cloudflare Worker and D1

```sh
npm ci --ignore-scripts
npm run check
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js d1 create codexbot
```

Replace the database ID, PUBLIC_URL (HTTPS origin without trailing slash), GITHUB_APP_ID, GITHUB_APP_SLUG and TRUSTED_WORKFLOW in wrangler.jsonc. The trusted value is YOUR-ORG/codexbot/.github/workflows/review.yml@FULL_40_CHARACTER_COMMIT_SHA. Use a reviewed real immutable source commit accessible to customer Actions checkouts; self-hosters use their own fork. There is no fictitious upstream release or vendor origin. A private cross-repository source checkout may need separate GitHub access arrangements and is not provided by an unrestricted token here.

```sh
node node_modules/wrangler/bin/wrangler.js secret put GITHUB_PRIVATE_KEY
node node_modules/wrangler/bin/wrangler.js secret put GITHUB_WEBHOOK_SECRET
npm run worker:types
node node_modules/wrangler/bin/wrangler.js d1 migrations apply codexbot --remote
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/worker
npm run deploy
```

Those final remote commands are operator actions. Keep user OpenAI credentials out of Worker vars/secrets. Generated Env declarations contain binding/secret names and string types, never secret values; generate locally/CI rather than hand-edit or archive them. Initial-schema upgrades require [the migration runbook](operations.md).

The installed minute cron handles bounded dispatch/publication recovery and cleanup. Keep safe Workers Logs enabled and automatic traces disabled as explicitly authorized for browser OAuth; invocation payload logging is disabled. Do not add body/header capture to proxies, analytics or APM. /health proves route availability only; use runtime tests/acceptance for D1, App permissions, OIDC and provider access.

## Independent external gates

CHATGPT_DEPLOYMENT_AUTHORIZED=false is mandatory until OpenAI confirms eligibility for the actual local/hosted/ephemeral Actions topology. Public source or a successful token exchange does not grant hosted ChatGPT-plan rights. API-key mode works independently with each actor's own key and separate billing.

MERGE_DEPLOYMENT_AUTHORIZED=false remains until the disposable advisory/verdict/protection acceptance matrix passes. Then explicitly enable repository merge policy and independent whitelist. Never add the App to branch/ruleset bypass lists. Require current human approvals and CI. For pending CI, require check "CodexBot reviewed commit" with integration/app_id equal to this App's numeric ID; allowing any source is insufficient. No automated merge-queue implementation is claimed.

## Capacity and hosting

The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) apply independently of repository-owned Actions compute. Workers Free currently has 100,000 requests/day, 10 ms CPU/request, 128 MB memory and 50 external subrequests/request. Minute cron is supported, but bounded cron work does not prove it meets the CPU budget. Crypto, YAML, DLP and review history/human permission checks can require Paid; measure realistic private/public workloads and reduce quotas or provision capacity. No inference runs on Cloudflare and no personal VM/VPS is used.

A request expires after one hour; metadata/receipts retain seven days. Successful receipt payloads are cleared immediately; session ciphertext remains until disconnect/uninstall, subject to separate D1 backup retention. Review history, branch rules, human permission checks and collector calls have hard bounds; ambiguous evidence requires manual action. Read [operations](operations.md) before opening public installation broadly.

## Browser activation / migration 0004

Follow [ADR 0001 and its activation table](web-onboarding.md). Apply migration 0004 before the new Worker, preserve existing CLI vaults and leave WEB_ENABLED=false until the actual GitHub/OpenAI registered clients, exact callbacks, signed workspace claim and inference scopes are provisioned. Registration approval does not invent these values. Set secrets with Wrangler protected input; no plaintext user tokens/API keys belong in Worker vars. The hosted master key protects encrypted D1 key records and requires a separate backup/rotation procedure. No production secrets or registrations are modified by this repository change.

Run npm run check, npm run test:clean, npm run test:workers, npm run test:web, npm run catalog:check, Docker sandbox tests, Actionlint, audit, image scan and Wrangler dry-run before activation. The web test uses local self-signed TLS only inside an isolated browser context; production TLS verification is never disabled. Keep automatic merge off through disposable GitHub/OIDC and separately authorized provider acceptance. Reverting to an older runner requires quiescing hosted sessions and matching both immutable pins, since older runners do not implement hosted renew.
