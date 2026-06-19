import { createCrud } from "../utils/crudHelper.js";
import type { SkillParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Skill extends RpgMakerDbEntry {
  name: string;
  description: string;
  iconIndex: number;
  stypeId: number;
  mpCost: number;
  tpCost: number;
  scope: number;
  occasion: number;
  speed: number;
  successRate: number;
  repeats: number;
  tpGain: number;
  hitType: number;
  animationId: number;
  damage: { type: number; elementId: number; formula: string; variance: number; critical: boolean };
  effects: unknown[];
  message1: string;
  message2: string;
  note: string;
  requiredWtypeId1: number;
  requiredWtypeId2: number;
  messageType: number;
  traits: unknown[];
}

function skillFactory(id: number): Skill {
  return {
    id, name: "", description: "", iconIndex: 64, stypeId: 1, mpCost: 0, tpCost: 0,
    scope: 1, occasion: 1, speed: 0, successRate: 100, repeats: 1, tpGain: 0,
    hitType: 2, animationId: 0,
    damage: { type: 0, elementId: 0, formula: "0", variance: 20, critical: false },
    effects: [], message1: "", message2: "", note: "", requiredWtypeId1: 0,
    requiredWtypeId2: 0, messageType: 1, traits: []
  };
}

const skillsCrud = createCrud<Skill>("Skills.json", skillFactory);

async function getSkills(projectPath: string) {
  return skillsCrud.getAll(projectPath);
}

async function getSkill(projectPath: string, id: number) {
  return skillsCrud.getById(projectPath, id);
}

async function createSkill(projectPath: string, params: SkillParams) {
  return skillsCrud.create(projectPath, (id) => ({
    ...skillFactory(id),
    ...params,
    damage: params.damage ?? skillFactory(id).damage,
    id
  }));
}

async function createDamageSkill(projectPath: string, name: string, mpCost: number, scope: number, formula: string, element: number, animationId: number) {
  return createSkill(projectPath, { name, mpCost, scope, damage: { type: 1, elementId: element ?? 0, formula, variance: 20, critical: true }, hitType: 1, animationId: animationId ?? 1, stypeId: 1 });
}

async function createHealingSkill(projectPath: string, name: string, mpCost: number, scope: number, formula: string, animationId: number) {
  return createSkill(projectPath, { name, mpCost, scope, iconIndex: 72, damage: { type: 3, elementId: 0, formula, variance: 20, critical: false }, hitType: 2, animationId: animationId ?? 47, stypeId: 1, occasion: 0 });
}

async function createBuffSkill(projectPath: string, name: string, mpCost: number, scope: number, paramId: number, turns: number) {
  return createSkill(projectPath, { name, mpCost, scope, iconIndex: 73, damage: { type: 0, elementId: 0, formula: "0", variance: 0, critical: false }, effects: [{ code: 31, dataId: paramId, value1: turns, value2: 0 }], animationId: 52, hitType: 0, stypeId: 1, occasion: 1 });
}

async function createStateSkill(projectPath: string, name: string, mpCost: number, scope: number, stateId: number, chance: number) {
  return createSkill(projectPath, { name, mpCost, scope, damage: { type: 0, elementId: 0, formula: "0", variance: 0, critical: false }, effects: [{ code: 21, dataId: stateId, value1: chance, value2: 0 }], animationId: 1, hitType: 2, stypeId: 1, occasion: 1 });
}

async function updateSkill(projectPath: string, id: number, fields: Partial<SkillParams>) {
  return skillsCrud.update(projectPath, id, fields);
}

async function searchSkills(projectPath: string, query: string) {
  return skillsCrud.search(projectPath, query, ["name", "description"]);
}

async function deleteSkill(projectPath: string, id: number) {
  if (id === 1 || id === 2) {
    throw new Error('Cannot delete essential skill ' + id + ' (' + (id === 1 ? 'Attack' : 'Guard') + ')');
  }
  return skillsCrud.delete(projectPath, id);
}

async function getSkillsList(projectPath: string) {
  return skillsCrud.getAll(projectPath);
}

export { getSkills, getSkill, createSkill, createDamageSkill, createHealingSkill, createBuffSkill, createStateSkill, updateSkill, searchSkills, deleteSkill, getSkillsList };
