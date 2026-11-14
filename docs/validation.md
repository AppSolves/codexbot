# Validation record and release gates

## Provider response-format diagnostics — 2026-11-14

Inspected `inferenceProxy` at pinned source `0e937476323bbe35e3c33dc3a8572e62d1e544e5`: the observed format error occurs after `upstream.ok`, when the response body is absent or the SSE Content-Type guard fails. The original diagnostic contains no actual status, header category or body-presence evidence; a specific authentication, entitlement, model, HTML or JSON cause is unproven. The observed production workflow correctly failed analysis while its separate non-approving publisher succeeded.

The new response projection retains actual 200–599 HTTP status, a five-value MIME category and a boolean body-presence field. Rejected responses are inspected for at most 8 KiB of JSON, projecting only existing exact code/parameter allowlists. Unknown text, MIME parameters, credentials, user data, headers and response bodies are never emitted. Provider fields are removed from non-provider diagnostics, and the Docker boundary still rejects provider attestations from the unprivileged reviewer. Non-SSE 2xx responses remain rejected; an SSE-looking MIME prefix is no longer sufficient without the exact media type. No session, schema, authorization, endpoint, credential or merge-policy migration is involved.

Local verification passed: `npm run check` (143 tests, typecheck, lint, build), `npm run test:clean`, real workerd/D1, targeted execution/security regressions (21 tests), Actionlint, Docker build plus synthetic Codex integration, `npm audit --audit-level=moderate`, strict HIGH/CRITICAL image scan and Wrangler dry-run. No deployment, reconnect, paid inference or production review was performed.

`proxy.test.ts` covers successful SSE (including case/parameters), 2xx JSON success/error envelopes, 204/missing bodies, HTML, missing/misleading headers, oversized/malformed/unknown JSON and read/cancellation errors. `execution.test.ts` covers metadata validation, envelope/outer-log round trips and provenance. `test:sandbox` uses pinned Codex 0.169.0 and isolated Docker with synthetic successful SSE, HTTP 400 JSON and HTTP 200 JSON; both failure cases require exit 1 and absent review output, with safe proxy metadata. No real provider request is made. The pinned credential-free model-catalog test and official documentation show why bundled `model/list` is not account entitlement; the production account-specific catalog and completed inference remain unverified. See [the owner-only acceptance steps](acceptance.md#optional-real-openai-protocol-acceptance).

## Isolated review failure and misleading success — 2026-11-14

Verified root cause of the green workflow: `reviewJob` caught inference failure, saved the incomplete fallback and returned successfully. It now always rethrows the primary failure, even when reporting fails; the existing separately protected publisher remains eligible and can only publish a non-approving report. Original container/Codex/provider diagnostics were discarded, so the production inference failure's specific cause remains unknown. Its old `400` was a local AppError default, not evidence of upstream HTTP 400.

Regression coverage in `execution.test.ts` exercises the actual review job through synthetic GitHub/OIDC/Docker boundaries, fallback persistence, primary-error preservation and session release. It also covers Docker exit classes/stderr drain, RPC rejection/process exit, model selection and failed/interrupted/malformed turns. Proxy/stream tests distinguish actual HTTP status and documented entitlement/scope/usage/model codes from validation/stream failures and discard malicious/unknown/oversized details. Progress tests distinguish failed analysis plus successful fallback publication from completed AI analysis, including historical green workflow status. Workflow tests enforce failed-job publication without `continue-on-error`; existing Worker/security tests enforce permanent non-approval after a failed job.

`test:sandbox` executes real Docker isolation and pinned Codex 0.169.0 with synthetic Responses, first successfully and then with a simulated unsupported-capability HTTP 400. It checks exit 1, absent review output, safe engine/proxy envelopes and absence of the private provider message. No stderr/provider-body dumps are used, including test failures. This is protocol/containment evidence, not a claim about any production account, model entitlement or non-API-billed inference. Current official [SIWC constraints](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) are retained; no undocumented endpoint is used.

Local validation: `npm run check` (140 tests, typecheck, lint, build), `npm run test:clean`, `npm run test:workers`, actionlint, Docker image build, `npm run test:sandbox`, `npm audit --audit-level=moderate` and Wrangler dry-run passed. See the [coordinated rollout](review-rollout.md#isolated-failure-diagnostics-and-workflow-conclusions). Source, Worker trust and caller pins must move together after normal approval. Deployment and fresh credential-only/advisory provider acceptance remain external gates; no production request was triggered by these tests.

## Workers.dev origin migration

The configured hosted origin, CLI and generated caller defaults, manifest and onboarding website now use `https://codexbot.appsolves.workers.dev`. Focused tests cover the real CLI default/self-hosted override/profile separation, exact OIDC audience, HMAC on the new origin, strict Origin/host rejection, nonredirecting retired aliases and inability to decrypt old-origin OAuth ciphertext under new AAD. The workerd/D1 test also exercises onboarding, Origin rejection and authenticated endpoint denial without a bearer. [Cutover/rollback](origin-migration.md) separates local evidence from pending deployment, GitHub App ping delivery, protected-default-branch credential diagnostic and fresh OAuth connection. No production change or inference is performed by these tests.

Local validation passed: `npm run check` (130 tests, strict typecheck, lint and build), `npm run test:clean`, `npm run test:workers`, actionlint for repository and actual proposed caller, and Wrangler deploy dry-runs for the prepared configuration. Preview URLs remain disabled, custom-domain routes are empty and the immutable review pin is unchanged. A successful dry-run is not a production route/OIDC/provider acceptance result.

## Environment secret forwarding correction — 2026-11-14

A real [GitHub Actions contract probe](https://github.com/AppSolves/codexbot/actions/runs/43602684286) used synthetic, non-credential canaries in two separate test Environments and a uniquely named repository canary. No OpenAI credentials, production Environment changes, OIDC bypass, inference or deployment were involved. All six assertions passed:

| GitHub configuration | Observed result |
|---|---|
| Literal empty caller grant; Environment contains the named canary | Empty value |
| No caller grant; Environment contains the named canary | Empty value |
| Named secret reference; canary exists only in Environment | Environment value |
| Named reference; same name in repository and Environment | Environment value |
| Named reference; key absent from Environment, present in repository | Repository fallback, demonstrating why references alone are unsafe |
| Caller job without Environment | Sees global canary presence but cannot see the Environment-only canary |

The [probe commit](https://github.com/AppSolves/codexbot/commit/9e602025fdb2ff5c2176584d0d40f1af58222118) preserves the exact assertions and workflow definitions; its diagnostic branch was removed after acceptance at the owner's request. The temporary canary secret and both test Environments were removed after successful completion. The production generator now combines named references with a required environment-free guard that rejects either global credential name. Regression tests execute its fail-closed script, enforce its dependency/permissions/boolean-only inputs and compare the manual example against the generator. Static tests do not implement or mock GitHub's secret resolver. `npm run check` (124 tests, typecheck, lint, build), `npm run test:clean`, actionlint for repository/generated/caller workflows and `git diff --check` passed. The production reusable workflow and Worker pin remain `4ed668864cac0682e09ec49a2515a6e1893a2780`.

The real owning-repository credential/OIDC diagnostic must be freshly dispatched on its protected default branch after the caller PR receives normal approval and is merged. The canary probe does not establish that repository's OAuth session, broker admission or inference success. See [the caller-only migration](review-rollout.md#credential-diagnosis).

The latest [review reliability rollout](review-rollout.md) adds focused tests for credential forwarding/availability, broker error redaction, no-release-before-admission, workload-bound stage/failure updates, permanent non-approval after failed jobs, comment ownership/leases/idempotency/ambiguous responses and bounded recovery. The credential-only workflow checks availability and read-only OIDC identity only. A separate manually dispatched cache benchmark measures real GHA import/export; cache remains opt-in until that evidence justifies it. These checks do not assert live provider inference.

Run the exact commands in [development](development.md). Local checks cover HMAC, policy/parser/aliases, safe regex, quotas, immutable commit/tree/blob context, output schema/DLP/limits/confidence, OAuth/OIDC contracts, native review and guarded-merge state machines, installation-scoped session leases/CAS, atomic setup, and D1/HTTP fault transitions.

`test:clean` validates an independent source checkout without generated Env. `test:workers` executes the actual Worker under workerd with real D1. `test:sandbox` uses the real pinned Codex app-server and isolated Docker wiring with synthetic Responses SSE. The native protocol test initializes the actual platform binary with an empty private home. None of these invokes paid inference or proves model quality, entitlement or GitHub protection behavior.

The per-finding implementation/evidence matrix is maintained in [remediation](remediation.md). Deployment/permission/session migrations are in [operations](operations.md); repeatable real-provider and disposable-GitHub acceptance steps are in [acceptance](acceptance.md).

## Review reliability validation — 2026-11-14

`npm run check` passed strict typecheck, lint, **124 tests** and build. `npm run test:clean`, `npm run test:workers`, actionlint, `docker build --tag codexbot-review:local .`, `npm run test:sandbox`, `npm audit --audit-level=moderate`, Wrangler deploy dry-run and `git diff --check` passed. Actual workerd/D1 coverage includes migration 0003, expired-request cleanup and installation-isolated session release. The strict image scan below reported zero HIGH/CRITICAL findings; a source-only secret scan reported no findings. No real model inference was used. Remote acceptance and cache timings must be recorded separately after execution; local green checks do not establish them.

## Initial source-only audit snapshot — 2026-11-14

Verified on Windows with Node 24.22.1/npm 11.6.4, Docker Desktop Linux containers, Node 24.22.3 in the final image, pinned Wrangler 4.162.0, actionlint 1.7.12 and Trivy 0.76.2. At this initial snapshot the source tree had no initial Git commit or configured origin; test:clean created an independent source-only directory, not a remote Git clone. No remote migration, deployment, GitHub mutation or real provider inference had been performed at that snapshot.

| Executed command | Observed result |
|---|---|
| `npm ci --ignore-scripts` | Passed in the independent source-only validation directory |
| `npm run worker:types` | Passed through both pretypecheck/prebuild hooks; absent Env declaration regenerated from actual bindings |
| `npm run check` | Strict typecheck, lint, 96 tests (96 passed, zero failed/skipped) and production build passed |
| `npm run test:clean` | Independent npm ci/check passed without generated types, dependencies or local state copied in |
| `npm run test:workers` | Actual workerd/D1 migration, HMAC, receipt deduplication and scheduled recovery passed |
| `docker build --tag codexbot-review:local .` | Passed with digest-pinned Node 24 Alpine base and locked production dependencies |
| `npm run test:sandbox` | Actual Codex app-server turn, synthetic SSE, proxy, read-only shell inspection, absent credentials/package managers, blocked network and partial-container cleanup passed |
| `npm audit --audit-level=moderate` | Passed: zero reported vulnerabilities |
| `.local/tools/actionlint/actionlint.exe` | Passed with exit 0; CI verifies the corresponding pinned Linux binary |
| `node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/worker` | Passed: 1061.92 KiB / 225.20 KiB gzip; no deployment |
| `git diff --check` | Passed; generated Env/dependencies/dist/local state excluded from index |

The final local image scan used the following exact options (on Windows set DOCKER_HOST to the Docker Desktop named pipe; CI uses the Linux socket):

```sh
.local/tools/trivy/trivy.exe image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --skip-java-db-update --skip-version-check --no-progress --offline-scan --timeout 90s --db-repository ghcr.io/aquasecurity/trivy-db:2 --cache-dir .local/trivy-cache --format json --output .local/image-vulnerabilities-final.json codexbot-review:local
```

Result: exit 0, zero reported High/Critical vulnerabilities using the database updated 2026-11-14 01:05 UTC, Alpine 3.24.4 and the final image built from the source above. Earlier Debian images failed this same strict gate; they were replaced, not exempted. No CVE ignore list or ignore-unfixed switch was used. This is a database/package scan, not proof that every dependency embedded in native binaries is known or safe. Repeat on the release image with a fresh database.

## External acceptance gates (initial snapshot; verify per deployment)

- Public App registration, source publication, actual installation and OIDC workload verification against GitHub.
- OpenAI authorization for the exact hosted/ephemeral Actions ChatGPT topology. Defaults keep CHATGPT_DEPLOYMENT_AUTHORIZED false; no workaround exists.
- Real non-API-billed OAuth inference, actual refresh/revoke/exhaustion and a separately authorized budget-limited API-key test.
- Native review/inline/verdict/protection/CI/human approval/auto-merge behavior in a disposable live repository; automated merge queues remain manual-only.
- Cloudflare production CPU/subrequest/D1 capacity and an actual deployed smoke test. Workers Free compatibility is a target for light traffic, not a measured production claim.

No release/deployment/merge is authorized by local green checks. The initial smoke must be advisory with merge and approval disabled. Keep MERGE_DEPLOYMENT_AUTHORIZED false until applicable live gates pass. Legacy auth.json import and a hosted web OAuth wizard are not implemented; CLI-assisted official SIWC and manual/CLI setup are the supported paths.
