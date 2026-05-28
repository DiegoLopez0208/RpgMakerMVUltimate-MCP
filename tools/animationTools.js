const { readJson, writeJson } = require('../utils/fileHandler');

async function getAnimations(projectPath) {
  const data = await readJson(projectPath, 'Animations.json');
  return data.filter(function(e) { return e !== null; });
}

async function getAnimation(projectPath, id) {
  const data = await readJson(projectPath, 'Animations.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

module.exports = { getAnimations, getAnimation };
