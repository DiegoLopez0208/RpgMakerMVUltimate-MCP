import { createCrud } from "../utils/crudHelper.js";
import type { TroopParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Troop extends RpgMakerDbEntry {
  members: { enemyId: number; x: number; y: number; hidden: boolean }[];
  pages: unknown[];
}

function troopFactory(id: number): Troop {
  return {
    id,
    name: "",
    note: "",
    members: [],
    pages: [
      {
        conditions: { actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false, switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false },
        list: [{ code: 0, indent: 0, parameters: [] }],
        span: 0,
      },
    ],
  };
}

const troopsCrud = createCrud<Troop>("Troops.json", troopFactory);

async function getTroops(projectPath: string) {
  return troopsCrud.getAll(projectPath);
}

async function getTroop(projectPath: string, id: number) {
  return troopsCrud.getById(projectPath, id);
}

async function createTroop(projectPath: string, params: TroopParams) {
  return troopsCrud.create(projectPath, (id) => ({
    ...troopFactory(id),
    members: params.members || [],
    name: params.name || "",
    note: params.note || "",
    pages: params.pages !== undefined ? params.pages : troopFactory(0).pages,
  }));
}

async function updateTroop(projectPath: string, id: number, fields: Partial<Troop>) {
  return troopsCrud.update(projectPath, id, fields);
}

async function deleteTroop(projectPath: string, id: number) {
  return troopsCrud.delete(projectPath, id);
}

async function addEnemyToTroop(projectPath: string, troopId: number, enemyId: number) {
  const troop = await troopsCrud.getById(projectPath, troopId);
  if (!troop) throw new Error("Troop " + troopId + " not found");
  const members = [
    ...troop.members,
    { enemyId, x: 200 + troop.members.length * 80, y: 200 + Math.floor(Math.random() * 60), hidden: false },
  ];
  return troopsCrud.update(projectPath, troopId, { members });
}

async function createRandomEncounterTroop(projectPath: string, params: { name?: string; enemyIds?: number[]; note?: string }) {
  const enemyIds = params.enemyIds || [];
  const members = enemyIds.map((eid: number, i: number) => ({
    enemyId: eid,
    x: 200 + i * 80,
    y: 200 + Math.floor(Math.random() * 60),
    hidden: false,
  }));
  return createTroop(projectPath, { name: params.name || "Troop", members, note: params.note || "" });
}

export { getTroops, getTroop, createTroop, updateTroop, deleteTroop, addEnemyToTroop, createRandomEncounterTroop };
