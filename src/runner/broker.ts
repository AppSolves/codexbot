import { record, requireCondition, AppError } from '../core/errors.js';
import { BrokerError, BROKER_CODES } from '../core/diagnostics.js';

async function result(response: Response, operation: string): Promise<unknown> {
  if (response.ok) return response.json() as Promise<unknown>;
  let code: string | null = null;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) { await reader.cancel(); break; } chunks.push(part.value); }
      if (size <= 4096) {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && BROKER_CODES.has(body.error)) code = body.error;
      }
    } catch { /* Raw provider/proxy diagnostics may echo credentials. */ }
    finally { reader.releaseLock(); }
  }
  throw new BrokerError(operation, response.status, code);
}

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
  requireCondition(response.ok, 'github_oidc_request_failed', response.status);
  const result = record(await response.json()); requireCondition(typeof result.value === 'string', 'github_oidc_missing_token');
  return result.value;
}
export async function broker(backend: string, request: string, operation: string, body: unknown = {}): Promise<unknown> {
  requireCondition(/^[a-f0-9-]{36}$/.test(request), 'invalid_request_id');
  requireCondition(['prepare','result','rotate','publish','release','failure','stage'].includes(operation), 'invalid_broker_operation');
  const origin = backendUrl(backend);
  const send = async () => {
    const response = await fetch(`${origin}/v1/requests/${request}/${operation}`, { method: 'POST',
      headers: { Authorization: `Bearer ${await oidcToken(origin)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90_000) });
    return result(response, operation);
  };
  try { return await send(); }
  catch (error) {
    // Prepare has a two-attempt, same-run admission CAS. Only transport uncertainty
    // is retried here; token rotation is deliberately never retried blindly.
    if (operation === 'prepare' && !(error instanceof AppError)) return send();
    throw error;
  }
}
export async function checkWorkload(backend: string): Promise<unknown> {
  const origin = backendUrl(backend);
  return result(await fetch(`${origin}/v1/workload/check`, { method: 'POST', headers: { Authorization: `Bearer ${await oidcToken(origin)}` },
    redirect: 'error', signal: AbortSignal.timeout(90_000) }), 'check');
}
