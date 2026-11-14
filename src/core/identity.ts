import { requireCondition } from './errors.js';

export function credentialEnvironment(installation: number, actor: number): string {
  requireCondition(Number.isSafeInteger(installation) && installation > 0 && Number.isSafeInteger(actor) && actor > 0, 'invalid_credential_owner');
  return `codexbot-${installation}-${actor}`;
}
export function publishingEnvironment(installation: number): string {
  requireCondition(Number.isSafeInteger(installation) && installation > 0, 'invalid_installation');
  return `codexbot-publish-${installation}`;
}
