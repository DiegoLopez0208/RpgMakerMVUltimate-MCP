/**
 * scaffoldTools.ts — create a brand-new RPG Maker MV project by cloning the
 * engine's blank template (NewData) and rewriting a few System.json fields.
 *
 * NewData is the canonical empty project the editor copies for "New Project": a
 * complete data/ img/ js/ audio/ fonts/ tree. Cloning it wholesale guarantees a
 * valid, openable project. The source install is configurable (param sourcePath,
 * else the RPGMAKER_MV_INSTALL env var, else the default Steam location) so this
 * works on any machine and is testable against a fixture. It refuses to overwrite
 * an existing project (a directory that already has data/System.json).
 */
import { cp, readFile, writeFile, access, mkdir } from 'fs/promises';
import path from 'path';

const DEFAULT_INSTALL = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RPG Maker MV';

export interface ScaffoldParams {
  destPath: string;
  sourcePath?: string; // a NewData-style folder; overrides env/default
  title?: string;
  startMapId?: number | string;
  startX?: number | string;
  startY?: number | string;
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Resolve the blank-project source: explicit sourcePath, else env, else Steam. */
function resolveSource(sourcePath?: string): string {
  if (sourcePath) return sourcePath;
  const install = process.env.RPGMAKER_MV_INSTALL;
  return install ? path.join(install, 'NewData') : path.join(DEFAULT_INSTALL, 'NewData');
}

export async function scaffoldProject(_projectPath: string, params: ScaffoldParams) {
  const destPath = params.destPath;
  if (!destPath) throw new Error('scaffold_project requires destPath (the new project directory to create).');

  const source = resolveSource(params.sourcePath);
  if (!(await pathExists(path.join(source, 'data', 'System.json')))) {
    throw new Error(
      'Blank project not found at "' + source + '" (expected a NewData folder containing data/System.json). ' +
      'Pass sourcePath, or set the RPGMAKER_MV_INSTALL env var to your RPG Maker MV install directory.'
    );
  }
  // Never clobber an existing project.
  if (await pathExists(path.join(destPath, 'data', 'System.json'))) {
    throw new Error('Destination "' + destPath + '" already contains an RPG Maker MV project (data/System.json). Choose an empty directory.');
  }

  await mkdir(destPath, { recursive: true });
  await cp(source, destPath, { recursive: true });

  // Rewrite the copied System.json with the requested title / start position.
  const sysPath = path.join(destPath, 'data', 'System.json');
  const system = JSON.parse((await readFile(sysPath, 'utf-8')).replace(/^﻿/, '')) as Record<string, unknown>;
  if (params.title !== undefined) system.gameTitle = params.title;
  if (params.startMapId !== undefined) system.startMapId = Number(params.startMapId);
  if (params.startX !== undefined) system.startX = Number(params.startX);
  if (params.startY !== undefined) system.startY = Number(params.startY);
  await writeFile(sysPath, JSON.stringify(system), 'utf-8');

  return {
    created: destPath,
    source,
    title: system.gameTitle,
    startMapId: system.startMapId,
    startX: system.startX,
    startY: system.startY,
  };
}
