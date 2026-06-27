/**
 * projectIndex.ts — build and cache an in-memory model of a whole MV project.
 *
 * Instead of re-reading and re-parsing data/*.json on every query, the index is
 * built once and reused until the data directory changes (detected by a cheap
 * mtime signature). It exposes a normalised view of every database, map, event,
 * common event, switch and variable, plus a flat list of "reference sources"
 * (every command list in the project and what it touches) that powers the graph
 * and validation layers.
 *
 * Roadmap #1 (Comprensión del proyecto).
 */

import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import {
  extractRefs, extractRefsFromMany, extractWrites, extractWritesFromMany,
  extractReads, extractReadsFromMany, type RefSet, type WriteSet, type ReadSet,
} from "./references.js";
import type { RawCommand } from "./eventAst.js";

export type EntityKind =
  | "actors" | "classes" | "skills" | "items" | "weapons" | "armors"
  | "enemies" | "states" | "troops" | "tilesets" | "animations";

const ENTITY_FILES: Record<EntityKind, string> = {
  actors: "Actors.json", classes: "Classes.json", skills: "Skills.json",
  items: "Items.json", weapons: "Weapons.json", armors: "Armors.json",
  enemies: "Enemies.json", states: "States.json", troops: "Troops.json",
  tilesets: "Tilesets.json", animations: "Animations.json",
};

export interface IndexedEntity { id: number; name: string; }
export interface NamedSlot { id: number; name: string; }

export interface IndexedEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  pageCount: number;
  refs: RefSet;
  /** Page appearance conditions (a switch/variable/item gating the page). */
  conditionRefs: { switches: number[]; variables: number[]; items: number[] };
}

export interface Transfer {
  fromMap: number;
  fromEvent: number | null;
  toMap: number;
  x: number;
  y: number;
}

export interface IndexedMap {
  id: number;
  name: string;
  displayName: string;
  parentId: number;
  tilesetId: number;
  width: number;
  height: number;
  eventCount: number;
  events: IndexedEvent[];
  refs: RefSet;
  transfers: Transfer[];
  encounterTroops: number[];
  /** True when MapInfos lists the map but the MapNNN.json file is absent. */
  missing: boolean;
}

export interface IndexedCommonEvent {
  id: number;
  name: string;
  trigger: number;
  switchId: number;
  refs: RefSet;
}

/** One command list in the project and the entities it references. */
export interface RefSource {
  kind: "map-event" | "common-event" | "troop";
  label: string;
  mapId?: number;
  eventId?: number;
  commonEventId?: number;
  troopId?: number;
  refs: RefSet;
  writes: WriteSet;
  reads: ReadSet;
}

export interface ProjectIndex {
  projectPath: string;
  builtAt: number;
  signature: string;
  gameTitle: string;
  start: { mapId: number; x: number; y: number };
  entities: Record<EntityKind, IndexedEntity[]>;
  maps: IndexedMap[];
  commonEvents: IndexedCommonEvent[];
  switches: NamedSlot[];
  variables: NamedSlot[];
  refSources: RefSource[];
  counts: Record<string, number>;
}

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function stripBom(s: string): string {
  return s.replace(/^﻿/, "");
}

async function readJsonSafe(dir: string, file: string): Promise<unknown> {
  try {
    const content = await readFile(path.join(dir, file), "utf-8");
    return JSON.parse(stripBom(content));
  } catch {
    return null;
  }
}

/** Cheap fingerprint of the data directory: file names + mtimes. */
async function dataSignature(dataDir: string): Promise<{ signature: string; files: string[] }> {
  let names: string[] = [];
  try {
    names = (await readdir(dataDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { signature: "missing", files: [] };
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      const s = await stat(path.join(dataDir, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  return { signature: parts.join("|"), files: names };
}

function indexEntityArray(arr: unknown): IndexedEntity[] {
  if (!Array.isArray(arr)) return [];
  const out: IndexedEntity[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    out.push({ id: num(rec.id), name: String(rec.name ?? "") });
  }
  return out;
}

function namedSlots(arr: unknown): NamedSlot[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((name, id) => ({ id, name: String(name ?? "") }));
}

function pageLists(pages: unknown): RawCommand[][] {
  if (!Array.isArray(pages)) return [];
  const lists: RawCommand[][] = [];
  for (const page of pages) {
    const list = (page as Record<string, unknown>)?.list;
    if (Array.isArray(list)) lists.push(list as RawCommand[]);
  }
  return lists;
}

function conditionRefs(pages: unknown): IndexedEvent["conditionRefs"] {
  const switches = new Set<number>();
  const variables = new Set<number>();
  const items = new Set<number>();
  if (Array.isArray(pages)) {
    for (const page of pages) {
      const c = (page as Record<string, unknown>)?.conditions as Record<string, unknown> | undefined;
      if (!c) continue;
      if (c.switch1Valid) switches.add(num(c.switch1Id));
      if (c.switch2Valid) switches.add(num(c.switch2Id));
      if (c.variableValid) variables.add(num(c.variableId));
      if (c.itemValid) items.add(num(c.itemId));
    }
  }
  const pick = (s: Set<number>) => [...s].filter((n) => n > 0).sort((a, b) => a - b);
  return { switches: pick(switches), variables: pick(variables), items: pick(items) };
}

function scanTransfers(mapId: number, eventId: number | null, lists: RawCommand[][]): Transfer[] {
  const transfers: Transfer[] = [];
  for (const list of lists) {
    for (const cmd of list) {
      if (num(cmd?.code) === 201) {
        const p = Array.isArray(cmd.parameters) ? cmd.parameters : [];
        if (p[0] === 0) transfers.push({ fromMap: mapId, fromEvent: eventId, toMap: num(p[1]), x: num(p[2]), y: num(p[3]) });
      }
    }
  }
  return transfers;
}

async function buildMap(dataDir: string, info: Record<string, unknown>, refSources: RefSource[]): Promise<IndexedMap> {
  const id = num(info.id);
  const file = `Map${String(id).padStart(3, "0")}.json`;
  const raw = (await readJsonSafe(dataDir, file)) as Record<string, unknown> | null;
  const base: IndexedMap = {
    id,
    name: String(info.name ?? ""),
    displayName: "",
    parentId: num(info.parentId),
    tilesetId: 0,
    width: 0,
    height: 0,
    eventCount: 0,
    events: [],
    refs: extractRefs([]),
    transfers: [],
    encounterTroops: [],
    missing: raw === null,
  };
  if (!raw) return base;

  base.displayName = String(raw.displayName ?? "");
  base.tilesetId = num(raw.tilesetId);
  base.width = num(raw.width);
  base.height = num(raw.height);
  base.encounterTroops = Array.isArray(raw.encounterList)
    ? [...new Set((raw.encounterList as Record<string, unknown>[]).map((e) => num(e?.troopId)).filter((n) => n > 0))]
    : [];

  const mapLists: RawCommand[][] = [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    const lists = pageLists(e.pages);
    mapLists.push(...lists);
    const refs = extractRefsFromMany(lists);
    const evId = num(e.id);
    base.events.push({
      id: evId,
      name: String(e.name ?? ""),
      x: num(e.x),
      y: num(e.y),
      pageCount: Array.isArray(e.pages) ? e.pages.length : 0,
      refs,
      conditionRefs: conditionRefs(e.pages),
    });
    base.transfers.push(...scanTransfers(id, evId, lists));
    refSources.push({ kind: "map-event", label: `Map ${id} / event ${evId} "${String(e.name ?? "")}"`, mapId: id, eventId: evId, refs, writes: extractWritesFromMany(lists), reads: extractReadsFromMany(lists) });
  }
  base.eventCount = base.events.length;
  base.refs = extractRefsFromMany(mapLists);
  return base;
}

let cache: ProjectIndex | null = null;

/**
 * Build (or return a cached) index of the project at `projectPath`.
 * Rebuilds automatically when any data/*.json file changes; pass force to
 * bypass the cache.
 */
export async function getProjectIndex(projectPath: string, force = false): Promise<ProjectIndex> {
  const dataDir = path.join(projectPath, "data");
  const { signature } = await dataSignature(dataDir);
  if (!force && cache && cache.projectPath === projectPath && cache.signature === signature) {
    return cache;
  }

  const refSources: RefSource[] = [];

  // Databases
  const entities = {} as Record<EntityKind, IndexedEntity[]>;
  for (const kind of Object.keys(ENTITY_FILES) as EntityKind[]) {
    entities[kind] = indexEntityArray(await readJsonSafe(dataDir, ENTITY_FILES[kind]));
  }

  // Troop battle-event pages contribute references too.
  const troopsRaw = (await readJsonSafe(dataDir, "Troops.json")) as unknown[] | null;
  if (Array.isArray(troopsRaw)) {
    for (const t of troopsRaw) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      const lists = pageLists(tr.pages);
      if (lists.length === 0) continue;
      const refs = extractRefsFromMany(lists);
      refSources.push({ kind: "troop", label: `Troop ${num(tr.id)} "${String(tr.name ?? "")}"`, troopId: num(tr.id), refs, writes: extractWritesFromMany(lists), reads: extractReadsFromMany(lists) });
    }
  }

  // Common events
  const commonRaw = (await readJsonSafe(dataDir, "CommonEvents.json")) as unknown[] | null;
  const commonEvents: IndexedCommonEvent[] = [];
  if (Array.isArray(commonRaw)) {
    for (const ce of commonRaw) {
      if (!ce || typeof ce !== "object") continue;
      const c = ce as Record<string, unknown>;
      const list = Array.isArray(c.list) ? (c.list as RawCommand[]) : [];
      const refs = extractRefs(list);
      const id = num(c.id);
      commonEvents.push({ id, name: String(c.name ?? ""), trigger: num(c.trigger), switchId: num(c.switchId), refs });
      refSources.push({ kind: "common-event", label: `Common Event ${id} "${String(c.name ?? "")}"`, commonEventId: id, refs, writes: extractWrites(list), reads: extractReads(list) });
    }
  }

  // System
  const system = (await readJsonSafe(dataDir, "System.json")) as Record<string, unknown> | null;
  const gameTitle = String(system?.gameTitle ?? "");
  const start = { mapId: num(system?.startMapId), x: num(system?.startX), y: num(system?.startY) };
  const switches = namedSlots(system?.switches);
  const variables = namedSlots(system?.variables);

  // Maps
  const mapInfos = (await readJsonSafe(dataDir, "MapInfos.json")) as unknown[] | null;
  const maps: IndexedMap[] = [];
  if (Array.isArray(mapInfos)) {
    for (const info of mapInfos) {
      if (!info || typeof info !== "object") continue;
      maps.push(await buildMap(dataDir, info as Record<string, unknown>, refSources));
    }
  }
  maps.sort((a, b) => a.id - b.id);

  const counts: Record<string, number> = {
    maps: maps.length,
    commonEvents: commonEvents.length,
    events: maps.reduce((n, m) => n + m.eventCount, 0),
    namedSwitches: switches.filter((s) => s.name).length,
    namedVariables: variables.filter((v) => v.name).length,
  };
  for (const kind of Object.keys(entities) as EntityKind[]) counts[kind] = entities[kind].length;

  const index: ProjectIndex = {
    projectPath,
    builtAt: Date.now(),
    signature,
    gameTitle,
    start,
    entities,
    maps,
    commonEvents,
    switches,
    variables,
    refSources,
    counts,
  };
  cache = index;
  return index;
}

/** Drop the cached index (used by tests and after bulk external edits). */
export function clearProjectIndexCache(): void {
  cache = null;
}
