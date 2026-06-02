// @ts-nocheck
import { readJson, writeJson, nextId } from '../utils/fileHandler.js';

async function getStates(projectPath) {
  const data = await readJson(projectPath, 'States.json');
  return data.filter(function(e) { return e !== null; });
}

async function getState(projectPath, id) {
  const data = await readJson(projectPath, 'States.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

async function createState(projectPath, params) {
  const data = await readJson(projectPath, 'States.json');
  const newId = nextId(data);
  var state = {
    id: newId,
    name: params.name || '',
    iconIndex: params.iconIndex || 0,
    restriction: params.restriction !== undefined ? params.restriction : 0,
    priority: params.priority !== undefined ? params.priority : 50,
    removeAtBattleEnd: params.removeAtBattleEnd || false,
    removeByDamage: params.removeByDamage || false,
    removeByRestriction: params.removeByRestriction || false,
    autoRemovalTiming: params.autoRemovalTiming !== undefined ? params.autoRemovalTiming : 0,
    minTurns: params.minTurns !== undefined ? params.minTurns : 1,
    maxTurns: params.maxTurns !== undefined ? params.maxTurns : 5,
    stepsToRemove: params.stepsToRemove !== undefined ? params.stepsToRemove : 100,
    message1: params.message1 || '',
    message2: params.message2 || '',
    message3: params.message3 || '',
    message4: params.message4 || '',
    traits: params.traits || [],
    note: params.note || ''
  };
  while (data.length <= newId) data.push(null);
  data[newId] = state;
  await writeJson(projectPath, 'States.json', data);
  return state;
}

async function updateState(projectPath, id, fields) {
  const data = await readJson(projectPath, 'States.json');
  if (!data[id]) throw new Error('State ' + id + ' not found');
  data[id] = Object.assign({}, data[id], fields);
  await writeJson(projectPath, 'States.json', data);
  return data[id];
}

async function searchStates(projectPath, query) {
  const data = await readJson(projectPath, 'States.json');
  var q = query.toLowerCase();
  return data.filter(function(e) {
    return e && (e.name.toLowerCase().includes(q));
  });
}

async function deleteState(projectPath, id) {
  const data = await readJson(projectPath, 'States.json');
  if (!data[id]) throw new Error('State ' + id + ' not found');
  var deleted = data[id];
  data[id] = null;
  await writeJson(projectPath, 'States.json', data);
  return { deleted: deleted };
}

export { getStates };
export { getState };
export { createState };
export { updateState };
export { searchStates };
export { deleteState };
