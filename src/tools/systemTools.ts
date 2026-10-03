import { readJson, writeJson } from '../utils/fileHandler.js';
import { readdir, readFile } from 'fs/promises';
import { resolveSafePath } from '../utils/security.js';
import { commitText } from '../parity/utils/commit.js';
import { getMap, loadTilesetFlags } from './mapTools.js';
import { nearestStandable } from '../utils/placement.js';
import type { RpgMakerMap } from '../types/rpgmaker.js';

interface SystemPlugin {
  name: string;
  status: boolean;
  [key: string]: unknown;
}

interface SystemData {
  gameTitle?: string;
  startMapId?: number;
  startX?: number;
  startY?: number;
  partyMembers?: number[];
  switches?: string[];
  variables?: string[];
  plugins?: SystemPlugin[];
  [key: string]: unknown;
}

async function getSystem(projectPath: string) {
  return await readJson(projectPath, 'System.json');
}

async function getSwitches(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  return system.switches || [];
}

async function getVariables(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  return system.variables || [];
}

async function setSwitchName(projectPath: string, id: number, name: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  if (!system.switches) system.switches = [];

  while (system.switches.length <= id) {
    system.switches.push('');
  }
  system.switches[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

async function setVariableName(projectPath: string, id: number, name: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  if (!system.variables) system.variables = [];

  while (system.variables.length <= id) {
    system.variables.push('');
  }
  system.variables[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

async function getGameTitle(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  return system.gameTitle || '';
}

async function updateGameTitle(projectPath: string, title: string) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  system.gameTitle = title;
  await writeJson(projectPath, 'System.json', system);
  return { gameTitle: title };
}

async function updateStartingPosition(projectPath: string, mapId: number, x: number, y: number) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  // Snap the start coordinate to a standable, reachable tile on the target map,
  // so the game never opens with the player stuck in a wall or floating in void.
  // Tiles that are already valid are left exactly where they were requested.
  let finalX = x, finalY = y, relocated = false;
  try {
    const map = await getMap(projectPath, mapId) as RpgMakerMap;
    const flags = await loadTilesetFlags(projectPath, map.tilesetId);
    if (flags) {
      const snap = nearestStandable(map, flags, x, y);
      finalX = snap.x; finalY = snap.y; relocated = snap.relocated;
    }
  } catch (_) { /* map/tileset unreadable → keep requested coords */ }
  system.startMapId = mapId;
  system.startX = finalX;
  system.startY = finalY;
  await writeJson(projectPath, 'System.json', system);
  return { startMapId: mapId, startX: finalX, startY: finalY, relocated: relocated, requested: { x: x, y: y } };
}

async function listPlugins(projectPath: string) {
  const pluginsDir = projectPath + '/js/plugins';
  try {
    const files = await readdir(pluginsDir);
    return files.filter(function (f) { return f.endsWith('.js'); }).map(function (f) { return f.replace(/\.js$/, ''); });
  } catch {
    return [];
  }
}

async function getPluginStatus(projectPath: string) {
  const source = await readFile(resolveSafePath(projectPath, 'js', 'plugins.js'), 'utf8');
  const match = /\b(?:var|let|const)\s+\$plugins\s*=\s*([\s\S]*?);?\s*$/.exec(source.replace(/^\uFEFF/, ''));
  if (!match) throw new Error('Cannot safely parse js/plugins.js: expected an editor-generated $plugins JSON array');
  const prefix = source.replace(/^\uFEFF/, '').slice(0, match.index);
  if (!/^(?:\s|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*$/.test(prefix)) throw new Error('Cannot safely parse js/plugins.js: unexpected executable prefix');
  let text = match[1].trim();
  if (text.endsWith(';')) text = text.slice(0, -1);
  const plugins: unknown = JSON.parse(text);
  if (!Array.isArray(plugins) || plugins.some(p => !p || typeof p.name !== 'string' || typeof p.status !== 'boolean')) throw new Error('Invalid plugin manifest entries');
  return plugins as SystemPlugin[];
}

async function togglePlugin(projectPath: string, pluginName: string, enabled: boolean) {
  const plugins = await getPluginStatus(projectPath);
  const plugin = plugins.find(function (p) { return p && p.name === pluginName; });
  if (!plugin) {
    throw new Error('Plugin "' + pluginName + '" not found in js/plugins.js. Add it in the MV Plugin Manager first.');
  }
  plugin.status = enabled;
  await commitText(resolveSafePath(projectPath, 'js', 'plugins.js'), `// Generated by RPG Maker MV MCP.\nvar $plugins = ${JSON.stringify(plugins, null, 2)};\n`);
  return { pluginName, enabled };
}

export { getSystem };
export { getSwitches };
export { getVariables };
export { setSwitchName };
export { setVariableName };
export { getGameTitle };
export { updateGameTitle };
export { updateStartingPosition };
export { listPlugins };
export { getPluginStatus };
export { togglePlugin };
