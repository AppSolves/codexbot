# Validation record and release gates

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

The [probe commit](https://github.com/AppSolves/codexbot/commit/9e602025fdb2ff5c2176584d0d40f1af58222118) preserves the exact assertions and workflow definitions; its diagnostic branch is retained as evidence. The temporary canary secret and both test Environments were removed after successful completion. The production generator now combines named references with a required environment-free guard that rejects either global credential name. Regression tests execute its fail-closed script, enforce its dependency/permissions/boolean-only inputs and compare the manual example against the generator. Static tests do not implement or mock GitHub's secret resolver. `npm run check` (124 tests, typecheck, lint, build), `npm run test:clean`, actionlint for repository/generated/caller workflows and `git diff --check` passed. The production reusable workflow and Worker pin remain `4ed668864cac0682e09ec49a2515a6e1893a2780`.

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
