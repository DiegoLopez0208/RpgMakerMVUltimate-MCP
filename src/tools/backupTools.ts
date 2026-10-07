/**
 * List and restore the timestamped backups every write leaves in <project>/.mcp-backups/.
 *
 * Each backup is the file as it was just before a write, so the newest one is the state before the
 * last change: restoring it undoes that change. Restoring is itself a write, so the version it
 * replaces is backed up too and a restore can be undone the same way.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getDataPath, safeWrite } from '../utils/fileHandler.js';
import { resolveSafePath } from '../utils/security.js';

const BACKUP_NAME = /^(.+)\.(\d{8}-\d{6}-\d{3})(\.[^.]+)?$/;

export interface BackupInfo { id: string; bytes: number; path: string; }
export interface BackedUpFile { file: string; backups: BackupInfo[]; }

/** Backups grouped by the file they protect, newest first. `file` narrows it to one file name. */
export async function listBackups(projectPath: string, file?: string): Promise<{ files: BackedUpFile[] }> {
  const dir = resolveSafePath(projectPath, '.mcp-backups');
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return { files: [] }; }
  const groups = new Map<string, BackupInfo[]>();
  for (const name of names) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;
    const original = match[1] + (match[3] ?? '');
    if (file !== undefined && original !== file) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const list = groups.get(original) ?? [];
    list.push({ id: match[2], bytes: info.size, path });
    groups.set(original, list);
  }
  const files = [...groups.entries()]
    .map(([name, backups]) => ({ file: name, backups: backups.sort((a, b) => b.id.localeCompare(a.id)) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { files };
}

/** Where a backed-up file lives: data/<file> for the database and maps, or js/plugins.js. */
function targetPath(projectPath: string, file: string): string {
  if (file === 'plugins.js') return resolveSafePath(projectPath, 'js', 'plugins.js');
  if (/^[A-Za-z0-9_-]+\.json$/.test(file)) return getDataPath(projectPath, file);
  throw new Error(`Cannot restore "${file}": only data/*.json files and plugins.js are backed up by name.`);
}

/**
 * Put a backup back in place of its file. `backup` is an id from listBackups; without it the newest
 * backup is used, which undoes the last write. A .json backup that is not valid JSON is refused.
 */
export async function restoreBackup(projectPath: string, args: { file: string; backup?: string; dryRun?: boolean }) {
  const file = String(args.file ?? '');
  const target = targetPath(projectPath, file);
  const { files } = await listBackups(projectPath, file);
  const backups = files[0]?.backups ?? [];
  if (backups.length === 0) throw new Error(`No backups of ${file}. action "list_backups" shows what exists.`);
  const chosen = args.backup === undefined ? backups[0] : backups.find((b) => b.id === args.backup);
  if (!chosen) throw new Error(`No backup "${args.backup}" of ${file}. Available: ${backups.map((b) => b.id).join(', ')}.`);
  const content = await readFile(chosen.path, 'utf-8');
  if (file.endsWith('.json')) {
    try { JSON.parse(content.replace(/^﻿/, '')); } catch { throw new Error(`Backup ${chosen.id} of ${file} is not valid JSON; refusing to restore it.`); }
  }
  if (args.dryRun) return { file, wouldRestore: chosen.id, bytes: chosen.bytes };
  await safeWrite(target, content);
  return { file, restored: chosen.id, bytes: chosen.bytes, replacedVersionBackedUp: true };
}
