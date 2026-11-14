import { requireCondition } from './errors.js';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export interface ReviewCommand { merge: boolean; effort: Effort | null; instructions: string; rerun?: boolean; model?: string }

export function validateHandle(handle: string): string {
  requireCondition(/^@[a-zA-Z0-9]{1,39}$/.test(handle), 'handle_must_be_at_and_1_to_39_ascii_letters_or_digits');
  return handle;
}

function words(line: string): string[] {
  const result: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && quote !== "'") {
      requireCondition(i + 1 < line.length, 'unfinished_escape');
      word += line[++i]!; started = true;
    } else if (quote) {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) result.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  requireCondition(!quote, 'unclosed_quote');
  if (started) result.push(word);
  return result;
}

export function parseCommand(body: string, trigger: string): ReviewCommand | null {
  validateHandle(trigger);
  requireCondition(body.length <= 16_384, 'comment_too_long');
  // Only a top-level first nonempty line is a command. Quoted/fenced examples cannot trigger.
  const allLines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const start = allLines.findIndex(line => line.trim() !== '');
  if (start < 0) return null;
  const lines = allLines.slice(start), rawFirst = lines[0]!;
  if (/^(?: {4}|\t)/.test(rawFirst)) return null;
  const first = rawFirst.trim();
  const match = /^(@[A-Za-z0-9]+)\s+review(?=\s|$)/i.exec(first);
  if (!match || match[1]!.toLowerCase() !== trigger.toLowerCase()) return null;
  const tokens = words(first.slice(match[0].length));
  let merge = false, effort: Effort | null = null, literal = false, rerun = false;
  let model: string | undefined;
  const context: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (literal) context.push(token);
    else if (token === '--') literal = true;
    else if (token === '--merge') { requireCondition(!merge, 'duplicate_merge'); merge = true; }
    else if (token === '--rerun') { requireCondition(!rerun, 'duplicate_rerun'); rerun = true; }
    else if (token === '--model' || token.startsWith('--model=')) {
      requireCondition(model === undefined, 'duplicate_model');
      const value = token === '--model' ? tokens[++i] : token.slice(8);
      requireCondition(typeof value === 'string' && !value.startsWith('-') && /^[a-zA-Z0-9._-]{1,100}$/.test(value), 'model_must_be_a_1_to_100_character_catalog_identifier');
      model = value;
    } else if (token === '--effort' || token.startsWith('--effort=')) {
      requireCondition(effort === null, 'duplicate_effort');
      const value = token === '--effort' ? tokens[++i] : token.slice(9);
      requireCondition(EFFORTS.includes(value as Effort), 'effort_must_be_none_minimal_low_medium_high_xhigh_or_max');
      effort = value as Effort;
    } else { requireCondition(!token.startsWith('-'), 'unknown_flag_use_double_dash_for_literal_context'); context.push(token); }
  }
  return { merge, effort, instructions: [context.join(' '), ...lines.slice(1)].join('\n').trim(), ...(rerun ? { rerun: true } : {}), ...(model !== undefined ? { model } : {}) };
}
