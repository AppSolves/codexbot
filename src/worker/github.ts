import { Octokit } from '@octokit/rest';
import { importPKCS8, SignJWT } from 'jose';
import { parseConfig } from '../core/config.js';
import type { Config } from '../core/config.js';
import type { RepositoryPermission } from '../core/policy.js';
import { requireCondition } from '../core/errors.js';

export interface GitHubCredentials { GITHUB_APP_ID: string; GITHUB_PRIVATE_KEY: string }
export function splitRepo(fullName: string): { owner: string; repo: string } {
  requireCondition(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(fullName), 'invalid_repository');
  const [owner, repo] = fullName.split('/'); return { owner: owner!, repo: repo! };
}
export async function appClient(env: GitHubCredentials): Promise<Octokit> {
  const key = await importPKCS8(env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.GITHUB_APP_ID).setIssuedAt(now - 30).setExpirationTime(now + 300).sign(key);
  return client(jwt);
}
export function client(token: string): Octokit {
  // Request errors can contain authorization headers: callers never log raw errors.
  return new Octokit({ auth: token, log: { debug() {}, info() {}, warn() {}, error() {} }, request: { timeout: 20_000 }, userAgent: 'CodexBot/0.1.0' });
}
export async function installationClient(env: GitHubCredentials, installation: number, repositoryId: number, permissions: { contents?: 'read' | 'write'; pull_requests?: 'read' | 'write'; actions?: 'read' | 'write'; workflows?: 'write'; checks?: 'write'; administration?: 'read' }): Promise<{ github: Octokit; token: string }> {
  const app = await appClient(env);
  const { data } = await app.rest.apps.createInstallationAccessToken({ installation_id: installation, repository_ids: [repositoryId], permissions });
  return { github: client(data.token), token: data.token };
}
export async function permission(github: Octokit, repository: string, login: string, expectedId?: number): Promise<RepositoryPermission> {
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...splitRepo(repository), username: login });
  if (expectedId !== undefined) requireCondition(data.user?.id === expectedId && data.user.type === 'User', 'permission_identity_changed', 403);
  return data.permission as RepositoryPermission;
}
export async function verifyActor(github: Octokit, login: string, id: number): Promise<void> {
  const { data } = await github.rest.users.getByUsername({ username: login });
  requireCondition(data.id === id && data.type === 'User', 'requester_identity_changed', 403);
}
export async function trustedConfig(github: Octokit, repository: string, ref: string): Promise<Config> {
  try {
    const { data } = await github.rest.repos.getContent({ ...splitRepo(repository), path: '.codexbot.yml', ref });
    requireCondition(!Array.isArray(data) && data.type === 'file' && 'content' in data && data.size <= 32_768, 'invalid_configuration_file');
    return parseConfig(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) return parseConfig('');
    throw error;
  }
}
