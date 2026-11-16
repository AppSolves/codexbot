// One contract from model stdout through transport and persisted publication evidence.
export const MAX_RAW_REVIEW_BYTES = 2_000_000;
export const MAX_REVIEW_BYTES = 60_000;
export const MAX_RESULT_BODY_BYTES = MAX_REVIEW_BYTES + 6_000;
export const REQUEST_LIFETIME_MS = 60 * 60_000;
export const RECOVERY_LEASE_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 5;
export const MAX_CONTEXT_REQUESTS = 100;
export const MAX_CONTEXT_PATHS = 24;
