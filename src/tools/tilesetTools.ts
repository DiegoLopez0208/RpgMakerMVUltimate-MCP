// @ts-nocheck
import { readJson, writeJson } from '../utils/fileHandler.js';

async function getTilesets(projectPath) {
  const data = await readJson(projectPath, 'Tilesets.json');
  return data.filter(function(e) { return e !== null; });
}

async function getTileset(projectPath, id) {
  const data = await readJson(projectPath, 'Tilesets.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

async function updateTileset(projectPath, id, fields) {
  const data = await readJson(projectPath, 'Tilesets.json');
  if (!data[id]) throw new Error('Tileset ' + id + ' not found');
  data[id] = Object.assign({}, data[id], fields);
  await writeJson(projectPath, 'Tilesets.json', data);
  return data[id];
}

export { getTilesets };
export { getTileset };
export { updateTileset };
