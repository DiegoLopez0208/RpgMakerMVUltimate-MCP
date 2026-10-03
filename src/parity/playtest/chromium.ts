import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Locating a Chromium binary for the headless renderer.
 *
 * We never download a browser. `playwright-core` ships without one, and the
 * machines this server runs on usually already have Playwright's browser cache
 * (`npx playwright install chromium-headless-shell` populates it, as does any
 * other Playwright project). So discovery is: an explicit env override first,
 * then the newest cached `chrome-headless-shell`, then the newest cached full
 * Chromium. The ordering logic is pure (filesystem access is injected) so it is
 * unit-testable on any platform.
 */

/** Env var that points straight at a Chromium/Chrome executable. Wins over the cache. */
export const CHROMIUM_ENV = 'RPGMAKER_MCP_CHROMIUM';

export interface ChromiumEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  env: Record<string, string | undefined>;
  /** Directory listing; throws (or returns []) for a missing directory. */
  listDir: (dir: string) => string[];
}

/** The Playwright browser cache roots to search, in priority order. */
export function playwrightCacheRoots(e: ChromiumEnvironment): string[] {
  const roots: string[] = [];
  const custom = e.env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" means "inside node_modules" — not a cache root we can search.
  if (custom && custom !== '0') roots.push(custom);
  if (e.platform === 'darwin') roots.push(join(e.home, 'Library', 'Caches', 'ms-playwright'));
  else if (e.platform === 'win32') {
    const local = e.env.LOCALAPPDATA ?? join(e.home, 'AppData', 'Local');
    roots.push(join(local, 'ms-playwright'));
  } else {
    roots.push(join(e.env.XDG_CACHE_HOME ?? join(e.home, '.cache'), 'ms-playwright'));
  }
  return roots;
}

/** Executable paths *inside* a `chromium_headless_shell-<rev>` directory, per platform. */
function headlessShellExecutables(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === 'darwin') {
    const dirs = arch === 'arm64' ? ['chrome-headless-shell-mac-arm64'] : [];
    dirs.push('chrome-headless-shell-mac-x64');
    return dirs.map((d) => join(d, 'chrome-headless-shell'));
  }
  if (platform === 'win32')
    return [join('chrome-headless-shell-win64', 'chrome-headless-shell.exe')];
  const dirs = arch === 'arm64' ? ['chrome-headless-shell-linux-arm64'] : [];
  dirs.push('chrome-headless-shell-linux64', 'chrome-linux');
  return dirs.map((d) =>
    join(d, d === 'chrome-linux' ? 'headless_shell' : 'chrome-headless-shell'),
  );
}

/** Executable paths inside a full `chromium-<rev>` directory, per platform (new layout first). */
function fullChromiumExecutables(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === 'darwin') {
    const testing = join(
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
    const dirs = arch === 'arm64' ? ['chrome-mac-arm64'] : [];
    dirs.push('chrome-mac-x64', 'chrome-mac');
    return [
      ...dirs.map((d) => join(d, testing)),
      join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }
  if (platform === 'win32') {
    return [join('chrome-win64', 'chrome.exe'), join('chrome-win', 'chrome.exe')];
  }
  const dirs = arch === 'arm64' ? ['chrome-linux-arm64'] : [];
  dirs.push('chrome-linux64', 'chrome-linux');
  return dirs.map((d) => join(d, 'chrome'));
}

/** `chromium_headless_shell-1223` → 1223; non-matching names → null. */
function revisionOf(dirName: string, prefix: string): number | null {
  if (!dirName.startsWith(prefix)) return null;
  const rev = Number(dirName.slice(prefix.length));
  return Number.isInteger(rev) ? rev : null;
}

/** Newest-revision-first list of `<root>/<prefix><rev>` directories. */
function revisionDirs(e: ChromiumEnvironment, root: string, prefix: string): string[] {
  let entries: string[];
  try {
    entries = e.listDir(root);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, rev: revisionOf(name, prefix) }))
    .filter((x): x is { name: string; rev: number } => x.rev !== null)
    .sort((a, b) => b.rev - a.rev)
    .map((x) => join(root, x.name));
}

/**
 * Every executable path worth trying, best first: the env override, then every
 * cached headless shell (newest first, across all roots), then every cached full
 * Chromium. Existence is NOT checked here — see {@link findChromium}.
 */
export function chromiumCandidates(e: ChromiumEnvironment): string[] {
  const out: string[] = [];
  const explicit = e.env[CHROMIUM_ENV];
  if (explicit) out.push(explicit);
  const roots = playwrightCacheRoots(e);
  for (const root of roots) {
    for (const dir of revisionDirs(e, root, 'chromium_headless_shell-')) {
      for (const exe of headlessShellExecutables(e.platform, e.arch)) out.push(join(dir, exe));
    }
  }
  for (const root of roots) {
    for (const dir of revisionDirs(e, root, 'chromium-')) {
      for (const exe of fullChromiumExecutables(e.platform, e.arch)) out.push(join(dir, exe));
    }
  }
  return out;
}

/** The real process environment, for production callers. */
export function currentEnvironment(): ChromiumEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    env: process.env,
    listDir: (dir) => readdirSync(dir),
  };
}

/**
 * Resolve a usable Chromium executable, or throw a message that tells the caller
 * exactly how to get one. An explicit `RPGMAKER_MCP_CHROMIUM` that doesn't exist
 * is an error rather than a silent fall-through — a typo there should be loud.
 */
export function findChromium(
  e: ChromiumEnvironment = currentEnvironment(),
  exists: (path: string) => boolean = existsSync,
): string {
  const explicit = e.env[CHROMIUM_ENV];
  if (explicit && !exists(explicit)) {
    throw new Error(`${CHROMIUM_ENV} is set to "${explicit}", but no file exists there.`);
  }
  const found = chromiumCandidates(e).find((p) => exists(p));
  if (found) return found;
  throw new Error(
    `No Chromium found for headless rendering. Searched the Playwright cache (${playwrightCacheRoots(e).join(', ')}). ` +
      `Install one with \`npx playwright install chromium-headless-shell\`, or set ${CHROMIUM_ENV} to a Chrome/Chromium executable.`,
  );
}
