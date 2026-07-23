import { readFile, writeFile, copyFile, rename, mkdir, readdir, unlink, stat } from 'fs/promises';
import { dirname, basename, join } from 'path';
import { resolveSafePath } from './security.js';

/**
 * How many timestamped backups to keep per file (env RPGMV_BACKUP_KEEP, default 10).
 */
const BACKUP_KEEP = Math.max(1, parseInt(process.env.RPGMV_BACKUP_KEEP || '10', 10) || 10);

/**
 * Dry-run mode. When active, mutating writes are recorded instead of performed,
 * so a caller can preview what a tool would change without touching disk.
 * The tool-call queue in server.ts serializes requests, so a module-level flag
 * is safe: only one tool executes at a time.
 */
let dryRunActive = false;
const dryRunLog: { filePath: string; bytes: number }[] = [];

function setDryRun(value: boolean): void {
  dryRunActive = value;
  dryRunLog.length = 0;
}

function isDryRun(): boolean {
  return dryRunActive;
}

/** Snapshot of the files that would have been written during the current dry run. */
function getDryRunLog(): { filePath: string; bytes: number }[] {
  return dryRunLog.slice();
}

/** Compact sortable timestamp: YYYYMMDD-HHMMSS-mmm (local time). */
function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/**
 * Copy the current version of a data file into {projectRoot}/.mcp-backups/ with a
 * timestamped name, then prune to the newest BACKUP_KEEP for that file. Data and
 * map files both live under {projectRoot}/data/, so the project root is the file's
 * grandparent directory. Best-effort: never throws (a backup failure must not block
 * the write it protects, and a missing source file just means nothing to back up).
 */
async function rotateBackup(filePath: string): Promise<void> {
  try {
    await stat(filePath); // nothing to back up if the file doesn't exist yet
  } catch {
    return;
  }
  const projectRoot = dirname(dirname(filePath));
  const backupDir = join(projectRoot, '.mcp-backups');
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  try {
    await mkdir(backupDir, { recursive: true });
    await copyFile(filePath, join(backupDir, `${base}.${backupTimestamp()}${ext}`));
  } catch {
    return; // if we can't even create the backup, don't block the real write
  }
  try {
    const prefix = base + '.';
    const entries = await readdir(backupDir);
    const mine = entries.filter(e => e.startsWith(prefix) && e.endsWith(ext)).sort();
    for (let i = 0; i < mine.length - BACKUP_KEEP; i++) {
      await unlink(join(backupDir, mine[i])).catch(() => {});
    }
  } catch {
    // pruning is best-effort
  }
}

/**
 * Atomic, backup-protected write for any project file. Honors dry-run.
 *
 * Ordering guarantees:
 *  1. In dry-run, records the intent and returns without touching disk.
 *  2. Rotates a timestamped backup of the current file (keeps the last N).
 *  3. Writes to a `.tmp` sibling, then renames it over the target. rename() is
 *     atomic on the same volume, so an interrupted write can never leave a
 *     half-written JSON in place — the old file survives until the rename.
 * The legacy single-level `.bak` is still produced for backward compatibility.
 */
async function safeWrite(filePath: string, content: string): Promise<void> {
  if (dryRunActive) {
    dryRunLog.push({ filePath, bytes: Buffer.byteLength(content, 'utf-8') });
    console.error(`[DRY-RUN] would write ${filePath}`);
    return;
  }
  await rotateBackup(filePath);
  try {
    await copyFile(filePath, filePath + '.bak');
  } catch {
    // legacy .bak: file may not exist yet
  }
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
  console.error(`[WRITE] ${filePath}`);
}

/**
 * Get the full path to a data file in the RPG Maker MV project.
 * All data files live under {projectPath}/data/
 */
function getDataPath(projectPath: string, filename: string) {
  return resolveSafePath(projectPath, 'data', filename);
}

/**
 * Get the full path to a map file.
 * Map files are named Map001.json, Map002.json, etc.
 */
function getMapPath(projectPath: string, mapId: number) {
  const filename = `Map${String(mapId).padStart(3, '0')}.json`;
  return getDataPath(projectPath, filename);
}

/**
 * Read and parse a JSON file from the RPG Maker MV data directory.
 * @param {string} projectPath - The project root path
 * @param {string} filename - The filename within data/ (e.g. "Actors.json")
 * @returns {Promise<any>} Parsed JSON content
 */
async function readJson(projectPath: string, filename: string) {
    const filePath = getDataPath(projectPath, filename);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
}

/**
 * Write JSON data to a file in the RPG Maker MV data directory.
 * Creates a .bak backup before writing. Logs write to stderr.
 * @param {string} projectPath - The project root path
 * @param {string} filename - The filename within data/ (e.g. "Actors.json")
 * @param {any} data - The data to serialize and write
 */
async function writeJson(projectPath: string, filename: string, data: unknown) {
  const filePath = getDataPath(projectPath, filename);
  await safeWrite(filePath, JSON.stringify(data, null, 2));
}

/**
 * Ensure a JSON array handles RPG Maker MV's convention of null at index 0.
 * MV stores data arrays where index 0 is always null and real data starts at index 1.
 * This function guarantees the array has the null padding.
 * @param {any[]} json - The parsed JSON array
 * @returns {any[]} The array with null at index 0 guaranteed
 */
function ensureArray(json: unknown): unknown[] {
  if (!Array.isArray(json)) return [null];
  if (json.length === 0) return [null];
  if (json[0] === null) return json;
  return [null, ...json];
}

/**
 * Find the next available ID in a RPG Maker MV data array.
 * MV arrays have null at index 0, and IDs correspond to array indices.
 * Skips null entries and finds the highest existing ID, then returns max+1.
 * @param {any[]} array - The data array (e.g. from Actors.json)
 * @returns {number} The next available ID
 */
function nextId(array: unknown[]): number {
  let max = 0;
  for (let i = 0; i < array.length; i++) {
    if (array[i] && (array[i] as Record<string, unknown>).id && ((array[i] as Record<string, unknown>).id as number) > max) {
      max = (array[i] as Record<string, unknown>).id as number;
    }
  }
  return max + 1;
}

/**
 * Validate that the RPG Maker MV project path is valid.
 * Checks that data/System.json exists (essential project file).
 * @param {string} projectPath - The project root path to validate
 * @returns {Promise<boolean>} True if valid project path
 */
async function validateProjectPath(projectPath: string): Promise<boolean> {
  try {
    const systemPath = getDataPath(projectPath, 'System.json');
    await readFile(systemPath, 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

export { getDataPath };
export { getMapPath };
export { readJson };
export { writeJson };
export { safeWrite };
export { setDryRun };
export { isDryRun };
export { getDryRunLog };
export { ensureArray };
export { nextId };
export { validateProjectPath };
