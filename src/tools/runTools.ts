/**
 * runTools.ts — launch an RPG Maker MV project.
 *
 * playtest() runs the project through the engine's bundled nwjs runtime
 * (nwjs-win/Game.exe <projectDir> [test]) — the same thing the editor's Playtest
 * button does — so an agent can actually SEE a change working, not just edit JSON.
 * openInEditor() opens the project in the RPGMV.exe editor (best-effort).
 *
 * The engine install is located via param `install`, else the RPGMAKER_MV_INSTALL
 * env var, else the default Steam path. Processes are spawned detached so the MCP
 * server doesn't block on them.
 */
import { spawn } from 'child_process';
import { access, writeFile } from 'fs/promises';
import path from 'path';

const DEFAULT_INSTALL = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RPG Maker MV';
const RPGPROJECT_CONTENT = 'RPGMV 1.6.2';

export interface RunParams {
  install?: string;  // RPG Maker MV install root (contains the nwjs runtime and RPGMV.exe)
  gameExe?: string;  // explicit path to the nwjs game exe (overrides auto-detection)
  test?: boolean;    // playtest: run in test mode (default true; false = plain run)
}

function installRoot(params?: RunParams): string {
  return params?.install || process.env.RPGMAKER_MV_INSTALL || DEFAULT_INSTALL;
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Candidate nwjs runtimes shipped with the engine, most-preferred first.
// CRUCIAL: a runtime only runs an arbitrary project (passed as an argument) when
// its OWN directory has no package.json — otherwise nwjs binds to that sibling
// manifest (nwjs-win/Game.exe is a deploy template pinned to its own www/, so it
// ignores the project path and shows ERR_FILE_NOT_FOUND). nwjs-win-test/game.exe
// has no sibling manifest, so it honors the project path.
const RUNTIME_CANDIDATES: [string, string][] = [
  ['nwjs-win-test', 'game.exe'],
  ['nwjs-win', 'Game.exe'],
];

/**
 * Resolve the nwjs game exe to launch a project with. Prefers a runtime whose
 * directory has no package.json (so the project path argument is honored); falls
 * back to the first existing exe otherwise. An explicit params.gameExe wins.
 */
async function resolveGameExe(install: string, params?: RunParams): Promise<string> {
  if (params?.gameExe) {
    if (!(await pathExists(params.gameExe))) throw new Error('gameExe not found: ' + params.gameExe);
    return params.gameExe;
  }
  let firstExisting: string | null = null;
  for (const [dir, exe] of RUNTIME_CANDIDATES) {
    const exePath = path.join(install, dir, exe);
    if (!(await pathExists(exePath))) continue;
    if (firstExisting === null) firstExisting = exePath;
    // A sibling package.json would pin nwjs to that runtime's own app — skip it.
    if (!(await pathExists(path.join(install, dir, 'package.json')))) return exePath;
  }
  if (firstExisting) return firstExisting; // last resort (may be deploy-bound)
  throw new Error(
    'No nwjs runtime found under "' + install + '" (looked for ' +
    RUNTIME_CANDIDATES.map(([d, e]) => d + '/' + e).join(', ') +
    '). Set the RPGMAKER_MV_INSTALL env var or pass install/gameExe.'
  );
}

/**
 * Launch a playtest of the project via the bundled nwjs runtime. The project must
 * be a runnable MV app (index.html + package.json — every real project has these).
 * Returns immediately with the spawned pid; the game window is the user's to close.
 */
export async function playtest(projectPath: string, params?: RunParams) {
  if (!projectPath) throw new Error('playtest requires an active project path (set_project_path or RPGMAKER_PROJECT_PATH).');
  if (!(await pathExists(path.join(projectPath, 'index.html'))) || !(await pathExists(path.join(projectPath, 'package.json')))) {
    throw new Error('Not a runnable MV project (missing index.html/package.json): ' + projectPath);
  }
  const install = installRoot(params);
  const gameExe = await resolveGameExe(install, params);
  const testMode = params?.test !== false;
  // The project path is the nwjs app root; a trailing "test" puts MV in playtest mode.
  const args = testMode ? [projectPath, 'test'] : [projectPath];
  // Launch FROM the project. Recent NW.js serves index.html as chrome-extension://,
  // so a plugin inside the game cannot derive the project root from its location and
  // falls back to process.cwd(); without this the game would inherit the MCP server's
  // directory and the bridge would look for the handshake file in the wrong place.
  const child = spawn(gameExe, args, { cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { launched: true, pid: child.pid ?? null, exe: gameExe, project: projectPath, testMode };
}

/**
 * Open the project in RPGMV.exe through Game.rpgproject. Steam's NewData folder
 * does not always contain that descriptor, so legacy/scaffolded projects are
 * repaired before launch instead of silently opening an empty editor shell.
 */
export async function openInEditor(projectPath: string, params?: RunParams) {
  if (!projectPath) throw new Error('openInEditor requires an active project path.');
  if (!(await pathExists(path.join(projectPath, 'data', 'System.json')))) {
    throw new Error('Not an RPG Maker MV project (missing data/System.json): ' + projectPath);
  }
  const install = installRoot(params);
  const editorExe = path.join(install, 'RPGMV.exe');
  if (!(await pathExists(editorExe))) {
    throw new Error('Editor not found at "' + editorExe + '". Set the RPGMAKER_MV_INSTALL env var or pass install.');
  }
  const rpgproject = path.join(projectPath, 'Game.rpgproject');
  let createdProjectFile = false;
  if (!(await pathExists(rpgproject))) {
    // 'wx' so a descriptor that appeared between the check and the write is never
    // clobbered — the editor writes this file too, and its version string is the
    // project's, not ours. Losing that race produces the state we wanted anyway,
    // so EEXIST means "already repaired", not a failure to open the project.
    try {
      await writeFile(rpgproject, RPGPROJECT_CONTENT, { encoding: 'utf-8', flag: 'wx' });
      createdProjectFile = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const child = spawn(editorExe, [rpgproject], {
    cwd: projectPath, detached: true, stdio: 'ignore', windowsHide: false,
  });
  child.unref();
  return {
    launched: true, pid: child.pid ?? null, exe: editorExe,
    opened: rpgproject, createdProjectFile,
  };
}
