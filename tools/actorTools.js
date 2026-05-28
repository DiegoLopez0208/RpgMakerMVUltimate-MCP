const { readJson, writeJson, nextId } = require('../utils/fileHandler');

/**
 * Get all actors from the RPG Maker MV project.
 * Reads Actors.json and returns all non-null entries.
 * MV stores actors with null at index 0.
 */
async function getActors(projectPath) {
  const actors = await readJson(projectPath, 'Actors.json');
  return actors.filter(function(a) { return a !== null; });
}

/**
 * Get a single actor by ID.
 * MV actor IDs correspond to their array index in Actors.json.
 * @param {string} projectPath - The project root path
 * @param {number} id - The actor ID to retrieve
 */
async function getActor(projectPath, id) {
  const actors = await readJson(projectPath, 'Actors.json');
  if (id >= 0 && id < actors.length && actors[id] !== null) {
    return actors[id];
  }
  return null;
}

/**
 * Create a new actor with the specified properties.
 * Generates a complete RPG Maker MV actor object with all required fields.
 * The actor is appended to Actors.json with the next available ID.
 * @param {string} projectPath - The project root path
 * @param {object} params - Actor properties
 */
async function createActor(projectPath, params) {
  const actors = await readJson(projectPath, 'Actors.json');
  const newId = nextId(actors);

  const newActor = {
    id: newId,
    name: params.name || '',
    nickname: params.nickname || '',
    profile: params.profile || '',
    classId: params.classId || 1,
    initialLevel: params.initialLevel || 1,
    maxLevel: params.maxLevel || 99,
    characterName: params.characterName || '',
    characterIndex: params.characterIndex || 0,
    faceName: params.faceName || '',
    faceIndex: params.faceIndex || 0,
    battlerName: params.battlerName || '',
    traits: params.traits || [],
    equips: params.equips || [0, 0, 0, 0, 0],
    note: params.note || ''
  };

  // Ensure the array is large enough to place the actor at its ID index
  while (actors.length <= newId) {
    actors.push(null);
  }
  actors[newId] = newActor;

  await writeJson(projectPath, 'Actors.json', actors);
  return newActor;
}

/**
 * Update an existing actor's properties (partial update).
 * Only the fields provided in the updates object will be changed.
 * @param {string} projectPath - The project root path
 * @param {number} id - The actor ID to update
 * @param {object} fields - Object containing fields to update
 */
async function updateActor(projectPath, id, fields) {
  const actors = await readJson(projectPath, 'Actors.json');

  if (id < 0 || id >= actors.length || actors[id] === null) {
    throw new Error('Actor with ID ' + id + ' not found');
  }

  actors[id] = Object.assign({}, actors[id], fields);
  await writeJson(projectPath, 'Actors.json', actors);
  return actors[id];
}

/**
 * Search actors by name or nickname (case-insensitive).
 * @param {string} projectPath - The project root path
 * @param {string} query - Search term to match against name or nickname
 */
async function searchActors(projectPath, query) {
  const actors = await readJson(projectPath, 'Actors.json');
  const lowerQuery = query.toLowerCase();
  return actors.filter(function(a) {
    return a !== null &&
      (a.name.toLowerCase().includes(lowerQuery) ||
       a.nickname.toLowerCase().includes(lowerQuery));
  });
}

async function deleteActor(projectPath, id) {
  const actors = await readJson(projectPath, 'Actors.json');
  if (id < 0 || id >= actors.length || actors[id] === null) {
    throw new Error('Actor with ID ' + id + ' not found');
  }
  var deleted = actors[id];
  actors[id] = null;
  await writeJson(projectPath, 'Actors.json', actors);
  return { deleted: deleted };
}

module.exports = {
  getActors, getActor, createActor, updateActor, searchActors, deleteActor
};
