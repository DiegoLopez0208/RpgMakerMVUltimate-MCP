import { readJson, writeJson } from '../utils/fileHandler.js';
import { readdir } from 'fs/promises';
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
  const system = await readJson(projectPath, 'System.json') as SystemData;
  return system.plugins || [];
}

async function togglePlugin(projectPath: string, pluginName: string, enabled: boolean) {
  const system = await readJson(projectPath, 'System.json') as SystemData;
  const plugins = system.plugins || [];
  const plugin = plugins.find(function (p) { return p && p.name === pluginName; });
  if (!plugin) {
    throw new Error('Plugin "' + pluginName + '" not found in System.json. Install it in js/plugins/ first, then add it to System.json.');
  }
  plugin.status = enabled;
  await writeJson(projectPath, 'System.json', system);
  return { pluginName, enabled };
}

/** The editor allows at most this many switches or variables. */
const MAX_SYSTEM_LIST = 5000;

/**
 * Set the highest valid switch or variable id, like the editor's "Change Maximum". MV ignores any
 * id at or past the length of these arrays (Game_Variables.setValue and Game_Switches.setValue test
 * it), so an event that writes variable 40 into a 20-variable project does nothing, silently.
 * Growing adds empty names. Shrinking is refused while a name past the new maximum is in use, unless
 * `force` is set, because those ids stop working.
 */
async function resizeSystemList(projectPath: string, section: string, size: unknown, force = false) {
  if (section !== 'switches' && section !== 'variables') throw new Error('section must be "switches" or "variables"');
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_SYSTEM_LIST) {
    throw new Error('size is the highest valid id: an integer from 1 to ' + MAX_SYSTEM_LIST);
  }
  const system = await readJson(projectPath, 'System.json') as SystemData;
  const list = (system[section] || []) as Array<string | null>;
  const before = list.length - 1;
  if (list.length === 0) list.push(null);
  if (size < before) {
    const named = list.slice(size + 1).map((name, offset) => ({ id: size + 1 + offset, name })).filter((entry) => entry.name);
    if (named.length > 0 && !force) {
      const shown = named.slice(0, 5).map((entry) => entry.id + ' "' + entry.name + '"').join(', ');
      throw new Error('Shrinking ' + section + ' to ' + size + ' drops named ids (' + shown + (named.length > 5 ? ', ...' : '') + '), and those ids stop working. Pass force: true to do it anyway.');
    }
    list.length = size + 1;
  }
  while (list.length < size + 1) list.push('');
  system[section] = list as string[];
  await writeJson(projectPath, 'System.json', system);
  return { section: section, previousMax: Math.max(before, 0), max: size };
}

export { resizeSystemList };
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
