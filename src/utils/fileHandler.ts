// @ts-nocheck
import { readFile, writeFile, copyFile } from 'fs/promises';
import path from 'path';

/**
 * Get the full path to a data file in the RPG Maker MV project.
 * All data files live under {projectPath}/data/
 */
function getDataPath(projectPath, filename) {
  return path.join(projectPath, 'data', filename);
}

/**
 * Get the full path to a map file.
 * Map files are named Map001.json, Map002.json, etc.
 */
function getMapPath(projectPath, mapId) {
  const filename = `Map${String(mapId).padStart(3, '0')}.json`;
  return getDataPath(projectPath, filename);
}

/**
 * Read and parse a JSON file from the RPG Maker MV data directory.
 * @param {string} projectPath - The project root path
 * @param {string} filename - The filename within data/ (e.g. "Actors.json")
 * @returns {Promise<any>} Parsed JSON content
 */
async function readJson(projectPath, filename) {
    const filePath = getDataPath(projectPath, filename);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
}

/**
 * Write JSON data to a file in the RPG Maker MV data directory.
 * Creates a .bak backup before writing. Logs write to stderr.
 * @param {string} projectPath - The project root path
 * @param {string} filename - The filename within data/ (e.g. "Actors.json")
 * @param {any} data - The data to serialize and write
 */
async function writeJson(projectPath, filename, data) {
  const filePath = getDataPath(projectPath, filename);
  const backupPath = filePath + '.bak';

  // Create backup of existing file before overwriting
  try {
    await copyFile(filePath, backupPath);
  } catch (_) {
    // If backup fails (e.g. file doesn't exist yet), continue
  }

  const jsonString = JSON.stringify(data, null, 2);
  await writeFile(filePath, jsonString, 'utf-8');
  console.error(`[WRITE] ${filePath}`);
}

/**
 * Ensure a JSON array handles RPG Maker MV's convention of null at index 0.
 * MV stores data arrays where index 0 is always null and real data starts at index 1.
 * This function guarantees the array has the null padding.
 * @param {any[]} json - The parsed JSON array
 * @returns {any[]} The array with null at index 0 guaranteed
 */
function ensureArray(json) {
  if (!Array.isArray(json)) return [null];
  if (json.length === 0) return [null];
  if (json[0] === null) return json;
  return [null, ...json];
}

/**
 * Find the next available ID in a RPG Maker MV data array.
 * MV arrays have null at index 0, and IDs correspond to array indices.
 * Skips null entries and finds the highest existing ID, then returns max+1.
 * @param {any[]} array - The data array (e.g. from Actors.json)
 * @returns {number} The next available ID
 */
function nextId(array) {
  let max = 0;
  for (let i = 0; i < array.length; i++) {
    if (array[i] && array[i].id && array[i].id > max) {
      max = array[i].id;
    }
  }
  return max + 1;
}

/**
 * Validate that the RPG Maker MV project path is valid.
 * Checks that data/System.json exists (essential project file).
 * @param {string} projectPath - The project root path to validate
 * @returns {Promise<boolean>} True if valid project path
 */
async function validateProjectPath(projectPath) {
  try {
    const systemPath = getDataPath(projectPath, 'System.json');
    await readFile(systemPath, 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

export { getDataPath };
export { getMapPath };
export { readJson };
export { writeJson };
export { ensureArray };
export { nextId };
export { validateProjectPath };
