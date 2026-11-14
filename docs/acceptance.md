# Live acceptance: disposable resources only

Nothing here is executed by CI. Use a separate GitHub App/Worker/D1 and disposable repository, your own account/credential and explicit authorization for writes or paid usage. Never test merge/protection races against production. Record exact immutable source, App ID, repository plan/visibility, provider/model versions and outcomes privately. Mocks and synthetic SSE are not live acceptance.

## Baseline and advisory smoke

1. Complete [deployment](deployment.md) and [installation](installation.md). Confirm no bypass actor, reviewed source pin, selected repository scope, protected default branch and default-branch-only credential/publishing Environments. Leave MERGE_DEPLOYMENT_AUTHORIZED=false and repository merge disabled. Start with review.auto_approve=false and review.request_changes=false.
2. Make a tiny PR from a **non-default branch** (and repeat from a fork). Include ordinary changed text, a small test and a trusted AGENTS.md instruction. The base workflow must never execute fork workflow/project code. Provision only the invoking human's own credential.
3. Read-only preflight verifies live capability and immutable commit→tree API contracts:

```sh
npm run build
npm run acceptance:github -- --repository OWNER/DISPOSABLE --backend https://TEST-WORKER --pr NUMBER
```

4. Only when you intentionally authorize the chosen credential's usage and one real GitHub comment:

```sh
npm run acceptance:github -- --repository OWNER/DISPOSABLE --backend https://TEST-WORKER --pr NUMBER \
  --advisory-smoke --allow-github-write --allow-review-usage --disposable OWNER/DISPOSABLE
```

This requests a real advisory review. It does not fake a verdict, poll CI or enable merge. Inspect once complete, then optionally pass --run-id RUN_ID to the read-only command. Verify native COMMENT, meaningful summary, correct inline line/path where findings exist, exact head, App identity, request/attempt run name and no sensitive artifact/log output. A completed workflow alone is insufficient if the report is inconclusive.

## GitHub acceptance matrix

Perform each mutation through reviewed disposable configuration/PR changes. Do not inject production tokens into tests. Use normal UI/gh actions under your own administrator account; the acceptance script performs no hidden setup mutations.

| Scenario | Required observation |
|---|---|
| Public Free, personal private Pro, organization private Team/Enterprise | Live Environment probe succeeds where features/permissions exist; no unsupported plan inference from a missing field |
| Personal/org Free private | Capability/connect/setup fails before credential transfer; no repository-secret fallback |
| Insufficient App Workflows permission | First-class manual or explicit temporary --setup-as-user path; no permission elevation |
| Repeated setup / existing default files / lost setup response | Same verified PR or precise refusal; atomic two-file commit; no overwrite/force update |
| Installed versus unselected repo; suspend/uninstall/transfer/reinstall | Foreign/stale install cannot prepare/publish/read a session; delayed lifecycle events do not erase active new installation |
| Authorized, denied, review-only --merge, renamed/revoked actor | Live identity/policy denied as appropriate at dispatch, prepare, publish and merge |
| Forged OIDC issuer/audience/subject/repo/owner/run/stage/caller/reusable SHA | Rejected without credentials or GitHub writes; use the fixture suite for cryptographic forgery, not another tenant |
| Signed duplicate/redelivery, lost dispatch response, concurrent runs | Durable recovery; one authorized run binding and unchanged attempt identity |
| Invalid model/effort/credentials/exhaustion | Inconclusive report, no approval, no API billing fallback |
| Clean, complete review after enabling approval | Native APPROVE tied to exact SHA and useful summary |
| Deliberate introduced security defect with high-confidence validated finding | Native REQUEST_CHANGES and safe changed-line finding; never fabricate model output to claim live quality |
| Advisory/uncertain/binary/large/truncated/essential-context missing | COMMENT and no merge; irrelevant supplementary omissions alone do not invalidate a tiny PR |
| Head/base/default-policy/source pin changes during review | Old result cannot approve or merge the new context; new request required |
| Review accepted then response lost / publisher crash | Reconcile same pending/submitted App review; no duplicate approval; merge separate |
| Ready protected PR, passing required CI and current independent humans | Native expected-head merge only after separate merge authorization and explicit --merge |
| Pending required CI with App-bound required guard | Native intent may queue; guard stays pending; backend rechecks before disabling intent/releasing guard/final guarded merge |
| Known failed/missing/unknown CI, conflicts or required human missing | No merge; no native intent when failure/human denial is known |
| Bot approval would otherwise satisfy human count | Independent exact-head non-author humans still required at configured/branch/ruleset minimum |
| New commit / revoked credential or authorization / blocking rerun / one-hour expiry while queued | Owned intent cancelled or safely held; old successful guard cannot satisfy a new head |
| Auto-merge disabled or GitHub rejects already-mergeable enable | Ready path uses guarded native merge; pending path does not force/bypass; safe reconciliation after ambiguous response |
| Required merge queue | Explicit manual-only outcome; no direct merge or queue bypass |
| Two installations, same repository/actor history | Installation-bound session lookup/lease/AAD; old ciphertext cannot be used in the new installation |

Enable MERGE_DEPLOYMENT_AUTHORIZED only after recording the applicable rows as passed, then opt in repository policy and the separate whitelist. The check source must be this App's ID (REST app_id / ruleset integration_id), not any integration. For human approvals, count current-head APPROVED reviews from distinct write-capable users other than the author. Include CODEOWNERS, stale-approval dismissal and rulesets in the live matrix; bot approval is never counted as a human.

## Optional real OpenAI protocol acceptance

First use official local SIWC through the normal CLI. Hosted/ephemeral Actions eligibility is an external prerequisite: without it the OAuth launch gate is **BLOCKED**. Never reinterpret native CLI auth.json. Model discovery is bundled catalog discovery, not subscription entitlement.

For a model-access investigation, the [official account-specific catalog](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) is `GET https://api.openai.com/v1/models` using the **same owning account/workspace OAuth access token** as inference. Its `models` array contains `slug` and `visibility`; compare the selected configured model (or Codex's bundled default) locally against those slugs. Codex `model/list` instead returns its own `data` catalog and supported efforts, including with an empty credential home in our pinned-binary test. That catalog does not establish account membership, entitlement, capability support or completed inference. Do not substitute the API-key catalog shape/credential or silently pick another model. A read-only catalog comparison performs no inference but still requires an authorized owner credential context; do not export central ciphertext or Environment secrets to obtain it, print the catalog/user data, or reconnect solely because of a response-format error. This check has not been run against the production OAuth session.

`provider_stream_content_type_invalid` at source `0e937476323bbe35e3c33dc3a8572e62d1e544e5` proves a 2xx response with a missing body or a failing SSE Content-Type check. It does not distinguish JSON, HTML or absent headers, and proves no specific model/account/provider failure. New diagnostics retain only `upstream_status`, `content_type_category` (`event-stream`, `json`, `html`, `missing`, `other`), `body_present`, and optional allowlisted provider codes/parameters. A `json` category is a header classification, not proof of a valid error envelope; missing/other headers can also carry a bounded JSON error. MIME parameters and arbitrary provider text are discarded. A zero-length stream can have `body_present:true`; this is presence, not a content/completeness claim. After the coordinated immutable-pin rollout, a fresh authorized advisory test is needed to establish the production response shape. Keep the exact public Responses endpoint, `stream:true`, `store:false` and input-array constraints from the [SIWC limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations); a 2xx JSON response is never accepted as completed review output.

The optional Linux-only harness accepts an operator-controlled owner-only JSON credential file outside the repository: a validated official SIWC OAuthSession or `{ "api_key": "..." }`. This is an acceptance input, not a new mandatory onboarding export. Provision it only through your own official OAuth/vault tooling; never paste it into chat, PRs or shell arguments. The harness does not export sessions from other users or the hosted service. It holds an exclusive lock, durably persists refresh rotation before use and prints only a fixed completion message.

```sh
# OAuth, only after deployment authorization; no API-key fallback:
CHATGPT_DEPLOYMENT_AUTHORIZED=true npm run acceptance:provider -- --mode oauth \
  --credential-file /private/operator/session.json --model YOUR_MODEL --max-requests 3 --allow-live-oauth

# Separate intentional paid API test:
npm run acceptance:provider -- --mode api-key --credential-file /private/operator/api-key.json \
  --model YOUR_MODEL --max-requests 3 --allow-paid-api
```

Build the pinned image first and use a nonroot Linux host. The fixture sends no real private source or GitHub writes. Requests are limited to an explicit 1–3, each input to 50 KB; the API-key harness adds a 2048-output-token cap. These are usage-unit ceilings, not a guaranteed currency ceiling: select the model using current pricing and an operator-controlled project/account budget. OAuth must omit unsupported API fields. Failure or truncation never becomes a passing check.

The provider harness now reviews a synthetic authorization regression, not an empty no-tool prompt. It supplies a diff, both source versions and trusted project instructions; the change makes a role check always truthy. Success requires actual inspection, complete schema-valid findings and a finding on `src/access.js` RIGHT line 3. The model is passed through the same per-review override path. Reading and reporting normally need at least two provider requests; a one-request budget is an intentional failure test. A model that exceeds the chosen three-request ceiling fails rather than borrowing more quota. This real-provider gate is opt-in and has not been executed for the approval-policy fix; scripted Responses in CI prove native command execution/isolation, not AI defect recognition. Never run this harness with an API key without explicit paid-usage authorization.

For OAuth success, require real streamed inference to a valid completed structured result using **only** the eligible SIWC access credential and verify the corresponding ChatGPT usage allowance/account/workspace. Confirm no API-key secret exists and no API-billed inference occurred in that isolated test window. A synthetic stream, successful token exchange, model list or HTTP 200 alone is insufficient. Check explicit denied plan scope, expired/revoked grants, actual refresh/rotation across two runs, disconnect/revoke and exhausted allowance; each must fail closed without paid fallback. Repeat API-key success and revoked/invalid-key behavior independently with bounded intentional billing.

## Resource and release gates

Measure deployed Worker CPU/subrequests/D1 and runner resources on realistic bounded public/private workloads. Verify logs/traces contain fixed codes only and no secret transformations. Local dry-run is not a Free-capacity benchmark. No public App, OAuth hosting approval, live provider inference or native merge acceptance has been established merely by this repository's automated tests. Keep both deployment gates closed until the relevant external evidence exists.
