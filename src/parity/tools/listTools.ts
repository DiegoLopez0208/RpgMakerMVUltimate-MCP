import { z } from 'zod';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { ToolDefinition } from '../registry.js';

/**
 * Database tables that can be listed as a names-only index. Each is stored as a
 * 1-indexed JSON array whose entries share an `{ id, name }` shape (slot 0 is
 * null), so a single generic lister covers all of them.
 */
export const LISTABLE_FILES = {
  actors: 'Actors.json',
  classes: 'Classes.json',
  items: 'Items.json',
  weapons: 'Weapons.json',
  armors: 'Armors.json',
  skills: 'Skills.json',
  enemies: 'Enemies.json',
  troops: 'Troops.json',
  states: 'States.json',
  common_events: 'CommonEvents.json',
  tilesets: 'Tilesets.json',
  maps: 'MapInfos.json',
} as const;

export type ListableType = keyof typeof LISTABLE_FILES;

/**
 * The subset of {@link LISTABLE_FILES} that `get_database` dumps in full. Two
 * listable tables are deliberately absent: `maps` is an index, not a record
 * table (`get_map_infos` / `get_map` own it), and a raw `tilesets` dump carries
 * an 8192-entry `flags` array per tileset — `get_tilesets` summarizes it and
 * `get_tile_flags` decodes single entries instead.
 */
export const DATABASE_TYPES = [
  'actors',
  'classes',
  'items',
  'weapons',
  'armors',
  'skills',
  'enemies',
  'troops',
  'states',
  'common_events',
] as const;

export type DatabaseType = (typeof DATABASE_TYPES)[number];

/**
 * Read one database table in full, or a single record from it by id.
 *
 * Every table is a 1-indexed array whose slot 0 is null, so one generic reader
 * replaces the ten per-table `get_*` dumps that each cost a client a tool slot.
 * The return shapes are the ones those tools had: the raw array (slot-0 null
 * included) for a whole table, the record or `null` for a lookup that misses.
 */
export async function getDatabase<T extends { id: number }>(
  projectPath: string,
  type: DatabaseType,
  id?: number,
): Promise<(T | null)[] | T | null> {
  const records = await readJsonFile<(T | null)[]>(getDataPath(projectPath, LISTABLE_FILES[type]));
  if (id === undefined) return records;
  return records.find((record) => record && record.id === id) ?? null;
}

export interface NamedEntry {
  id: number;
  name: string;
}

export interface NamedIndex {
  type: ListableType;
  count: number;
  entries: NamedEntry[];
}

/**
 * Return a compact `{ id, name }` index for one database table — far cheaper
 * than the full-record `get_*`/`search_*` dumps when all you need is to look up
 * or sanity-check an ID before wiring it into an event.
 */
export async function listNames(projectPath: string, type: ListableType): Promise<NamedIndex> {
  const file = LISTABLE_FILES[type];
  if (!file) {
    throw new Error(
      `Unknown list type: ${type}. Valid types: ${Object.keys(LISTABLE_FILES).join(', ')}`,
    );
  }

  const records = await readJsonFile<(NamedEntry | null)[]>(getDataPath(projectPath, file));
  const entries = records
    .filter((record): record is NamedEntry => record != null)
    .map((record) => ({ id: record.id, name: record.name }));

  return { type, count: entries.length, entries };
}

export const listToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_names',
    description:
      'Cheap names-only index for a database table. Returns { id, name } entries instead of full records — use it to look up or sanity-check IDs before wiring them into events, without paying the token cost of a full get_*/search_* dump.',
    inputSchema: {
      type: z
        .enum(Object.keys(LISTABLE_FILES) as [ListableType, ...ListableType[]])
        .describe(
          'Which table to index: actors, classes, items, weapons, armors, skills, enemies, troops, states, common_events, tilesets, or maps.',
        ),
    },
    handler: (ctx, args) => listNames(ctx.projectPath, args.type),
  },
  {
    name: 'get_database',
    description:
      'Read a database table in full: actors, classes, items, weapons, armors, skills, enemies, troops, states, or common_events. Returns the raw 1-indexed array (slot 0 is null), or — with `id` — that single record, or null if no such record exists. These are full records: prefer list_names for an id→name index, or search_actors/search_items/search_skills to find records by name, and reach for this only when you need every field. Maps and tilesets are not here: use get_map_infos/get_map and get_tilesets/get_tile_flags. Read-only.',
    inputSchema: {
      type: z
        .enum(DATABASE_TYPES)
        .describe(
          'Which table to read: actors, classes, items, weapons, armors, skills, enemies, troops, states, or common_events.',
        ),
      id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Return just this record (null if missing); omitted = the whole table'),
    },
    handler: (ctx, args) => getDatabase(ctx.projectPath, args.type, args.id),
  },
];
