# Development and local validation

For the current reliability changes, `node --import tsx --test tests/broker.test.ts tests/progress.test.ts tests/worker.test.ts tests/workflows.test.ts` runs the focused contracts. Full check also exercises them. [The rollout guide](review-rollout.md) describes provider-free credential and cache diagnostics; neither is a substitute for real inference acceptance.

Use Node 24. Dependency, Codex, Wrangler, Action and container versions are pinned. npm ci --ignore-scripts installs the packaged official native Codex binary without executing lifecycle scripts. The lockfile records integrity; the minimatch override avoids the audited transitive advisory and is checked by lint/tests.

```sh
npm ci --ignore-scripts
npm run worker:types
npm run check
npm run test:clean
npm run test:workers
npm audit --audit-level=moderate
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/worker
docker build --tag codexbot-review:local .
npm run test:sandbox
actionlint
```

CI also downloads checksum-pinned Trivy 0.76.2 and scans the built image locally with `trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 codexbot-review:local`. The public vulnerability database download is not a source-code upload. The gate includes unfixed findings and has no ignore list. Reproduce using the checksum and full command in .github/workflows/ci.yml; database freshness can change the outcome, so rerun before release. The digest-pinned Alpine runtime retains the official musl Codex binary and read-only shell inspection tools; unused npm/Yarn are removed after installing locked dependencies.

pretypecheck/prebuild always run the pinned Wrangler type generator against the actual bindings. Generated worker-configuration.d.ts is ignored, has no credentials and must not be manually written. test:clean copies only source/config/docs/tests to an independent disposable checkout, omits Env/node_modules/local state, runs npm ci --ignore-scripts and the complete check suite there, then verifies Env regeneration. It needs registry access, not deployment credentials.

check runs strict TypeScript, ESLint, Node tests and production compilation. SQLite tests execute every production migration. Fault tests inject failures before/after D1 commits and accepted GitHub side effects; model/provider contracts use fixture keys/HTTPS mocks. The real pinned native Codex app-server initializes and supplies its model catalog with a fresh allowlisted home, then receives EOF for orderly shutdown.

test:workers runs real workerd, applies migrations to real disposable local D1, checks HMAC rejection, durable receipts/deduplication, payload cleanup and scheduled recovery. No Node-only D1 mock substitutes for this check. test:sandbox drives a real Codex turn through the Unix-socket proxy against synthetic SSE in the built image. It checks credential/network/filesystem isolation, not real inference or account entitlement. Production orchestration needs a nonroot Linux runner; Windows Docker Desktop can execute the fixture test.

The sandbox suite also executes the pinned `functions.exec` code-mode tool and its `tools.exec_command` against an isolated synthetic repository. A negative control restores only `untrusted` and observes an actual rejected approval; `never` reads the exact diff/base/head/trusted-instruction bytes (verified by nonce-specific SHA-256), while write/network/credential probes remain blocked. Scripted complete/findings/incomplete results test schema/line validation and exit behavior; complete JSON without inspection fails. No source, tool output or raw Codex stderr is printed. Use the separately authorized provider acceptance harness to establish real AI recognition of the introduced bug.

For disposable local Worker development copy .dev.vars.example to ignored .dev.vars, configure only test credentials, apply D1 migrations with --local and run npm run dev. Never copy production credentials. Actual provisioning requires a controlled HTTPS origin. Production remote migration/deploy, live GitHub writes and inference are never part of check or CI.

Keep changes focused and retain deterministic security checks. Review [architecture](architecture.md), [security](security.md), [operations](operations.md) and [acceptance](acceptance.md) before changing workload identity, credential rotation, quotas or publication. No artifact should contain secrets/private source; do not broaden workflow permissions or run PR code on the credential-bearing host.

## Browser and pinned catalog checks

Install the pinned test browser with `node node_modules/playwright/cli.js install chromium` (`--with-deps` on CI/Linux), then run `npm run test:web`. This starts real disposable workerd/D1 with a test-only provider entrypoint. All external browser requests are blocked; GitHub/OpenAI metadata, JWT issuance and PR/secret API responses are deterministic. It checks actual forms/cookies, PKCE callbacks, setup idempotency, ambiguous Environment writes/resume, readiness/PR merge detection, policy validation and proposal, permission changes, CSRF, tenant denial, logout, keyboard access and desktop/mobile layouts. No real provider credentials or inference are used. Synthetic screenshots remain ignored under .local; no browser storage/session artifact is committed.

`npm run catalog:check` queries only model/list on the exact installed Codex binary with an empty temporary home and a disabled provider endpoint. It compares the committed generated catalog, including model-specific efforts. Regenerate intentionally with `node scripts/model-catalog.mjs` after reviewing a Codex upgrade. No account credential or inference is required. The shared synthetic inspection fixture now includes unchanged caller code and hostile repository text; Docker verifies actual byte access and isolation, not live AI quality. Compare old/revised prompt quality only in separately authorized real-provider acceptance using identical fixtures and recorded expected findings.

Codex upgrades must update `package.json`, the lockfile and `src/core/model-catalog.json` in the same PR. The native protocol regression also compares the complete installed catalog and version during `npm run check`; never regenerate silently in CI or relax the equality check. Codex 0.172.0 advertises eleven models, defaults to `gpt-6.2-sol`, and includes `gpt-6.2-astra`. Both GPT-6.2 variants support low, medium, high, xhigh, max and ultra reasoning; omitted effort still defers to Codex. Existing explicit model selections are retained, and account entitlement remains a separate provider check. Native scripted Docker tests assert the selected default model without contacting a real provider.

### Preventing merges before CI completes

The 0.1.4 refresh retains TypeScript 6.0.3 intentionally: the current `typescript-eslint` peer range is `>=4.8.4 <6.1.0`, while context collection needs `typescript.preProcessFile`. TypeScript 7.0.2 does not export that API. Migrating to its unstable APIs or adding a second compiler is a separate tooling migration, not a reason to force peer dependencies or weaken linting. All other direct npm dependencies were checked against current stable registry versions; Actions, Node image, Actionlint and Trivy pins were checked against their upstream releases.

Dependabot #64 was merged at 12:23:01 UTC while its CI checks were still running; they failed at 12:23:40 and 12:24:04 UTC. The merge actor was AppSolves and no submitted reviews are recorded. Inspection found an active Main ruleset requiring the GitHub Actions `check` result (App ID 15368), but allowing repository administrators (`RepositoryRole` 5) an `always` bypass. This is a bypass-capable configuration, not an absent catalog check. The REST timeline does not identify the exact UI/CLI bypass action or prove historical ruleset state.

Recommended operator change: place the required, up-to-date `check` status from GitHub Actions in a separate active Main ruleset with **no bypass actors**, so review exceptions cannot skip CI. Require normal protected merging for dependency updates. Keep Codex upgrades coupled to regenerated catalog review and full Docker/security acceptance. Do not add an auto-merge bot with admin bypass or treat the skipped optional cache benchmark as the required check. This fix does not modify repository protection settings.
