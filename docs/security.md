# Security and trust boundaries

Untrusted data includes PR/fork code, comments, prompts, model output and API metadata until validated. Trusted components are protected default-branch/release code, repository administrators, GitHub/Actions/OIDC, the Worker/D1 operator, pinned dependencies, Docker/kernel isolation and OpenAI's official endpoints.

| Boundary | Control | Residual limit |
|---|---|---|
| Webhook sender/replay | HMAC over bounded exact bytes, delivery/digest uniqueness, freshness, live permission and immutable PR check | Compromised webhook secret must be rotated |
| Dispatch reliability | Durable receipt/outbox, stable attempt, verifiable run-name reconciliation, bounded leases/backoff | GitHub dispatch has no exactly-once key; an extra trusted workflow may start, only one may prepare |
| Cross-installation sessions | Installation/repository/actor primary key, installation-bound AES-GCM AAD, live installation checks, lease and CAS | Rotation/persistence cannot be atomic across OpenAI and D1; reconnect after uncertainty |
| Forged workload | RS256 issuer/audience/time/JWKS, repository/owner IDs, caller/reusable SHA, GitHub-hosted runner, Environment subject and live App-authored attempt/run | Custom OIDC subjects/self-hosted runners are unsupported |
| PR changes trusted policy | Protected default revision snapshotted and rechecked; no PR checkout/execution on host | Administrators/default-branch workflow writers remain trusted |
| Model credential theft | Token-free read-only reviewer, network=none, isolated fixed-route proxy, no host/Docker socket, no inherited credential env | Model may disclose inspected source to the explicitly allowed OpenAI endpoint |
| Public output leakage | Local deterministic scan over every candidate field and bounded decoding; quarantine before transport/storage/writes | No scanner detects all secrets or semantic encodings |
| Result replay/publication | Immutable result, exact head/base/diff validation, pending native review, App-owned markers, separate leased steps | API/provider failures can require bounded operator reconciliation |
| Merge escalation | Explicit flag, separate live authorization, minimum independent humans, no bypass, expected head, protected branch, pending guard | External GitHub settings and multi-API races remain part of the trusted boundary; acceptance gate defaults closed |
| Resource abuse | Atomic sliding quotas, cooldown/concurrency, bounded rerun, RE2, body/source/output/API caps and container limits | Production Free CPU/subrequest capacity requires measurement |

## Credential ownership

The Worker alone holds the GitHub App private key. Installation tokens are minted for one numeric repository and exact operation. The reviewer cannot publish reviews or merge. Only the host collector receives a read token, revokes it before inference and mounts inert source. Publishing uses a separate job and backend authority. Every human uses their own GitHub Environment and OpenAI credential. Neither hosted operators nor other tenants supply fallback quota.

Environment Secrets are not cryptographically limited to one workflow. Repository administrators and writers able to change trusted workflow/Environment policies can expose them. Restrict workflow/default-branch writes, Environment deployment branches and source-release changes. A malicious operator can replace trusted reusable code; reviewed immutable pins and operator trust are necessary. Stronger separation requires separately administered repositories/installations.

The host decrypts and refreshes OAuth; the model receives neither refresh token nor vault key. Ciphertext AAD v2 includes backend origin, installation, repository and actor. Base64 is encoding only. Owner-only local files use Unix modes or protected Windows DACLs. No raw provider errors, credentials, source, prompts or results are logged or uploaded as Actions artifacts/caches. HTTP/APM tracing must not capture bodies/headers. Worker logs contain fixed codes and numeric operational identifiers; invocation logging is disabled and traces sampled. Do not rely on GitHub masking transformed/refreshed tokens.

## Output policy and limits

The versioned local RE2 scanner covers OpenAI/GitHub/AWS/vendor tokens, JWTs, private-key headers, credential-bearing database URLs, bearer/basic credentials and common secret assignments. It examines summary, titles, explanations, remediation, paths and all other JSON metadata before any public write. It normalizes Unicode and scans bounded whitespace/escaped-newline, percent and base64 variants to depth three. Candidates exceeding scanner expansion bounds are quarantined. External URLs are also quarantined to prevent Markdown/autolink/image exfiltration. Only category IDs, never matched content, are returned internally.

A suspicious candidate is replaced wholesale by a fixed incomplete COMMENT result; raw suspicious text is not retained in telemetry, artifacts or backend results. Ordinary output also escapes HTML/mentions/Markdown. This intentionally conservative policy can quarantine benign examples/links. It is not a guarantee: arbitrary fragmentation, encryption, unknown vendor formats and semantic disclosure can evade deterministic scanners. Reviewers must still avoid sensitive source disclosure and operators must treat source sent to OpenAI as a deliberate data transfer.

Model schema and trusted transport flags are separate. Up to 40 findings are accepted; normalized output is at most 60 KB. Oversized text is reduced deterministically, preserving severities/locations when possible, and information loss disables approval. If a safe bounded representation is impossible, publish only a generic incomplete report. Malformed, truncated, binary, symlink, submodule, unknown-object or essential-context failures never approve. Low-confidence high-severity findings require manual review, never approval by omission.

## Merge and recovery

Required human approvals are counted independently of bot approvals, exclude the author, require the exact head and current write permission, and honor the larger configured/branch/ruleset minimum. Unknown/failed checks, conflicts and missing evidence cannot merge. Pending CI can enable native auto-merge only with an App-bound required guard which stays pending. The backend cancels that native intent before releasing the guard and performs a separately reauthorized expected-head merge. New heads cannot inherit the old successful guard. Merge queues are never bypassed and require manual action.

Do not grant the App branch/ruleset bypass rights. Its native approval is not evidence that repository tests ran or that code is secure. Independent CI and human review remain required. OAuth deployment permission and merge live acceptance are separate external release gates. See [acceptance](acceptance.md), [operations](operations.md) and [authentication](authentication.md).
