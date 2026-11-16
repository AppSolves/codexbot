import { Ajv } from 'ajv';
import { parseDocument } from 'yaml';
import { EFFORTS, validateHandle } from './command.js';
import type { Effort } from './command.js';
import { requireCondition } from './errors.js';
import { validatePolicy } from './policy.js';
import {DEFAULT_REVIEW_TIMEOUT_MINUTES,MAX_REVIEW_TIMEOUT_MINUTES} from './limits.js';

export type ReviewQuota = number | 'unlimited';
export interface Policy { whitelist: string; blacklist: string }
export interface Config {
  version: 1;
  bot: { trigger: string; aliases: string[] };
  authorization: Policy;
  review: { enabled: boolean; auto_review: boolean; auto_approve: boolean; request_changes: boolean; model: string | null; effort: Effort | null; timeout_minutes:number; blocking_confidence: number; advisory_confidence: number };
  merge: { enabled: boolean; auto_merge_on_approval: boolean; method: 'squash' | 'merge' | 'rebase'; authorization: Policy; minimum_human_approvals: number; guard_check: string };
  credentials: { mode: 'chatgpt' | 'api-key'; automatic_reviewer: string | null };
  quotas: { user_per_day: ReviewQuota; repository_per_day: ReviewQuota; installation_per_day: ReviewQuota; concurrent_repository: number; concurrent_installation: number; cooldown_seconds: number; reruns_per_day: ReviewQuota };
}
export const DEFAULT_CONFIG: Config = {
  version: 1, bot: { trigger: '@codexbot', aliases: [] }, authorization: { whitelist: '', blacklist: '*' },
  review: { enabled: true, auto_review: false, auto_approve: true, request_changes: true, model: null, effort: null, timeout_minutes:DEFAULT_REVIEW_TIMEOUT_MINUTES, blocking_confidence: 0.9, advisory_confidence: 0.7 },
  merge: { enabled: false, auto_merge_on_approval: false, method: 'squash', authorization: { whitelist: '', blacklist: '*' }, minimum_human_approvals: 0, guard_check: 'CodexBot reviewed commit' },
  credentials: { mode: 'chatgpt', automatic_reviewer: null },
  quotas: { user_per_day: 10, repository_per_day: 40, installation_per_day: 200, concurrent_repository: 1, concurrent_installation: 4, cooldown_seconds: 60, reruns_per_day: 2 }
};
const policySchema = { type: 'object', additionalProperties: false, properties: {
  whitelist: { type: 'string', maxLength: 4096 }, blacklist: { type: 'string', maxLength: 4096 }
} };
const schema = { type: 'object', additionalProperties: false, properties: {
  version: { const: 1 }, bot: { type: 'object', additionalProperties: false, properties: { trigger: { type: 'string', maxLength: 40 }, aliases: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', maxLength: 40 } } } },
  authorization: policySchema,
  review: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean' }, auto_review: { type: 'boolean' }, auto_approve: { type: 'boolean' }, request_changes: { type: 'boolean' },
    model: { type: ['string', 'null'], minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9._-]+$' },
    timeout_minutes:{type:'integer',minimum:1,maximum:MAX_REVIEW_TIMEOUT_MINUTES},
    effort: { enum: [null, ...EFFORTS] }, blocking_confidence: { type: 'number', minimum: 0.5, maximum: 1 }, advisory_confidence: { type: 'number', minimum: 0, maximum: 1 }
  } },
  merge: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean' }, auto_merge_on_approval: { type: 'boolean' }, method: { enum: ['squash', 'merge', 'rebase'] }, authorization: policySchema,
    minimum_human_approvals: { type: 'integer', minimum: 0, maximum: 6 }, guard_check: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9 _.-]+$' }
  } },
  credentials: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['chatgpt', 'api-key'] }, automatic_reviewer: {type:['string','null'],pattern:'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$',maxLength:39} } },
  quotas: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.keys(DEFAULT_CONFIG.quotas).map(key => [key, key.endsWith('_per_day') ? {anyOf:[{type:'integer',minimum:1,maximum:1000},{const:'unlimited'}]} : { type: 'integer', minimum: key === 'cooldown_seconds' ? 0 : 1, maximum: key === 'cooldown_seconds' ? 86400 : key.startsWith('concurrent') ? 10 : 1000 }])) }
} };
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile<Partial<Config>>(schema);

export function parseConfig(source: string): Config {
  requireCondition(source.length <= 32_768, 'configuration_too_large');
  const document = parseDocument(source, { uniqueKeys: true, version: '1.2' });
  requireCondition(document.errors.length === 0, 'invalid_yaml');
  const input: unknown = document.toJS({ maxAliasCount: 0 }) ?? {};
  requireCondition(validate(input), 'invalid_configuration');
  const config: Config = {
    version: 1,
    bot: { ...DEFAULT_CONFIG.bot, ...input.bot },
    authorization: { ...DEFAULT_CONFIG.authorization, ...input.authorization },
    review: { ...DEFAULT_CONFIG.review, ...input.review },
    merge: { ...DEFAULT_CONFIG.merge, ...input.merge, authorization: { ...DEFAULT_CONFIG.merge.authorization, ...input.merge?.authorization } },
    credentials: { ...DEFAULT_CONFIG.credentials, ...input.credentials },
    quotas: { ...DEFAULT_CONFIG.quotas, ...input.quotas }
  };
  validateHandle(config.bot.trigger);
  for (const alias of config.bot.aliases) validateHandle(alias);
  requireCondition(new Set([config.bot.trigger, ...config.bot.aliases].map(x => x.toLowerCase())).size === config.bot.aliases.length + 1, 'duplicate_command_alias');
  requireCondition(config.review.advisory_confidence <= config.review.blocking_confidence, 'confidence_threshold_order');
  validatePolicy(config.authorization); validatePolicy(config.merge.authorization);
  return config;
}
