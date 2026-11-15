# Architecture

The [review reliability guide](review-rollout.md) documents migration 0003, named Environment grants, sanitized runner diagnostics, durable progress comments and optional Buildx caching. Progress writes are backend-only and validate App/request/PR ownership; the model receives no write capability. A failed upstream job permanently disables approval for its persisted result, including publication recovery.

The Cloudflare Worker ingests signed GitHub webhooks, verifies live authorization, maintains D1 metadata and publishes native reviews. Official Codex runs exclusively in the repository owner's ephemeral GitHub-hosted Linux Actions jobs. Independent installations choose their own App, Worker, D1 database and source release; no vendor backend or shared OpenAI credential exists.

```mermaid
sequenceDiagram
  participant GitHub
  participant Worker
  participant D1
  participant Actions
  participant Reviewer
  participant Proxy
  participant OpenAI
  GitHub->>Worker: Signed webhook
  Worker->>D1: Durable receipt + immutable authorized request
  Worker->>GitHub: Attempt-bound workflow dispatch
  Actions->>Worker: GitHub OIDC prepare
  Worker->>Actions: One-repository read token + installation/actor ciphertext
  Actions->>GitHub: Immutable commit/tree/blob collection and bounded context broker
  Actions->>Worker: Persist encrypted token rotation with lease/CAS
  Actions->>Reviewer: Read-only data, no credentials or external network
  Reviewer->>Proxy: Unix socket inference request
  Proxy->>OpenAI: Fixed Responses endpoint + injected access credential
  Actions->>Worker: Bounded, DLP-gated result
  Actions->>Worker: Separate publishing job + publishing-stage OIDC
  Worker->>GitHub: Revalidate; reconcile pending review; submit verdict
  Worker->>GitHub: Optional independently guarded merge
```

`core` owns parser, policy, schema, crypto and deterministic DLP. `auth` owns official SIWC and protected local files. `worker` owns authorization, durable dispatch, publishing and merge reconciliation. `runner` owns collection, Docker isolation and official Codex JSON-RPC. `setup.ts` creates atomic setup commits; the CLI performs local authentication and credential provisioning.

## Required-first immutable context

Each immutable commit is resolved through Git Commits to its tree SHA. Nonrecursive tree requests walk only needed directories; trees and verified Git blobs are cached by SHA within that authorized collection. There is no cross-tenant cache or full recursive repository download. Changed base/head content (including rename/delete locations) and applicable default-branch AGENTS.md files precede root manifests/README, nearby tests and up to 256 essential direct literal JS/TS local dependencies across base/head (including new imports). Nonrelative/dynamic resolver semantics are not exhaustively reconstructed; model completeness must reflect remaining uncertainty.

The manifest distinguishes `diffComplete`, `requiredContextComplete` and supplementary selected/omitted coverage. Approval needs both required signals and complete model analysis. Unrelated omitted files do not make a small PR incomplete. Missing/truncated/special/oversized essential text or unsupported binaries do. Verified base/head PNGs are supplied as official localImage inputs to an image-capable model. The proxy verifies actual image inputs; incomplete visual analysis remains non-approving. Image findings use a null line and appear in the summary, while text findings still require actual changed lines. Unsupported binaries remain fail-closed. Limits: 200 changed files, 512 KB per text blob, 16 MB source, 6 MB diff, 768 collector API calls and 120-second initial collection, including a final exact-head/base recheck. UTF-8, paths, Git object types, blob sizes and Git blob hashes are verified. No checkout/hooks/project installation occurs. Tests in the reviewed repository are inspected, never executed.

## Isolated inference

Nonroot Docker containers use read-only root filesystems, resource caps, no capabilities, no-new-privileges and private temporary homes. The reviewer has network=none and only context/socket read-only mounts. It has no Docker socket, GitHub/OIDC token, API key, refresh token or vault key. A separate audited proxy owns the access credential, only permits stateless streaming Responses inference at one HTTPS route, rejects hosted network tools, pins model/effort/service-tier selection and replaces provider errors. Default limits are 100 requests and a 20-minute turn. The host owns CLI-session refresh and all context GitHub access. Approved hosted-session refresh stays on the Worker behind OIDC and leases.

Codex 0.169.0 uses `approvalPolicy: never` for unattended inspection. The thread's read-only default remains, and each review turn explicitly selects `externalSandbox` with restricted network, relying on the unchanged Docker boundary. `never` is not a client approval grant: all server-initiated approval/tool/permission requests still receive JSON-RPC -32601 and cause the analysis to fail. Native declined commands also fail. At least one completed command with exit 0 is necessary before a turn can produce a review; this is execution evidence, not proof of full semantic coverage. Both the isolated entrypoint and trusted host validate completeness, exact head and changed-line references. Incomplete/quarantined/truncated/inconclusive output fails the review job; the protected publisher can still publish a non-approving fallback.

## Durable identity and side effects

D1 receipts distinguish receipt/processing/retryable/done/failed. A request stores a dispatch-attempt UUID before the external POST. Workflow run names contain request plus attempt UUID; reconciliation verifies run identity, App actor, repository, event and immutable workflow SHA. Lost dispatch responses remain usable: prepare accepts an authorized created/dispatched request. A run-ID CAS admits one runner. A bounded resend can launch an extra trusted workflow after ambiguous provider failure; its prepare is denied once another run wins. Distributed exactly-once dispatch is not claimed.

OIDC verifies signatures/JWKS, issuer/audience/time, repository and owner IDs, default ref/event, caller workflow SHA, pinned reusable workflow SHA, GitHub-hosted runner, Environment subject/stage and live run/attempt/App identity. Prepare permits one identical same-run transport retry; review-job reruns require a new authorized command. Results are immutable and identical resubmissions are acknowledged.

Public output is scanned before runner stdout, backend persistence and GitHub writes. A valid transport result is at most 60 KB; HTTP allows 66 KB and Docker stdout 100 KB. Bounded text reduction preserves finding severity/location and marks information loss; it cannot approve. Suspicious candidates produce only a fixed inconclusive report, with no raw quarantine artifact.

Publishing has leases, checkpoints and bounded retries. A GitHub pending review is created before submission, then resumed by its App-owned request/head/fingerprint marker after an ambiguous write. Review submission and merge intent are separate durable steps. Ready PRs use GitHub's expected-head native merge. Pending CI requires an App-bound required guard; it remains pending while the backend rechecks humans, credentials and policy. The native intent is disabled before guard release; final merging repeats authorization. Conflicts, unknown evidence and merge queues require manual action. No bypass rights are supported.

See [operations](operations.md), [security](security.md) and [acceptance](acceptance.md) for failure handling, limitations and release gates.

## Adaptive context and browser management

The collector also writes a supplementary regular-file index (12 directories / 5,000 paths, no recursive tree dump). Explicit Python relative imports and Rust sibling modules join JS/TS dependencies; nearby Python/Go/Java test names are considered. A separate host Unix socket accepts only bounded base/head path requests for this authorized immutable repository. It never forwards arbitrary URLs, executes project code or exposes credentials. At most 24 requests share the existing byte/blob/API limits and per-SHA cache. Requested files that cannot be obtained invalidate completeness. The reviewer mount stays read-only and network=none. The read token now lasts through bounded context exploration; shutdown cancels/drains lookups and revokes it before temporary source cleanup. Failed token cleanup fails the review job.

The system prompt asks for introduced, evidence-backed bugs traced through unchanged callers and dependencies, with trusted default-branch guidance subordinate to execution/output safety. Additional comment context is advisory. The model/effort CLI precedence is unchanged; a generated pinned-native catalog powers dashboard validation and distinguishes catalog membership from account entitlement.

Browser auth, repository management, durable provisioning states, exact-base policy PRs and the explicit hosted decryption boundary are documented in [ADR 0001](web-onboarding.md). Migration 0004 is additive; existing CLI envelopes keep their AAD and keys. Native review receipt fingerprints/event policy are unchanged; human-readable summaries replace mechanical status/merge-noise text.
