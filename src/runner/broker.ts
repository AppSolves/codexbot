import { record, requireCondition, AppError } from '../core/errors.js';

export function backendUrl(value: string): string {
  const url = new URL(value);
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'backend_requires_https_origin');
  return url.origin;
}
export async function oidcToken(audience: string): Promise<string> {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  requireCondition(endpoint && token, 'github_actions_oidc_unavailable');
  const url = new URL(endpoint); requireCondition(url.protocol === 'https:', 'invalid_oidc_endpoint');
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireCondition(response.ok, 'github_oidc_request_failed');
  const result = record(await response.json()); requireCondition(typeof result.value === 'string', 'github_oidc_missing_token');
  return result.value;
}
export async function broker(backend: string, request: string, operation: string, body: unknown = {}): Promise<unknown> {
  requireCondition(/^[a-f0-9-]{36}$/.test(request), 'invalid_request_id');
  requireCondition(['prepare','result','rotate','publish','release'].includes(operation), 'invalid_broker_operation');
  const origin = backendUrl(backend);
  const send = async () => {
    const response = await fetch(`${origin}/v1/requests/${request}/${operation}`, { method: 'POST',
      headers: { Authorization: `Bearer ${await oidcToken(origin)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90_000) });
    requireCondition(response.ok, `broker_${operation}_failed`, response.status);
    return response.json() as Promise<unknown>;
  };
  try { return await send(); }
  catch (error) {
    // Prepare has a two-attempt, same-run admission CAS. Only transport uncertainty
    // is retried here; token rotation is deliberately never retried blindly.
    if (operation === 'prepare' && !(error instanceof AppError)) return send();
    throw error;
  }
}
