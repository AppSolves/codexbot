# Security policy

This is a pre-release security-sensitive integration. Do not send credentials, private repository content or token dumps in public issues.

For a vulnerability, use GitHub's **Report a vulnerability** private advisory on the repository hosting your installed release. If its operator has not enabled private reporting, ask that operator for a private reporting channel without posting exploit details. Each independent self-hosted installation is administered by its own operator.

Include the affected immutable release, boundary violated, a minimal fixture-based reproduction and expected/actual behavior. Do not probe other installations or spend another user's quota. See [the threat model](docs/security.md).

If a credential is exposed: stop workflow dispatch, revoke the credential with its provider, suspend the affected installation if needed, rotate App/webhook keys or Environment secrets as appropriate, and inspect authorized metadata privately. Removing a log or git commit does not revoke credentials or erase previous disclosure.

Recovery and release gates: [operations](docs/operations.md), [acceptance](docs/acceptance.md), [finding evidence](docs/remediation.md). The deterministic local output scanner reduces leakage risk but cannot detect all secrets or encodings. A clean AI verdict is not a security guarantee; required CI and repository protection remain enforced; independent human review is configurable, and any GitHub human-review requirement still applies. Disable/cancel App-owned auto-merge in GitHub during an incident; stopping the Worker alone does not cancel a previously enabled native intent.

Browser-managed OAuth introduces an explicit trusted Worker decryption boundary; CLI vaults retain their existing isolation. See [hosted security and key management](docs/web-onboarding.md). Report website/session/CSRF/provisioning issues privately. Include only fixed error codes and synthetic reproductions; never submit callback URLs, browser cookies, exported D1 credentials or raw traces.
