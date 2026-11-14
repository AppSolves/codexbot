export class AppError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}

export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new AppError(code, status);
}

export function record(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_object');
  return value as Record<string, unknown>;
}
