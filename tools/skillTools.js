const { readJson, writeJson, nextId } = require('../utils/fileHandler');

/**
 * Get all skills from the RPG Maker MV project.
 * Reads Skills.json and returns all non-null entries.
 */
async function getSkills(projectPath) {
  const skills = await readJson(projectPath, 'Skills.json');
  return skills.filter(function(s) { return s !== null; });
}

/**
 * Get a single skill by ID.
 * @param {string} projectPath - The project root path
 * @param {number} id - The skill ID
 */
async function getSkill(projectPath, id) {
  const skills = await readJson(projectPath, 'Skills.json');
  if (id >= 0 && id < skills.length && skills[id] !== null) {
    return skills[id];
  }
  return null;
}

/**
 * Create a new skill with full control over all properties.
 * Generates a complete RPG Maker MV skill object.
 * @param {string} projectPath - The project root path
 * @param {object} params - Skill properties including damage, effects, etc.
 */
async function createSkill(projectPath, params) {
  const skills = await readJson(projectPath, 'Skills.json');
  const newId = nextId(skills);

  var damage = params.damage || {
    type: 0,            // 0=none, 1=HP damage, 2=MP damage, 3=HP recover, 4=MP recover, 5=MP drain
    elementId: 0,       // 0=none, 1=physical, 2=fire, 3=ice, 4=thunder, 5=water, 6=earth, 7=wind, 8=light, 9=darkness
    formula: '0',       // Damage formula string (evaluated in battle)
    variance: 20,       // Percentage variance (0-100)
    critical: false     // Whether critical hits can occur
  };

  // Determine hit type based on damage type if not explicitly provided
  var hitType = params.hitType !== undefined ? params.hitType :
    (damage.type === 1 || damage.type === 5 ? 1 : 2);

  var newSkill = {
    id: newId,
    name: params.name || '',
    description: params.description || '',
    iconIndex: params.iconIndex || 64,
    stypeId: params.stypeId || 1,          // Skill type: 1=magic, 2=special
    mpCost: params.mpCost || 0,
    tpCost: params.tpCost || 0,
    scope: params.scope || 1,              // 1=single enemy, 2=all enemies, 3=1 random enemy,
                                            // 4=2 random enemies, 5=3 random enemies,
                                            // 6=4 random enemies, 7=all allies,
                                            // 8=dead ally, 9=all dead allies, 10=user
    occasion: params.occasion !== undefined ? params.occasion : 1,
                                            // 0=always, 1=battle, 2=menu, 3=never
    speed: params.speed || 0,
    successRate: params.successRate || 100,
    repeats: params.repeats || 1,
    tpGain: params.tpGain || 0,
    hitType: hitType,                       // 0=certain, 1=physical, 2=magical
    animationId: params.animationId || 0,
    damage: damage,
    effects: params.effects || [],
    message1: params.message1 || '',
    message2: params.message2 || '',
    note: params.note || '',
    requiredWtypeId1: params.requiredWtypeId1 || 0,
    requiredWtypeId2: params.requiredWtypeId2 || 0,
    messageType: params.messageType || 1,
    traits: params.traits || []
  };

  while (skills.length <= newId) skills.push(null);
  skills[newId] = newSkill;

  await writeJson(projectPath, 'Skills.json', skills);
  return newSkill;
}

/**
 * Create a damage-dealing skill (simplified helper).
 * Automatically sets damage type to HP damage (1) with a formula.
 * @param {string} projectPath - The project root path
 * @param {string} name - Skill name
 * @param {number} mpCost - MP cost
 * @param {number} scope - Target scope (1=single enemy, 2=all enemies, etc.)
 * @param {string} formula - Damage formula (e.g. "a.mat * 4 - b.mdf * 2")
 * @param {number} element - Element ID (0=none, 2=fire, 3=ice, 4=thunder, etc.)
 * @param {number} animationId - Animation ID to play
 */
async function createDamageSkill(projectPath, name, mpCost, scope, formula, element, animationId) {
  element = element || 0;
  animationId = animationId || 1;
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    damage: {
      type: 1,           // HP damage
      elementId: element,
      formula: formula,
      variance: 20,
      critical: true
    },
    hitType: 1,          // Physical hit type
    animationId: animationId,
    stypeId: 1           // Magic skill type
  });
}

/**
 * Create a healing skill (simplified helper).
 * Automatically sets damage type to HP recover (3) with a formula.
 * @param {string} projectPath - The project root path
 * @param {string} name - Skill name
 * @param {number} mpCost - MP cost
 * @param {number} scope - Target scope (7=all allies, 11=user, etc.)
 * @param {string} formula - Healing formula (e.g. "a.mat * 3 + 100")
 * @param {number} animationId - Animation ID (default 47 = heal animation)
 */
async function createHealingSkill(projectPath, name, mpCost, scope, formula, animationId) {
  animationId = animationId || 47;
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    iconIndex: 72,       // Healing icon
    damage: {
      type: 3,           // HP recover
      elementId: 0,
      formula: formula,
      variance: 20,
      critical: false
    },
    hitType: 2,          // Magical hit type
    animationId: animationId,
    stypeId: 1,
    occasion: 0          // Always (battle + menu)
  });
}

/**
 * Create a buff skill (simplified helper).
 * Adds a buff effect to a parameter for a number of turns.
 * Effect code 31 = Add Buff.
 * @param {string} projectPath - The project root path
 * @param {string} name - Skill name
 * @param {number} mpCost - MP cost
 * @param {number} scope - Target scope
 * @param {number} paramId - Parameter to buff: 0=MaxHP, 1=MaxMP, 2=ATK, 3=DEF, 4=MAT, 5=MDF, 6=AGI, 7=LUK
 * @param {number} turns - Number of turns the buff lasts
 */
async function createBuffSkill(projectPath, name, mpCost, scope, paramId, turns) {
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    iconIndex: 73,       // Buff icon
    damage: {
      type: 0,
      elementId: 0,
      formula: '0',
      variance: 0,
      critical: false
    },
    effects: [
      { code: 31, dataId: paramId, value1: turns, value2: 0 }
    ],
    animationId: 52,     // Buff animation
    hitType: 0,          // Certain hit
    stypeId: 1,
    occasion: 1          // Battle only
  });
}

/**
 * Create a state-inflicting skill (simplified helper).
 * Adds a state effect (poison, sleep, confusion, etc.).
 * Effect code 21 = Add State.
 * @param {string} projectPath - The project root path
 * @param {string} name - Skill name
 * @param {number} mpCost - MP cost
 * @param {number} scope - Target scope (1=single enemy, 2=all enemies)
 * @param {number} stateId - State ID to inflict (4=poison, 5=blind, 6=silence, 8=confusion, 9=sleep, etc.)
 * @param {number} chance - Success chance (0.0 to 1.0)
 */
async function createStateSkill(projectPath, name, mpCost, scope, stateId, chance) {
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    damage: {
      type: 0,
      elementId: 0,
      formula: '0',
      variance: 0,
      critical: false
    },
    effects: [
      { code: 21, dataId: stateId, value1: chance, value2: 0 }
    ],
    animationId: 1,
    hitType: 2,          // Magical hit type
    stypeId: 1,
    occasion: 1          // Battle only
  });
}

/**
 * Update an existing skill's properties (partial update).
 * @param {string} projectPath - The project root path
 * @param {number} id - The skill ID to update
 * @param {object} fields - Fields to update
 */
async function updateSkill(projectPath, id, fields) {
  const skills = await readJson(projectPath, 'Skills.json');

  if (id < 0 || id >= skills.length || skills[id] === null) {
    throw new Error('Skill with ID ' + id + ' not found');
  }

  skills[id] = Object.assign({}, skills[id], fields);
  await writeJson(projectPath, 'Skills.json', skills);
  return skills[id];
}

/**
 * Search skills by name or description (case-insensitive).
 * @param {string} projectPath - The project root path
 * @param {string} query - Search term
 */
async function searchSkills(projectPath, query) {
  const skills = await readJson(projectPath, 'Skills.json');
  const lowerQuery = query.toLowerCase();
  return skills.filter(function(s) {
    return s !== null &&
      (s.name.toLowerCase().includes(lowerQuery) ||
       s.description.toLowerCase().includes(lowerQuery));
  });
}

async function deleteSkill(projectPath, id) {
  const skills = await readJson(projectPath, 'Skills.json');
  if (id < 0 || id >= skills.length || skills[id] === null) {
    throw new Error('Skill with ID ' + id + ' not found');
  }
  var deleted = skills[id];
  skills[id] = null;
  await writeJson(projectPath, 'Skills.json', skills);
  return { deleted: deleted };
}

module.exports = {
  getSkills, getSkill, createSkill, createDamageSkill, createHealingSkill,
  createBuffSkill, createStateSkill, updateSkill, searchSkills, deleteSkill
};
