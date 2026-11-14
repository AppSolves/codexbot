import { verifyWebhook, sha256 } from '../core/crypto.js';
import type { Envelope } from '../core/crypto.js';
import { AppError, requireCondition, record } from '../core/errors.js';
import { authorize } from '../core/policy.js';
import { appClient, client, installationClient, permission, splitRepo, trustedConfig, verifyActor } from './github.js';
import { verifyWorkload } from './oidc.js';
import { Store } from './store.js';
import { publish, discardPendingReview } from './publish.js';
import { invalidateMerge } from './merge.js';
import { onboarding } from './onboarding.js';
import { setupPullRequest } from '../setup.js';
import { processDelivery, recover } from './recovery.js';
import { MAX_RESULT_BODY_BYTES } from '../core/limits.js';
import { repositoryCapabilities } from '../capabilities.js';
import { compactWebhook } from './webhook.js';
import { credentialEnvironment, publishingEnvironment } from '../core/identity.js';

export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  requireCondition(Number(request.headers.get('content-length') ?? 0) <= limit, 'body_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new AppError('body_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function bearer(request: Request): string {
  const header = request.headers.get('authorization');
  requireCondition(header && header.startsWith('Bearer ') && header.length < 20_000, 'bearer_required', 401); return header.slice(7);
}
function envelope(value: unknown): Envelope {
  const input = record(value);
  requireCondition(input.version === 1 && typeof input.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(input.iv) && typeof input.ciphertext === 'string' && /^[A-Za-z0-9_-]{20,64000}$/.test(input.ciphertext), 'invalid_envelope');
  return input as unknown as Envelope;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), store = new Store(env.DB);
  const origin = request.headers.get('origin');
  requireCondition(!origin || origin === new URL(env.PUBLIC_URL).origin, 'cross_origin_request_denied', 403);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', version: '0.1.0' });
  if (url.pathname === '/' && request.method === 'GET') return onboarding(env);
  if (url.pathname === '/v1/capabilities' && request.method === 'GET') {
    const github = client(bearer(request)), repository = url.searchParams.get('repository') ?? '';
    const capabilities = await repositoryCapabilities(github, repository);
    const { data } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(repository));
    requireCondition(!data.suspended_at, 'installation_suspended', 403);
    return Response.json({ ...capabilities, installation_id: data.id, automatic_setup: data.permissions?.workflows === 'write', chatgpt_deployment_authorized: env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true' });
  }
  if (url.pathname === '/v1/operations' && ['GET','POST'].includes(request.method)) {
    const github = client(bearer(request)), repository = url.searchParams.get('repository') ?? '';
    const { data: repo } = await github.rest.repos.get(splitRepo(repository));
    requireCondition(repo.permissions?.admin, 'repository_admin_required', 403);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(repository));
    requireCondition(!installation.suspended_at, 'installation_suspended', 403);
    if (request.method === 'POST') {
      const { data: actor } = await github.rest.users.getAuthenticated();
      const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))) as unknown);
      requireCondition(typeof body.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(body.id), 'invalid_recovery_id');
      requireCondition(body.action === undefined || ['retry','cancel'].includes(String(body.action)), 'invalid_recovery_action');
      if (body.action === 'cancel') {
        const snapshot = await store.cancellable(body.id, repo.id, installation.id);
        const { github: cleanup } = await installationClient(env, installation.id, repo.id, { pull_requests: 'write', ...(snapshot.command.merge ? { checks: 'write' } as const : {}) });
        await discardPendingReview(cleanup, snapshot, env.GITHUB_APP_SLUG);
        const merged = snapshot.command.merge ? await invalidateMerge(cleanup, snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID)) : false;
        await store.terminateIntent(snapshot.id, merged); await store.release(snapshot);
      } else await store.operatorRetry(body.id, repo.id, installation.id);
      console.info(JSON.stringify({ event: 'operator_recovery_requested', action: body.action ?? 'retry', actor_id: actor.id, repository_id: repo.id, installation_id: installation.id }));
    }
    return Response.json(await store.operations(repo.id, installation.id));
  }
  if (url.pathname === '/v1/setup' && request.method === 'POST') {
    const userClient = client(bearer(request)), input = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))) as unknown);
    requireCondition(typeof input.repository === 'string', 'repository_required');
    const repo = splitRepo(input.repository);
    const { data: user } = await userClient.rest.users.getAuthenticated();
    const { data: metadata } = await userClient.rest.repos.get(repo);
    requireCondition(metadata.permissions?.admin, 'repository_admin_required', 403);
    await repositoryCapabilities(userClient, metadata.full_name);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(repo);
    requireCondition(!installation.suspended_at && installation.permissions?.workflows === 'write', 'app_workflows_permission_required_use_manual_or_setup_as_user', 403);
    const trusted = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/.github\/workflows\/review.yml@([a-f0-9]{40})$/.exec(env.TRUSTED_WORKFLOW);
    requireCondition(trusted && input.source === trusted[1] && input.ref === trusted[2], 'setup_source_must_match_backend_trusted_workflow');
    const { github } = await installationClient(env, installation.id, metadata.id, { contents: 'write', pull_requests: 'write', workflows: 'write' });
    const pr = await setupPullRequest(github, metadata.full_name, trusted[1]!, trusted[2]!, env.PUBLIC_URL, user.login, 'installation');
    return Response.json({ pull_request: pr });
  }
  if (url.pathname === '/webhook' && request.method === 'POST') {
    const bytes = await boundedBody(request, 1_048_576);
    requireCondition(await verifyWebhook(bytes, request.headers.get('x-hub-signature-256') ?? '', env.GITHUB_WEBHOOK_SECRET), 'invalid_webhook_signature', 401);
    const event = request.headers.get('x-github-event') ?? '', delivery = request.headers.get('x-github-delivery') ?? '';
    requireCondition(/^[a-zA-Z0-9-]{1,100}$/.test(delivery), 'invalid_delivery_id');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const digest = await sha256(body);
    if (!await store.delivery(delivery, digest, event, JSON.stringify(compactWebhook(event, JSON.parse(body) as unknown)))) return Response.json({ status: 'duplicate_or_recovering' });
    const status = await processDelivery(delivery, env);
    return Response.json({ status }, { status: status === 'dispatched' ? 202 : 200 });
  }
  // Interactive provisioning uses a caller-owned, transient GitHub token, never a central user credential.
  if (url.pathname === '/v1/session' && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
    const github = client(bearer(request));
    const { data: user } = await github.rest.users.getAuthenticated();
    const repository = url.searchParams.get('repository') ?? '';
    const { data: repo } = await github.rest.repos.get(splitRepo(repository));
    requireCondition(repo.permissions?.admin, 'repository_admin_required_for_provisioning', 403);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(repository));
    requireCondition(!installation.suspended_at, 'installation_suspended', 403);
    if (request.method === 'PUT') {
      requireCondition(env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true', 'chatgpt_deployment_not_authorized', 403);
      await store.saveSession(repo.id, user.id, envelope(JSON.parse(new TextDecoder().decode(await boundedBody(request, 66_000))) as unknown), installation.id);
    } else if (request.method === 'DELETE') await store.deleteSession(repo.id, user.id, installation.id);
    else return Response.json({ installation_id: installation.id, session: await store.session(repo.id, user.id, installation.id) });
    return Response.json({ status: 'ok' });
  }
  const match = /^\/v1\/requests\/([a-f0-9-]{36})\/(prepare|rotate|result|publish|release)$/.exec(url.pathname);
  if (!match || request.method !== 'POST') throw new AppError('not_found', 404);
  const id = match[1]!, operation = match[2]!;
  const { row, snapshot } = await store.get(id);
  const identity = await verifyWorkload(bearer(request), env.PUBLIC_URL, {
    repository: snapshot.repository, repositoryId: snapshot.repositoryId, ownerId: snapshot.ownerId, defaultBranch: snapshot.defaultBranch,
    workflowSha: snapshot.workflowSha, trustedWorkflow: env.TRUSTED_WORKFLOW,
    environment: operation === 'publish' ? publishingEnvironment(snapshot.installationId) : credentialEnvironment(snapshot.installationId, snapshot.actorId)
  });
  requireCondition(!row.run_id || row.run_id === identity.runId, 'request_bound_to_another_run', 403);
  const app = await appClient(env);
  const { data: installation } = await app.rest.apps.getRepoInstallation(splitRepo(snapshot.repository));
  requireCondition(installation.id === snapshot.installationId && !installation.suspended_at, 'installation_no_longer_valid', 403);
  const { github } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: 'read', pull_requests: 'read', actions: 'read' });
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...splitRepo(snapshot.repository), run_id: Number(identity.runId) });
  requireCondition(run.event === 'workflow_dispatch' && run.head_sha === snapshot.workflowSha && run.path === '.github/workflows/codexbot.yml' && run.repository.id === snapshot.repositoryId && run.repository.owner.id === snapshot.ownerId && run.repository.default_branch === snapshot.defaultBranch && run.run_attempt === Number(identity.attempt), 'workflow_run_mismatch', 403);
  requireCondition(run.actor?.type === 'Bot' && run.actor.login === `${env.GITHUB_APP_SLUG}[bot]`, 'workflow_not_dispatched_by_this_app', 403);
  requireCondition(row.dispatch_attempt && run.display_title === `CodexBot ${snapshot.id} ${row.dispatch_attempt}`, 'workflow_dispatch_attempt_mismatch', 403);
  if (operation === 'release') { await store.release(snapshot); return Response.json({ status: 'released' }); }
  requireCondition(snapshot.config.credentials.mode !== 'chatgpt' || env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true', 'chatgpt_deployment_authorization_revoked', 403);
  requireCondition(operation === 'publish' || identity.attempt === '1', 'use_authorized_rerun_command_instead_of_workflow_rerun', 403);
  if (operation === 'prepare') {
    requireCondition(await store.prepare(id, identity.runId), 'request_already_started', 409);
    const { data: pr } = await github.rest.pulls.get({ ...splitRepo(snapshot.repository), pull_number: snapshot.pr });
    requireCondition(pr.head.sha === snapshot.head && pr.base.sha === snapshot.base && pr.state === 'open' && !pr.draft, 'stale_pull_request', 409);
    const { data: branch } = await github.rest.repos.getBranch({ ...splitRepo(snapshot.repository), branch: snapshot.defaultBranch });
    requireCondition(branch.protected && branch.commit.sha === snapshot.workflowSha, 'trusted_default_branch_changed_or_unprotected', 409);
    const config = await trustedConfig(github, snapshot.repository, snapshot.defaultBranch);
    await verifyActor(github, snapshot.actor, snapshot.actorId);
    const livePermission = await permission(github, snapshot.repository, snapshot.actor);
    requireCondition(config.review.enabled && authorize(snapshot.actor, livePermission, config.authorization), 'review_authorization_revoked', 403);
    // Acquire before reading: reconnect must not replace the record between snapshot and lease.
    if (snapshot.config.credentials.mode === 'chatgpt') await store.acquire(snapshot);
    const credentialSession = snapshot.config.credentials.mode === 'chatgpt' ? await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId) : null;
    if (snapshot.config.credentials.mode === 'chatgpt') requireCondition(credentialSession, 'chatgpt_session_not_connected', 409);
    const { token } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: 'read', pull_requests: 'read' });
    return Response.json({ snapshot, read_token: token, session: credentialSession });
  }
  if (operation === 'rotate') {
    requireCondition(row.state === 'running', 'request_not_running', 409);
    const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, MAX_RESULT_BODY_BYTES))) as unknown);
    requireCondition(Number.isSafeInteger(body.version), 'invalid_session_version');
    await store.rotate(snapshot, Number(body.version), envelope(body.envelope));
    return Response.json({ status: 'saved' });
  }
  if (operation === 'result') {
    const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, MAX_RESULT_BODY_BYTES))) as unknown);
    requireCondition(typeof body.context_complete === 'boolean' && body.output !== undefined, 'invalid_result_submission');
    await store.result(id, body.output, body.context_complete, identity.runId);
    return Response.json({ status: 'recorded' });
  }
  if (row.state === 'published') return Response.json({ status: 'already_published', review_id: row.review_id });
  if (snapshot.config.credentials.mode === 'chatgpt') requireCondition(await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId), 'chatgpt_connection_revoked', 403);
  requireCondition(['reviewed','publishing'].includes(row.state) && row.result !== null, 'request_not_ready_for_publication', 409);
  const lease = await store.claimPublication(id, identity.runId);
  try {
    const { github: publisher } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, {
      contents: snapshot.command.merge ? 'write' : 'read', pull_requests: 'write',
      ...(snapshot.command.merge && env.MERGE_DEPLOYMENT_AUTHORIZED === 'true' ? { checks: 'write', administration: 'read' } as const : {})
    });
    const result = await publish(publisher, snapshot, JSON.parse(row.result) as unknown, row.context_complete === 1, env.GITHUB_APP_SLUG, {
      checkpoint: (reviewId, phase, merge) => store.checkpoint(id, lease, reviewId, phase, merge),
      merge: { enabled: env.MERGE_DEPLOYMENT_AUTHORIZED === 'true', appId: Number(env.GITHUB_APP_ID) },
      beforeWrite: () => store.heartbeat(id, lease)
    });
    await store.published(id, result.reviewId, lease); return Response.json(result);
  } catch (error) { await store.publicationFailed(id, lease, error instanceof AppError && error.status < 500 && error.status !== 429); throw error; }
  finally { await store.release(snapshot); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await route(request, env);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
      return response;
    } catch (error) {
      // No raw exceptions, URLs, authorization headers, source, prompts or provider responses in telemetry.
      const code = error instanceof AppError ? error.code : 'internal_error';
      console.error(JSON.stringify({ event: 'request_failed', code }));
      return Response.json({ error: code }, { status: error instanceof AppError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await recover(env); }
} satisfies ExportedHandler<Env>;
