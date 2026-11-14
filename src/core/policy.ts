import { RE2JS } from 're2js';
import type { Policy } from './config.js';
import { requireCondition } from './errors.js';

function patterns(source: string): string[] {
  // Commas inside regexes must be avoided (use repeated atoms instead of {1,3}).
  const entries = source.split(',').map(x => x.trim()).filter(Boolean);
  requireCondition(entries.length <= 64, 'too_many_policy_patterns');
  return entries;
}
function compile(pattern: string): RE2JS {
  requireCondition(pattern.length <= 128, 'policy_pattern_too_long');
  if (pattern.startsWith('re:')) return RE2JS.compile(`^(?:${pattern.slice(3)})$`, RE2JS.CASE_INSENSITIVE);
  requireCondition(/^[a-zA-Z0-9*?-]+$/.test(pattern), 'invalid_policy_pattern');
  return RE2JS.compile(`^${pattern.replace(/\?/g, '.').replace(/\*/g, '.*')}$`, RE2JS.CASE_INSENSITIVE);
}
export function validatePolicy(policy: Policy): void {
  for (const pattern of [...patterns(policy.whitelist), ...patterns(policy.blacklist)]) compile(pattern);
}
export function policyAllows(login: string, policy: Policy): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login)) return false;
  const denies = patterns(policy.blacklist).filter(x => x !== '*');
  if (denies.some(x => compile(x).matcher(login).matches())) return false;
  return patterns(policy.whitelist).some(x => compile(x).matcher(login).matches());
}
export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';
export function authorize(login: string, permission: RepositoryPermission, policy: Policy, merge = false): boolean {
  const permitted = merge ? ['write', 'maintain', 'admin'] : ['read', 'triage', 'write', 'maintain', 'admin'];
  return permitted.includes(permission) && policyAllows(login, policy);
}
