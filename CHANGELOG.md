# Security and behavior changes

## Unreleased — security remediation pass

- Stage the hosted origin on codexbot.appsolves.workers.dev with Workers.dev enabled and previews disabled; preserve the existing custom domain for controlled cutover. Default CLI/generated callers and the onboarding page/manifest to the new URL. Reject all privileged requests on noncanonical aliases, keep exact OIDC audiences and require fresh origin-bound ChatGPT connection. No deployment, zone-security change or credential migration is automatic; see docs/origin-migration.md.

- Correct Environment secret forwarding: generate named references after a required environment-free caller guard rejects repository/organization credentials. Empty literals did not enable Environment lookup; named references alone would allow fallback. Existing callers must update through a PR; reusable/Worker pins and credentials remain unchanged. See docs/review-rollout.md.

- Explicitly forward only named Environment credential grants; add a credential-only availability diagnostic, safe runner/broker/OIDC failure codes and failed-job publication safeguards.
- Add migration 0003 with recoverable, App-owned progress comments, verified run status, failure metadata and bounded operator reconciliation. Existing sessions remain valid.
- Add opt-in source-scoped Buildx caching and a credential-free cache benchmark; execute review images by content ID. Keep cache off until measurements justify its cost.
- New setup triggers use @CBReview plus repository ID; document independent OpenAI connector settings without changing App identity or removing legacy parsing.

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
