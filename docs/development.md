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
