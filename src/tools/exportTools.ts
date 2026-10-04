import { access, copyFile, mkdir, readFile, readdir, rm, realpath, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { writeZip } from '../utils/zip.js';

/** Build an MV HTML5 deployment. Asset names include MV .rpgmvp/.rpgmvo/.rpgmvm
 * encrypted variants; bytes and System encryption flags/key remain unchanged.
 * Static string scanning is conservative, but dynamic plugin names need prune:false.
 */
async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Copied wholesale (no pruning). */
const WHOLESALE_DIRS = ['js', 'css', 'fonts', 'icon'] as const;
/** Pruned by referenced basename (except `img/system`). */
const PRUNABLE_DIRS = ['img', 'audio', 'movies'] as const;
/** Everything the export reads from — `outDir` may not live inside any of these. */
const SOURCE_DIRS = [...WHOLESALE_DIRS, ...PRUNABLE_DIRS, 'data', 'save'];

/** Marker written into the export folder (never zipped) so a re-export may safely wipe it. */
const EXPORT_MARKER = '.rpgmaker-mcp-export';

/** itch.io caps an HTML5 upload at 1000 files and 200 MB per extracted file. */
const ITCH_MAX_FILES = 1000;
const ITCH_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** How many dropped paths to list before truncating. */
const DROPPED_LIST_CAP = 200;

export interface ExportWebOptions {
  outDir: string;
  zip?: boolean;
  prune?: boolean;
  dryRun?: boolean;
}

export interface ExportWebResult {
  outDir: string;
  dryRun?: boolean;
  zipPath?: string;
  zipBytes?: number;
  /** Files in the deployment. */
  files: number;
  /** Total uncompressed bytes of those files. */
  bytes: number;
  /** Asset files (img/audio/movies) kept. */
  kept: number;
  /** Asset files dropped as unreferenced. */
  dropped: number;
  droppedList?: string[];
  droppedListTruncated?: true;
  /** MV core resolution (plugins may override it) — use it as the itch.io embed size. */
  screen: { width: number; height: number };
  warnings?: string[];
}

/** Recursively list files under `dir` as project-relative forward-slash paths. Missing dir → []. */
async function walk(root: string, rel: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, ...rel.split('/')), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || /\.(?:bak|tmp|mcp-backups)$/.test(e.name) || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/** Strip one trailing extension (`Foo.png` → `Foo`, `Foo.png_` → `Foo`); no extension → unchanged. */
function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9_]{1,8}$/, '');
}

const TOKEN_SPLIT = /[\s,:;<>"'`=(){}[\]|\\/]+/;

/** Add one referenced string (and its derived forms) to the set. */
function addRef(refs: Set<string>, raw: string, depth = 0): void {
  const s = raw.trim();
  if (!s) return;
  const forms = new Set<string>([s]);
  const base = s.split(/[\\/]/).pop();
  if (base) forms.add(base);
  if (s.length <= 4096) for (const tok of s.split(TOKEN_SPLIT)) if (tok) forms.add(tok);
  for (const f of forms) {
    refs.add(f);
    refs.add(stripExt(f));
  }
  // Plugin parameters nest JSON inside strings (struct/list params) — descend.
  if (depth < 6 && (s.startsWith('{') || s.startsWith('[') || s.startsWith('"'))) {
    try {
      collectJsonStrings(refs, JSON.parse(s), depth + 1);
    } catch {
      /* not JSON */
    }
  }
}

function collectJsonStrings(refs: Set<string>, value: unknown, depth = 0): void {
  if (typeof value === 'string') addRef(refs, value, depth);
  else if (Array.isArray(value)) for (const v of value) collectJsonStrings(refs, v, depth);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectJsonStrings(refs, v, depth);
}

const JS_STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** Add every string literal (and `@default` annotation) in a JS source to the set. */
export function collectJsStrings(refs: Set<string>, source: string): void {
  for (const m of source.matchAll(JS_STRING_LITERAL)) {
    addRef(refs, m[2].replace(/\\(.)/g, '$1'));
  }
  for (const m of source.matchAll(/@default[ \t]+([^\r\n]+)/g)) addRef(refs, m[1]);
}

/**
 * The set of names the game may load — see the module comment for what is
 * scanned. Over-inclusive by design.
 */
export async function collectReferencedNames(projectPath: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const dataDir = join(projectPath, 'data');
  let dataFiles: string[] = [];
  try {
    dataFiles = (await readdir(dataDir)).filter((f) => f.endsWith('.json'));
  } catch {
    /* no data dir — nothing referenced */
  }
  for (const f of dataFiles) {
    try {
      collectJsonStrings(refs, JSON.parse(await readFile(join(dataDir, f), 'utf8')));
    } catch {
      /* unreadable/corrupt json — skip rather than fail the export */
    }
  }

  const jsFiles: string[] = [];
  try {
    jsFiles.push(
      ...(await readdir(join(projectPath, 'js')))
        .filter((f) => f.endsWith('.js'))
        .map((f) => join(projectPath, 'js', f)),
    );
  } catch {
    /* no js dir */
  }
  for (const rel of await walk(projectPath, 'js/plugins')) {
    if (rel.endsWith('.js')) jsFiles.push(join(projectPath, ...rel.split('/')));
  }
  for (const file of jsFiles) {
    try {
      collectJsStrings(refs, await readFile(file, 'utf8'));
    } catch {
      /* unreadable — skip */
    }
  }
  return refs;
}

/** Whether a prunable asset (project-relative path) is referenced. */
function isReferenced(rel: string, refs: Set<string>): boolean {
  const parts = rel.split('/');
  if (parts[0] === 'img' && parts[1] === 'system') return true;
  const file = parts[parts.length - 1];
  if (refs.has(file) || refs.has(stripExt(file))) return true;
  // A name referenced with a subfolder (e.g. a picture "ui/Frame" in img/pictures/ui/).
  const inKind = parts.slice(2).join('/');
  return inKind.length > 0 && (refs.has(inKind) || refs.has(stripExt(inKind)));
}

function isWithin(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Refuse output locations that would clobber or recurse into the project. */
function checkOutDir(projectPath: string, outAbs: string): void {
  const proj = resolve(projectPath);
  if (isWithin(proj, outAbs)) {
    throw new Error(
      `outDir ${outAbs} is the project folder or contains it — choose a separate folder.`,
    );
  }
  for (const d of [...SOURCE_DIRS, 'index.html']) {
    if (isWithin(outAbs, join(proj, d))) {
      throw new Error(
        `outDir ${outAbs} is inside the project's ${d}/ folder, which the export copies from — choose a folder outside it.`,
      );
    }
  }
}

/** Prepare an empty outDir: create it, or wipe a previous export (marker present). Refuse anything else. */
async function prepareOutDir(outAbs: string): Promise<void> {
  let existing: string[] = [];
  try {
    existing = await readdir(outAbs);
  } catch {
    /* doesn't exist yet */
  }
  if (existing.length > 0) {
    if (!(await fileExists(join(outAbs, EXPORT_MARKER)))) {
      throw new Error(
        `outDir ${outAbs} exists and is not empty (and isn't a previous export_web output). Choose an empty or new folder.`,
      );
    }
    await rm(outAbs, { recursive: true, force: true });
  }
  await mkdir(outAbs, { recursive: true });
  await writeFile(join(outAbs, EXPORT_MARKER), 'Created by rpgmaker-mv-mcp export_web.\n');
}

async function screenSize(projectPath: string): Promise<{ width: number; height: number }> {
  const source = await readFile(join(projectPath, 'js', 'rpg_managers.js'), 'utf8').catch(() => '');
  return {
    width: Number(source.match(/SceneManager\._screenWidth\s*=\s*(\d+)/)?.[1]) || 816,
    height: Number(source.match(/SceneManager\._screenHeight\s*=\s*(\d+)/)?.[1]) || 624,
  };
}

/** Resolve existing ancestors so junctions cannot redirect an export into source files. */
async function canonicalTarget(target: string): Promise<string> {
  try { return await realpath(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(target);
    if (parent === target) throw error;
    return join(await canonicalTarget(parent), relative(parent, target));
  }
}

/**
 * Build the deployment folder at `outDir` (resolved against the project root when
 * relative) and, with `zip` (default), `<outDir>.zip` beside it with `index.html`
 * at the archive root. Writes nothing inside the project.
 */
export async function exportWeb(
  projectPath: string,
  opts: ExportWebOptions,
): Promise<ExportWebResult> {
  // Pruning is opt-in: assets named only at runtime by a plugin would vanish from the build.
  const { zip = true, prune = false } = opts;
  if (!opts.outDir || !opts.outDir.trim()) throw new Error('outDir is required.');
  projectPath = await realpath(projectPath);
  const requested = resolve(projectPath, opts.outDir);
  const outAbs = await canonicalTarget(requested);
  checkOutDir(projectPath, outAbs);
  if (zip) checkOutDir(projectPath, await canonicalTarget(outAbs + '.zip'));
  if (!(await fileExists(join(projectPath, 'index.html')))) {
    throw new Error(
      `No index.html in ${projectPath} — not a deployable RPG Maker MV project (the web runtime entry point is missing).`,
    );
  }

  // Gather the file list first, so a bad project fails before outDir is touched.
  const files: string[] = ['index.html'];
  for (const d of WHOLESALE_DIRS) files.push(...(await walk(projectPath, d)));
  try {
    files.push(
      ...(await readdir(join(projectPath, 'data')))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => `data/${f}`),
    );
  } catch {
    /* no data dir — the deployment will be broken, but that's the project's state */
  }

  const refs = prune ? await collectReferencedNames(projectPath) : undefined;
  let kept = 0;
  const droppedPaths: string[] = [];
  for (const d of PRUNABLE_DIRS) {
    for (const rel of await walk(projectPath, d)) {
      if (!refs || isReferenced(rel, refs)) {
        files.push(rel);
        kept++;
      } else {
        droppedPaths.push(rel);
      }
    }
  }
  // The folder is protected by its marker; the zip beside it needs the same care, or an unrelated
  // <outDir>.zip would be overwritten. Only a previous export's zip (its folder has the marker) is replaced.
  if (zip && (await fileExists(outAbs + '.zip')) && !(await fileExists(join(outAbs, EXPORT_MARKER)))) {
    throw new Error(outAbs + '.zip already exists and is not from a previous export_web. Move it or choose another outDir.');
  }
  if (!opts.dryRun) await prepareOutDir(outAbs);
  let bytes = 0;
  const warnings: string[] = [];
  for (const rel of files) {
    const src = join(projectPath, ...rel.split('/'));
    const dest = join(outAbs, ...rel.split('/'));
    const actual = await realpath(src);
    if (!isWithin(actual, projectPath)) throw new Error(`Export source escapes project: ${rel}`);
    if (!opts.dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
    const { size } = await stat(src);
    bytes += size;
    if (size > ITCH_MAX_FILE_BYTES) {
      warnings.push(
        `${rel} is ${(size / 1048576).toFixed(1)} MB — itch.io rejects HTML5 uploads with any file over 200 MB.`,
      );
    }
  }
  if (files.length > ITCH_MAX_FILES) {
    warnings.push(
      `${files.length} files — itch.io caps HTML5 uploads at ${ITCH_MAX_FILES} files${prune ? '' : ' (try prune: true)'}.`,
    );
  }

  const result: ExportWebResult = {
    outDir: outAbs,
    dryRun: opts.dryRun === true,
    files: files.length,
    bytes,
    kept,
    dropped: droppedPaths.length,
    screen: await screenSize(projectPath),
  };
  if (droppedPaths.length > 0) {
    result.droppedList = droppedPaths.slice(0, DROPPED_LIST_CAP);
    if (droppedPaths.length > DROPPED_LIST_CAP) result.droppedListTruncated = true;
  }

  if (zip && !opts.dryRun) {
    const zipPath = `${outAbs}.zip`;
    const zipped = await writeZip(
      zipPath,
      files.map((rel) => ({ name: rel, source: join(outAbs, ...rel.split('/')) })),
    );
    result.zipPath = zipped.path;
    result.zipBytes = zipped.bytes;
  }
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
