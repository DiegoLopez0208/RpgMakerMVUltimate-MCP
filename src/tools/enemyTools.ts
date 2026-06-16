import { readdirSync, readFileSync } from "fs";
import { createCrud } from "../utils/crudHelper.js";
import type { EnemyParams, BossEnemyParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

// An enemy with battlerName "" is invisible in battle. Resolve a battler that
// actually exists in the project's battler folder (front-view img/enemies or
// side-view img/sv_enemies per System.json), keeping a valid provided name,
// and otherwise picking a real sprite deterministically by enemy name so
// different enemies look different. Returns "" only if no battlers exist.
function resolveEnemyBattler(projectPath: string, name: string | undefined, key: string): string {
  let sideView = false;
  try { sideView = !!JSON.parse(readFileSync(projectPath + "/data/System.json", "utf8")).optSideView; } catch { /* default front */ }
  const dir = projectPath + (sideView ? "/img/sv_enemies" : "/img/enemies");
  let battlers: string[] = [];
  try { battlers = readdirSync(dir).filter((f) => /\.png$/i.test(f)).map((f) => f.replace(/\.png$/i, "")); } catch { return name || ""; }
  if (battlers.length === 0) return name || "";
  if (name && battlers.includes(name)) return name;        // valid as given
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return battlers[h % battlers.length];                     // deterministic real sprite
}

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
  const battlerName = resolveEnemyBattler(projectPath, params.battlerName, params.name || "enemy");
  return enemiesCrud.create(projectPath, (id) => ({
    ...enemyFactory(id),
    ...params,
    battlerName,
  }));
}

async function createBossEnemy(projectPath: string, params: BossEnemyParams) {
  const battlerName = resolveEnemyBattler(projectPath, params.battlerName, params.name || "boss");
  return enemiesCrud.create(projectPath, (id) => ({
    ...enemyFactory(id),
    ...params,
    battlerName,
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
