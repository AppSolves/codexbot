# Repository installation and CLI-assisted onboarding

Install the operator's public App and select repositories. Its Worker landing page is an operational checklist, not a hosted OAuth wizard. All credential sign-in runs in the local CLI. Each installation can instead use its own App, Worker and immutable source fork.

## Setup permissions and supported plans

The default manifest deliberately omits Workflows write. App-authored setup requires an explicit operator permission upgrade and installer consent. Otherwise use the first-class manual workflow below, or add `--setup-as-user` with a temporary single-repository administrator credential granting Contents/Pull requests/Workflows write. It creates the same reviewed setup PR under your own identity; no automatic elevation or retained user token is used.

Before creating a setup PR or connecting credentials, the CLI probes Environment availability using live repository-admin access. Public repositories can use Environments on Free; private repositories need Pro, Team or Enterprise support and appropriate permissions. A 403/404 cannot alone distinguish an unsupported plan from an insufficient token; the error states both requirements. Outages/rate limits are reported separately. See GitHub's [Environment availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments). No repository-secret downgrade exists.

```sh
npm ci --ignore-scripts
npm run cli -- setup --repository OWNER/REPO --backend https://YOUR-WORKER \
  --source YOUR-ORG/codexbot --ref FULL_COMMIT_SHA --setup-as-user
```

Omit --setup-as-user only when the App has Workflows write. Backend setup checks live admin/installation/repository scope, source pin, permission and Origin; bearer authentication has no ambient cookies or permissive CORS. Both setup files appear atomically in one commit on `codexbot/setup`. Existing default files are never overwritten. Repeated setup verifies exact existing branch content, its two-file diff and PR head/base before returning the existing PR. Divergent/legacy partial setup branches require manual inspection; no force update occurs.

## Manual workflow

Create .codexbot.yml from [the example](../examples/codexbot.yml); allow only intended GitHub users. For initial acceptance set review.auto_approve and review.request_changes false, and keep merge.enabled false. Add this file through a reviewed PR on the default branch:

```yaml
name: CodexBot
run-name: CodexBot ${{ inputs.request_id }} ${{ inputs.dispatch_attempt }}
on:
  workflow_dispatch:
    inputs:
      request_id: { required: true, type: string }
      credential_owner: { required: true, type: string }
      installation_id: { required: true, type: string }
      dispatch_attempt: { required: true, type: string }
      credential_check_only: { required: false, type: boolean, default: false }
permissions: {}
concurrency:
  group: codexbot-credentials
  cancel-in-progress: false
jobs:
  credential-scope:
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    permissions: {}
    steps:
      - name: Reject credentials outside protected Environments
        shell: bash
        env:
          CODEXBOT_SHARED_CREDENTIAL_PRESENT: ${{ secrets.CODEXBOT_VAULT_KEY != '' || secrets.CODEXBOT_API_KEY != '' }}
        run: |
          node --input-type=module <<'JS'
          if (process.env.CODEXBOT_SHARED_CREDENTIAL_PRESENT !== 'false') {
            console.error(JSON.stringify({event: 'review_failed', stage: 'environment', code: 'non_environment_credentials_forbidden'}));
            process.exitCode = 1;
          }
          JS
  review:
    needs: [credential-scope]
    permissions:
      contents: read
      id-token: write
    uses: YOUR-ORG/codexbot/.github/workflows/review.yml@FULL_COMMIT_SHA
    secrets:
      CODEXBOT_VAULT_KEY: ${{ secrets.CODEXBOT_VAULT_KEY }}
      CODEXBOT_API_KEY: ${{ secrets.CODEXBOT_API_KEY }}
    with:
      request_id: ${{ inputs.request_id }}
      credential_owner: ${{ inputs.credential_owner }}
      installation_id: ${{ inputs.installation_id }}
      backend: https://YOUR-WORKER
      credential_check_only: ${{ inputs.credential_check_only }}
```

Use the exact filename .github/workflows/codexbot.yml and the backend's trusted immutable source pin. Do not add secrets: inherit, fork-head checkout, repository hooks or PR-controlled commands. The reusable workflow resolves its own source from GitHub's TLS-delivered workload identity; the backend independently verifies the signed claims/run before releasing anything.

Use the two named secret references, not literal empty grants. The `credential-scope` job must have no Environment and must succeed before the reusable workflow starts. It passes only a boolean to its process and rejects nonempty repository/organization credentials under either name, preventing fallback to shared keys. Do not remove this guard, add `always()` to its dependent job or use blanket inheritance. Exactly one credential must exist in the owning protected Environment. The credential-only diagnostic checks availability and a read-only administrator workload, without building an image, acquiring a session or running Codex. See [credential semantics and existing-caller migration](review-rollout.md#credential-diagnosis).

## Credentials

Protect the default branch **before** connecting. New codexbot-INSTALLATION_ID-NUMERIC_USER_ID and codexbot-publish-INSTALLATION_ID Environments use a default-branch-only custom deployment policy. The installation namespace isolates both API keys and OAuth vault keys across independent Apps/reinstalls. Existing reviewers/timers are preserved. Unrestricted Environments and custom policies allowing other branches/tags are rejected. Existing protected-branch policies require an actually protected default branch: GitHub otherwise permits every branch when no protected branches exist. Private Free repositories are unsupported.

```sh
npm run cli -- connect --repository OWNER/REPO --backend https://YOUR-WORKER
# Or, after securely setting CODEXBOT_API_KEY in the local process:
npm run cli -- connect-api-key --repository OWNER/REPO --backend https://YOUR-WORKER
```

ChatGPT connection checks the backend deployment gate before sign-in. Use your own eligible account/workspace; manual auth.json export is unnecessary and not supported. API keys go to GitHub through gh stdin; never the Worker. Set credentials.mode appropriately and remove the other mode's secret. API billing and ChatGPT allowance never fall back into one another.

Credential provisioning currently requires repository administrator access. Each authorized human needs their own Environment and credential; ordinary contributors need administrator assistance. Fine-grained provisioning access needs Administration write for Environment creation and Environments write for secrets. Review-only runtime tokens never have those permissions. GitHub Environment Secrets are available to workflows authorized to enter that Environment, not cryptographically restricted to this one workflow: trusted workflow writers/admins remain inside the boundary.

Disconnect retrieves/revokes the latest ChatGPT session, deletes the encrypted record and both named credential secrets for your Environment, and rotates the local vault key. Revoke removed API keys in OpenAI settings separately; a user API key cannot revoke itself through the administrative management API. Session removal remains available even if Environment support disappears. GitHub secret deletion can still require restored feature/permission access.

## Verify before enabling privileges

Run [advisory acceptance](acceptance.md), then independently enable approval if appropriate. Merge needs a separate whitelist, human approvals, protected branch, explicit --merge and the operator's deployment acceptance gate. Pending CI also requires the App-bound required guard and optional merge permissions. Ready PRs use a native exact-head merge. Unknown/conflicting/queue states are manual-only; the bot never bypasses protections.
