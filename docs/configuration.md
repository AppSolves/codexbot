# Configuration reference

Policy is read from the protected default branch, never from the PR. Dispatch snapshots the trusted commit; prepare and publication reject a changed default-branch revision, base or head. Re-request after such a change. Unknown keys, duplicate keys, YAML aliases, invalid regexes and configuration larger than 32 KB fail closed. Missing keys inherit defaults; there is no organization/global inheritance. Only model/effort accept null. Credentials never belong in YAML.

See [the complete example](../examples/codexbot.yml).

| Field | Default | Meaning |
|---|---|---|
| version | 1 | Schema version |
| bot.trigger | @codexbot | Existing compatible text trigger; @ plus 1–39 ASCII alphanumerics |
| bot.aliases | [] | Up to five additional triggers, unique ignoring case |
| authorization.whitelist | empty | Comma-separated logins, wildcards or re: patterns |
| authorization.blacklist | * | Default-deny fallback; other matching entries explicitly deny |
| review.enabled | true | Master switch |
| review.auto_review | false | Authorized human PR-event sender uses their own credential |
| review.auto_approve | true | Permit a complete, clean native APPROVE |
| review.request_changes | true | High-confidence critical/high findings request changes |
| review.model | null | Effective Codex catalog default |
| review.effort | null | Effective Codex model default; no override |
| review.blocking_confidence | 0.9 | Critical/high threshold, range 0.5–1 |
| review.advisory_confidence | 0.7 | Advisory versus manual-verification label, at most blocking threshold |
| merge.enabled | false | Owner opt-in to guarded merging; separate merge authorization always applies |
| merge.auto_merge_on_approval | false | Owner opt-in to merging after an eligible authorized clean review; otherwise --merge is required |
| merge.method | squash | squash, merge, rebase |
| merge.authorization.* | empty / * | Independent policy plus live write/maintain/admin role |
| merge.minimum_human_approvals | 0 | Fully Autonomous: 0; Human-in-the-Loop: 1–6 current-head approvals by distinct non-author humans with write access. Stricter GitHub rules still apply |
| merge.guard_check | CodexBot reviewed commit | For pending CI, a required check bound to this App's numeric ID |
| credentials.mode | chatgpt | chatgpt or api-key; no fallback |
| credentials.automatic_reviewer | null | Explicitly consenting administrator login for PR-event reviews; no manual-command credential sharing |
| quotas.user_per_day | 10 | Sliding 24-hour count per installation/actor |
| quotas.repository_per_day | 40 | Sliding repository count |
| quotas.installation_per_day | 200 | Sliding installation count |
| quotas.concurrent_repository | 1 | Active unexpired requests |
| quotas.concurrent_installation | 4 | Active unexpired requests |
| quotas.cooldown_seconds | 60 | Per repository/actor admission cooldown |
| quotas.reruns_per_day | 2 | Additional bound on explicit rereviews |

Count limits are 1–1000, concurrency 1–10 and cooldown 0–86400 seconds. Admission checks and insertion occur in one SQL statement. A duplicate head/base/policy/workflow/effective-command request is rejected without starting another review. The identity includes tenant, actor, prompt, flags, trusted configuration and reusable-workflow revision. `--rerun` intentionally creates a new request and requires live write access, normal review authorization, normal quotas and the separate rerun allowance. It does not bypass cooldown or merge authorization. Re-running an Actions review job is rejected; use the command instead.

## Authorization precedence

1. Explicit blacklist match denies.
2. Explicit whitelist match allows, subject to live repository permission (read for review, write for merge).
3. Everyone else is denied. The exact blacklist entry `*` is only this fallback; use `re:.*` for an explicit deny-all.

Patterns are full-string, case-insensitive RE2. `*` matches a sequence; `?` one character. At most 64 comma-separated patterns of 128 characters each. Backreferences/lookarounds are rejected. Commas remain separators, including in regex quantifiers.

## Commands and aliases

The first nonempty top-level line must begin with a configured trigger and `review`. Four-space/tab indents, quotations, inline examples and code fences do not invoke. Flags may occur in any order on that first line: `--merge`, `--model MODEL_ID`, `--model=MODEL_ID`, `--effort LEVEL`, `--effort=LEVEL`, `--rerun`, and `--` for literal context. Duplicates, unknown flags and unclosed quotes are errors. Later lines are advisory context, never flags or authorization.

Aliases are textual commands, not guaranteed GitHub App mentions. A custom alias can notify an unrelated GitHub account with the same name. Existing @codexbot installations remain compatible. New automated setup uses @CBReview followed by the numeric repository ID to reduce collisions; it remains editable. Configure `bot: {trigger: "@CBReview", aliases: []}` for a short explicit alternative. Avoid adding the old name as an alias if the purpose is avoiding an independent connector. Changing a trigger never changes the App's publishing identity. See [trigger isolation](review-rollout.md).

Effort syntax recognizes none/minimal/low/medium/high/xhigh/max/ultra, but the selected model must actually advertise the requested value. Omission preserves Codex defaults. Catalog discovery does not prove account entitlement; completed inference is required. Never substitute an unsupported value or change billing modes.

Model precedence is the explicit command override, then `review.model`, then the Codex catalog default. Model identifiers use 1–100 ASCII letters, digits, dots, underscores or hyphens, cannot begin with a flag hyphen and must match an actual catalog entry. Effort is validated against that selected model; a model override never silently changes an unsupported requested effort. Existing snapshots without `command.model` retain the previous behavior. Overrides are included in the existing request idempotency key and remain subject to normal authorization and quotas; they grant no merge permissions.

## Review decision table

| Evidence | Native decision |
|---|---|
| Incomplete diff/essential context/model analysis, malformed output, quarantine or output loss | COMMENT; review job fails |
| Complete critical/high finding at or above blocking confidence | REQUEST_CHANGES, or COMMENT when disabled |
| Critical/high below threshold, or any medium/low finding | COMMENT; never approve by ignoring uncertainty |
| Complete clean result, zero findings, approval enabled | APPROVE |

Supplementary coverage is reported separately and does not alone disable approval. Any finding, even very low confidence, prevents automatic approval/merge. The model cannot set thresholds. Suspicious text is quarantined wholesale into a generic non-approving report. See [security](security.md).

## Browser settings

The repository dashboard renders the same canonical fields, validates syntax/policy/thresholds and the generated pinned Codex model/effort catalog, and creates a reviewed configuration/workflow PR against the exact default-branch commit shown. Active settings remain unchanged until merge. Unsupported selections fail explicitly; model membership does not establish actual account entitlement. Existing configurations are not silently rewritten. Suspected secrets in a proposed policy are rejected before GitHub writes. Credentials are connected separately to the owning protected Environment, never YAML.

## Merge modes

Fully Autonomous is the primary mode. It requires explicit owner opt-in:

```yaml
merge:
  enabled: true
  auto_merge_on_approval: true
  minimum_human_approvals: 0
  method: squash
  authorization:
    whitelist: AppSolves # Replace with authorized requesters; review permission alone is insufficient.
    blacklist: "*"
```

Human-in-the-Loop uses the same configuration with `minimum_human_approvals: 1` through `6`. Each counted human must be independent of the PR author, approve the exact current head and currently have write access. Native AI approval is never counted as a human. The default disables merging and automatic merge-on-approval; choosing a mode alone does not enable either. Missing required humans leaves a bounded durable intent for cron reconciliation, with native auto-merge disabled. A later qualifying real approval resumes the same review without another inference. Known failed checks and changes requested remain non-merging outcomes.

With automatic merge-on-approval disabled, only an authorized `--merge` can request merging. With it enabled, a separately merge-authorized review/event actor receives a durable automatic intent at admission. Review-only actors still receive reviews but cannot cause merging. The publisher, retries, cancellation and recovery use that same intent, recheck current authorization/policy/credentials and require a genuine native APPROVE. Any finding, incomplete analysis or failed check prevents merging.

Compatible autonomous GitHub protection requires a protected PR-only default branch and required CI, with no bot/admin bypass. Keep GitHub Required approvals at 1 (or your chosen stronger count). GitHub required reviews are qualifying approvals, not an additional CodexBot human minimum: an App approval counts only when GitHub reports APPROVED for the actual PR. GitHub also decides whether CODEOWNER and last-push requirements are satisfied; REVIEW_REQUIRED or unverifiable approval evidence blocks merging. Only merge.minimum_human_approvals adds independently checked non-author humans. An App that made the last reviewable push cannot supply its own last-push approval; preserve that rule and obtain another qualifying reviewer when GitHub requires one. Keep signature and other rules enabled when desired: GitHub's native expected-head merge remains the final authority and does not bypass them. Required merge queues remain unsupported/manual. Pending CI requires the guard check bound to this App's numeric ID, Checks write and Administration read. Unknown evidence never authorizes merging.

Without an explicit assignment, automatic PR events use the authorized event actor’s own connection. The assignment below permits unattended reviews of authorized contributors without their own provider connection.

## Unattended credential consent

The owner/administrator connects their own credential for this repository with `--allow-automatic-reviews`. The authenticated provisioning endpoint records only that administrator's explicit consent in migration 0006, after checking the protected default branch, default-branch-only Environment and named credential metadata. Trusted configuration separately opts in with `credentials.automatic_reviewer: OWNER_LOGIN` and `review.auto_review: true`. Configuration alone cannot authorize borrowing. Both ChatGPT and API-key modes remain explicit and independent.

The incoming PR-event actor still needs review authorization under `authorization`; use an appropriate whitelist, including `"*"` only when all read-capable contributors are intentionally authorized. For public repositories, non-collaborators have public read access even when the collaborator API returns `none`; this applies only to assigned automatic reviews, never merge permission or private access. The explicit whitelist/blacklist and owner consent are still required. Verified GitHub Bot actors are supported only with this explicit assignment; manual bot commands remain denied. Responsible owner identity, original trigger identity and the consent generation are snapshotted separately. The owner must remain an administrator and pass the review policy; merging additionally requires the owner's separate merge policy and an admitted automatic merge intent. No human approval is fabricated: GitHub reviews use the App identity.

The protected runner Environment, encryption AAD, session lease and all user quotas bind to the consenting owner, installation and repository. Contributions cannot spread usage across actor IDs or select another user's Environment. Owner credentials are never returned to contributors or placed in the model container. Manual commands always use the command author's own connection, even when unattended assignment is enabled.

Revoking/disconnecting consent, replacing the connection, changing the configured owner/mode or losing administrator authority stops new delegated execution and privileged publication. Refresh and publication lease SQL fence the exact consent generation, so reauthorizing the same owner cannot revive an old merge intent. Already started inference may have consumed usage; revocation does not undo it. Configure `automatic_reviewer: null` through a reviewed PR to stop assignment; disconnect the owner connection to revoke its stored grant. No CLI process is needed after provisioning.
