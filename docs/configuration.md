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
| merge.enabled | false | Explicit --merge may request a guarded merge |
| merge.method | squash | squash, merge, rebase |
| merge.authorization.* | empty / * | Independent policy plus live write/maintain/admin role |
| merge.minimum_human_approvals | 1 | Current-head approvals by distinct non-author humans with write access; maximum 6 |
| merge.guard_check | CodexBot reviewed commit | For pending CI, a required check bound to this App's numeric ID |
| credentials.mode | chatgpt | chatgpt or api-key; no fallback |
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
