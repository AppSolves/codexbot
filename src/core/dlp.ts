import { RE2JS } from 're2js';
import { MAX_RAW_REVIEW_BYTES } from './limits.js';

// Versioned local rules, maintained with regression fixtures. Never return matched text.
// Sources: GitHub secret-scanning supported patterns; AWS/GitHub/OpenAI credential formats.
export const DLP_RULESET = '2026-11-14.1';
const rules = [
  ['openai', String.raw`\bsk-[A-Za-z0-9_-]{16,}\b`],
  ['github', String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`],
  ['aws', String.raw`\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b`],
  ['jwt', String.raw`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{12,}\b`],
  ['private_key', String.raw`-----\s*BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY\s*-----`],
  ['database_url', String.raw`(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?)://[^\s/@:]+:[^\s/@]+@`],
  ['bearer', String.raw`(?i)\b(?:bearer|basic)\s+[A-Za-z0-9_+/.=-]{12,}`],
  ['vendor', String.raw`\b(?:xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})`],
  ['assigned_secret', String.raw`(?i)\b(?:password|passwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|aws_secret_access_key)\s*[=:]\s*["']?[^\s"',;]{8,}`],
  ['external_url', String.raw`(?i)(?:https?|ftp)://[^\s]+`]
].map(([id, pattern]) => ({ id: id!, expression: RE2JS.compile(pattern!) }));
const encoded = RE2JS.compile('[A-Za-z0-9_+/=-]{24,}');

export function scanSecrets(value: unknown): string[] {
  let original: string;
  try { original = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { return ['unscannable']; }
  if (typeof original !== 'string' || Buffer.byteLength(original) > MAX_RAW_REVIEW_BYTES) return ['size_limit'];
  const reasons = new Set<string>();
  let current = original.normalize('NFKC');
  for (let depth = 0; depth < 3; depth++) {
    const unescaped = current.replace(/\\[nrt]/g, '');
    const variants = [current, unescaped, unescaped.replace(/\s+/g, '')];
    for (const { id, expression } of rules) if (variants.some(text => expression.matcher(text).find())) reasons.add(id);
    let decoded = '';
    try { decoded += decodeURIComponent(current); } catch { /* A malformed percent escape grants no decoding exception. */ }
    const matcher = encoded.matcher(current);
    for (let n = 0; n < 64 && matcher.find(); n++) {
      const candidate = matcher.group();
      if (!candidate) continue;
      if (candidate.length > 16384) { reasons.add('decode_limit'); continue; }
      const bytes = Buffer.from(candidate.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (bytes.length >= 8 && [...bytes].every(x => x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127))) decoded += '\n' + bytes.toString('utf8');
    }
    // Bounded expansion and recursion; decoding is local and never sent to telemetry.
    if (!decoded || decoded === current) break;
    if (Buffer.byteLength(decoded) > MAX_RAW_REVIEW_BYTES) { reasons.add('decode_limit'); break; }
    current = decoded;
  }
  return [...reasons].sort();
}
