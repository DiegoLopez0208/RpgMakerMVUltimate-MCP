/**
 * Checks that keep generated maps and placed events from being unreachable or broken:
 * a walkability report for a map, and argument checks for the manage_map_event presets.
 */
import { readJson } from '../utils/fileHandler.js';
import { isStandable, largestStandableRegion } from '../utils/placement.js';
import type { RpgMakerMap } from '../types/rpgmaker.js';
import { getMap, loadTilesetFlags } from './mapTools.js';

/** A main area smaller than this is reported as too small to play in. */
const MIN_MAIN_REGION = 25;
/** Share of standable tiles cut off from the main area above which the map is flagged. */
const MAX_ISOLATED_SHARE = 0.2;

export interface WalkReport {
  mapId: number;
  standableTiles: number;
  mainRegionTiles: number;
  isolatedTiles: number;
  warnings: string[];
}

/** Standable cells of the map's biggest connected area, as "x,y" keys. */
export function mainRegionCells(map: RpgMakerMap, flags: number[]): Set<string> {
  const cells = new Set<string>();
  for (const index of largestStandableRegion(map, flags)) cells.add((index % map.width) + ',' + Math.floor(index / map.width));
  return cells;
}

/**
 * How much of the map the player can actually walk: tiles that can be stood on, the size of
 * the largest connected area, and how many standable tiles are cut off from it. Null when the
 * tileset has no passage flags to judge by.
 */
export async function mapWalkReport(projectPath: string, mapId: number): Promise<WalkReport | null> {
  const map = await getMap(projectPath, mapId) as RpgMakerMap | null;
  if (!map) throw new Error(`Map ${mapId} does not exist.`);
  const flags = await loadTilesetFlags(projectPath, map.tilesetId);
  if (!flags) return null;
  let standable = 0;
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (isStandable(map, flags, x, y)) standable++;
  const main = largestStandableRegion(map, flags).length;
  const isolated = standable - main;
  const warnings: string[] = [];
  if (main === 0) {
    warnings.push('No tile on this map can be walked on; the player could not move. Check the tileset and the tile layers (query_map "ascii").');
  } else {
    if (main < MIN_MAIN_REGION) warnings.push(`The walkable area is only ${main} tiles.`);
    if (isolated / standable > MAX_ISOLATED_SHARE) {
      warnings.push(`${isolated} of ${standable} walkable tiles are cut off from the main area (${main} tiles) and cannot be reached on foot.`);
    }
  }
  return { mapId, standableTiles: standable, mainRegionTiles: main, isolatedTiles: isolated, warnings };
}

/** Collect the ids of the maps a generator result created. */
export function generatedMapIds(result: unknown): number[] {
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  const ids = new Set<number>();
  const add = (value: unknown) => { if (typeof value === 'number' && Number.isInteger(value) && value > 0) ids.add(value); };
  add(record.mapId);
  for (const key of ['mapIds', 'interiorMapIds']) {
    if (Array.isArray(record[key])) for (const value of record[key] as unknown[]) add(value);
  }
  return [...ids];
}

/** Attach a walkability report and its warnings to a generator result; never fails the generation. */
export async function withWalkReport<T>(projectPath: string, result: T): Promise<T> {
  const reports: WalkReport[] = [];
  for (const id of generatedMapIds(result)) {
    try {
      const report = await mapWalkReport(projectPath, id);
      if (report) reports.push(report);
    } catch { /* map unreadable: leave the result as it is */ }
  }
  if (reports.length === 0 || typeof result !== 'object' || result === null) return result;
  const warnings = reports.flatMap((report) => report.warnings.map((text) => `map ${report.mapId}: ${text}`));
  return { ...result, walkability: reports, ...(warnings.length ? { warnings } : {}) };
}

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

async function table(projectPath: string, file: string): Promise<unknown[]> {
  const value = await readJson(projectPath, file);
  return Array.isArray(value) ? value : [];
}

async function requireEntry(projectPath: string, file: string, id: unknown, what: string) {
  if (!num(id)) return;
  const list = await table(projectPath, file);
  if (list.length > 1 && !list[id]) throw new Error(`${what} ${id} does not exist in ${file}.`);
}

/** Where an event would sit: a warning when the tile cannot be walked on or another event is there. */
async function spotWarnings(projectPath: string, mapId: unknown, x: unknown, y: unknown, label: string, needsStandable: boolean): Promise<string[]> {
  if (!num(mapId) || !num(x) || !num(y)) return [];
  const map = await getMap(projectPath, mapId) as RpgMakerMap | null;
  if (!map) throw new Error(`Map ${mapId} does not exist.`);
  const warnings: string[] = [];
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
    throw new Error(`${label} (${x},${y}) is outside map ${mapId} (${map.width}x${map.height}).`);
  }
  if (needsStandable) {
    const flags = await loadTilesetFlags(projectPath, map.tilesetId);
    if (flags && !isStandable(map, flags, x, y)) warnings.push(`${label} (${x},${y}) is not a walkable tile on map ${mapId}.`);
  }
  const other = (map.events || []).find((event) => event && event.x === x && event.y === y);
  if (other) warnings.push(`${label} (${x},${y}) already holds event ${other.id} "${other.name}" on map ${mapId}.`);
  return warnings;
}

async function destinationWarnings(projectPath: string, args: Record<string, unknown>): Promise<string[]> {
  if (!num(args.destMapId)) return [];
  // A door may be built before the map it leads to, so a missing destination is a warning, not an error.
  if (!await getMap(projectPath, args.destMapId).catch(() => null)) {
    return [`Destination map ${args.destMapId} does not exist yet; the game fails if the player takes this transfer before it is created.`];
  }
  const warnings = await spotWarnings(projectPath, args.destMapId, args.destX, args.destY, 'Destination', true);
  // the destination may legitimately hold an event (a door's own spot); only walkability matters
  return warnings.filter((text) => !text.includes('already holds'));
}

async function checkSwitch(projectPath: string, id: unknown, what: string) {
  if (!num(id)) return;
  const system = await readJson(projectPath, 'System.json') as { switches?: unknown[] };
  const size = Array.isArray(system.switches) ? system.switches.length : 0;
  if (size > 1 && id >= size) throw new Error(`${what} ${id} exceeds System.json maximum ${size - 1}.`);
}

const ITEM_FILES: Record<string, string> = { item: 'Items.json', weapon: 'Weapons.json', armor: 'Armors.json' };
const GOOD_FILES = ['Items.json', 'Weapons.json', 'Armors.json'];

/**
 * Validate the arguments of a manage_map_event preset before anything is written. Throws for
 * references that do not exist (a missing map, troop, item, switch); returns warnings for
 * placements that are legal but probably wrong (a wall tile, an occupied tile).
 */
export async function checkEventPreset(projectPath: string, preset: string, args: Record<string, unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const spot = (x: unknown, y: unknown, label: string, needsStandable: boolean) =>
    spotWarnings(projectPath, args.mapId, x, y, label, needsStandable).then((found) => warnings.push(...found));
  switch (preset) {
    case 'npc': case 'inn':
      await spot(args.x, args.y, 'Event position', true);
      break;
    case 'chest':
      await spot(args.x, args.y, 'Event position', true);
      if (Array.isArray(args.items)) {
        for (const entry of args.items as Array<Record<string, unknown>>) {
          const file = ITEM_FILES[String(entry?.type)];
          if (file) await requireEntry(projectPath, file, entry.id, String(entry.type));
        }
      }
      break;
    case 'shop':
      await spot(args.x, args.y, 'Event position', true);
      if (Array.isArray(args.goods)) {
        for (const good of args.goods as unknown[][]) {
          if (Array.isArray(good) && num(good[0]) && GOOD_FILES[good[0]]) {
            await requireEntry(projectPath, GOOD_FILES[good[0]], good[1], GOOD_FILES[good[0]].replace('s.json', ''));
          }
        }
      }
      break;
    case 'boss':
      await spot(args.x, args.y, 'Event position', true);
      await requireEntry(projectPath, 'Troops.json', args.troopId, 'Troop');
      break;
    case 'teleport':
      await spot(args.x, args.y, 'Event position', true);
      warnings.push(...await destinationWarnings(projectPath, args));
      break;
    case 'door':
      // an action-button door normally sits on a wall tile, so only occupancy is checked
      await spot(args.x, args.y, 'Event position', false);
      warnings.push(...await destinationWarnings(projectPath, args));
      await checkSwitch(projectPath, args.lockedSwitchId, 'lockedSwitchId');
      break;
    case 'puzzle_switch':
      await spot(args.switchX, args.switchY, 'Switch position', true);
      await spot(args.doorX, args.doorY, 'Door position', false);
      await checkSwitch(projectPath, args.gameSwitchId, 'gameSwitchId');
      break;
    default:
      break;
  }
  return warnings;
}
