// @ts-nocheck
import { readJson, writeJson, nextId } from '../utils/fileHandler.js';

async function getTroops(projectPath) {
  const data = await readJson(projectPath, 'Troops.json');
  return data.filter(function(e) { return e !== null; });
}

async function getTroop(projectPath, id) {
  const data = await readJson(projectPath, 'Troops.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

async function createTroop(projectPath, params) {
  const data = await readJson(projectPath, 'Troops.json');
  const newId = nextId(data);
  var troop = {
    id: newId,
    name: params.name || '',
    members: params.members || [],
    pages: params.pages || [{
      conditions: { actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false, switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false },
      list: [{ code: 0, indent: 0, parameters: [] }],
      span: 0
    }],
    note: params.note || ''
  };
  while (data.length <= newId) data.push(null);
  data[newId] = troop;
  await writeJson(projectPath, 'Troops.json', data);
  return troop;
}

async function addEnemyToTroop(projectPath, troopId, enemyId) {
  const data = await readJson(projectPath, 'Troops.json');
  if (!data[troopId]) throw new Error('Troop ' + troopId + ' not found');
  data[troopId].members.push({ enemyId: enemyId, x: 200 + data[troopId].members.length * 80, y: 200 + Math.floor(Math.random() * 60), hidden: false });
  await writeJson(projectPath, 'Troops.json', data);
  return data[troopId];
}

async function createRandomEncounterTroop(projectPath, params) {
  var enemyIds = params.enemyIds || [];
  var members = enemyIds.map(function(eid, i) {
    return { enemyId: eid, x: 200 + i * 80, y: 200 + Math.floor(Math.random() * 60), hidden: false };
  });
  return await createTroop(projectPath, {
    name: params.name || 'Troop',
    members: members,
    note: params.note || ''
  });
}

export { getTroops };
export { getTroop };
export { createTroop };
export { addEnemyToTroop };
export { createRandomEncounterTroop };
