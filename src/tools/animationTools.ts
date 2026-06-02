// @ts-nocheck
import { readJson, writeJson } from '../utils/fileHandler.js';

async function getAnimations(projectPath) {
  const data = await readJson(projectPath, 'Animations.json');
  return data.filter(function(e) { return e !== null; });
}

async function getAnimation(projectPath, id) {
  const data = await readJson(projectPath, 'Animations.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

export { getAnimations };
export { getAnimation };
