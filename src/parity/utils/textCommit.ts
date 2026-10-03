import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { basename, dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { commitStore, diffJson, type CommitResult } from './commit.js';

export interface TextChange {
  path: string;
  text: string;
}

interface PreparedChange extends TextChange {
  old: Buffer | null;
  result: CommitResult;
  staged?: string;
  backup?: string;
  applied?: boolean;
}

async function readExisting(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Commit related UTF-8 files, e.g. a bridge plugin and its plugin manifest.
 * Prepares all bytes before replacing any target; each replacement is atomic.
 * On an ordinary I/O failure, already replaced files are restored. This is not
 * a crash-atomic multi-file transaction. Unique backups retain prior bytes.
 * Dry runs use the same commit context/diff format as JSON writers and create
 * neither directories, staging files, nor backups.
 */
export async function commitTextBatch(changes: TextChange[]): Promise<CommitResult[]> {
  const paths = changes.map((change) => resolve(change.path));
  const keys = paths.map((path) => (process.platform === 'win32' ? path.toLowerCase() : path));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate text commit target');
  const context = commitStore.getStore();
  const dryRun = context?.dryRun ?? false;
  const prepared: PreparedChange[] = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const path = paths[i];
    const old = await readExisting(path);
    const result: CommitResult = {
      path,
      changed: old === null || old.toString('utf8') !== change.text,
      dryRun,
      diff: diffJson(old === null ? undefined : old.toString('utf8'), change.text),
    };
    prepared.push({ ...change, path, old, result });
  }
  const changed = prepared.filter((change) => change.result.changed);
  if (!dryRun) {
    try {
      // Stage every file before committing any of them.
      for (const change of changed) {
        await mkdir(dirname(change.path), { recursive: true });
        change.staged = `${change.path}.mcp-${randomUUID()}.tmp`;
        await writeFile(change.staged, change.text, { encoding: 'utf8', flag: 'wx' });
      }
      // Refuse to clobber an editor/external write between preparation and commit.
      for (const change of changed) {
        const current = await readExisting(change.path);
        if (
          current === null
            ? change.old !== null
            : change.old === null || !current.equals(change.old)
        ) {
          throw new Error(`File changed during preparation: ${change.path}`);
        }
      }
      for (const change of changed) {
        if (change.old !== null) {
          const directory = `${change.path}.mcp-backups`;
          await mkdir(directory, { recursive: true });
          change.backup = `${directory}/${Date.now()}-${randomUUID()}-${basename(change.path)}`;
          await writeFile(change.backup, change.old, { flag: 'wx' });
        }
        await rename(change.staged!, change.path);
        change.staged = undefined;
        change.applied = true;
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const change of [...changed].reverse()) {
        if (!change.applied) continue;
        try {
          if (change.old === null) {
            await unlink(change.path);
          } else {
            const restore = `${change.path}.mcp-${randomUUID()}.tmp`;
            change.staged = restore;
            await copyFile(change.backup!, restore);
            await rename(restore, change.path);
            change.staged = undefined;
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${change.path}: ${String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Text commit failed: ${String(error)}; restore from backups: ${rollbackErrors.join('; ')}`,
        );
      }
      throw error;
    } finally {
      for (const change of changed) {
        if (change.staged) await unlink(change.staged).catch(() => undefined);
      }
    }
  }
  const results = prepared.map((change) => change.result);
  context?.commits.push(...results);
  return results;
}

export async function commitText(path: string, text: string): Promise<CommitResult> {
  return (await commitTextBatch([{ path, text }]))[0];
}
