# Validation record and release gates

Run the exact commands in [development](development.md). Local checks cover HMAC, policy/parser/aliases, safe regex, quotas, immutable commit/tree/blob context, output schema/DLP/limits/confidence, OAuth/OIDC contracts, native review and guarded-merge state machines, installation-scoped session leases/CAS, atomic setup, and D1/HTTP fault transitions.

`test:clean` validates an independent source checkout without generated Env. `test:workers` executes the actual Worker under workerd with real D1. `test:sandbox` uses the real pinned Codex app-server and isolated Docker wiring with synthetic Responses SSE. The native protocol test initializes the actual platform binary with an empty private home. None of these invokes paid inference or proves model quality, entitlement or GitHub protection behavior.

The per-finding implementation/evidence matrix is maintained in [remediation](remediation.md). Deployment/permission/session migrations are in [operations](operations.md); repeatable real-provider and disposable-GitHub acceptance steps are in [acceptance](acceptance.md).

## Local verification — 2026-11-14

Verified on Windows with Node 24.22.1/npm 11.6.4, Docker Desktop Linux containers, Node 24.22.3 in the final image, pinned Wrangler 4.162.0, actionlint 1.7.12 and Trivy 0.76.2. This source tree has no initial Git commit or configured origin; test:clean creates an independent source-only directory, not a remote Git clone. No remote migration, deployment, GitHub mutation or real provider inference was performed.

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

## Gates which remain external

- Public App registration, source publication, actual installation and OIDC workload verification against GitHub.
- OpenAI authorization for the exact hosted/ephemeral Actions ChatGPT topology. Defaults keep CHATGPT_DEPLOYMENT_AUTHORIZED false; no workaround exists.
- Real non-API-billed OAuth inference, actual refresh/revoke/exhaustion and a separately authorized budget-limited API-key test.
- Native review/inline/verdict/protection/CI/human approval/auto-merge behavior in a disposable live repository; automated merge queues remain manual-only.
- Cloudflare production CPU/subrequest/D1 capacity and an actual deployed smoke test. Workers Free compatibility is a target for light traffic, not a measured production claim.

No release/deployment/merge is authorized by local green checks. The initial smoke must be advisory with merge and approval disabled. Keep MERGE_DEPLOYMENT_AUTHORIZED false until applicable live gates pass. Legacy auth.json import and a hosted web OAuth wizard are not implemented; CLI-assisted official SIWC and manual/CLI setup are the supported paths.
