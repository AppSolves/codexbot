# Browser onboarding and hosted credential boundary (ADR 0001)

Status: implemented behind `WEB_ENABLED=false`; activation requires the registered OAuth configuration and operator rollout below. The existing production review pipeline is preserved. No claim of live website OAuth acceptance follows from local tests.

## Decisions

Use the existing Worker and D1, with server-rendered HTML, ordinary forms and a small same-origin theme/loading script. There is no browser token store, frontend API credential, separate configuration database or external onboarding SaaS. GitHub remains the authority for installations, repository administration, protected Environments, workflow/configuration files and setup PRs.

The visual direction is an understated code-review desk: warm paper / deep green themes, serif editorial headings, compact monospace metadata, readable native forms and a single illustrative diff. Responsive layouts and keyboard behavior are checked in Chromium; theme selection stores no browser data.

The browser flow is: GitHub sign-in → native App installation/selection → live authorized repository list → capability/admin/protection checks → protected Environments and an atomic setup PR → ChatGPT or API-key connection → reviewed PR merge → live readiness check. Existing repositories are reconciled without migration. Policy and workflow repairs create minimal update PRs against an exact default-branch commit. A concurrent edit rejects the proposal; no force update or protected-branch write is supported.

## Registered configuration and activation

The existing public App's client ID and Workflows/Administration/Environments write grants were checked through the public GitHub API. OpenAI application approval is operator-confirmed. Its website client ID, callback registration, client type/authentication method, inference scopes and signed workspace claim have **not** been provisioned in this repository or Worker. They must come from the application's actual approved registration. Identity-only SIWC is insufficient.

| Setting | Required value / purpose |
|---|---|
| `PUBLIC_URL` | Exact HTTPS origin without trailing slash; self-hosters use their own origin |
| `GITHUB_CLIENT_ID` | This GitHub App's OAuth client ID, not its numeric App ID |
| `GITHUB_CLIENT_SECRET` | Worker secret for server-side code exchange |
| `WEB_SESSION_KEY` | Separate 32-byte base64url Worker secret; protects browser tokens, transactions and hosted key records |
| `OPENAI_WEB_CLIENT_ID` | Actual approved website client ID; never `dynamic_agent_client` or another application's client |
| `OPENAI_WEB_AUTH_METHOD` | Registered `none`, `client_secret_post` or `client_secret_basic` |
| `OPENAI_WEB_CLIENT_SECRET` | Worker secret only for a confidential website client |
| `OPENAI_WEB_SCOPES` | Actual approved grant including `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `OPENAI_WEB_WORKSPACE_CLAIM` | Exact signed ID-token claim **from the approved scope contract** identifying the workspace; no guessed claim or default workspace |
| `CHATGPT_DEPLOYMENT_AUTHORIZED` | Existing operator authorization gate; remains enforced |
| `OPENAI_HOSTED_INFERENCE_AUTHORIZED` | Explicit attestation that this registered website client is approved for plan inference on this topology |
| `WEB_ENABLED` | Set true only after secrets, registration, migration, trace privacy and staged acceptance are verified |

Add `OPENAI_WEB_WORKSPACE_CLAIM` to Wrangler vars using the provisioned claim name. Do not guess it from an unrelated token. A missing/mismatched signed workspace claim fails closed. If the approved provider contract uses a different workspace representation, review that exact contract before adapting validation. Model entitlement still needs owner-authorized inference acceptance.

GitHub App settings: homepage `/`; user authorization callback `/auth/github/callback`; setup URL `/dashboard`; webhook `/webhook`. Use `request_oauth_on_install=false` and `setup_on_update=true` so GitHub's native setup redirect is distinct from OAuth. Setup return parameters are hints, reconciled with the signed-in user's installation API. OpenAI callback: exact `/auth/openai/callback` on the same registered origin. No loopback-to-website redirect substitution is used.

Workflows write updates workflow files; Administration write creates/protects Environments; Environments write provisions encrypted Environment secrets. The installation must actually have each grant, and the user must currently administer the repository. Environment mutations use the App user token's intersection with that administrator's authority; the separate setup installation token has only Contents/Pull requests/Workflows write. Ordinary review/publish tokens do not receive these setup privileges. Permission upgrades need native GitHub installer consent; code does not change live registrations. Public repositories support Environments on Free; private repositories need appropriate Pro/Team/Enterprise features and admin access. Failed feature probes never trigger a repository-secret fallback.

## Browser and OAuth security

Migration `0004_web_onboarding.sql` adds only web tables. Random state hashes and browser-cookie hashes bind ten-minute transactions; atomic DELETE RETURNING consumes callbacks once across Worker instances. PKCE, nonce and exact redirects are verified. OpenAI discovery endpoints stay on the official issuer; jose verifies RS256 signature, issuer, audience, authorized party, expiry, nonce, subject and the registered signed workspace claim. Missing granted plan scopes fail. Confidential client authentication never enters the runner.

Browser sessions have independent random IDs, hashed D1 lookup keys, encrypted GitHub access tokens and at most one hour lifetime (bounded by provider expiry). Login rotates the session and removes its prior row. Tokens are never returned to JavaScript, storage, comments or artifacts. Each authenticated request rechecks GitHub identity; privileged repository actions additionally check live admin authority, numeric repository/installation identity, suspension and permissions. Logout removes the browser session. Each request invalidates its own session if live GitHub authorization fails; delayed/replayed authorization-revocation webhooks never delete a newly reauthorized session merely by actor ID. Cookie flags are `__Host-`, Secure, HttpOnly, SameSite=Lax and Path=/. State-changing forms require both the exact Origin and session CSRF token. Application CSP permits only same-origin scripts/styles/forms and forbids framing and base overrides. HTML uses Referrer-Policy same-origin so real browser forms retain a verifiable Origin; OAuth callback redirects use no-referrer and remove code/state on both success and failure.

Authentication endpoints are limited to 20 starts per hashed IP bucket per ten minutes. Mutations are limited to 30 per actor, dashboard reads to 60, and setup/configuration proposals to 5 per actor/repository per ten minutes. Existing review quotas remain independent. Expired sessions, transactions, rate buckets and operation leases are removed by the existing cron. Installation/repository removal deletes only that tenant's web connection/operation state; every subsequent action still checks live GitHub access.

## Explicitly changed credential trust

**CLI connections:** unchanged v2 AES-GCM binding (`origin|installation|repository|actor`); the Worker has no vault key for them. They are not silently converted. Disconnect explicitly before changing connection management mode. CLI mutation endpoints reject attempts to overwrite browser-managed connections; use the dashboard for those.

**Hosted connections:** the Worker exchanges tokens and necessarily observes them transiently. It generates a separate repository/installation/actor vault key, encrypts the renewable session with existing v2 AAD, and uses the GitHub encrypted-secret API to put only the vault key into the owning protected Environment. NaCl sealed-box interoperability is checked independently with libsodium. The hosted key and pending provisioning journal are themselves AES-GCM encrypted under `WEB_SESSION_KEY`, with distinct origin/installation/repository/actor AAD. Thus the operator has persistent **decryption capability** for browser-managed sessions, unlike CLI sessions. D1 contains no plaintext keys or tokens. This is an explicit new trusted backend boundary, not a claim that central decryption is impossible.

The reviewer still has network=none, read-only context and no credentials. The credential proxy gets only the execution access credential. The host can decrypt its owning encrypted session using its protected Environment key. Hosted refresh is performed through the new OIDC-bound `renew` operation, so confidential client secrets never leave the Worker. Existing issuer/audience/Environment/run/actor/dispatch/immutable-workflow checks apply, followed by live review authorization and protected branch checks. Refresh takes both a repository operation lease and the existing session lease, then persists token rotation with version CAS and an atomic operation-owner predicate in the same SQL update before inference. Hosted journal/session writes are likewise fenced by the operation lease; a separate preceding check is not treated as a substitute for that predicate. An uncertain exchange remains `refreshing` and requires reconnection; it is never blindly replayed. A trusted proxy-reported HTTP 401 marks the hosted connection reconnect-required, preventing further preparations while preserving non-approving fallback publication.

Provisioning stores an encrypted pending journal before a GitHub write. A lost secret-write response resumes with the same vault and token set through “Resume pending connection”; it never redeems the OAuth code again. Existing session leases prevent replacing credentials during active reviews. CLI save/delete/acquire paths also respect active web-operation leases. Reconnection retains host identity and verifies the prior subject/workspace unless the administrator explicitly consents to switching accounts. Accounts remain independent per repository and actor; nothing borrows another user's allowance.

Disconnect first prevents new execution, attempts renewable-session revocation, removes only the two owning CodexBot Environment secrets and clears the hosted key record. If remote revocation cannot be confirmed, the UI directs the user to ChatGPT Settings. API-key disconnect removes the Environment copy; users revoke the key itself in OpenAI settings. Before removing installation/repository access, disconnect credentials where possible; GitHub can no longer permit Environment cleanup after uninstall. Remaining Environment secrets and provider grants need owner cleanup. Repository disablement is a reviewed configuration PR; removal uses GitHub's native selection flow.

Do not rotate `WEB_SESSION_KEY` casually: losing it prevents decrypting browser tokens and hosted key records. Back it up separately from encrypted D1 backups. For a planned rotation, quiesce browser mutations/reviews, re-encrypt those three web payload tables under the old/new master with their existing AAD in an operator-reviewed migration, or explicitly disconnect/reconnect hosted accounts. Do not change CLI vaults. For compromise, revoke provider/GitHub grants and invalidate browser sessions before restoring service; ciphertext deletion is not credential revocation.

## Observability and rollout

Automatic Cloudflare traces capture full request URLs/query metadata, including callback codes. The operator explicitly authorized disabling automatic traces for web OAuth; structured safe logs remain enabled and invocation logging remains off. Do not re-enable automatic tracing or URL/body/header capture around auth. There is no scanning SaaS, browser analytics or raw provider/stderr logging.

1. Review/merge source PRs through normal protection; do not deploy from an unmerged or guessed revision.
2. Apply additive migration 0004 **before** the new Worker; old backend code can run against the expanded schema.
3. Obtain actual OAuth website registration values and exact callback/usage contract. Provision Worker secrets through Wrangler's protected input, never chat or git. Confirm App installation consent and branch protection.
4. Deploy the reviewed Worker initially with `WEB_ENABLED=false`, merge disabled and existing credentials preserved. Do not invoke `renew` from an older runner.
5. After the final source merge is known, coordinate Worker TRUSTED_WORKFLOW, exact backend-test expectation and each caller jobs.review.uses to the **same actual source merge SHA**. Keep the named secret references and environment-free guard. Temporary mismatches must fail closed; never add a second audience or mutable pin.
6. Activate browser onboarding only after registration, privacy configuration and local checks pass. In a disposable repository, complete browser GitHub/ChatGPT setup, verify native webhook delivery and run the existing credential-only OIDC diagnostic (no inference).
7. Only with separate owner permission perform advisory inference, explicit non-default model checks and native verdict acceptance. Keep merge off. A successful callback or mocked test is not a live entitlement or inference pass.

Rollback: set WEB_ENABLED=false through a separately authorized deployment to stop browser flows; preserve web tables and master key. Quiesce hosted reviews before rolling back runner/Worker protocol because old runners cannot refresh confidential website clients. Coordinate both immutable pins when reverting source. Existing CLI connections need no reconnect for this additive change. Never rebind origin AAD, drop the new tables, reset request state or revoke users as an implicit rollback.

## Acceptance matrix

| Scenario | Local evidence | External release gate |
|---|---|---|
| New public repository | Chromium → real workerd/D1: GitHub PKCE, setup PR, hosted OAuth/JWT, encrypted Environment provisioning, merge detection/readiness | Real registered clients, GitHub installation/PR/Environment acceptance |
| Existing repository | Live metadata/config reconciliation and existing CLI records preserved | Confirm an existing deployment shows accurate status |
| Additional/removed repository | User-scoped installation list, live numeric scope checks, existing lifecycle and tenant cleanup tests | Native organization/selected-repository install changes |
| Configuration change | Canonical schema, catalog/effort rejection, exact-base reviewed PR, active policy unchanged before merge | Review actual proposed diff and protected-branch behavior |
| Cross-file regression | Immutable index/lookup tests; native Codex reads unchanged caller hashes in Docker | Real AI recognition, old/revised prompt comparison on identical fixtures |
| Blocking native review | Full severity/confidence/completeness decision table and publisher API event tests | Disposable real REQUEST_CHANGES, COMMENT, APPROVE matrix |
| Revoke/reconnect | Refresh CAS/uncertainty, workspace/subject checks, disconnect and tenant isolation tests | Real provider revoke/limit/refresh behavior |
| Security isolation | HMAC/OIDC suite, browser CSRF/permission denial, real Docker network/write/secret checks | Operator security review and realistic capacity measurement |
| Model override | Parser/precedence/idempotency tests; catalog generated from pinned executable, no inference | Authorized non-default-model inference; account entitlement |

Browser providers are synthetic, while Worker, D1, crypto, forms, cookies and UI are real. Docker responses are scripted; actual pinned Codex tools/filesystem/sandbox execute. No local test proves live model quality or official hosted entitlement. Use existing opt-in provider acceptance for an owner-authorized real fixture; never enable paid API fallback to pass it.

## Coordinated post-merge pin preparation

After the **final runner-source PR** is merged through normal review, run:

```sh
node scripts/prepare-pin-upgrade.mjs --source AppSolves/codexbot --source-pr FINAL_SOURCE_PR_NUMBER --caller OWNER/REPOSITORY --check-only
node scripts/prepare-pin-upgrade.mjs --source AppSolves/codexbot --source-pr FINAL_SOURCE_PR_NUMBER --caller OWNER/REPOSITORY
```

The script refuses unmerged source PRs and derives the real merge SHA from GitHub. It verifies exact old immutable pins and named-secret/scope guards, reads files at immutable default-branch snapshots, then creates dedicated reviewed pin PRs in both repositories. It changes Worker TRUSTED_WORKFLOW, the exact backend-test expectation and caller jobs.review.uses only. Concurrent default-branch changes or divergent existing branches stop preparation. It never merges, deploys, touches secrets or runs inference. `--check-only` performs no GitHub writes. Public source PR descriptions contain no private caller metadata. Existing bootstrap callers keep the same environment-free guard, named references and backend URL.
