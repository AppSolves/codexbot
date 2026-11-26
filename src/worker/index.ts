import { mergeRequested, deploymentMergeEnabled } from '../core/review.js';
import { verifyWebhook, sha256 } from '../core/crypto.js';
import type { Envelope } from '../core/crypto.js';
import { AppError, requireCondition, record } from '../core/errors.js';
import { authorize } from '../core/policy.js';
import { appClient, client, installationClient, permission, splitRepo, trustedConfig, verifyActor } from './github.js';
import { verifyWorkload, verifySignedClaims, checkClaims } from './oidc.js';
import { Store } from './store.js';
import type { RequestSnapshot } from './store.js';
import { publish, discardPendingReview } from './publish.js';
import { invalidateMerge } from './merge.js';
import { onboarding } from './onboarding.js';
import { setupPullRequest, ensureProtectedEnvironment } from '../setup.js';
import { processDelivery, recover } from './recovery.js';
import { MAX_RESULT_BODY_BYTES } from '../core/limits.js';
import { repositoryCapabilities } from '../capabilities.js';
import { recoverRejection } from './rejections.js';
import { compactWebhook } from './webhook.js';
import { credentialEnvironment, publishingEnvironment } from '../core/identity.js';
import { updateProgress, recoverProgress } from './progress.js';
import { FAILURE_CODES, REVIEW_STAGES, BROKER_CODES } from '../core/diagnostics.js';
import { webRoute } from './web.js';
import { renewHosted } from './web-connections.js';
import { executionFailure } from '../core/execution.js';

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
function failure(value: unknown): { code: string; stage: string; status: number | null; revoked: boolean } {
  const body = record(value);
  requireCondition(typeof body.code === 'string' && (FAILURE_CODES.has(body.code) || BROKER_CODES.has(body.code)) && typeof body.stage === 'string' && REVIEW_STAGES.includes(body.stage as typeof REVIEW_STAGES[number]), 'invalid_failure_diagnostic');
  const proxy = executionFailure(body.proxy_failure);
  return { code: body.code, stage: body.stage, status: typeof body.status === 'number' && Number.isInteger(body.status) && body.status >= 400 && body.status <= 599 ? body.status : null,
    revoked: proxy?.component === 'provider' && proxy.upstream_status === 401 };
}
async function notify(env: Env, store: Store, snapshot: RequestSnapshot): Promise<void> {
  try {
    const { github } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: 'read', pull_requests: 'write', actions: 'read' });
    await updateProgress(github, store, snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID));
  } catch { console.error(JSON.stringify({ event: 'progress_update_deferred', request_id: snapshot.id })); }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), store = new Store(env.DB);
  const canonical = new URL(env.PUBLIC_URL).origin;
  const publicPage = request.method === 'GET' && ['/', '/health'].includes(url.pathname);
  // Retained custom domains are public landing/liveness aliases only. Never
  // redirect credentials or accept a canonical audience through another host.
  requireCondition(publicPage || url.origin === canonical, 'non_canonical_backend_origin', 421);
  const origin = request.headers.get('origin');
  requireCondition(!origin || origin === canonical, 'cross_origin_request_denied', 403);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', version: '0.1.4' });
  if (url.pathname === '/' && request.method === 'GET') return onboarding(env);
  const web = await webRoute(request, env); if (web) return web;
  if (url.pathname === '/v1/workload/check' && request.method === 'POST') {
    // A read-only administrator diagnostic, never a credential/token broker grant.
    // Privileged review routes below still require this App's dispatch identity.
    const claims = await verifySignedClaims(bearer(request), env.PUBLIC_URL);
    requireCondition(typeof claims.repository === 'string' && typeof claims.actor === 'string' && typeof claims.actor_id === 'string' && /^\d+$/.test(claims.actor_id) &&
      typeof claims.repository_id === 'string' && /^\d+$/.test(claims.repository_id), 'oidc_invalid_run_identity', 403);
    const repo = splitRepo(claims.repository), actorId = Number(claims.actor_id), repositoryId = Number(claims.repository_id);
    requireCondition(Number.isSafeInteger(actorId) && actorId > 0 && Number.isSafeInteger(repositoryId) && repositoryId > 0, 'oidc_repository_mismatch', 403);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(repo);
    requireCondition(!installation.suspended_at, 'installation_no_longer_valid', 403);
    const { github } = await installationClient(env, installation.id, repositoryId, { contents: 'read', pull_requests: 'read', actions: 'read' });
    const { data: metadata } = await github.rest.repos.get(repo);
    const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: metadata.default_branch });
    requireCondition(branch.protected, 'trusted_default_branch_changed_or_unprotected', 403);
    const identity = checkClaims(claims, { repository: metadata.full_name, repositoryId: metadata.id, ownerId: metadata.owner.id, defaultBranch: metadata.default_branch,
      workflowSha: branch.commit.sha, trustedWorkflow: env.TRUSTED_WORKFLOW, environment: credentialEnvironment(installation.id, actorId) });
    requireCondition(await permission(github, metadata.full_name, claims.actor, actorId) === 'admin', 'repository_admin_required', 403);
    const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(identity.runId) });
    requireCondition(run.actor?.type === 'User' && run.actor.id === actorId && run.repository.id === metadata.id && run.repository.owner.id === metadata.owner.id &&
      run.head_sha === branch.commit.sha && run.event === 'workflow_dispatch' && run.path === '.github/workflows/codexbot.yml' && run.run_attempt === Number(identity.attempt), 'workflow_run_mismatch', 403);
    return Response.json({ status: 'verified', scope: 'diagnostic_only' });
  }
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
      requireCondition(body.action === undefined || ['retry','cancel','retry-progress'].includes(String(body.action)), 'invalid_recovery_action');
      if (body.action === 'cancel') {
        const snapshot = await store.cancellable(body.id, repo.id, installation.id);
        const { github: cleanup } = await installationClient(env, installation.id, repo.id, { pull_requests: 'write', ...(mergeRequested(snapshot) ? { checks: 'write' } as const : {}) });
        await discardPendingReview(cleanup, snapshot, env.GITHUB_APP_SLUG);
        const merged = mergeRequested(snapshot) ? await invalidateMerge(cleanup, snapshot, env.GITHUB_APP_SLUG, Number(env.GITHUB_APP_ID)) : false;
        await store.terminateIntent(snapshot.id, merged); await store.release(snapshot);
      } else if (body.action === 'retry-progress') await store.operatorRetryProgress(body.id, repo.id, installation.id);
      else await store.operatorRetry(body.id, repo.id, installation.id);
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
    if (event === 'github_app_authorization') {
      const revoked = record(JSON.parse(body) as unknown), sender = record(revoked.sender);
      requireCondition(revoked.action === 'revoked' && Number.isSafeInteger(sender.id) && sender.type === 'User', 'invalid_authorization_revocation');
      // Deliveries can arrive after reauthorization. Each browser request checks
      // its own current token, rather than deleting a newly valid grant by actor.
      return Response.json({ status: 'live_authorization_check_required' });
    }
    const digest = await sha256(body);
    if (!await store.delivery(delivery, digest, event, JSON.stringify(compactWebhook(event, JSON.parse(body) as unknown)))) return Response.json({ status: 'duplicate_or_recovering' });
    const status = await processDelivery(delivery, env);
    return Response.json({ status }, { status: status === 'dispatched' ? 202 : 200 });
  }
  // Interactive provisioning uses a caller-owned, transient GitHub token, never a central user credential.
  if (url.pathname === '/v1/session' && ['GET', 'PUT', 'POST', 'DELETE'].includes(request.method)) {
    const github = client(bearer(request));
    const { data: user } = await github.rest.users.getAuthenticated();
    const repository = url.searchParams.get('repository') ?? '';
    const { data: repo } = await github.rest.repos.get(splitRepo(repository));
    requireCondition(repo.permissions?.admin, 'repository_admin_required_for_provisioning', 403);
    const { data: installation } = await (await appClient(env)).rest.apps.getRepoInstallation(splitRepo(repository));
    requireCondition(!installation.suspended_at, 'installation_suspended', 403);
    if (request.method !== 'GET') requireCondition(!await env.DB.prepare('SELECT 1 FROM web_connections WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(installation.id, repo.id, user.id).first(), 'hosted_connections_must_be_managed_in_dashboard', 409);
    if (request.method === 'POST') {
      requireCondition(user.type==='User','human_credential_owner_required',403);
      const body=record(JSON.parse(new TextDecoder().decode(await boundedBody(request,1024))) as unknown);
      requireCondition(Object.keys(body).every(key=>['enabled','mode'].includes(key)) && typeof body.enabled==='boolean' && (body.enabled===false || ['chatgpt','api-key'].includes(String(body.mode))),'invalid_automatic_review_consent');
      if (body.enabled) {
        const {data:branch}=await github.rest.repos.getBranch({...splitRepo(repository),branch:repo.default_branch}); requireCondition(branch.protected,'protected_branch_required_for_automatic_reviews',403);
        await ensureProtectedEnvironment(github,repository,credentialEnvironment(installation.id,user.id),undefined,true);
        await github.rest.actions.getEnvironmentSecret({...splitRepo(repository),environment_name:credentialEnvironment(installation.id,user.id),secret_name:body.mode==='chatgpt'?'CODEXBOT_VAULT_KEY':'CODEXBOT_API_KEY'});
      }
      await store.automaticConsent(repo.id,installation.id,user.id,user.login,body.enabled ? body.mode as 'chatgpt'|'api-key' : null);
      return Response.json({status:body.enabled?'automatic_reviews_authorized':'automatic_reviews_revoked'});
    }
    if (request.method === 'PUT') {
      requireCondition(env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true', 'chatgpt_deployment_not_authorized', 403);
      await store.saveSession(repo.id, user.id, envelope(JSON.parse(new TextDecoder().decode(await boundedBody(request, 66_000))) as unknown), installation.id);
    } else if (request.method === 'DELETE') await store.deleteSession(repo.id, user.id, installation.id);
    else return Response.json({ installation_id: installation.id, session: await store.session(repo.id, user.id, installation.id) });
    return Response.json({ status: 'ok' });
  }
  const match = /^\/v1\/requests\/([a-f0-9-]{36})\/(prepare|context|rotate|renew|result|publish|release|failure|stage)$/.exec(url.pathname);
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
  // Actions embeds a minimal repository without default_branch. Validate the
  // current default branch against authoritative metadata for every operation.
  const { data: repository } = await github.rest.repos.get(splitRepo(snapshot.repository));
  requireCondition(repository.id === snapshot.repositoryId && repository.owner.id === snapshot.ownerId && repository.default_branch === snapshot.defaultBranch, 'workflow_run_mismatch', 403);
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...splitRepo(snapshot.repository), run_id: Number(identity.runId) });
  requireCondition(run.event === 'workflow_dispatch' && run.head_sha === snapshot.workflowSha && run.path === '.github/workflows/codexbot.yml' && run.repository.id === snapshot.repositoryId && run.repository.owner.id === snapshot.ownerId && run.run_attempt === Number(identity.attempt), 'workflow_run_mismatch', 403);
  requireCondition(run.actor?.type === 'Bot' && run.actor.login === `${env.GITHUB_APP_SLUG}[bot]`, 'workflow_not_dispatched_by_this_app', 403);
  requireCondition(row.dispatch_attempt && run.display_title === `CodexBot ${snapshot.id} ${row.dispatch_attempt}`, 'workflow_dispatch_attempt_mismatch', 403);
  if (operation === 'release') { await store.release(snapshot); return Response.json({ status: 'released' }); }
  if (operation === 'failure') {
    requireCondition(identity.attempt === '1', 'use_authorized_rerun_command_instead_of_workflow_rerun', 403);
    const input = failure(JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))) as unknown);
    const failed = await store.failRun(id, identity.runId, input.code, input.stage, input.status);
    const current = await store.progressRequest(id);
    requireCondition(current?.row.run_id === identity.runId, 'request_bound_to_another_run', 403);
    if (failed || current.row.state === 'failed') await store.release(snapshot);
    await notify(env, store, snapshot); return Response.json({ status: 'failed' });
  }
  await store.authorizeAutomatic(snapshot);
  requireCondition(snapshot.config.credentials.mode !== 'chatgpt' || env.CHATGPT_DEPLOYMENT_AUTHORIZED === 'true', 'chatgpt_deployment_authorization_revoked', 403);
  requireCondition(operation === 'publish' || identity.attempt === '1', 'use_authorized_rerun_command_instead_of_workflow_rerun', 403);
  if (operation === 'stage') {
    const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))) as unknown);
    requireCondition(body.stage === 'analyzing', 'invalid_review_stage');
    await store.stage(id, identity.runId, 'analyzing'); await notify(env, store, snapshot);
    return Response.json({ status: 'recorded' });
  }
  if (['prepare','context','rotate','renew'].includes(operation)) {
    const hosted = await env.DB.prepare('SELECT state FROM web_connections WHERE installation_id=? AND repository_id=? AND actor_id=?').bind(snapshot.installationId, snapshot.repositoryId, snapshot.actorId).first<{ state: string }>();
    requireCondition(!hosted || hosted.state === 'ready', 'hosted_connection_requires_reconnect', 409);
    const { data: pr } = await github.rest.pulls.get({ ...splitRepo(snapshot.repository), pull_number: snapshot.pr });
    requireCondition(pr.head.sha === snapshot.head && pr.base.sha === snapshot.base && pr.state === 'open' && !pr.draft, 'stale_pull_request', 409);
    const { data: branch } = await github.rest.repos.getBranch({ ...splitRepo(snapshot.repository), branch: snapshot.defaultBranch });
    requireCondition(branch.protected && branch.commit.sha === snapshot.workflowSha, 'trusted_default_branch_changed_or_unprotected', 409);
    const config = await trustedConfig(github, snapshot.repository, snapshot.defaultBranch);
    await verifyActor(github, snapshot.actor, snapshot.actorId);
    const livePermission = await permission(github, snapshot.repository, snapshot.actor,snapshot.actorId);
    requireCondition(!snapshot.triggerActor || (livePermission==='admin' && config.credentials.automatic_reviewer?.toLowerCase()===snapshot.actor.toLowerCase()),'automatic_review_authorization_revoked',403);
    requireCondition(config.review.enabled && authorize(snapshot.actor, livePermission, config.authorization), 'review_authorization_revoked', 403);
  }
  if(operation==='prepare'||operation==='context'){
    if(operation==='prepare')requireCondition(await store.prepare(id, identity.runId), 'request_already_started', 409);
    else requireCondition(row.state==='running'&&row.run_id===identity.runId,'request_not_running',409);
    // Acquire before reading: reconnect must not replace the record between snapshot and lease.
    if (operation==='prepare'&&snapshot.config.credentials.mode === 'chatgpt') await store.acquire(snapshot);
    const credentialSession = operation==='prepare'&&snapshot.config.credentials.mode === 'chatgpt' ? await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId) : null;
    if (operation==='prepare'&&snapshot.config.credentials.mode === 'chatgpt') requireCondition(credentialSession, 'chatgpt_session_not_connected', 409);
    const { token } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, { contents: 'read', pull_requests: 'read' });
    if(operation==='context')return Response.json({read_token:token});
    await notify(env, store, snapshot);
    return Response.json({ snapshot, read_token: token, session: credentialSession });
  }
  if (operation === 'rotate') {
    requireCondition(row.state === 'running', 'request_not_running', 409);
    const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, MAX_RESULT_BODY_BYTES))) as unknown);
    requireCondition(Number.isSafeInteger(body.version), 'invalid_session_version');
    await store.rotate(snapshot, Number(body.version), envelope(body.envelope));
    return Response.json({ status: 'saved' });
  }
  if (operation === 'renew') {
    requireCondition(row.state === 'running' && snapshot.config.credentials.mode === 'chatgpt', 'request_not_running', 409);
    const liveConfig = await trustedConfig(github, snapshot.repository, snapshot.defaultBranch);
    await verifyActor(github, snapshot.actor, snapshot.actorId);
    requireCondition(liveConfig.review.enabled && authorize(snapshot.actor, await permission(github, snapshot.repository, snapshot.actor, snapshot.actorId), liveConfig.authorization), 'review_authorization_revoked', 403);
    const { data: branch } = await github.rest.repos.getBranch({ ...splitRepo(snapshot.repository), branch: snapshot.defaultBranch });
    requireCondition(branch.protected && branch.commit.sha === snapshot.workflowSha, 'trusted_default_branch_changed_or_unprotected', 409);
    return Response.json(await renewHosted(env, snapshot));
  }
  if (operation === 'result') {
    const body = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, MAX_RESULT_BODY_BYTES))) as unknown);
    requireCondition(typeof body.context_complete === 'boolean' && body.output !== undefined, 'invalid_result_submission');
    const input = body.failure !== undefined ? failure(body.failure) : null;
    if (input) requireCondition(body.context_complete === false, 'failure_requires_incomplete_result');
    await store.result(id, body.output, body.context_complete, identity.runId);
    if (input) {
      await store.noteFailure(id, identity.runId, input.code, input.stage, input.status);
      if (input.revoked) await env.DB.prepare("UPDATE web_connections SET state='reconnect_required' WHERE installation_id=? AND repository_id=? AND actor_id=?").bind(snapshot.installationId, snapshot.repositoryId, snapshot.actorId).run();
    }
    await notify(env, store, snapshot);
    return Response.json({ status: 'recorded' });
  }
  if (row.state === 'published') return Response.json({ status: 'already_published', review_id: row.review_id });
  if (row.state === 'failed') { await notify(env, store, snapshot); return Response.json({ status: 'review_failed' }); }
  if (snapshot.config.credentials.mode === 'chatgpt') requireCondition(await store.session(snapshot.repositoryId, snapshot.actorId, snapshot.installationId), 'chatgpt_connection_revoked', 403);
  requireCondition(['reviewed','publishing'].includes(row.state) && row.result !== null, 'request_not_ready_for_publication', 409);
  const input = record(JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))) as unknown);
  requireCondition(input.review_job_failed === undefined || typeof input.review_job_failed === 'boolean', 'invalid_publication_job_state');
  const lease = await store.claimPublication(id, identity.runId);
  if (input.review_job_failed === true) await store.noteFailure(id, identity.runId, 'review_job_failed', 'workflow');
  await notify(env, store, snapshot);
  try {
    const { github: publisher } = await installationClient(env, snapshot.installationId, snapshot.repositoryId, {
      contents: mergeRequested(snapshot) ? 'write' : 'read', pull_requests: 'write',
      ...(mergeRequested(snapshot) && deploymentMergeEnabled(env,snapshot) ? { checks: 'write', administration: 'read' } as const : {})
    });
    const result = await publish(publisher, snapshot, JSON.parse(row.result) as unknown, row.context_complete === 1 && input.review_job_failed !== true, env.GITHUB_APP_SLUG, {
      checkpoint: (reviewId, phase, merge) => store.checkpoint(id, lease, reviewId, phase, merge),
      merge: { enabled: deploymentMergeEnabled(env,snapshot), appId: Number(env.GITHUB_APP_ID) },
      beforeWrite: async () => {await store.authorizeAutomatic(snapshot);await store.heartbeat(id,lease);}
    });
    await store.published(id, result.reviewId, lease); await notify(env, store, snapshot); return Response.json(result);
  } catch (error) { await store.publicationFailed(id, lease, error instanceof AppError && error.status < 500 && error.status !== 429); throw error; }
  finally { await store.release(snapshot); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await route(request, env);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      // no-referrer makes browser form navigations send Origin:null. Keep exact
      // same-origin CSRF checks, while callback redirects never forward codes.
      response.headers.set('Referrer-Policy', response.headers.get('Content-Type')?.startsWith('text/html') && !new URL(request.url).pathname.endsWith('/callback') ? 'same-origin' : 'no-referrer');
      response.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      return response;
    } catch (error) {
      // No raw exceptions, URLs, authorization headers, source, prompts or provider responses in telemetry.
      const code = error instanceof AppError ? error.code : 'internal_error';
      console.error(JSON.stringify({ event: 'request_failed', code }));
      return Response.json({ error: code }, { status: error instanceof AppError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
    }
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === '*/2 * * * *') {
      // A separate bounded invocation prevents busy dispatch/publication queues
      // from starving terminal comment updates or sharing their subrequest budget.
      const store = new Store(env.DB); await store.cleanup(); await recoverRejection(env); await recoverProgress(env, store);
    } else await recover(env);
  }
} satisfies ExportedHandler<Env>;
