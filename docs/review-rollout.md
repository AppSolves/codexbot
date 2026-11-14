# Review reliability, credential forwarding and coordinated rollout

## Credential diagnosis

An Environment secret existing in GitHub is not proof that a called workflow receives it. [GitHub's reusable-workflow contract](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow) requires a named grant in the caller as well as the Environment on the called job. Both workflows must be updated together. CodexBot uses two optional named declarations and explicit empty caller grants. The Environment supplies the value; repository/organization keys are not forwarded. Never add `secrets: inherit` or move a user's key into repository secrets.

The review job checks for exactly one credential before checkout/install/build. A missing or ambiguous credential fails with a fixed JSON diagnostic. With `credential_check_only: true`, it then compiles the trusted client and verifies a read-only OIDC diagnostic; no image build, session lease, credential decryption, inference or publishing is performed. A passing check proves availability and the checked workload claims, not OAuth entitlement or privileged broker admission. Use a new UUID for the diagnostic request/attempt and the actual installation/actor IDs. Its caller must remain on the protected default branch allowed by the Environment.

The separate `/v1/workload/check` diagnostic requires a signed workload, the same exact caller/reusable/subject/Environment constraints, live repository administrator identity and the actual administrator-authored run. It returns only a fixed verification status. Its installation token is read-only and never returned. It does not read sessions, write D1 or authorize the review broker: manual user-authored runs still cannot prepare, rotate, submit or publish a review. Normal privileged routes continue requiring this App's exact dispatch actor/attempt/request identity.

For normal reviews the Worker still verifies signature, issuer, audience, subject, repository/owner IDs, caller SHA, reusable SHA, Environment, run and App/dispatch-attempt identity. JWT expiry, invalid tokens and unavailable JWKS now have separate safe codes. Broker errors retain only status and known machine codes from a bounded response. HTML, arbitrary provider messages, request headers, URLs and tokens are withheld. The runner logs fixed stage/code/status records; it does not report a session-release failure when prepare never acquired a session.

`/failure` and `/stage` require the same verified review workload. Failure reporting cannot alter another admitted run. Session release is conditioned on the actual run-binding transition. A failed review job cannot turn its stored output into approval during publisher retry: its context is durably non-approving. Review and publishing remain separate jobs; neither gives the model a write token.

## Progress and recovery

Migration 0003 adds comment identity, leased update state, verified workflow observations and sanitized failure metadata to requests. It does not change encrypted session AAD or require reconnecting existing credentials. New requests snapshot commit/file counts from GitHub's verified PR response; legacy requests explicitly report when counts were not recorded.

One top-level progress comment is created per accepted request. Repeated deliveries and reruns of recovery edit that same App-owned comment. Every update verifies App ID/login/type, exact request marker, repository and PR. Public text contains only fixed vocabulary and validated identifiers/counts/constructed GitHub links, never prompts, model output, source or internal error codes. The native inline review remains separate.

Updates are rate limited to fifteen seconds and each scheduled invocation handles one due operation. A separate two-minute progress trigger prevents dispatch/publication traffic from starving terminal comments; idle minute recovery can also reconcile progress. Run links/status come from exact App/attempt/SHA-bound GitHub run metadata. A published request continues observing the workflow until its actual completion is confirmed. Completed/cancelled/failed workflows without publication are finalized, and expired requests release leases during the same cleanup transaction. No invented percentage or fake analysis stage is shown.

Creation is intentionally at-most-one automatic POST after an ambiguous response. Recovery lists comments for the exact App marker instead of blindly resending. A crash before the POST can therefore leave an unresolved creation requiring operator attention. Known rejection responses may retry; deleted comments stay deleted. Five failed reconciliations exhaust automatic retries. GitHub permission revocation/removal can prevent remote finalization; restore access or handle the comment manually.

The repository-admin operations endpoint lists only status/IDs and sanitized failure metadata. To restart exhausted comment reconciliation:

```sh
npm run ops -- --repository OWNER/REPO --backend https://YOUR-WORKER --retry-progress REQUEST_ID
```

This shares the existing bounded operator retry budget, cannot reset an ambiguous creation to a fresh POST and cannot recreate deleted comments. A failed job that never entered the protected publishing stage cannot be operator-retried into publication; fix prerequisites and request a new authorized review instead.

## Cache cost and trust

`docker_cache` defaults false. A roughly 20-second cold build and the locally observed roughly 867 MB uncompressed image do not justify assuming that network cache import/export is faster. The opt-in path uses commit-pinned Actions, an exact Buildx version and a digest-pinned BuildKit image. Its GHA v2 scope includes repository ID, immutable trusted reusable revision and Dockerfile/lockfile/input hashes. The build context is the checked-out trusted source; no PR source, review output, credential, Docker build secret or registry push is used. Runtime execution uses the built image's content ID instead of a mutable tag. Cache misses still build; optional cache-export failures cannot conceal build failures. Build records are not uploaded.

Run the manually dispatched `Trusted image cache benchmark` workflow, or CI's `cache_benchmark: true` option. It compares ordinary, cold-cached and restored builds using a fresh second builder, including setup, load and export. Its scope is separate from production caches, and it uses no credential Environment or provider. Same-host reuse of the builder image is optimistic: repeat on independent runners and include network/storage/initial cache cost. Enable `with: {docker_cache: true}` in a repository caller only when repeated measurements show a meaningful net saving; otherwise retain the ordinary build. No release-image registry is introduced.

The first [GitHub-hosted benchmark](https://github.com/AppSolves/codexbot/actions/runs/43571256477) measured **14 seconds ordinary / 49 seconds cold cache / 14 seconds restored cache** on 2026-11-14. This showed no net saving even with optimistic same-host builder-image reuse. The default therefore remains off. This is one measurement, not a general performance guarantee.

## Trigger isolation

Set `.codexbot.yml` to `bot: {trigger: "@CBReview", aliases: []}` or use the generated `@CBReview<repository_id>`. Matching is exact and case-insensitive; extra suffixes, quoted examples, inline code and fences do not invoke CodexBot. Legacy triggers remain supported when explicitly configured or inherited from the legacy default. They do not rename the GitHub App.

OpenAI's connector is independent. Its [documented manual command](https://learn.chatgpt.com/docs/third-party/github) is `@codex review`; CodexBot cannot guarantee how that service matches other text. To disable its automatic reviews, open [Codex review settings](https://chatgpt.com/codex/settings/code-review), select the repository and disable Automatic review, and disable the personal automatic-review preference when applicable. This does not necessarily disable manual mentions. For complete isolation, disconnect that repository from the native integration or remove/suspend its separate GitHub App installation under GitHub Settings → Applications → Installed GitHub Apps. Do not uninstall CodexBot by mistake. No settings of the independent connector are modified by this project.

## Coordinated immutable-pin upgrade

1. Validate and merge the feature branch. Obtain the **actual merged commit SHA** from GitHub and verify that it contains the reviewed reusable workflow. Never substitute an example, branch name, guessed SHA or an unrelated last commit.
2. Drain active old reviews. Apply migration 0003 using pinned Wrangler's remote migrations command. It is additive; do not reapply ALTER statements individually. Keep `MERGE_DEPLOYMENT_AUTHORIZED=false` and repository merge disabled.
3. Prepare a caller PR using that exact SHA plus the two empty named secret grants and optional credential-only input. Preserve its run-name, permissions, concurrency and default-branch protection. Update the textual trigger separately if desired; do not change authorization or merge policy.
4. Report local/CI validation before deployment. Deploy the reviewed Worker with `TRUSTED_WORKFLOW=OWNER/codexbot/.github/workflows/review.yml@THAT_SAME_SHA`, preserving existing bindings, OAuth gate, secrets and domain settings. Merge the caller PR using normal protection checks. There is no atomic transaction across Cloudflare and GitHub: during the short mismatch window requests fail closed. Do not relax either SHA check to hide it.
5. Read back both actual pins and compare them byte-for-byte. Run the credential-only workflow check under the owning actor/installation Environment. Then request a new advisory/no-merge review for end-to-end broker/provider acceptance. Old Actions review attempts are not rerun to borrow a new credential/pin; use a new authorized comment.
6. Inspect the same progress comment, workflow link, sanitized failures and native review. Provider inference remains a distinct live test with the owner's authorization/allowance, never an API-key fallback. Roll back both pins together on failure; keep additive DB columns. A backend/caller protected-branch or deployment-permission block is a release blocker, not permission to bypass safeguards.
