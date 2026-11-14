import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Shared by deterministic tool execution and opt-in real-provider acceptance.
export async function writeInspectionFixture(directory, request, buggy = true) {
  const marker = randomUUID();
  const base = `// fixture ${marker}\nexport function canAccess(role) {\n  return role === 'admin' || role === 'owner';\n}\n`;
  const line = buggy ? "  return role === 'admin' || 'owner';" : "  return role === 'owner' || role === 'admin';";
  const source = base.split('\n').map((value, index) => index === 2 ? line : value).join('\n');
  const files = [{ filename: 'src/access.js', status: 'modified', additions: 1, deletions: 1,
    patch: `@@ -1,4 +1,4 @@\n // fixture ${marker}\n export function canAccess(role) {\n-  return role === 'admin' || role === 'owner';\n+${line}\n }` }];
  const instructions = [{ path: 'AGENTS.md', content: `Fixture instructions ${marker}: only admin and owner roles may access protected records. Authorization helpers must return booleans. Inspect callers and exact changed lines; do not execute project code.` }];
  await mkdir(join(directory, 'source', 'head', 'src'), { recursive: true });
  await mkdir(join(directory, 'source', 'base', 'src'), { recursive: true });
  await writeFile(join(directory, 'source', 'head', 'src', 'access.js'), source);
  await writeFile(join(directory, 'source', 'base', 'src', 'access.js'), base);
  for (const [file, value] of [['request.json', request], ['manifest.json', { complete: true, diffComplete: true, requiredContextComplete: true }], ['diff.json', files], ['trusted-instructions.json', instructions]]) await writeFile(join(directory, file), JSON.stringify(value));
  return { files, source, base, instructions, marker };
}
