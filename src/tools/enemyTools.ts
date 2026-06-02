import { createCrud } from "../utils/crudHelper.js";
import type { EnemyParams, BossEnemyParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Enemy extends RpgMakerDbEntry {
  battlerName: string;
  battlerHue: number;
  exp: number;
  gold: number;
  params: number[];
  dropItems: { kind: number; dataId: number; denominator: number }[];
  actions: { skillId: number; conditionType: number; conditionParam1: number; conditionParam2: number; rating: number }[];
  traits: unknown[];
}

function enemyFactory(id: number): Enemy {
  return {
    id,
    name: "",
    note: "",
    battlerName: "",
    battlerHue: 0,
    exp: 0,
    gold: 0,
    params: [100, 0, 10, 10, 10, 10, 10, 10],
    dropItems: [
      { kind: 0, dataId: 0, denominator: 1 },
      { kind: 0, dataId: 0, denominator: 1 },
      { kind: 0, dataId: 0, denominator: 1 },
    ],
    traits: [],
    actions: [{ skillId: 1, conditionType: 1, conditionParam1: 0, conditionParam2: 1, rating: 5 }],
  };
}

const enemiesCrud = createCrud<Enemy>("Enemies.json", enemyFactory);

async function getEnemies(projectPath: string) {
  return enemiesCrud.getAll(projectPath);
}

async function getEnemy(projectPath: string, id: number) {
  return enemiesCrud.getById(projectPath, id);
}

async function createEnemy(projectPath: string, params: EnemyParams) {
  return enemiesCrud.create(projectPath, (id) => ({
    ...enemyFactory(id),
    ...params,
  }));
}

async function createBossEnemy(projectPath: string, params: BossEnemyParams) {
  return enemiesCrud.create(projectPath, (id) => ({
    ...enemyFactory(id),
    ...params,
    params: params.params || [5000, 0, 80, 60, 60, 60, 50, 50],
    exp: params.exp !== undefined ? params.exp : 500,
    gold: params.gold !== undefined ? params.gold : 200,
    actions: (params as EnemyParams).actions || [
      { skillId: 1, conditionType: 1, conditionParam1: 0, conditionParam2: 1, rating: 5 },
      { skillId: params.specialSkillId || 2, conditionType: 2, conditionParam1: 0.3, conditionParam2: 1, rating: 7 },
    ],
  }));
}

async function updateEnemy(projectPath: string, id: number, fields: Partial<EnemyParams>) {
  return enemiesCrud.update(projectPath, id, fields);
}

async function searchEnemies(projectPath: string, query: string) {
  return enemiesCrud.search(projectPath, query, ["name"]);
}

async function deleteEnemy(projectPath: string, id: number) {
  const deleted = await enemiesCrud.delete(projectPath, id);
  return { deleted };
}

export { getEnemies, getEnemy, createEnemy, createBossEnemy, updateEnemy, searchEnemies, deleteEnemy };
