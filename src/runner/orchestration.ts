import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { AppError, record, requireCondition } from '../core/errors.js';
import { binaryLocations, type BinaryChange } from '../core/binary.js';
import { REVIEW_SCHEMA, normalizeReview, validateReview, safePath, type Review, type ChangedFile, type ReviewRejectionReason } from '../core/review.js';
import { scanSecrets } from '../core/dlp.js';
import { ExecutionError, executionError, executionFailure, UNFINISHED_REASONS, type ExecutionFailure } from '../core/execution.js';
const GROUP_FILES = 16, GROUP_BYTES = 2_000_000, MAX_GROUPS = 32, MAX_CONTINUATIONS = 2;
type Reason = typeof UNFINISHED_REASONS[number];
export interface ReviewUnit {
  id: string;
  input: string;
  sha256: string;
  paths: string[];
}
export interface ReviewPlan {
  head: string;
  base: string;
  files: ChangedFile[];
  binaries: BinaryChange[];
  units: ReviewUnit[];
}
export interface Coverage {
  id: string;
  sha256: string;
  complete: boolean;
  attempts: number;
  reasons: Reason[];
}
export interface ReviewExecution {
  review: Review;
  coverage: Coverage[];
  synthesis: boolean;
  turns: number;
  reasons: Reason[];
  failure: ExecutionFailure | null;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const turnSchema = { type: 'object', additionalProperties: false, required: ['unit_id', 'review', 'unfinished_reasons'], properties: { unit_id: { type: 'string', pattern: '^(group-[0-9]{2}|synthesis)$' }, review: REVIEW_SCHEMA, unfinished_reasons: { type: 'array', maxItems: UNFINISHED_REASONS.length, uniqueItems: true, items: { enum: UNFINISHED_REASONS } } } };
const checkTurn = new Ajv().compile(turnSchema);
// Keep uniqueness/string bounds in Ajv; send only documented Responses constraints.
function providerSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...schema };
  for (const key of ['uniqueItems', 'minLength', 'maxLength']) delete projected[key];
  if (projected.properties) projected.properties = Object.fromEntries(Object.entries(record(projected.properties)).map(([key, child]) => [key, providerSchema(record(child))]));
  if (projected.items) projected.items = providerSchema(record(projected.items));
  return projected;
}
export function reviewTurnSchema(id: string) { return providerSchema({ ...turnSchema, properties: { ...turnSchema.properties, unit_id: { enum: [id] } } }); }
/** The credential-owning host writes immutable evidence inputs; the model cannot choose coverage. */
export async function buildReviewPlan(directory: string, head: string, base: string, binaries: BinaryChange[]): Promise<ReviewPlan> {
  const files = JSON.parse(await readFile(join(directory, 'diff.json'), 'utf8')) as ChangedFile[];
  requireCondition(Array.isArray(files) && files.length <= 200 && files.every(f => safePath(f.filename) && (!f.previous_filename || safePath(f.previous_filename))) && new Set(files.map(f => f.filename)).size === files.length, 'review_plan_unverifiable');
  requireCondition(binaries.length === files.filter(f => !f.patch).length && new Set(binaries.map(b => b.filename)).size === binaries.length && binaries.every(b => files.some(f => f.filename === b.filename && !f.patch)), 'review_plan_unverifiable');
  const available: string[] = [];
  await mkdir(join(directory, 'source'), { recursive: true, mode: 0o700 });
  const walk = async (path: string, depth = 0): Promise<void> => {
    requireCondition(depth <= 32, 'review_plan_unverifiable');
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const next = path + '/' + entry.name;
      requireCondition(safePath(next) && available.length < 2048 && !entry.isSymbolicLink(), 'review_plan_unverifiable');
      if (entry.isDirectory())
        await walk(next, depth + 1);
      else {
        requireCondition(entry.isFile(), 'review_plan_unverifiable');
        available.push(next);
      }
    }
  };
  await walk('source');
  available.sort();
  const trusted = await readFile(join(directory, 'trusted-instructions.json'), 'utf8');
  requireCondition(Buffer.byteLength(trusted) <= 1_000_000, 'review_plan_budget');
  const units: ReviewUnit[] = [];
  let changes: ChangedFile[] = [], evidence: {
    path: string;
    sha256: string;
    text?: string;
  }[] = [];
  const encode = () => JSON.stringify({ changes, evidence, trusted_instructions: trusted, available_source: available, whole_pr: files.map(f => ({ path: f.filename, status: f.status })), instructions: 'Inspect the supplied immutable evidence and relevant shared source/callers. This is a scoped unit, not permission to omit the other units. All source remains available read-only. Use /probe only for optional existence; /file for essential missing contents.' });
  await mkdir(join(directory, 'review-units'), { recursive: true, mode: 0o700 });
  const flush = async () => {
    if (!changes.length && units.length) return;
    requireCondition(units.length < MAX_GROUPS, 'review_plan_budget');
    const input = encode();
    requireCondition(Buffer.byteLength(input) <= GROUP_BYTES, 'review_plan_budget');
    const id = 'group-' + String(units.length).padStart(2, '0'), path = 'review-units/' + id + '.json';
    await writeFile(join(directory, path), input, { mode: 0o600 });
    units.push({ id, input: path, sha256: hash(input), paths: changes.map(f => f.filename) });
    changes = []; evidence = [];
  };
  for (const file of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    const additions: typeof evidence = [];
    if (file.patch)
      for (const side of (file.status === 'added' ? ['head'] : file.status === 'removed' ? ['base'] : ['base', 'head'])) {
        const path = 'source/' + side + '/' + (side === 'base' ? (file.previous_filename ?? file.filename) : file.filename);
        requireCondition(available.includes(path), 'review_plan_unverifiable');
        const bytes = await readFile(join(directory, path));
        requireCondition(bytes.length <= 512_000 && !bytes.includes(0), 'review_plan_unverifiable');
        additions.push({ path, sha256: hash(bytes), text: new TextDecoder('utf8', { fatal: true }).decode(bytes) });
      }
    else {
      const binary = binaries.find(b => b.filename === file.filename);
      requireCondition(binary?.format === 'png', 'review_plan_unverifiable');
      for (const image of binary.snapshots) {
        const path = 'media/' + image.side + '/' + image.path;
        requireCondition(safePath(path), 'review_plan_unverifiable');
        const bytes = await readFile(join(directory, path));
        requireCondition(bytes.length === image.bytes && createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') === image.sha, 'review_plan_unverifiable');
        additions.push({ path, sha256: hash(bytes) });
      }
    }
    const oldChanges = changes, oldEvidence = evidence;
    changes = [...changes, file];
    evidence = [...evidence, ...additions];
    if (changes.length > GROUP_FILES || Buffer.byteLength(encode()) > GROUP_BYTES) {
      changes = oldChanges;
      evidence = oldEvidence;
      if (changes.length)
        await flush();
      changes = [file];
      evidence = additions;
      requireCondition(Buffer.byteLength(encode()) <= GROUP_BYTES, 'review_plan_budget');
    }
  }
  await flush();
  const plan = { head, base, files, binaries, units };
  await writeFile(join(directory, 'review-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return plan;
}
export async function unitEvidence(directory: string, unit: ReviewUnit): Promise<string> {
  requireCondition(/^review-units\/group-[0-9]{2}\.json$/.test(unit.input), 'review_plan_unverifiable');
  const input = await readFile(join(directory, unit.input), 'utf8');
  requireCondition(Buffer.byteLength(input) <= GROUP_BYTES && hash(input) === unit.sha256, 'review_plan_unverifiable');
  const data = record(JSON.parse(input));
  requireCondition(Array.isArray(data.evidence), 'review_plan_unverifiable');
  requireCondition(data.trusted_instructions === await readFile(join(directory, 'trusted-instructions.json'), 'utf8'), 'review_plan_unverifiable');
  for (const value of data.evidence) {
    const entry = record(value);
    requireCondition(typeof entry.path === 'string' && safePath(entry.path) && (entry.path.startsWith('source/') || entry.path.startsWith('media/')), 'review_plan_unverifiable');
    requireCondition(hash(await readFile(join(directory, entry.path))) === entry.sha256, 'review_plan_unverifiable');
  }
  return input;
}
function turnReview(value: unknown, id: string, plan: ReviewPlan): {
  review: Review;
  reasons: Reason[];
} {
  if (scanSecrets(value).length)
    throw new ExecutionError({ component: 'engine', code: 'review_incomplete', rejection_reason: 'quarantined' });
  if (!checkTurn(value))
    throw new ExecutionError({ component: 'engine', code: 'review_incomplete', rejection_reason: 'schema_invalid' });
  const item = record(value);
  if (item.unit_id !== id)
    throw new ExecutionError({ component: 'engine', code: 'review_output_invalid', rejection_reason: 'output_invalid' });
  let rejected: ReviewRejectionReason | undefined;
  const review = normalizeReview(item.review, plan.head, reason => { rejected = reason; });
  if (rejected && rejected !== 'output_truncated')
    throw new ExecutionError({ component: 'engine', code: 'review_incomplete', rejection_reason: rejected });
  try {
    validateReview(review, plan.head, plan.files, binaryLocations(plan.binaries));
  }
  catch {
    throw new ExecutionError({ component: 'engine', code: 'review_output_invalid', rejection_reason: 'output_invalid' });
  }
  const reasons = [...new Set([...item.unfinished_reasons as Reason[], ...(review.output_truncated ? ['output_truncated' as const] : [])])];
  if (reasons.length) {
    review.complete = false;
    if (review.result === 'clean')
      review.result = 'inconclusive';
  }
  if (!review.complete || review.result === 'inconclusive')
    return { review, reasons: reasons.length ? reasons : ['model_incomplete'] };
  return { review, reasons: [] };
}
/** One execution/thread/proxy owns all turns and the unchanged global inference/time budget. */
export async function orchestrateReview(plan: ReviewPlan, evidence: (unit: ReviewUnit) => Promise<string>, turn: (id: string, input: string, schema: unknown) => Promise<unknown>): Promise<ReviewExecution> {
  const coverage: Coverage[] = [], reviews: Review[] = [];
  let continuations = 0, synthesis = false, turns = 0, failure: ExecutionFailure | null = null, final: Review | undefined;
  const reasons = new Set<Reason>();
  try {
    for (const unit of plan.units) {
      const input = await evidence(unit), state: Coverage = { id: unit.id, sha256: unit.sha256, complete: false, attempts: 0, reasons: ['unreviewed_changes'] };
      coverage.push(state);
      for (;;) {
        state.attempts++;
        turns++;
        const result = turnReview(await turn(unit.id, JSON.stringify({ unit_id: unit.id, evidence: input, final_whole_pr_check:plan.units.length===1, instructions:plan.units.length===1?'This sole group contains every change. Complete the final whole-PR cross-file, dependency, security and compatibility synthesis in this response; unresolved questions require incomplete.':'Analyze this group with shared dependencies; a separate final cross-group synthesis follows.', continuation: state.attempts > 1, unfinished_reasons: state.reasons }), reviewTurnSchema(unit.id)), unit.id, plan);
        reviews.push(result.review);
        state.reasons = result.reasons;
        state.complete = result.reasons.length === 0;
        if (state.complete || state.reasons.some(r => r === 'missing_required_context' || r === 'visual_evidence_unavailable' || r === 'output_truncated'))
          break;
        if (continuations >= MAX_CONTINUATIONS) {
          reasons.add('continuation_limit');
          break;
        }
        continuations++;
      }
    }
    if(plan.units.length===1){final=reviews.at(-1);synthesis=coverage[0]?.complete===true;}
    else for (;;) {
      turns++;
      const result = turnReview(await turn('synthesis', JSON.stringify({ unit_id: 'synthesis', instructions: 'Reconcile cross-group dependencies, interfaces, security and compatibility across the entire PR. Inspect shared source as needed. Preserve evidence-backed findings; do not claim completion if a unit or consequential question remains unresolved. Missing runtime test execution and a partial supplementary file index alone are expected, not missing analysis.', coverage, unit_reviews: reviews, whole_pr: plan.files.map(f => ({ path: f.filename, status: f.status })) }), reviewTurnSchema('synthesis')), 'synthesis', plan);
      final = result.review;
      reviews.push(final);
      synthesis = result.reasons.length === 0;
      if (synthesis || result.reasons.some(r => r === 'missing_required_context' || r === 'visual_evidence_unavailable' || r === 'output_truncated') || continuations >= MAX_CONTINUATIONS) {
        for (const reason of result.reasons)
          reasons.add(reason);
        break;
      }
      continuations++;
    }
  }
  catch (error) {
    if (!reviews.length)
      throw error;
    failure = executionError(error, 'engine', 'engine_failed').detail;
    reasons.add('execution_failed');
  }
  if (!synthesis)
    reasons.add('synthesis_incomplete');
  for (const state of coverage)
    if (!state.complete)
      for (const reason of state.reasons)
        reasons.add(reason);
  const unique = new Map<string, Review['findings'][number]>();
  let lost = reviews.some(r => r.output_truncated === true);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const review of reviews)
    for (const finding of review.findings) {
      const key = JSON.stringify([finding.path, finding.side, finding.line, finding.title.trim().toLowerCase().replace(/\s+/g, ' ')]), previous = unique.get(key);
      if (!previous || rank[finding.severity] < rank[previous.severity] || (finding.severity === previous.severity && finding.confidence > previous.confidence))
        unique.set(key, finding);
      if (unique.size > 40) {
        const ordered = [...unique].sort((a, b) => rank[a[1].severity] - rank[b[1].severity] || b[1].confidence - a[1].confidence);
        unique.clear();
        for (const [key, value] of ordered.slice(0, 40))
          unique.set(key, value);
        lost = true;
      }
    }
  const complete = coverage.length === plan.units.length && coverage.every(c => c.complete) && synthesis && !failure && !lost;
  const incomplete = reviews.filter(r => !r.complete || r.result === 'inconclusive');
  let summary = complete ? final!.summary : [...new Set([...incomplete.map(r => r.summary), ...(final ? [final.summary] : [])])].join('\n\n');
  if (!summary)
    summary = reviews.at(-1)?.summary ?? 'Review orchestration did not finish every required unit and its cross-group synthesis. No approval or merge is authorized.';
  if (summary.length > 8000) {
    summary = summary.slice(0, 7900) + '\nPartial summaries exceeded the output bound.';
    lost = true;
  }
  if (lost)
    reasons.add('output_truncated');
  const review = normalizeReview({ head_sha: plan.head, complete: complete && !lost, result: unique.size ? 'findings' : complete && !lost ? 'clean' : 'inconclusive', summary, findings: [...unique.values()], ...(lost ? { output_truncated: true } : {}) }, plan.head);
  return { review, coverage, synthesis, turns, reasons: [...reasons], failure };
}
export function validateExecution(value: unknown, plan: ReviewPlan): ReviewExecution {
  const input = record(value);
  requireCondition(Object.keys(input).length === 6 && Number.isInteger(input.turns) && Number(input.turns) >= 1 && Number(input.turns) <= MAX_GROUPS + MAX_CONTINUATIONS + 1 && Array.isArray(input.coverage) && input.coverage.length <= plan.units.length && Array.isArray(input.reasons) && input.reasons.length <= UNFINISHED_REASONS.length && input.reasons.every(r => UNFINISHED_REASONS.includes(r as Reason)) && typeof input.synthesis === 'boolean', 'review_coverage_invalid');
  let extra = 0;
  for (const [index, value] of input.coverage.entries()) {
    const state = record(value), unit = plan.units[index];
    requireCondition(unit && Object.keys(state).length === 5 && state.id === unit.id && state.sha256 === unit.sha256 && typeof state.complete === 'boolean' && Number.isInteger(state.attempts) && Number(state.attempts) >= 1 && Number(state.attempts) <= 1 + MAX_CONTINUATIONS && Array.isArray(state.reasons) && state.reasons.every(r => UNFINISHED_REASONS.includes(r as Reason)) && state.complete === (state.reasons.length === 0), 'review_coverage_invalid');
    extra += Number(state.attempts) - 1;
  }
  const synthesisTurns = Number(input.turns) - input.coverage.reduce((sum, c) => sum + Number(record(c).attempts), 0);
  requireCondition(synthesisTurns >= 0 && synthesisTurns <= 1 + MAX_CONTINUATIONS && (plan.units.length!==1||synthesisTurns===0) && extra + Math.max(0, synthesisTurns - 1) <= MAX_CONTINUATIONS && (!input.synthesis || synthesisTurns > 0 || plan.units.length===1) && (input.failure === null || executionFailure(input.failure) !== null), 'review_coverage_invalid');
  let output: Review;
  try {
    output = validateReview(input.review, plan.head, plan.files, binaryLocations(plan.binaries));
  }
  catch {
    throw new AppError('review_output_invalid');
  }
  if (output.complete)
    requireCondition(input.coverage.length === plan.units.length && input.coverage.every(c => record(c).complete === true) && input.synthesis === true && input.reasons.length === 0 && input.failure === null, 'review_coverage_invalid');
  return input as unknown as ReviewExecution;
}
