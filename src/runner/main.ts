import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { client } from '../worker/github.js';
import type { RequestSnapshot } from '../worker/store.js';
import type { Envelope } from '../core/crypto.js';
import { unseal, seal, sessionBinding } from '../core/crypto.js';
import { record, requireCondition } from '../core/errors.js';
import { OAuth, validateSession } from '../auth/oauth.js';
import { broker, backendUrl } from './broker.js';
import { collectContext } from './context.js';
import { isolatedReview } from './docker.js';
import { failedReview } from '../core/review.js';

export async function reviewJob(): Promise<void> {
  const backend = backendUrl(process.env.CODEXBOT_BACKEND ?? ''), id = process.env.CODEXBOT_REQUEST_ID ?? '';
  const temporary = await mkdtemp(join(tmpdir(), 'codexbot-'));
  let snapshot: RequestSnapshot | null = null;
  let submission: { output: unknown; context_complete: boolean } | null = null;
  try {
    const prepared = record(await broker(backend, id, 'prepare'));
    snapshot = prepared.snapshot as RequestSnapshot;
    requireCondition(snapshot.id === id && String(snapshot.actorId) === process.env.CODEXBOT_CREDENTIAL_OWNER && String(snapshot.installationId) === process.env.CODEXBOT_INSTALLATION_ID, 'credential_owner_mismatch');
    requireCondition(typeof prepared.read_token === 'string', 'missing_read_token');
    const github = client(prepared.read_token);
    const directory = join(temporary, 'context');
    let manifest;
    try { manifest = await collectContext(github, snapshot, directory); }
    finally { await github.rest.apps.revokeInstallationAccessToken(); }
    let credential: string;
    if (snapshot.config.credentials.mode === 'api-key') {
      requireCondition(process.env.CODEXBOT_API_KEY && !process.env.CODEXBOT_VAULT_KEY, 'api_key_missing_or_ambiguous_credentials');
      credential = process.env.CODEXBOT_API_KEY;
    } else {
      requireCondition(process.env.CODEXBOT_VAULT_KEY && !process.env.CODEXBOT_API_KEY, 'vault_key_missing_or_ambiguous_credentials');
      const saved = record(prepared.session);
      const binding = sessionBinding(backend, snapshot.installationId, snapshot.repositoryId, snapshot.actorId);
      let session = validateSession(await unseal(saved.envelope as Envelope, process.env.CODEXBOT_VAULT_KEY, binding));
      if (session.expires_at - Date.now() < 25 * 60_000) {
        session = await new OAuth().refresh(session);
        // Durably persist rotated credentials before starting inference. A conflict fails closed.
        await broker(backend, id, 'rotate', { version: saved.version, envelope: await seal(session, process.env.CODEXBOT_VAULT_KEY, binding) });
      }
      requireCondition(session.expires_at - Date.now() >= 22 * 60_000, 'session_too_short_reconnect_required');
      credential = session.access_token;
    }
    const credentialPath = join(temporary, 'credential');
    await writeFile(credentialPath, credential, { mode: 0o600 });
    // The container runs as this host uid; the credential file remains owner-readable only.
    await mkdir(directory, { recursive: true });
    // Context is private source, readable only by the dedicated container uid via a read-only bind.
    const image = process.env.CODEXBOT_IMAGE; requireCondition(image, 'review_image_missing');
    const sockets = join(temporary, 'sockets'); await mkdir(sockets, { mode: 0o700 });
    const output = await isolatedReview(image, directory, credentialPath, sockets);
    submission = { output, context_complete: manifest.complete };
    await broker(backend, id, 'result', submission);
  } catch {
    // Always leave a deterministic non-approving result when preflight succeeded.
    if (snapshot) await broker(backend, id, 'result', submission ?? { context_complete: false, output: failedReview(snapshot.head) });
    else throw new Error('review_preflight_failed');
  } finally {
    try {
      try { await broker(backend, id, 'release'); }
      catch {
        // A durable result must still reach the separately protected publisher.
        // Backend cleanup releases terminal/expired leases; surface the cleanup failure explicitly.
        process.stderr.write('CodexBot session release failed; backend lease cleanup is required.\n');
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
if (process.argv[2] === 'review') {
  try { await reviewJob(); } catch { process.stderr.write('CodexBot review failed; no approval or merge authorized.\n'); process.exitCode = 1; }
} else if (process.argv[2] === 'publish') {
  try { const result = record(await broker(process.env.CODEXBOT_BACKEND ?? '', process.env.CODEXBOT_REQUEST_ID ?? '', 'publish')); process.stdout.write(`CodexBot publication: ${String(result.event ?? result.status)}; merge: ${String(result.merge ?? 'unchanged')}\n`); }
  catch { process.stderr.write('CodexBot publication failed; inspect backend diagnostic codes.\n'); process.exitCode = 1; }
}
