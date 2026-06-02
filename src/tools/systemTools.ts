// @ts-nocheck
import { readJson, writeJson } from '../utils/fileHandler.js';

/**
 * Get the system data from the RPG Maker MV project.
 * System.json contains game title, switches, variables, starting position, etc.
 */
async function getSystem(projectPath) {
  return await readJson(projectPath, 'System.json');
}

/**
 * Get all game switch names.
 * Switches are boolean flags used for game logic.
 * Index 0 is always null in MV.
 */
async function getSwitches(projectPath) {
  const system = await readJson(projectPath, 'System.json');
  return system.switches || [];
}

/**
 * Get all game variable names.
 * Variables are numeric values used for game logic.
 * Index 0 is always null in MV.
 */
async function getVariables(projectPath) {
  const system = await readJson(projectPath, 'System.json');
  return system.variables || [];
}

/**
 * Set a switch name by ID.
 * @param {string} projectPath - The project root path
 * @param {number} id - Switch ID (1-based, as MV reserves index 0)
 * @param {string} name - New name for the switch
 */
async function setSwitchName(projectPath, id, name) {
  const system = await readJson(projectPath, 'System.json');
  if (!system.switches) system.switches = [];

  // Ensure the switches array is large enough
  while (system.switches.length <= id) {
    system.switches.push('');
  }
  system.switches[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

/**
 * Set a variable name by ID.
 * @param {string} projectPath - The project root path
 * @param {number} id - Variable ID (1-based)
 * @param {string} name - New name for the variable
 */
async function setVariableName(projectPath, id, name) {
  const system = await readJson(projectPath, 'System.json');
  if (!system.variables) system.variables = [];

  while (system.variables.length <= id) {
    system.variables.push('');
  }
  system.variables[id] = name;

  await writeJson(projectPath, 'System.json', system);
  return { id: id, name: name };
}

/**
 * Get the game title.
 */
async function getGameTitle(projectPath) {
  const system = await readJson(projectPath, 'System.json');
  return system.gameTitle || '';
}

/**
 * Update the game title.
 * @param {string} projectPath - The project root path
 * @param {string} title - New game title
 */
async function updateGameTitle(projectPath, title) {
  const system = await readJson(projectPath, 'System.json');
  system.gameTitle = title;
  await writeJson(projectPath, 'System.json', system);
  return { gameTitle: title };
}

/**
 * Update the player starting position.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - Starting map ID
 * @param {number} x - Starting X coordinate
 * @param {number} y - Starting Y coordinate
 */
async function updateStartingPosition(projectPath, mapId, x, y) {
  const system = await readJson(projectPath, 'System.json');
  system.startMapId = mapId;
  system.startX = x;
  system.startY = y;
  await writeJson(projectPath, 'System.json', system);
  return { startMapId: mapId, startX: x, startY: y };
}

export { getSystem };
export { getSwitches };
export { getVariables };
export { setSwitchName };
export { setVariableName };
export { getGameTitle };
export { updateGameTitle };
export { updateStartingPosition };
