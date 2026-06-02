// @ts-nocheck
import { readJson, writeJson, nextId } from '../utils/fileHandler.js';

async function getClasses(projectPath) {
  const data = await readJson(projectPath, 'Classes.json');
  return data.filter(function(e) { return e !== null; });
}

async function getClass(projectPath, id) {
  const data = await readJson(projectPath, 'Classes.json');
  if (id > 0 && id < data.length && data[id]) return data[id];
  return null;
}

async function createClass(projectPath, params) {
  const data = await readJson(projectPath, 'Classes.json');
  const newId = nextId(data);
  var cls = {
    id: newId,
    name: params.name || '',
    note: params.note || '',
    params: params.params || [500, 30, 30, 30, 30, 30, 30, 30],
    expParams: params.expParams || [30, 20, 10, 90],
    traits: params.traits || [],
    learnings: params.learnings || []
  };
  while (data.length <= newId) data.push(null);
  data[newId] = cls;
  await writeJson(projectPath, 'Classes.json', data);
  return cls;
}

async function updateClass(projectPath, id, fields) {
  const data = await readJson(projectPath, 'Classes.json');
  if (!data[id]) throw new Error('Class ' + id + ' not found');
  data[id] = Object.assign({}, data[id], fields);
  await writeJson(projectPath, 'Classes.json', data);
  return data[id];
}

async function searchClasses(projectPath, query) {
  const data = await readJson(projectPath, 'Classes.json');
  var q = query.toLowerCase();
  return data.filter(function(e) {
    return e && (e.name.toLowerCase().includes(q));
  });
}

async function deleteClass(projectPath, id) {
  const data = await readJson(projectPath, 'Classes.json');
  if (!data[id]) throw new Error('Class ' + id + ' not found');
  var deleted = data[id];
  data[id] = null;
  await writeJson(projectPath, 'Classes.json', data);
  return { deleted: deleted };
}

export { getClasses };
export { getClass };
export { createClass };
export { updateClass };
export { searchClasses };
export { deleteClass };
