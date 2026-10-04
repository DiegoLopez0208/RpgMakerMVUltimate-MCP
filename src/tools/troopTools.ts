import { createCrud } from "../utils/crudHelper.js";
import type { TroopParams, RpgMakerDbEntry } from "../types/rpgmaker.js";
import { readJson } from "../utils/fileHandler.js";
import { buildTroopPage } from "../utils/troopPage.js";
import { checkReferences } from "./eventCommandTools.js";

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

/**
 * Insert one battle-event page into a troop without resending its other pages.
 * Refuses conditions the engine could never meet (an empty enemy slot, a missing
 * actor, a switch past System.json) and checks the page's commands like
 * insert_event_commands does. Page order matters: the engine runs every page whose
 * conditions hold, in order.
 */
async function addTroopPage(projectPath: string, troopId: number, input: unknown) {
  const troop = await troopsCrud.getById(projectPath, troopId);
  if (!troop) throw new Error("Troop " + troopId + " not found");
  const { page, position, warnings } = buildTroopPage(input);
  const c = page.conditions;
  if (c.enemyValid && !troop.members[c.enemyIndex]) {
    throw new Error("Troop " + troopId + " has no enemy in slot " + c.enemyIndex + " (it has " + troop.members.length + "); that page could never run");
  }
  if (c.actorValid) {
    const actors = await readJson(projectPath, "Actors.json");
    if (!Array.isArray(actors) || !actors[c.actorId]) throw new Error("Actor " + c.actorId + " does not exist");
  }
  if (c.switchValid) {
    const system = await readJson(projectPath, "System.json") as { switches?: unknown[] } | null;
    const count = Array.isArray(system?.switches) ? system!.switches.length : 0;
    if (count > 1 && c.switchId >= count) throw new Error("switches ID " + c.switchId + " exceeds System.json maximum " + (count - 1));
  }
  warnings.push(...await checkReferences(projectPath, page.list));
  const pages = [...(troop.pages || [])];
  const index = position === undefined ? pages.length : position;
  if (index > pages.length) throw new Error("position " + index + " is past the end of the troop's " + pages.length + " pages");
  pages.splice(index, 0, page);
  const updated = await troopsCrud.update(projectPath, troopId, { pages });
  return { troopId, pageIndex: index, pageCount: pages.length, page, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), troop: { id: updated.id, name: updated.name } };
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

export { getTroops, getTroop, createTroop, updateTroop, deleteTroop, addEnemyToTroop, addTroopPage, createRandomEncounterTroop };
