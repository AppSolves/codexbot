# CodexBot

An Apache-2.0 GitHub App for Codex pull request reviews on repository-owned GitHub Actions runners. The Cloudflare Worker authenticates requests and publishes native reviews; it never runs Codex.

Hosted backend: **[https://codexbot.appsolves.workers.dev](https://codexbot.appsolves.workers.dev/)**. This is the CLI and generated-workflow default. The hostname migration is staged; production availability and credential acceptance must be verified during the [operator cutover](docs/origin-migration.md). Independent installations pass their own HTTPS origin with `--backend`.

```text
@CBReview review --effort xhigh --merge

Review authentication, authorization, migrations and compatibility.
```

Configure a trigger plus up to five aliases matching `@[A-Za-z0-9]{1,39}`. Matching ignores case. These are text commands and can notify unrelated GitHub users with the same name; choose distinctive aliases. Quoted examples and fenced commands do not trigger reviews. Model and reasoning effort are separate; omitted effort preserves Codex's default.

Use `--model MODEL_ID` (or `--model=MODEL_ID`) to override the repository's model for one review; replace MODEL_ID with an available Codex catalog identifier. An unsupported model or effort fails without substitution or billing fallback. Missing inspection, incomplete context or an inconclusive result fails the review job while the separate publisher may still publish a safe COMMENT.

Set `bot.trigger: "@CBReview"` to use the example above. The legacy default `@codexbot` remains supported; new setup chooses `@CBReview<repository_id>`. Use a name without “codex” when another Codex integration is installed. CodexBot cannot control that independent connector; see [trigger isolation and rollout](docs/review-rollout.md).

## Status

**Pre-release; full production review acceptance remains pending.** Unit/integration tests exercise signed webhooks, official OAuth contracts, OIDC, actual SQLite persistence, setup PR creation and GitHub publishing against mocked external APIs. The pinned official Codex binary is tested without credentials. A separate Docker check uses synthetic inference; it does not claim to have performed a real AI review. See [validation and live acceptance](docs/validation.md).

Live GitHub installation, real OpenAI inference/allowance, OAuth eligibility and Cloudflare production resource usage require operator credentials and acceptance testing. Do not market this as battle-tested or deploy with automatic merge before completing those checks.

## What is implemented

- Public GitHub App installation/onboarding page, signed webhook intake, installation suspension/deletion handling and replay protection.
- Configurable handle and command parser, default-deny whitelist/blacklist policy, RE2 matching, live GitHub identity/permission checks, separate merge policy.
- ChatGPT OSS OAuth with PKCE, state, nonce, issued-client/account validation, encrypted session provisioning, persistent host IDs, serialized refresh and token rotation/revocation.
- Independent personal API-key mode; no billing fallback between modes.
- Official Codex app-server, model-catalog effort validation and JSON-schema output validation.
- Read-only, resource-limited review container with **no network namespace connectivity and no credentials**. A Unix-socket proxy injects credentials only into fixed OpenAI Responses requests.
- Separate publishing job, native inline reviews, exact-commit checks, conservative approvals, and explicitly requested native exact-head merge; pending CI is held behind an App-bound required check and durable intent.
- App-authored setup PR when Workflows permission is granted; a temporary user-credential setup alternative and manual installation.

## Quick start

Requirements: Node 24+, GitHub CLI (`gh auth login`), a GitHub App/Worker deployment, a protected default branch, and GitHub-hosted Ubuntu runners with Docker. The onboarding CLI currently requires repository administrator access to create/protect credential Environments. Windows/macOS can run onboarding; production review orchestration runs on Linux.

```sh
npm ci --ignore-scripts
npm run check
```

1. Operators: follow [deployment](docs/deployment.md) to register your own public App, configure its Worker and choose an immutable source commit. Independent installations use their own Worker and App exclusively.
2. Install the App on selected repositories. Open its setup URL.
3. Create the setup PR (replace the uppercase values):

```sh
npm run cli -- setup --repository OWNER/REPO --backend https://codexbot.appsolves.workers.dev \
  --source AppSolves/codexbot --ref 4ed668864cac0682e09ec49a2515a6e1893a2780
```

The source must match the Worker's trusted reusable workflow. If you prefer a temporary personal setup token to granting the App Workflows write, add `--setup-as-user`; the user credential needs Contents/Pull requests/Workflows write. No files are overwritten. See [manual setup](docs/installation.md).

4. Choose authentication:

```sh
# Preferred, when your deployment is eligible for OpenAI's OSS/hosted policy:
npm run cli -- connect --repository OWNER/REPO --backend https://codexbot.appsolves.workers.dev

# Alternative: set CODEXBOT_API_KEY securely in your local process environment first.
npm run cli -- connect-api-key --repository OWNER/REPO --backend https://codexbot.appsolves.workers.dev
```

The ChatGPT flow displays **Continue with ChatGPT** and opens an official authorization URL using a loopback callback. Manual `auth.json` export is unnecessary. API-key mode requires `credentials.mode: api-key` in trusted configuration. Do not keep both mode secrets in the Environment.

5. Review and merge the setup PR. Configure whitelist/merge policies and an optional custom handle in `.codexbot.yml`. Protect both the default branch and credential/publishing Environments. Comment using the handle from your setup PR. New setup chooses `@CBReview<repository_id>` to reduce collisions; existing/manual `@codexbot` configurations remain supported.

Accepted requests receive one editable App-owned progress comment, separate from the native review. It shows verified commit/file counts, a request identifier, confirmed lifecycle/run status and the final native-review link. Temporary comment/API failures are reconciled without borrowing credentials or duplicating ambiguous POSTs. Image caching is opt-in pending measurement; [the rollout guide](docs/review-rollout.md) explains both controls.

### ChatGPT hosting restrictions

OpenAI documents dynamic registration for OSS/local integrations and a local-to-self-hosted credential transfer. **Paid/remotely hosted ChatGPT-plan integrations require additional OpenAI authorization.** This repository does not infer that ephemeral GitHub Actions or a centrally operated public service is automatically covered. The Worker rejects ChatGPT requests until the operator sets `CHATGPT_DEPLOYMENT_AUTHORIZED=true` after establishing deployment eligibility. See [authentication](docs/authentication.md) and the [official OSS guide](https://developers.openai.com/siwc/token-sharing-open-source).

That gate does not affect API-key mode. The Worker has no OpenAI key and cannot spend the operator's personal allowance for users.

## Configuration

See [the reference](docs/configuration.md) and [example](examples/codexbot.yml). Configuration comes from the default branch, never the PR. A clean, complete result can approve; sufficiently confident high/critical findings request changes; uncertain, incomplete or advisory results comment. Quotas, cooldowns and explicit bounded --rerun prevent repeated unbounded reviews. Automatic reviews and merge are opt-in. `--merge` cannot bypass GitHub protections.

## Development and security

[Architecture](docs/architecture.md) · [Threat model](docs/security.md) · [Development](docs/development.md) · [Validation](docs/validation.md) · [Security reporting](SECURITY.md) · [Contributing](CONTRIBUTING.md)

AI review can miss defects and is vulnerable to semantic prompt manipulation. Isolation protects credentials and GitHub capabilities; it cannot prove that a model's clean verdict is correct. Keep independent required CI and human review rules. Context limits intentionally disable approval when coverage is limited.

## Security remediation and release gates

See [the per-finding matrix](docs/remediation.md), [changelog](CHANGELOG.md), [migration/recovery runbook](docs/operations.md) and [live acceptance](docs/acceptance.md). Durable outbox/publication recovery, installation-bound session encryption, required-first context and deterministic output quarantine are implemented and locally tested. Existing OAuth sessions require reconnect after migration 0002.

Both hosted ChatGPT eligibility and actual provider/GitHub acceptance remain external gates. MERGE_DEPLOYMENT_AUTHORIZED defaults false independently of repository policy. Initial smoke is advisory/no-merge. Private GitHub Free repositories lack the supported credential Environment path; merge queues are manual-only. No deployment or paid inference is performed by local checks.
