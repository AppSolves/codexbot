# Security and behavior changes

## Unreleased — security remediation pass

- Generate Cloudflare Env from the pinned Wrangler configuration before every build/typecheck. CI tests an independent source checkout without generated declarations.
- Resolve commit objects to tree SHAs; fetch essential changed files/instructions first. Separate complete diff, essential context and bounded supplementary coverage. Cache immutable trees/blobs only inside the authorized collection.
- Add migration 0002: durable webhook/outbox receipts, stable dispatch attempts, exact run-name reconciliation, quotas, publication leases/checkpoints and installation-bound sessions. Existing sessions require reconnect; pending legacy requests are invalidated. See docs/operations.md.
- Quarantine suspicious model output locally before transport, storage and publication. Keep explicit information-loss flags when bounding large output; no incomplete or uncertain review can approve.
- Use pending GitHub reviews as resumable resources; submit once and reconcile remote state. Track publication separately from merge intent.
- Merge-ready PRs use native expected-head merge. Pending checks require an App-bound required guard, native auto-merge availability and current independent human approvals. Unknown states/conflicts/merge queues fail closed. Merge deployment acceptance remains disabled by default.
- Preflight Environment support and protected default branches. GitHub Free private repositories are unsupported; repository-secret fallback is prohibited. Setup files are committed atomically and setup PRs reconcile after partial failures.
- Preserve existing command handles; add explicit aliases and bounded --rerun. Aliases are textual commands and may notify unrelated GitHub accounts.
- Add real workerd/D1 validation, isolated native Codex protocol validation, D1/HTTP fault injection and opt-in provider/disposable-GitHub acceptance tools. No live inference, hosting eligibility, deployment or merge acceptance is implied.
- Move the runtime to a digest-pinned Alpine Node 24 image and remove unused npm/Yarn after installing locked dependencies. CI runs a checksum-pinned local Trivy scan and fails on High/Critical findings, including unfixed ones; no CVE ignore policy is introduced.
