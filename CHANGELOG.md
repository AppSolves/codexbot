# Security and behavior changes

## Unreleased — binary/large-PR context hotfix

- Verify PNG evidence separately from textual patches and supply immutable base/head images through official Codex localImage inputs. Require image-capable models and actual image transport; independently verify publication evidence. Image findings appear in the summary without invented inline locations. Unsupported formats and incomplete visual coverage remain non-approving.
- Raise bounded context capacity to 768 calls, 16 MB text, 512 KB per text file and 6 MB diff; retain immutable caches, safe Git types, deadlines and precise non-approving budget diagnostics.
- Allow explicit `unlimited` rolling-day review quotas without disabling authorization, concurrency, cooldown or idempotency.
- Temporarily close the deployment merge gate for the coordinated runner upgrade.

## 0.1.0-beta.2

- Treat GitHub required reviews as qualifying App/user approvals rather than additional humans; retain explicit Human-in-the-Loop policy and native GitHub enforcement, including last-push/CODEOWNER rules.
- Preserve manual review and explicit-only merge settings. Add the website copyright footer.
- Live approval-rule retesting was explicitly waived by the operator; unknown/unmet GitHub review evidence remains non-merging.

## 0.1.0-beta.1 — CLI onboarding release

Native review decisions, automatic owner-consented reviews, autonomous and optional human-supervised merging. Browser ChatGPT onboarding remains explicitly deferred and disabled. Repository opt-in and all actual GitHub protections remain mandatory.


- Allow an explicit, bounded operator request budget only for the exact disposable acceptance tenant. Preserve all counters, other quotas, authorization, protected policy and native review requirements; disabled by default.

- Parse real JS/TS import syntax with the existing pinned TypeScript compiler when selecting essential context. Generated-code strings/comments no longer cause false missing-dependency failures; actual missing imports/exports/require calls remain fail-closed.

- Honor public read access for authorized non-collaborator PR events only when explicitly assigned to a consenting repository admin. Private repositories, manual commands, tenant identity checks and separate merge authorization are unchanged.

- Respect the provider's earliest refresh timestamp before runtime token renewal. Bound the credential wait and workflow lifetime, preserve exclusive leases/CAS and persist rotation before inference; classify premature/unavailable refresh windows without raw credential diagnostics.

- Accept GitHub's documented immutable default OIDC subjects for new/renamed repositories, exactly binding owner ID, repository ID and Environment while retaining the legacy subject and all signed identity/workflow checks.

- Add primary Fully Autonomous merging (0 humans), optional Human-in-the-Loop (1–6), owner-opted-in merge-on-approval and a repository/installation-scoped live acceptance gate. Preserve GitHub protections, native approval and exact-head checks.
- Add explicit CLI consent and protected repository assignment for unattended reviews of authorized contributors without provider accounts. Migration 0006 scopes grants by installation/repository/owner and fences each consent generation through leases, refresh and privileged publication. Manual commands never borrow an assigned connection.
- Make CLI provisioning the current public onboarding path; browser OAuth remains deferred and disabled until its separate client is provisioned.

- Admission feedback: precise atomic quota/duplicate/cooldown/concurrency outcomes, calculated UTC retry times and durable App-owned rejection comments; deterministic denials no longer churn webhook retries. Additive migration 0005 and bounded ambiguity-safe publication recovery.

## Unreleased — security remediation pass

- Add bounded immutable file-index/context-socket exploration, simple Python/Rust dependencies, unchanged-caller fixtures and concise evidence-driven review guidance. Keep the reviewer read-only, network-disabled and credential-free; drain/cancel lookups and revoke the read token during cleanup. Improve native review summaries without changing verdict policy or publication fingerprints.
- Implement GitHub website PKCE authentication, encrypted one-use state and sessions, CSRF/Origin checks, live installation/admin reconciliation and a responsive browser repository/account dashboard. Add additive migration 0004; existing CLI envelopes are preserved.
- Add exact-base setup/configuration update PRs, protected Environments and encrypted Environment-secret provisioning. Hosted ChatGPT OAuth accepts only the actual registered client/auth method/scopes and signed workspace identity. Missing registration values keep activation disabled. API-key billing remains separate.
- Add encrypted pending provisioning recovery, stable provisioning IDs, atomic owner-checked operation heartbeats and session-lease interlocks. Hosted refresh remains behind strict OIDC/run/tenant validation and version CAS; ambiguous refresh requires reconnect. No production credentials or existing sessions are changed by these source changes.
- Generate dashboard model/effort choices from the exact pinned native catalog, including advertised ultra effort; retain explicit command/config/default precedence. Add real workerd/D1 browser acceptance with synthetic providers, libsodium interoperability and concurrency/fault regressions.
- Disable automatic Cloudflare URL traces with explicit operator approval for OAuth privacy; retain safe structured logs. Add post-merge paired pin-PR preparation without guessed SHAs, automatic merge or deployment. See docs/web-onboarding.md for registration, migration and activation gates.

- Fix unattended Codex inspection with `approvalPolicy: never` under unchanged external Docker isolation. Keep client approval/tool grants denied and fail on denied/missing inspection, incomplete context, inconclusive/quarantined/truncated analysis or invalid review locations. Preserve safe separate COMMENT publication. Add per-review `--model` with model-specific effort validation and existing quota/idempotency binding. No schema, credential or permission migration; coordinate runner/Worker/caller pins.

- Classify rejected Responses replies with their actual upstream status (including 2xx), fixed Content-Type category and body presence. Extract only allowlisted codes/parameters from bounded JSON errors; keep non-SSE success responses fail-closed and provider metadata confined to the credential-proxy boundary.

- Failed inference now fails the review job even after recording a safe COMMENT fallback. Preserve separate protected publication, distinguish fallback publication from completed AI review, and carry only allowlisted Docker/Codex/RPC/proxy diagnostics. Local AppError statuses are not presented as provider HTTP responses. Runner changes require a coordinated immutable source/Worker/caller pin upgrade; no credential or database migration.

- Validate broker default-branch identity using the authoritative repository API, not the minimal repository embedded in Actions runs. Preserve signed OIDC and all run/App dispatch checks across prepare, failure, publication and cleanup operations.

- Stage the hosted origin on codexbot.appsolves.workers.dev with Workers.dev enabled, previews disabled and no custom-domain routes. Default CLI/generated callers and the onboarding page/manifest to the new URL. Reject all privileged requests on noncanonical aliases, keep exact OIDC audiences and require fresh origin-bound ChatGPT connection. The retired domain is removed; rollback must stay on Workers.dev. No code deployment, zone-security change or credential migration is automatic; see docs/origin-migration.md.

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
