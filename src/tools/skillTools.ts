import { readJson, writeJson, nextId } from '../utils/fileHandler.js';
import type { SkillParams } from '../types/rpgmaker.js';

async function getSkills(projectPath: string) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];
  return skills.filter(function(s: unknown) { return s !== null; });
}

async function getSkill(projectPath: string, id: number) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];
  if (id >= 0 && id < skills.length && skills[id] !== null) {
    return skills[id];
  }
  return null;
}

async function createSkill(projectPath: string, params: SkillParams) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];
  const newId = nextId(skills);

  var damage = params.damage || {
    type: 0,
    elementId: 0,
    formula: '0',
    variance: 20,
    critical: false
  };

  var hitType = params.hitType !== undefined ? params.hitType :
    (damage.type === 1 || damage.type === 5 ? 1 : 2);

  var newSkill = {
    id: newId,
    name: params.name || '',
    description: params.description || '',
    iconIndex: params.iconIndex || 64,
    stypeId: params.stypeId || 1,
    mpCost: params.mpCost || 0,
    tpCost: params.tpCost || 0,
    scope: params.scope || 1,
    occasion: params.occasion !== undefined ? params.occasion : 1,
    speed: params.speed || 0,
    successRate: params.successRate || 100,
    repeats: params.repeats || 1,
    tpGain: params.tpGain || 0,
    hitType: hitType,
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

async function createDamageSkill(projectPath: string, name: string, mpCost: number, scope: number, formula: string, element: number, animationId: number) {
  element = element || 0;
  animationId = animationId || 1;
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    damage: {
      type: 1,
      elementId: element,
      formula: formula,
      variance: 20,
      critical: true
    },
    hitType: 1,
    animationId: animationId,
    stypeId: 1
  });
}

async function createHealingSkill(projectPath: string, name: string, mpCost: number, scope: number, formula: string, animationId: number) {
  animationId = animationId || 47;
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    iconIndex: 72,
    damage: {
      type: 3,
      elementId: 0,
      formula: formula,
      variance: 20,
      critical: false
    },
    hitType: 2,
    animationId: animationId,
    stypeId: 1,
    occasion: 0
  });
}

async function createBuffSkill(projectPath: string, name: string, mpCost: number, scope: number, paramId: number, turns: number) {
  return await createSkill(projectPath, {
    name: name,
    mpCost: mpCost,
    scope: scope,
    iconIndex: 73,
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
    animationId: 52,
    hitType: 0,
    stypeId: 1,
    occasion: 1
  });
}

async function createStateSkill(projectPath: string, name: string, mpCost: number, scope: number, stateId: number, chance: number) {
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
    hitType: 2,
    stypeId: 1,
    occasion: 1
  });
}

async function updateSkill(projectPath: string, id: number, fields: Partial<SkillParams>) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];

  if (id < 0 || id >= skills.length || skills[id] === null) {
    throw new Error('Skill with ID ' + id + ' not found');
  }

  skills[id] = Object.assign({}, skills[id], fields);
  await writeJson(projectPath, 'Skills.json', skills);
  return skills[id];
}

async function searchSkills(projectPath: string, query: string) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];
  const lowerQuery = query.toLowerCase();
  return skills.filter(function(s: unknown) {
    return s !== null &&
      (((s as Record<string, string>).name.toLowerCase().includes(lowerQuery) ||
       (s as Record<string, string>).description.toLowerCase().includes(lowerQuery)));
  });
}

async function deleteSkill(projectPath: string, id: number) {
  const skills = await readJson(projectPath, 'Skills.json') as unknown[];
  if (id < 0 || id >= skills.length || skills[id] === null) {
    throw new Error('Skill with ID ' + id + ' not found');
  }
  var deleted = skills[id];
  skills[id] = null;
  await writeJson(projectPath, 'Skills.json', skills);
  return { deleted: deleted };
}

export { getSkills };
export { getSkill };
export { createSkill };
export { createDamageSkill };
export { createHealingSkill };
export { createBuffSkill };
export { createStateSkill };
export { updateSkill };
export { searchSkills };
export { deleteSkill };
