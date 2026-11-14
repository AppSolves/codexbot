import { readFile } from 'node:fs/promises';
import { createInferenceServer } from './proxy.js';
import type { InferenceLimits } from './proxy.js';
const token = (await readFile('/run/credential', 'utf8')).trim();
if (!token || /[\r\n]/.test(token)) throw new Error('invalid_credential');
process.umask(0o077);
const limits = JSON.parse(process.env.CODEXBOT_ACCEPTANCE_LIMITS ?? '{}') as InferenceLimits;
createInferenceServer(token, limits).listen('/run/proxy/inference.sock', () => process.stdout.write('codexbot-proxy-ready\n'));
