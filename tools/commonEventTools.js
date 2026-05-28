const { readJson, writeJson, nextId } = require('../utils/fileHandler');

async function getCommonEvents(projectPath) {
  const data = await readJson(projectPath, 'CommonEvents.json');
  return data.filter(function(e) { return e !== null; });
}

async function createCommonEvent(projectPath, params) {
  const data = await readJson(projectPath, 'CommonEvents.json');
  const newId = nextId(data);
  var ev = {
    id: newId,
    name: params.name || '',
    trigger: params.trigger || 0,
    switchId: params.switchId || 0,
    list: params.list || [{ code: 0, indent: 0, parameters: [] }],
    note: params.note || ''
  };
  while (data.length <= newId) data.push(null);
  data[newId] = ev;
  await writeJson(projectPath, 'CommonEvents.json', data);
  return ev;
}

async function updateCommonEvent(projectPath, id, fields) {
  const data = await readJson(projectPath, 'CommonEvents.json');
  if (!data[id]) throw new Error('Common Event ' + id + ' not found');
  data[id] = Object.assign({}, data[id], fields);
  await writeJson(projectPath, 'CommonEvents.json', data);
  return data[id];
}

async function addCommonEventCommand(projectPath, id, command) {
  const data = await readJson(projectPath, 'CommonEvents.json');
  if (!data[id]) throw new Error('Common Event ' + id + ' not found');
  var list = data[id].list;
  list.splice(list.length - 1, 0, command);
  await writeJson(projectPath, 'CommonEvents.json', data);
  return data[id];
}

module.exports = { getCommonEvents, createCommonEvent, updateCommonEvent, addCommonEventCommand };
