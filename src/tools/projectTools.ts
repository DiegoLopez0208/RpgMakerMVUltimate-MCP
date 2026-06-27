import { readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { getDataPath, validateProjectPath } from '../utils/fileHandler.js';
import type { ProjectSummary } from '../types/rpgmaker.js';

let _currentProjectPath = '';

function getCurrentPath(): string {
  return _currentProjectPath;
}

function setCurrentPath(p: string) {
  _currentProjectPath = p;
}

async function getProjectSummary(projectPath: string): Promise<ProjectSummary> {
  const result: ProjectSummary = { projectPath: projectPath, dataFiles: {} };
  const dataDir = getDataPath(projectPath, '');
  let files: string[] = [];
  try { files = readdirSync(dataDir); } catch { result.dataFiles['error'] = { type: 'error', error: 'Cannot read data directory' }; return result; }
  const jsonFiles = files.filter(function(f) { return f.endsWith('.json'); });
  for (let i = 0; i < jsonFiles.length; i++) {
    const fname = jsonFiles[i];
    try {
      const content = await readFile(getDataPath(projectPath, fname), 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const nonNull = parsed.filter(function(e: unknown) { return e !== null; }).length;
        result.dataFiles[fname] = { type: 'array', total: parsed.length, entries: nonNull };
      } else if (typeof parsed === 'object') {
        result.dataFiles[fname] = { type: 'object', keys: Object.keys(parsed).length };
      }
    } catch(e: unknown) {
      result.dataFiles[fname] = { type: 'error', error: (e as Error).message };
    }
  }
  const systemPath = getDataPath(projectPath, 'System.json');
  try {
    const sysContent = await readFile(systemPath, 'utf-8');
    const sys = JSON.parse(sysContent);
    result.gameTitle = (sys as Record<string, unknown>).gameTitle as string || '';
    result.startMapId = (sys as Record<string, unknown>).startMapId as number;
    result.startX = (sys as Record<string, unknown>).startX as number;
    result.startY = (sys as Record<string, unknown>).startY as number;
    result.switchCount = sys.switches ? (sys.switches as string[]).filter(function(s: string) { return s && s.length > 0; }).length : 0;
    result.variableCount = sys.variables ? (sys.variables as string[]).filter(function(v: string) { return v && v.length > 0; }).length : 0;
  } catch {
    result.systemError = 'Cannot read System.json';
  }
  const mapFiles = files.filter(function(f) { return /^Map\d{3}\.json$/.test(f); });
  result.mapCount = mapFiles.length;
  return result;
}

async function setProjectPath(newPath: string) {
  const valid = await validateProjectPath(newPath);
  if (!valid) throw new Error('Invalid project path: ' + newPath + '. Must contain data/System.json');
  _currentProjectPath = newPath;
  return { projectPath: newPath, valid: true };
}

export { getProjectSummary };
export { setProjectPath };
export { getCurrentPath };
export { setCurrentPath };
export { getCurrentPath as getProjectPath };
export { setCurrentPath as initProjectPath };
