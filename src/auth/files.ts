import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.js';

export async function securePrivatePath(path: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, directory ? 0o700 : 0o600); return; }
  const root = process.env.SystemRoot;
  if (!root) throw new AppError('windows_acl_system_root_missing');
  // A fresh ACL removes inherited/explicit access for other users. No caller text is interpolated as code.
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().User; $taskAcl=New-Object Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}; $taskAcl.SetAccessRuleProtection($true,$false); $taskRule=New-Object Security.AccessControl.FileSystemAccessRule($taskUser,'FullControl'${directory ? ",'ContainerInherit,ObjectInherit','None'" : ''},'Allow'); $taskAcl.AddAccessRule($taskRule); [IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($taskPath,$taskAcl)`;
  try { await promisify(execFile)(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }); }
  catch { throw new AppError('cannot_secure_windows_credential_acl'); }
}

export async function atomicPrivateFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await securePrivatePath(dirname(path), true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await securePrivatePath(temporary, false); await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
}
export async function readPrivateFile(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}
export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await securePrivatePath(dirname(path), true);
  let file;
  try { file = await open(`${path}.lock`, 'wx', 0o600); }
  catch { throw new AppError('credential_file_locked_close_other_process_or_recover_lock'); }
  try { return await action(); } finally { await file.close(); await unlink(`${path}.lock`); }
}
