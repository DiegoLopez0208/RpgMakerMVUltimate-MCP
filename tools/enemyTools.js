const { readJson, writeJson, nextId } = require('../utils/fileHandler');

async function getEnemies(projectPath) {
  const data = await readJson(projectPath, 'Enemies.json');
  return data.filter(function(e) { return e !== null; });
}

async function getEnemy(projectPath, id) {
  const data = await readJson(projectPath, 'Enemies.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

function makeDefaultEnemy(name, params) {
  return {
    id: 0,
    name: name || '',
    note: '',
    battlerName: params.battlerName || '',
    battlerHue: params.battlerHue || 0,
    exp: params.exp || 0,
    gold: params.gold || 0,
    dropItems: params.dropItems || [
      { kind: 0, dataId: 0, denominator: 1 },
      { kind: 0, dataId: 0, denominator: 1 },
      { kind: 0, dataId: 0, denominator: 1 }
    ],
    params: params.params || [100, 0, 10, 10, 10, 10, 10, 10],
    traits: params.traits || [],
    actions: params.actions || [{ skillId: 1, conditionType: 1, conditionParam1: 0, conditionParam2: 1, rating: 5 }]
  };
}

async function createEnemy(projectPath, params) {
  const data = await readJson(projectPath, 'Enemies.json');
  const newId = nextId(data);
  var enemy = makeDefaultEnemy(params.name, params);
  enemy.id = newId;
  while (data.length <= newId) data.push(null);
  data[newId] = enemy;
  await writeJson(projectPath, 'Enemies.json', data);
  return enemy;
}

async function createBossEnemy(projectPath, params) {
  const data = await readJson(projectPath, 'Enemies.json');
  const newId = nextId(data);
  var enemy = makeDefaultEnemy(params.name, params);
  enemy.id = newId;
  enemy.params = params.params || [5000, 0, 80, 60, 60, 60, 50, 50];
  enemy.exp = params.exp || 500;
  enemy.gold = params.gold || 200;
  enemy.actions = params.actions || [
    { skillId: 1, conditionType: 1, conditionParam1: 0, conditionParam2: 1, rating: 5 },
    { skillId: params.specialSkillId || 2, conditionType: 2, conditionParam1: 0.3, conditionParam2: 1, rating: 7 }
  ];
  while (data.length <= newId) data.push(null);
  data[newId] = enemy;
  await writeJson(projectPath, 'Enemies.json', data);
  return enemy;
}

async function updateEnemy(projectPath, id, fields) {
  const data = await readJson(projectPath, 'Enemies.json');
  if (!data[id]) throw new Error('Enemy ' + id + ' not found');
  data[id] = Object.assign({}, data[id], fields);
  await writeJson(projectPath, 'Enemies.json', data);
  return data[id];
}

async function searchEnemies(projectPath, query) {
  const data = await readJson(projectPath, 'Enemies.json');
  var q = query.toLowerCase();
  return data.filter(function(e) {
    return e && (e.name.toLowerCase().includes(q));
  });
}

async function deleteEnemy(projectPath, id) {
  const data = await readJson(projectPath, 'Enemies.json');
  if (!data[id]) throw new Error('Enemy ' + id + ' not found');
  var deleted = data[id];
  data[id] = null;
  await writeJson(projectPath, 'Enemies.json', data);
  return { deleted: deleted };
}

module.exports = { getEnemies, getEnemy, createEnemy, createBossEnemy, updateEnemy, searchEnemies, deleteEnemy };
