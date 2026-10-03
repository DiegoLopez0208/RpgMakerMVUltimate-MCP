import { AsyncLocalStorage } from 'async_hooks';
import { readFile } from 'fs/promises';
import { writeJsonFile, deleteFile, fileExists } from './fileHandler.js';

export { commitText, commitTextBatch } from './textCommit.js';

/**
 * A single leaf-level difference between the old and new file contents.
 * `from` absent means the value was added; `to` absent means it was removed.
 */
export interface ChangeRecord {
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface JsonDiff {
  changes: ChangeRecord[];
  /** True if the change list was capped (see MAX_CHANGES). */
  truncated: boolean;
}

export interface CommitResult {
  path: string;
  changed: boolean;
  dryRun: boolean;
  diff: JsonDiff;
  /** True when this commit deletes the file rather than writing it. */
  deleted?: boolean;
}

/**
 * Per-request commit context. `commitChange` reads it via AsyncLocalStorage so
 * dry-run stays a cross-cutting concern: tool functions don't need a `dryRun`
 * parameter threaded through their signatures. When `dryRun` is set, writes are
 * skipped and every attempted change is collected in `commits` for the caller
 * to report back as a preview.
 */
export interface CommitContext {
  dryRun: boolean;
  commits: CommitResult[];
}

export const commitStore = new AsyncLocalStorage<CommitContext>();

// Cap on reported leaf changes, so a wholesale rewrite (e.g. an entire repainted
// tile array) can't produce an enormous diff payload.
const MAX_CHANGES = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural diff between two JSON-serializable values. Recurses through arrays
 * and plain objects, recording only the leaves that actually differ. Equal
 * subtrees produce no records.
 */
export function diffJson(oldValue: unknown, newValue: unknown): JsonDiff {
  const changes: ChangeRecord[] = [];
  let truncated = false;

  const record = (path: string, from: unknown, to: unknown): void => {
    if (changes.length >= MAX_CHANGES) {
      truncated = true;
      return;
    }
    const entry: ChangeRecord = { path };
    if (from !== undefined) entry.from = from;
    if (to !== undefined) entry.to = to;
    changes.push(entry);
  };

  const walk = (path: string, oldVal: unknown, newVal: unknown): void => {
    if (oldVal === newVal) return;
    if (truncated) return;

    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      const len = Math.max(oldVal.length, newVal.length);
      for (let i = 0; i < len; i++) {
        walk(`${path}[${i}]`, oldVal[i], newVal[i]);
      }
    } else if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
      for (const key of keys) {
        walk(path ? `${path}.${key}` : key, oldVal[key], newVal[key]);
      }
    } else {
      record(path, oldVal, newVal);
    }
  };

  walk('', oldValue, newValue);
  return { changes, truncated };
}

/** Read and parse the existing file, treating a missing file as no prior data. */
async function readOld(filePath: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(filePath, 'utf-8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * The single write choke point for all tool mutations. Computes the diff against
 * the file's current contents, then:
 *  - in dry-run mode, records the diff and skips the write;
 *  - otherwise, writes only if something actually changed.
 *
 * Either way the result is pushed onto the active CommitContext (if any) so the
 * dispatcher can surface a preview.
 */
export async function commitChange(filePath: string, newData: unknown): Promise<CommitResult> {
  const context = commitStore.getStore();
  const dryRun = context?.dryRun ?? false;

  const oldData = await readOld(filePath);
  const diff = diffJson(oldData, newData);
  const result: CommitResult = {
    path: filePath,
    changed: diff.changes.length > 0,
    dryRun,
    diff,
  };

  if (!dryRun && result.changed) {
    await writeJsonFile(filePath, newData);
  }

  context?.commits.push(result);
  return result;
}

/**
 * The deletion arm of the write choke point. Mirrors `commitChange` so that
 * file removals participate in the same dry-run/preview machinery: in dry-run
 * the deletion is recorded but not performed, otherwise the file is unlinked
 * (only if it currently exists — a missing file is reported as `changed: false`
 * and left alone). `changed` reflects whether the file existed to begin with,
 * so a preview reads "this file would be deleted" rather than dumping the file's
 * entire contents through `diffJson`.
 */
export async function commitDelete(filePath: string): Promise<CommitResult> {
  const context = commitStore.getStore();
  const dryRun = context?.dryRun ?? false;

  const existed = await fileExists(filePath);
  const result: CommitResult = {
    path: filePath,
    changed: existed,
    dryRun,
    diff: { changes: [], truncated: false },
    deleted: true,
  };

  if (!dryRun && existed) {
    await deleteFile(filePath);
  }

  context?.commits.push(result);
  return result;
}
