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
import { access } from 'fs/promises';
import path from 'path';

const DEFAULT_INSTALL = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RPG Maker MV';

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
  const child = spawn(gameExe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { launched: true, pid: child.pid ?? null, exe: gameExe, project: projectPath, testMode };
}

/**
 * Open the project in the RPGMV.exe editor (best-effort). Note: the MV editor
 * opens a project through its Game.rpgproject file; a freshly-cloned project may
 * not have one until saved once in the editor, so this may just launch the editor.
 */
export async function openInEditor(projectPath: string, params?: RunParams) {
  if (!projectPath) throw new Error('openInEditor requires an active project path.');
  const install = installRoot(params);
  const editorExe = path.join(install, 'RPGMV.exe');
  if (!(await pathExists(editorExe))) {
    throw new Error('Editor not found at "' + editorExe + '". Set the RPGMAKER_MV_INSTALL env var or pass install.');
  }
  const rpgproject = path.join(projectPath, 'Game.rpgproject');
  const target = (await pathExists(rpgproject)) ? rpgproject : projectPath;
  const child = spawn(editorExe, [target], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { launched: true, pid: child.pid ?? null, exe: editorExe, opened: target };
}
