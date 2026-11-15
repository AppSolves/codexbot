import { Ajv } from 'ajv';
import type { Config } from './config.js';
import { requireCondition } from './errors.js';
import { RE2JS } from 're2js';
import { scanSecrets } from './dlp.js';
import { MAX_RAW_REVIEW_BYTES, MAX_REVIEW_BYTES } from './limits.js';
const SOURCE_TOKEN = RE2JS.compile(String.raw`\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{16,})\b`);

export interface Finding { severity: 'critical' | 'high' | 'medium' | 'low'; confidence: number; path: string; line: number | null; side: 'LEFT' | 'RIGHT'; title: string; explanation: string; remediation: string }
export interface Review { head_sha: string; result: 'clean' | 'findings' | 'inconclusive'; complete: boolean; summary: string; findings: Finding[]; output_truncated?: boolean; quarantined?: boolean }
export function reviewSummary(review: Review, event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES', contextComplete: boolean, binaryFiles = 0): string {
  const complete = review.complete && contextComplete && !review.quarantined && !review.output_truncated && review.result !== 'inconclusive';
  const counts = (['critical','high','medium','low'] as const).flatMap(severity => {
    const count = review.findings.filter(finding => finding.severity === severity).length;
    return count ? [`${count} ${severity}`] : [];
  });
  const status = !complete ? 'Review incomplete. Required evidence or reliable analysis was unavailable.'
    : event === 'REQUEST_CHANGES' ? 'Changes requested.' : 'Review complete.';
  const findings = counts.length ? `Found ${counts.join(', ')} severity ${review.findings.length === 1 ? 'issue' : 'issues'}.` : complete ? 'No actionable issues found.' : 'No approval is authorized.';
  return `**CodexBot Review**\n\n${status} ${findings}\n\n${publicText(review.summary)}${binaryFiles ? `\n\n${binaryFiles} PNG image change(s): immutable Git evidence verified; base/head images supplied to vision-capable Codex. An incomplete visual analysis cannot authorize approval or merge.` : ''}${review.findings.filter(f=>f.line===null).map(f=>`\n\n**${f.severity.toUpperCase()} image finding: ${publicText(f.path)} (${f.side}) — ${publicText(f.title)}**\n\n${publicText(f.explanation)}\n\n${publicText(f.remediation)}\n\nConfidence: ${f.confidence}`).join('')}${event === 'COMMENT' && complete ? '\n\nThis review is advisory. No changes were formally requested.' : ''}\n\nTests were not executed in the isolated review environment.`;
}
export function failedReview(head: string, contextCode?: string): Review {
  const reasons:Record<string,string>={context_api_budget:'The 768-call source-collection budget was exceeded.',context_collection_timeout:'Source collection exceeded 120 seconds.',context_diff_size_limit:'Serialized text changes exceeded 6 MB.',context_byte_budget:'Essential source exceeded the 16 MB budget.',context_file_size_limit:'An essential source file exceeds 512 KB.',context_binary_size_limit:'Binary evidence exceeds 2 MB per file or 8 MB total.',context_unsupported_binary:'A missing patch could not be verified as a supported PNG image; unsupported binaries require manual inspection.',context_text_patch_truncated:'A textual patch is missing or truncated.'};
  const contextSummary=contextCode ? (reasons[contextCode] ?? 'Essential source, dependencies or Git evidence could not be verified.')+' No AI inference was started. Reduce or split the PR, or inspect unsupported evidence manually. No approval or merge is authorized.' : null;
  return { head_sha: head, result: 'inconclusive', complete: false,
    summary: contextSummary ?? 'CodexBot could not complete a valid review. Check workflow configuration, authentication, selected model access and usage allowance. No approval or merge is authorized.', findings: [] };
}
export interface ChangedFile { filename: string; previous_filename?: string; status: string; patch?: string; additions?: number; deletions?: number }
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['head_sha', 'result', 'complete', 'summary', 'findings'],
  properties: {
    head_sha: { type: 'string', pattern: '^[a-f0-9]{40}$' }, result: { enum: ['clean', 'findings', 'inconclusive'] }, complete: { type: 'boolean' },
    summary: { type: 'string', minLength: 20, maxLength: 8000 },
    findings: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false,
      required: ['severity', 'confidence', 'path', 'line', 'side', 'title', 'explanation', 'remediation'], properties: {
        severity: { enum: ['critical', 'high', 'medium', 'low'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        path: { type: 'string', minLength: 1, maxLength: 512 }, line: { type: ['integer','null'], minimum: 1, maximum: 10_000_000 }, side: { enum: ['LEFT', 'RIGHT'] },
        title: { type: 'string', minLength: 1, maxLength: 200 }, explanation: { type: 'string', minLength: 1, maxLength: 4000 }, remediation: { type: 'string', maxLength: 2000 }
      }
    } }
  }
} as const;
// OpenAI strict structured output requires every declared model field to be required.
// Provenance flags belong to the trusted transport, never the model's output schema.
const validate = new Ajv().compile<Review>({ ...REVIEW_SCHEMA, properties: { ...REVIEW_SCHEMA.properties,
  output_truncated: { type: 'boolean' }, quarantined: { type: 'boolean' } } });

/** Applied before transport, persistence and publication. No suspicious source text escapes. */
export function normalizeReview(value: unknown, head: string): Review {
  const fallback = failedReview(head);
  if (scanSecrets(value).length) return { ...fallback, quarantined: true };
  if (!validate(value) || value.head_sha !== head) return fallback;
  const review = structuredClone(value);
  const size = () => Buffer.byteLength(JSON.stringify(review));
  if (size() > MAX_RAW_REVIEW_BYTES) return { ...fallback, output_truncated: true };
  if (size() > MAX_REVIEW_BYTES) {
    // Retain severity, confidence and locations. Any information loss disables approval.
    review.complete = false; review.output_truncated = true;
    const shorten = (text: string, bytes: number) => {
      let result = ''; for (const char of text) { if (Buffer.byteLength(result + char) > bytes) break; result += char; } return result;
    };
    review.summary = shorten(review.summary, 1500);
    for (const finding of review.findings) {
      finding.title = shorten(finding.title, 100); finding.explanation = shorten(finding.explanation, 400); finding.remediation = shorten(finding.remediation, 200);
    }
    if (review.result === 'clean') review.result = 'inconclusive';
  }
  return size() <= MAX_REVIEW_BYTES ? review : { ...fallback, output_truncated: true };
}

export function safePath(path: string): boolean {
  return path.length <= 512 && !path.startsWith('/') && !/[\\:]/.test(path) && [...path].every(x => x.charCodeAt(0) >= 32 && x.charCodeAt(0) !== 127) && path.split('/').every(x => x !== '' && x !== '.' && x !== '..');
}
export function changedLines(file: ChangedFile): Set<string> {
  const lines = new Set<string>(); let left = 0, right = 0, inHunk = false;
  for (const line of (file.patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) lines.add(`RIGHT:${right++}`);
    else if (line.startsWith('-')) lines.add(`LEFT:${left++}`);
    else if (line.startsWith(' ')) { left++; right++; }
  }
  return lines;
}
export function completePatch(file: ChangedFile): boolean {
  if (!file.patch) return false;
  let expectedLeft = 0, expectedRight = 0, actualLeft = 0, actualRight = 0, additions = 0, deletions = 0, hunks = 0;
  for (const line of file.patch.replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (actualLeft !== expectedLeft || actualRight !== expectedRight) return false;
      expectedLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); expectedRight = hunk[2] === undefined ? 1 : Number(hunk[2]); actualLeft = 0; actualRight = 0; hunks++; continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) { actualRight++; additions++; }
    else if (line.startsWith('-')) { actualLeft++; deletions++; }
    else if (line.startsWith(' ')) { actualLeft++; actualRight++; }
    else return false;
  }
  return hunks > 0 && actualLeft === expectedLeft && actualRight === expectedRight &&
    (file.additions === undefined || additions === file.additions) && (file.deletions === undefined || deletions === file.deletions);
}
export function validateReview(value: unknown, head: string, files: ChangedFile[], binarySides:ReadonlySet<string> = new Set()): Review {
  requireCondition(validate(value), 'invalid_review_schema');
  requireCondition(value.head_sha === head, 'review_head_mismatch', 409);
  requireCondition(!(value.result === 'clean' && (value.findings.length > 0 || !value.complete)), 'contradictory_clean_review');
  requireCondition(!(value.result === 'findings' && value.findings.length === 0), 'empty_findings_result');
  const seen = new Set<string>();
  for (const finding of value.findings) {
    requireCondition(safePath(finding.path), 'invalid_finding_path');
    const file = files.find(x => x.filename === finding.path);
    requireCondition(file && (finding.line===null?binarySides.has(`${finding.side}:${finding.path}`):changedLines(file).has(`${finding.side}:${finding.line}`)), 'finding_not_on_changed_line');
    const fingerprint = `${finding.path}:${finding.side}:${finding.line}:${finding.title}`;
    requireCondition(!seen.has(fingerprint), 'duplicate_finding'); seen.add(fingerprint);
  }
  return value;
}
export function decision(review: Review, config: Config, contextComplete: boolean): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (!review.complete || !contextComplete || review.result === 'inconclusive' || review.output_truncated || review.quarantined) return 'COMMENT';
  if (review.findings.some(x => ['critical', 'high'].includes(x.severity) && x.confidence >= config.review.blocking_confidence)) return config.review.request_changes ? 'REQUEST_CHANGES' : 'COMMENT';
  if (review.findings.length > 0) return 'COMMENT';
  return config.review.auto_approve && review.result === 'clean' ? 'APPROVE' : 'COMMENT';
}
export function findingDisposition(finding: Finding, config: Config): 'blocking' | 'manual verification' | 'advisory' {
  if (['critical', 'high'].includes(finding.severity)) return finding.confidence >= config.review.blocking_confidence ? 'blocking' : 'manual verification';
  return finding.confidence < config.review.advisory_confidence ? 'manual verification' : 'advisory';
}
export function publicText(text: string): string {
  // Prevent model-generated hidden HTML, remote images, links and mass mentions in review output.
  const redacted = scanSecrets(text).length ? '[Content quarantined by output policy]' : SOURCE_TOKEN.matcher(text).replaceAll('[REDACTED]');
  return redacted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@\u200b').replace(/\[/g, '\\[').replace(/!\[/g, '!\\[');
}
/** Operator-controlled disposable acceptance scope; the public merge gate stays closed during live tests. */
export function deploymentMergeEnabled(env: {MERGE_DEPLOYMENT_AUTHORIZED:string;MERGE_ACCEPTANCE_REPOSITORY_ID?:string;MERGE_ACCEPTANCE_INSTALLATION_ID?:string}, request: {repositoryId:number;installationId:number}): boolean {
  return env.MERGE_DEPLOYMENT_AUTHORIZED==='true' || (env.MERGE_ACCEPTANCE_REPOSITORY_ID===String(request.repositoryId) && env.MERGE_ACCEPTANCE_INSTALLATION_ID===String(request.installationId));
}
export function mergeRequested(snapshot: { command: { merge: boolean }; mergeIntent?: 'automatic' }): boolean {
  return snapshot.command.merge || snapshot.mergeIntent === 'automatic';
}
export interface MergeState {
  head: string; expectedHead: string; open: boolean; draft: boolean; mergeStateStatus: string; reviewDecision: string | null;
  authorized: boolean; explicitlyRequested: boolean; event: string; checks: 'passed' | 'pending' | 'failed'; humans: boolean; protected: boolean; queue: boolean;
}
export function mergeDisposition(state: MergeState, config: Config): string {
  if (!config.merge.enabled || !state.authorized || (!state.explicitlyRequested && !config.merge.auto_merge_on_approval) || state.event !== 'APPROVE') return 'policy_denied';
  if (state.head !== state.expectedHead || !state.open || state.draft) return 'stale_or_closed';
  if (!state.protected) return 'protection_required';
  if (state.queue) return 'manual_merge_queue';
  if (state.mergeStateStatus === 'DIRTY') return 'conflicts';
  if (!['CLEAN', 'BLOCKED', 'UNSTABLE', 'BEHIND'].includes(state.mergeStateStatus)) return 'unknown';
  if (state.checks === 'failed') return 'failed_checks';
  if (!state.humans || ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(state.reviewDecision ?? '')) return 'human_review_required';
  return state.mergeStateStatus === 'CLEAN' && state.checks === 'passed' ? 'ready' : 'pending';
}
