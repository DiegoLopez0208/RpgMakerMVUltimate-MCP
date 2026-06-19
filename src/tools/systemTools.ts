import { readJson, writeJson } from '../utils/fileHandler.js';
import { readdir } from 'fs/promises';

async function getSystem(projectPath: string) {
  return await readJson(projectPath, 'System.json');
}

async function getSwitches(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  return system.switches || [];
}

async function getVariables(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  return system.variables || [];
}

async function setSwitchName(projectPath: string, id: number, name: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown[]>;
  if (!system.switches) system.switches = [];

  while (system.switches.length <= id) {
    system.switches.push('');
  }
  system.switches[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

async function setVariableName(projectPath: string, id: number, name: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown[]>;
  if (!system.variables) system.variables = [];

  while (system.variables.length <= id) {
    system.variables.push('');
  }
  system.variables[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

async function getGameTitle(projectPath: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  return system.gameTitle || '';
}

async function updateGameTitle(projectPath: string, title: string) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  system.gameTitle = title;
  await writeJson(projectPath, 'System.json', system);
  return { gameTitle: title };
}

async function updateStartingPosition(projectPath: string, mapId: number, x: number, y: number) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  system.startMapId = mapId;
  system.startX = x;
  system.startY = y;
  await writeJson(projectPath, 'System.json', system);
  return { startMapId: mapId, startX: x, startY: y };
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
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  return (system.plugins || []) as Array<Record<string, unknown>>;
}

async function togglePlugin(projectPath: string, pluginName: string, enabled: boolean) {
  const system = await readJson(projectPath, 'System.json') as Record<string, unknown>;
  const plugins = (system.plugins || []) as Array<Record<string, unknown>>;
  const plugin = plugins.find(function (p) { return p && p.name === pluginName; });
  if (!plugin) {
    throw new Error('Plugin "' + pluginName + '" not found in System.json. Install it in js/plugins/ first, then add it to System.json.');
  }
  plugin.status = enabled;
  await writeJson(projectPath, 'System.json', system);
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
