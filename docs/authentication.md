# Authentication and credential ownership

The hosted canonical origin is `https://codexbot.appsolves.workers.dev`; independent operators explicitly select their own origin. OAuth AAD includes this exact origin, installation, repository and actor, and local profile files are separated by backend host. Existing ChatGPT connections require [safe revocation and fresh sign-in](origin-migration.md#chatgpt-reconnection) when the origin changes. Do not copy profiles, rebind ciphertext or accept both OIDC audiences during a cutover. API-key mode keeps its existing owning Environment; it does not have OAuth ciphertext to migrate.

Reusable callers must use explicit named secret references after the environment-free `credential-scope` guard rejects nonempty repository/organization credentials under either name. The called installation/actor Environment supplies the actual credential. Literal empty grants do not enable Environment secret resolution. Named references alone would permit a global-secret fallback if an Environment secret were missing; keep the guard and its required dependency. [Credential diagnostics and rollout](review-rollout.md) explain the GitHub contract and no-inference check. No reusable-workflow/Worker pin or session format changes are needed for this caller-only correction.

## Official ChatGPT OAuth

CodexBot uses the documented OSS public-client flow, not a borrowed Codex client ID or an undocumented ChatGPT endpoint. [Registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and [deployment transfer](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) define the contract.

The CLI listens on `127.0.0.1` before showing **Continue with ChatGPT**. Every attempt has fresh state, nonce and S256 PKCE. It uses `dynamic_agent_client` only for first registration, validates the returned issued ID, exchanges the code with that issued ID, checks the ID-token signature/issuer/audience/expiry/nonce, and binds the validated subject to its issued client/workspace registration. Returning sign-in checks identity before replacing credentials. All identity and plan scopes are required: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. The callback's scope parameter is never proof of granted permission.

Profiles are separated by backend origin, numeric repository ID and numeric GitHub user ID under `~/.config/codexbot/`. Local and remote host UUIDs are persisted separately. The remote host ID is retained across reconnects, rather than copied from the laptop. The issued client identifies its selected account/workspace; email is display information. A provisional issued client is retained through a failed code exchange but never treated as an authenticated account. Attempts are consumed once. Current entitlement to the selected model is established by completed inference. Codex's bundled model catalog cannot establish it.

The selected session is AES-256-GCM encrypted locally with a per-profile 256-bit key, rotated on disconnect. Associated data v2 binds backend origin, live installation ID, repository ID and actor ID. Migration 0002 requires reconnect; old envelopes cannot be silently rebound. Only ciphertext goes to D1; the key goes to the user's `codexbot-INSTALLATION_ID-NUMERIC_USER_ID` GitHub Environment Secret `CODEXBOT_VAULT_KEY`. This is encryption, not Base64 obfuscation. The CLI removes its token copy after provisioning and retains registration/host/key metadata. Back up encryption keys appropriately. Unix writes use 0600/0700; Windows uses a protected DACL granting only the current user access and fails if that cannot be applied. State files are replaced atomically.

Actions authenticates by OIDC and can retrieve only the requesting user's ciphertext. D1 leases serialize the session for an hour, in addition to repository workflow concurrency. A rotating refresh token and its expiry/scopes are encrypted and durably version-checked **before inference starts**. A failed/uncertain exchange or persistence conflict requires reconnection; there is no fallback to paid API billing. A cancelled workflow can leave a lease until its one-hour expiry; do not break it while a runner may still be active. Loss of the rotated token after the provider has consumed the old one cannot be made atomic across providers: reconnect using the saved registration.

The app-server uses the official Responses provider contract. A separate credential proxy performs bearer injection so app-server's model/tool process never receives access/refresh tokens. Streaming and `store:false` are enforced. The proxy restarts for every review; tokens are renewed beforehand for the maximum review duration. [Preview constraints](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) apply.

### Hosting eligibility

The OSS guide distinguishes local/OSS deployment from paid or remotely hosted apps requiring additional authorization. It does not explicitly grant a public centrally hosted service or ephemeral Actions workloads permission merely because its code is open source. Operators must resolve that deployment eligibility with OpenAI. Set `CHATGPT_DEPLOYMENT_AUTHORIZED=true` only after confirming the intended topology is authorized; defaults deny it. There is no hosted website OAuth workaround. A registered commercial website integration is a separate approval/integration and is not implemented here. API-key mode works independently.

### Disconnect and revoke

```sh
npm run cli -- disconnect --repository OWNER/REPO --backend https://YOUR-WORKER
```

The CLI obtains the latest encrypted rotating session, decrypts it locally and uses the discovery-provided revocation endpoint. It clears the remote record and local token state, rotates the local vault key, and removes both CODEXBOT_VAULT_KEY and CODEXBOT_API_KEY if present in your Environment. Revoke removed API keys in OpenAI settings separately; the user key cannot perform its own administrative revocation. It retains issued-client/account and host metadata for reconnection. If remote revocation cannot be confirmed, the CLI says so; disconnect the app in ChatGPT Settings. Deleting a GitHub installation deletes its encrypted sessions/requests but cannot revoke tokens the Worker cannot decrypt. Revoke ChatGPT access in Settings after uninstalling. Do not rely on host-specific revocation for transferred sessions, which OpenAI documents as limited.

To switch to another ChatGPT account/workspace, disconnect first, then run `connect --new-account` with the same repository/backend arguments. A separate provisional registration is retained through failed attempts; the previous registration is not replaced until the new identity is validated. Normal `connect` reuses the existing issued client and checks the same subject. The CLI displays the verified account and registration after a successful connection.

### Legacy `auth.json`

Native Codex CLI `auth.json` and dynamically registered SIWC sessions are different credential formats/audiences. No legacy CLI file is imported into the SIWC Responses route. This repository deliberately does not reinterpret those tokens, borrow the native CLI client ID, or expose a native auth file inside the reviewer. A legacy bridge with the same credential isolation is **not implemented**. Use the supported browser OAuth flow; it does not require manual token export. This limitation must remain visible until an officially supported, isolated bridge is verified.

## Personal API key

Set a personal key in the CLI process environment, then run `connect-api-key`. The CLI passes it to `gh secret set` through stdin, never command arguments or the Worker. Select `credentials.mode: api-key`. Only the triggering numeric user's Environment Secret `CODEXBOT_API_KEY` is used. Keep this separate from `CODEXBOT_VAULT_KEY`; ambiguous credentials are rejected. The same app-server, sandbox, schema validation and publishing pipeline are used. The proxy receives the key; reviewer processes do not. API usage is billed independently of subscriptions.

Currently a repository administrator provisions each credential Environment. Other contributors require administrative onboarding; the bot never borrows another user's Environment. Fork PRs use the **base repository's** trusted workflow and the authorized triggering user's base-repository Environment, never fork secrets or fork workflow code.


See [the migration and recovery runbook](operations.md) and [real-provider acceptance](acceptance.md). A revoked/unsupported Environment does not prevent deleting a remote session, though GitHub secret cleanup may still require restored feature/permission access. Credential preflight happens before OAuth sign-in. No local/mock check marks the hosted or non-API-billed inference gate as passed.


Credential Environments include installation and actor IDs in both authentication modes. Reinstalling or installing an independent App never automatically reuses the prior Environment's API key. Provision a distinct key explicitly for the new installation. Remove old namespaces manually after uninstall and revoke their provider credentials; the Worker deliberately has no Environment-secret management permission. Disabling the deployment gate is rechecked at preparation, rotation/result and publication, while release/disconnect remain available.
