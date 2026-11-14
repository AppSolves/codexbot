import { requireCondition } from './errors.js';
export function base64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url'); }
export function randomSecret(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha256(value: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export async function verifyWebhook(body: Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) return false;
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Buffer.from(signature.slice(7), 'hex'), body as Uint8Array<ArrayBuffer>);
}
export interface Envelope { version: 1; iv: string; ciphertext: string }
export function sessionBinding(origin: string, installation: number, repository: number, actor: number): string {
  return `${origin}|v2|${installation}|${repository}|${actor}`;
}
export async function seal(value: unknown, secret: string, binding: string): Promise<Envelope> {
  const raw = Buffer.from(secret, 'base64url'); requireCondition(raw.length === 32, 'invalid_vault_key');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { version: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}
export async function unseal(envelope: Envelope, secret: string, binding: string): Promise<unknown> {
  requireCondition(envelope.version === 1 && envelope.ciphertext.length <= 64_000, 'invalid_envelope');
  const raw = Buffer.from(secret, 'base64url'); requireCondition(raw.length === 32, 'invalid_vault_key');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64url'), additionalData: new TextEncoder().encode(binding) }, key, Buffer.from(envelope.ciphertext, 'base64url'));
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
