import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import type { Octokit } from '@octokit/rest';
import { splitRepo } from './github.js';
import { requireCondition } from '../core/errors.js';

/** libsodium crypto_box_seal format: ephemeral X25519 key || XSalsa20-Poly1305 box. */
export function sealEnvironmentSecret(value: string, publicKey: string): string {
  const recipient = Buffer.from(publicKey, 'base64'); requireCondition(recipient.length === nacl.box.publicKeyLength, 'invalid_environment_public_key');
  const ephemeral = nacl.box.keyPair.fromSecretKey(crypto.getRandomValues(new Uint8Array(32)));
  try {
    const nonce = blake2b(Buffer.concat([ephemeral.publicKey, recipient]), undefined, nacl.box.nonceLength);
    const encrypted = nacl.box(new TextEncoder().encode(value), nonce, recipient, ephemeral.secretKey);
    return Buffer.concat([ephemeral.publicKey, encrypted]).toString('base64');
  } finally { ephemeral.secretKey.fill(0); }
}
export async function putEnvironmentSecret(github: Octokit, repository: string, environment: string, name: 'CODEXBOT_VAULT_KEY' | 'CODEXBOT_API_KEY', value: string): Promise<void> {
  const repo = splitRepo(repository), { data: key } = await github.rest.actions.getEnvironmentPublicKey({ ...repo, environment_name: environment });
  await github.rest.actions.createOrUpdateEnvironmentSecret({ ...repo, environment_name: environment, secret_name: name,
    key_id: key.key_id, encrypted_value: sealEnvironmentSecret(value, key.key) });
}
