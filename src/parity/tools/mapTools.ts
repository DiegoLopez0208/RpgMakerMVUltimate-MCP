import { z } from 'zod';
import {
  readJsonFile,
  readJsonArraySoft,
  getMapPath,
  getDataPath,
  fileExists,
} from '../utils/fileHandler.js';
import { commitChange, commitDelete } from '../utils/commit.js';
import {
  MapData,
  MapEvent,
  MapInfo,
  EventCommand,
  EventPage,
  Encounter,
  Tileset,
} from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { validateEvent, ValidationWarning } from '../validation/eventCommands.js';
import { PreCommit, writeGate } from '../validation/gate.js';
import { spliceIntoList } from '../events/commandBuilders.js';
import { layeredPassability } from '../tiles/tileFlags.js';
import { assertLayerTileValue } from '../tiles/tileCodec.js';
import { assertMvCompatibility } from '../../utils/eventCommandValidation.js';
import { refExists } from '../validation/references.js';
import { summarizeEventResult, summarizeMapResult } from '../utils/responseSummary.js';

/** Dimensions the RPG Maker MV editor defaults to when creating a new map. */
const DEFAULT_MAP_WIDTH = 17;
const DEFAULT_MAP_HEIGHT = 13;

/**
 * The pre-commit gate every event-writing tool installs: validate the event that
 * is *about* to be written, refuse the write outright if it is structurally
 * malformed (unless `force`), and keep any advisory findings for the response.
 *
 * Reachability is folded in here rather than checked by the caller afterwards
 * because it, too, is block-worthy — an action-button page that can never fire
 * is a dead event, not a style note. The advisory invisible-wall check rides
 * along on the same passability lookup.
 */
export function eventWriteGate(
  projectPath: string,
  mapId: number,
  force: boolean | undefined,
  extra: ValidationWarning[] = [],
): ReturnType<typeof writeGate<MapEvent>> {
  return writeGate<MapEvent>(force, `event on map ${mapId}`, async (event) => [
    ...extra,
    ...validateEvent(event).warnings,
    ...(await eventPassabilityWarnings(projectPath, mapId, event)),
  ]);
}

/**
 * Trim a freshly-created event down to a confirmation summary for a tool
 * response. The full event echoes every default field of every page (hundreds
 * of tokens even for a bare NPC), yet the caller already knows what it sent and
 * can re-read specifics with get_map_event — so return just id/name/position and
 * a page count. Validation warnings are still computed from the *full* event by
 * the caller before the event is summarized.
 */
export function summarizeCreatedEvent(event: MapEvent): {
  id: number;
  name: string;
  x: number;
  y: number;
  pageCount: number;
} {
  return {
    id: event.id,
    name: event.name,
    x: event.x,
    y: event.y,
    pageCount: event.pages.length,
  };
}

/**
 * Whether a map cell is walkable — any of its four directions passable, per the
 * engine's layered `checkPassage` over the cell's stacked tile flags.
 */
export type CellWalkable = (x: number, y: number) => boolean;

/**
 * Build a {@link CellWalkable} lookup for a map from its tileset flags, or
 * `null` when that can't be answered (no tileset, a bare fixture, an unreadable
 * `Tilesets.json`). Every passability-based event check fails soft on `null` —
 * an unanswerable check must never block or warn.
 */
export async function loadCellWalkable(
  projectPath: string,
  map: MapData,
): Promise<CellWalkable | null> {
  let tileset: Tileset | null | undefined;
  try {
    const tilesets = await readJsonFile<(Tileset | null)[]>(
      getDataPath(projectPath, 'Tilesets.json'),
    );
    tileset = tilesets.find((t) => t && t.id === map.tilesetId);
  } catch {
    return null;
  }
  if (!tileset || !Array.isArray(tileset.flags) || !Array.isArray(map.data)) return null;
  const flags = tileset.flags;
  return (x, y) => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    const stackFlags: number[] = [];
    for (let z = 3; z >= 0; z--) {
      const tileId = map.data[tileIndex(map.width, map.height, x, y, z)] || 0;
      stackFlags.push(flags[tileId] ?? 0);
    }
    const passable = layeredPassability(stackFlags);
    return passable.down || passable.left || passable.right || passable.up;
  };
}

/**
 * Whether a map cell has a drawn upper-layer object — a non-zero tile on layer 2
 * or 3 (the B–E sheets) — i.e. something visible sits there even when the
 * event on it has no graphic.
 */
export type CellHasObject = (x: number, y: number) => boolean;

/** A {@link CellHasObject} lookup over a map's upper tile layers (2 and 3). */
export function cellHasObject(map: MapData): CellHasObject {
  return (x, y) => {
    if (!Array.isArray(map.data) || x < 0 || y < 0 || x >= map.width || y >= map.height) {
      return false;
    }
    return [2, 3].some((z) => (map.data[tileIndex(map.width, map.height, x, y, z)] || 0) !== 0);
  };
}

/**
 * Flag an event with an action-button page drawn with priority "below
 * characters" (0) while the event's tile is impassable. Such a page fires only
 * when the player STANDS ON the tile — impossible on a blocked cell — so the
 * event (a !Door on a wall, an entrance trigger on a solid landmark) can never
 * fire at all. Priority "same as characters" (1) triggers from facing, which is
 * what these events want.
 *
 * Structural (`severity: 'error'`): the event is dead on arrival, which is
 * essentially never intended, so the write is refused unless forced. Pure; the
 * caller supplies whether the event's cell is walkable.
 */
export function actionButtonReachabilityFindings(
  event: MapEvent,
  walkable: boolean,
): ValidationWarning[] {
  if (walkable) return [];
  const affected = (event.pages ?? []).some(
    (p) => p && p.trigger === 0 && p.priorityType === 0 && (p.list?.length ?? 0) > 1,
  );
  if (!affected) return [];
  return [
    {
      path: `event ${event.id} / pages`,
      severity: 'error',
      message: `action-button page with priority "below characters" sits on an impassable tile (${event.x}, ${event.y}) — it only fires when the player stands on it, which is impossible there, so it can never trigger; use priorityType 1 (same as characters) so it fires from facing (doors, entrances, signs)`,
    },
  ];
}

/** True when a page has no activation condition at all (it is always eligible). */
function isUnconditionalPage(page: EventPage): boolean {
  const c = page.conditions;
  if (!c) return true;
  return !(
    c.actorValid ||
    c.itemValid ||
    c.selfSwitchValid ||
    c.switch1Valid ||
    c.switch2Valid ||
    c.variableValid
  );
}

/**
 * Flag every page of an event that is an *invisible wall*: no graphic
 * (`characterName` empty and `tileId` 0), priority "same as characters" (1) and
 * `through` off, while the event sits on a walkable tile. The engine still
 * treats such a page as a solid character, so the player bumps into nothing —
 * the classic way this ships is a cutscene NPC's blanked "after" page parked on
 * a doorway, sealing the map.
 *
 * Only *reachable* pages count: the engine runs the highest-numbered page whose
 * conditions hold, so a page followed by any unconditional page can never be
 * active and is skipped. An action-button page on a cell with a drawn
 * upper-layer object (`onObject`) is skipped too: that is the solid-landmark
 * idiom — a passable B/C landmark tile made solid on purpose by the event, so
 * nothing about it is invisible. Touch/autorun/parallel pages there are still
 * flagged. Advisory (`severity: 'warning'`) — an invisible blocker can be
 * deliberate ("you can't leave yet"), so this never refuses a write. Pure; the
 * caller supplies whether the event's cell is walkable and has a drawn object.
 */
export function invisibleWallFindings(
  event: MapEvent,
  walkable: boolean,
  onObject = false,
): ValidationWarning[] {
  if (!walkable || !Array.isArray(event.pages)) return [];
  const pages = event.pages;
  const warnings: ValidationWarning[] = [];
  pages.forEach((page, i) => {
    if (!page) return;
    const image = page.image;
    const hasGraphic = !!image && (!!image.characterName || (image.tileId ?? 0) !== 0);
    if (hasGraphic || page.priorityType !== 1 || page.through) return;
    if (onObject && page.trigger === 0) return;
    if (pages.slice(i + 1).some((later) => later && isUnconditionalPage(later))) return;
    warnings.push({
      path: `event ${event.id} / page ${i}`,
      severity: 'warning',
      message: `event ${event.id} "${event.name}" page ${i + 1} (index ${i}) is an invisible wall at (${event.x}, ${event.y}): no graphic, priority "same", on a walkable tile — use priority "below" (priorityType 0) or through: true if it should be walked past`,
    });
  });
  return warnings;
}

/**
 * Every passability-based finding for one event — action-button reachability
 * (blocking) + invisible wall (advisory) — given a map's walkability lookup and,
 * optionally, its drawn-object lookup. A `null` walkability lookup yields
 * nothing (fail soft). Shared by the write gate and the read-only
 * `validate_event`/`validate_project` audits.
 */
export function eventPassabilityFindings(
  event: MapEvent,
  walkable: CellWalkable | null,
  hasObject?: CellHasObject | null,
): ValidationWarning[] {
  if (!walkable || !event) return [];
  const onWalkable = walkable(event.x, event.y);
  return [
    ...actionButtonReachabilityFindings(event, onWalkable),
    ...invisibleWallFindings(event, onWalkable, hasObject?.(event.x, event.y) ?? false),
  ];
}

/**
 * {@link eventPassabilityFindings} for an event about to be written, resolving
 * its cell's walkability from the map + tileset. Fails soft on any *read*
 * problem (e.g. a bare fixture with no tileset) — an unanswerable check must
 * never block.
 */
export async function eventPassabilityWarnings(
  projectPath: string,
  mapId: number,
  event: MapEvent,
): Promise<ValidationWarning[]> {
  // Skip the map + tileset read when no page could trip either check.
  const candidate =
    eventPassabilityFindings(event, () => true).length > 0 ||
    eventPassabilityFindings(event, () => false).length > 0;
  if (!candidate) return [];
  try {
    const map = await getMap(projectPath, mapId);
    return eventPassabilityFindings(
      event,
      await loadCellWalkable(projectPath, map),
      cellHasObject(map),
    );
  } catch {
    return [];
  }
}

/**
 * Get map data by ID
 */
export async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  const mapPath = getMapPath(projectPath, mapId);
  try {
    return await readJsonFile<MapData>(mapPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT/.test(String(error))) {
      throw new Error(`Map ${mapId} does not exist`);
    }
    throw error;
  }
}

/**
 * Get all map info
 */
export async function getMapInfos(projectPath: string): Promise<(MapInfo | null)[]> {
  const mapInfosPath = getDataPath(projectPath, 'MapInfos.json');
  return await readJsonFile<(MapInfo | null)[]>(mapInfosPath);
}

/**
 * Build a blank MapData mirroring what the RPG Maker MV editor writes for a
 * freshly-created map: every tile zeroed (unpainted) across all 6 layers and no
 * events. Field order matches the editor's own output so round-tripped files
 * stay tidy. Kept pure (no I/O) so the template shape can be unit-tested.
 */
export function blankMapData(width: number, height: number, tilesetId: number): MapData {
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    battleback1Name: '',
    battleback2Name: '',
    bgm: { name: '', pan: 0, pitch: 100, volume: 90 },
    bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
    disableDashing: false,
    displayName: '',
    encounterList: [],
    encounterStep: 30,
    height,
    note: '',
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxName: '',
    parallaxShow: true,
    parallaxSx: 0,
    parallaxSy: 0,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId,
    width,
    data: new Array(width * height * 6).fill(0),
    events: [],
  };
}

/**
 * Create a new map: write a fresh `data/MapNNN.json` and register it in the map
 * tree (`data/MapInfos.json`). Allocates the next unused map id, appends a tree
 * entry, and lays down a blank (all-tiles-zeroed) map of the given size.
 *
 * Both files are written through the commit choke point, so a dry-run previews
 * the new map file *and* the MapInfos entry together. Does not touch
 * `System.json`: the editor's map tree is driven entirely by MapInfos, so a new
 * entry is enough for the editor to see the map (`System.editMapId` only tracks
 * which map is open on launch).
 */
export async function createMap(
  projectPath: string,
  options: {
    name: string;
    width?: number;
    height?: number;
    parentId?: number;
    tilesetId?: number;
  },
): Promise<{ mapId: number; mapInfo: MapInfo; map: MapData }> {
  const width = options.width ?? DEFAULT_MAP_WIDTH;
  const height = options.height ?? DEFAULT_MAP_HEIGHT;
  const tilesetId = options.tilesetId ?? 1;
  const parentId = options.parentId ?? 0;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Map dimensions must be positive integers (got ${width}x${height})`);
  }

  const infos = await getMapInfos(projectPath);

  // A non-root parent must point at an existing map, or the map is orphaned in
  // the tree.
  if (parentId !== 0 && !infos[parentId]) {
    throw new Error(`parentId ${parentId} does not match any existing map`);
  }

  // A bad tilesetId renders as a black map at runtime; validate it against
  // Tilesets.json (loaded fail-soft — skip the check if the file is missing).
  const tilesets = await readJsonArraySoft<Tileset>(getDataPath(projectPath, 'Tilesets.json'));
  if (tilesets.length > 0 && !tilesets[tilesetId]) {
    throw new Error(`tilesetId ${tilesetId} does not match any existing tileset`);
  }

  // Allocate a fresh id: one past the highest existing map id. MapInfos is a
  // 1-indexed array whose slot 0 is null.
  const maxId = infos.reduce((max, info) => (info && info.id > max ? info.id : max), 0);
  const newId = maxId + 1;

  // Guard: never clobber an existing MapNNN.json. With correct id allocation the
  // file should be genuinely unused; a collision means the tree and the files on
  // disk are out of sync, which we surface rather than silently overwrite.
  const mapPath = getMapPath(projectPath, newId);
  if (await fileExists(mapPath)) {
    throw new Error(
      `Map file for id ${newId} already exists though the id is unused in MapInfos — refusing to overwrite (${mapPath})`,
    );
  }

  const maxOrder = infos.reduce((max, info) => (info && info.order > max ? info.order : max), 0);
  const mapInfo: MapInfo = {
    id: newId,
    expanded: false,
    name: options.name,
    order: maxOrder + 1,
    parentId,
    scrollX: 0,
    scrollY: 0,
  };
  infos[newId] = mapInfo;

  const map = blankMapData(width, height, tilesetId);

  // Write the map file first, then register it in the tree — both through the
  // commit choke point so dry-run previews both writes.
  await commitChange(mapPath, map);
  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);

  return { mapId: newId, mapInfo, map };
}

/**
 * Delete a map: remove its entry from the map tree (`data/MapInfos.json`) and
 * delete its `data/MapNNN.json` file. Any child maps are **reparented** to the
 * deleted map's own parent rather than deleted with it — so a whole town/dungeon
 * sub-tree isn't wiped by removing one node. Both the tree rewrite and the file
 * deletion go through the commit choke point, so a dry-run previews the tree
 * change and the file removal together.
 *
 * Does not touch `System.json`; if the deleted map happens to be the editor's
 * open/start map that reference is left dangling (the editor tolerates it), same
 * hands-off stance `create_map` takes toward `System.json`.
 */
export async function deleteMap(
  projectPath: string,
  mapId: number,
): Promise<{
  mapId: number;
  reparentedTo: number;
  reparentedChildren: number[];
  warnings?: string[];
}> {
  const infos = await getMapInfos(projectPath);

  const target = infos[mapId];
  if (!target) {
    throw new Error(`Map ${mapId} does not exist in the map tree`);
  }

  // Warn (don't block) on references that will dangle once the map is gone: the
  // game start map and any direct Transfer Player (201) that targets it. Deletion
  // still proceeds — this mirrors the documented hands-off stance, just surfaced.
  const warnings = await danglingMapReferences(projectPath, mapId, infos);

  // Reparent the deleted map's direct children onto its parent so they aren't
  // orphaned (parentId pointing at a now-gone map).
  const reparentedTo = target.parentId;
  const reparentedChildren: number[] = [];
  for (const info of infos) {
    if (info && info.parentId === mapId) {
      info.parentId = reparentedTo;
      reparentedChildren.push(info.id);
    }
  }

  // Drop the tree entry, preserving the 1-indexed array shape (slot -> null).
  infos[mapId] = null;

  // Rewrite the tree, then delete the map file — both via the commit choke
  // point so dry-run previews both operations.
  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);
  await commitDelete(getMapPath(projectPath, mapId));

  return {
    mapId,
    reparentedTo,
    reparentedChildren,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Collect references that would dangle after `mapId` is deleted: the game start
 * map (`System.startMapId`), and any *direct* Transfer Player (201) command —
 * across every other map's events, common events, and troop pages — that targets
 * it. Variable-designated transfers can't be resolved statically, so they're
 * skipped. Read-only; each file loads fail-soft so a partial project can't break
 * the delete.
 */
async function danglingMapReferences(
  projectPath: string,
  mapId: number,
  infos: (MapInfo | null)[],
): Promise<string[]> {
  const warnings: string[] = [];

  try {
    const sys = await readJsonFile<{ startMapId?: number }>(
      getDataPath(projectPath, 'System.json'),
    );
    if (sys.startMapId === mapId) {
      warnings.push(
        `map ${mapId} is the game start map (System.startMapId) — update it after deleting`,
      );
    }
  } catch {
    // System.json missing/unreadable — skip the start-map check.
  }

  const scanList = (list: unknown, where: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((cmd, i) => {
      if (!cmd || !Array.isArray(cmd.parameters)) return;
      if (cmd.code === 201 && cmd.parameters[0] === 0 && cmd.parameters[1] === mapId) {
        warnings.push(`Transfer Player at ${where} / command ${i} targets map ${mapId}`);
      }
    });
  };

  for (const info of infos) {
    if (!info || info.id === mapId) continue;
    let map: MapData;
    try {
      map = await readJsonFile<MapData>(getMapPath(projectPath, info.id));
    } catch {
      continue;
    }
    for (const event of map.events ?? []) {
      if (!event || !Array.isArray(event.pages)) continue;
      event.pages.forEach((page, pi) =>
        scanList(page?.list, `map ${info.id} / event ${event.id} / page ${pi}`),
      );
    }
  }

  const commonEvents = await readJsonArraySoft<{ id: number; list?: unknown }>(
    getDataPath(projectPath, 'CommonEvents.json'),
  );
  commonEvents.forEach((ce) => {
    if (ce) scanList(ce.list, `common event ${ce.id}`);
  });

  const troops = await readJsonArraySoft<{ id: number; pages?: { list?: unknown }[] }>(
    getDataPath(projectPath, 'Troops.json'),
  );
  troops.forEach((troop) => {
    if (!troop || !Array.isArray(troop.pages)) return;
    troop.pages.forEach((page, pi) => scanList(page?.list, `troop ${troop.id} / page ${pi}`));
  });

  return warnings;
}

/** A single map-tree edit: reparent, reorder, rename, or expand/collapse a map. */
export interface MapTreeUpdate {
  mapId: number;
  parentId?: number;
  order?: number;
  name?: string;
  expanded?: boolean;
}

/**
 * Walk each map's parent chain to the root, throwing if a cycle is found (a map
 * that is transitively its own ancestor). Catches self-parenting and longer
 * loops that would otherwise make the editor's tree render infinitely.
 */
function assertNoTreeCycles(infos: (MapInfo | null)[]): void {
  for (const start of infos) {
    if (!start) continue;
    const seen = new Set<number>([start.id]);
    let parentId = start.parentId;
    while (parentId !== 0) {
      if (seen.has(parentId)) {
        throw new Error(`Map tree cycle detected involving map ${start.id}`);
      }
      seen.add(parentId);
      const parent = infos[parentId];
      if (!parent) break;
      parentId = parent.parentId;
    }
  }
}

/**
 * Edit the map tree (`data/MapInfos.json`) without touching any map's tiles or
 * events: reparent (move under a different node / to the top level), reorder
 * siblings, rename, or expand/collapse. Applies a batch of per-map updates, then
 * validates the whole tree stays acyclic before committing. Every referenced map
 * (and any non-zero `parentId`) must already exist.
 */
export async function updateMapTree(
  projectPath: string,
  updates: MapTreeUpdate[],
): Promise<{ updated: MapInfo[] }> {
  const infos = await getMapInfos(projectPath);

  // Validate every target exists before mutating anything, so a bad update in
  // the batch can't leave a partially-applied tree.
  for (const update of updates) {
    if (!infos[update.mapId]) {
      throw new Error(`Map ${update.mapId} does not exist in the map tree`);
    }
    if (update.parentId !== undefined) {
      if (update.parentId === update.mapId) {
        throw new Error(`Map ${update.mapId} cannot be its own parent`);
      }
      if (update.parentId !== 0 && !infos[update.parentId]) {
        throw new Error(`parentId ${update.parentId} does not match any existing map`);
      }
    }
  }

  const updated: MapInfo[] = [];
  for (const update of updates) {
    const info = infos[update.mapId]!;
    if (update.parentId !== undefined) info.parentId = update.parentId;
    if (update.order !== undefined) info.order = update.order;
    if (update.name !== undefined) info.name = update.name;
    if (update.expanded !== undefined) info.expanded = update.expanded;
    updated.push(info);
  }

  // A reparent can introduce a cycle (A under B, B under A); reject before write.
  assertNoTreeCycles(infos);

  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);

  return { updated };
}

/**
 * Update map properties. Refuses a width/height change: those would desync the
 * flat `data` tile array (sized `width*height*6`) without repadding it. Use
 * {@link resizeMap} for that.
 */
export async function updateMap(
  projectPath: string,
  mapId: number,
  updates: Partial<MapData>,
): Promise<MapData> {
  const map = await getMap(projectPath, mapId);

  // A width/height change here would NOT resize the tile `data` array, silently
  // desyncing the grid — the engine reads tiles by (layer*height + y)*width + x,
  // so a mismatched width/height reads garbage or out of bounds. Reject it (so
  // it can't half-apply) and point at resize_map, which repads every z-layer.
  if (
    (updates.width !== undefined && updates.width !== map.width) ||
    (updates.height !== undefined && updates.height !== map.height)
  ) {
    throw new Error(
      'update_map cannot change a map width/height (it does not resize the tile data array). Use resize_map instead.',
    );
  }

  // `data` and `events` bypass the dedicated tools' invariants: a wrong-length
  // `data` array desyncs the grid (the exact thing this tool guards width/height
  // against), and a raw `events` array skips event validation and id conventions.
  if (updates.data !== undefined) {
    throw new Error(
      'update_map cannot set the tile data array. Use paint_tiles/fill_area/set_map_tile (or resize_map to change dimensions).',
    );
  }
  if (updates.events !== undefined) {
    throw new Error(
      'update_map cannot set the events array. Use create_map_event/update_map_event/delete_map_event.',
    );
  }

  const updatedMap = { ...map, ...updates };

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, updatedMap);

  return updatedMap;
}

/**
 * Rebuild a map's flat tile `data` array for new dimensions, preserving each
 * z-layer's tiles where the old and new grids overlap and zero-filling any
 * newly-exposed cells (cropping when a dimension shrinks). RPG Maker MV packs
 * the 6 z-layers contiguously into one `width*height*6` array indexed by
 * `(layer*height + y)*width + x`, so a plain width/height swap misaligns every
 * layer — this copies cell-by-cell into a freshly-sized array. Pure (no I/O) so
 * the repadding math can be unit-tested.
 */
export function resizeMapData(
  oldData: number[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
): number[] {
  const LAYERS = 6;
  const newData: number[] = new Array(newWidth * newHeight * LAYERS).fill(0);
  const copyWidth = Math.min(oldWidth, newWidth);
  const copyHeight = Math.min(oldHeight, newHeight);
  for (let layer = 0; layer < LAYERS; layer++) {
    for (let y = 0; y < copyHeight; y++) {
      for (let x = 0; x < copyWidth; x++) {
        const oldIndex = (layer * oldHeight + y) * oldWidth + x;
        const newIndex = (layer * newHeight + y) * newWidth + x;
        newData[newIndex] = oldData[oldIndex];
      }
    }
  }
  return newData;
}

/**
 * Resize an existing map to new width/height, repadding every z-layer of its
 * tile `data` array (see {@link resizeMapData}) so the grid stays in sync — the
 * safe path `update_map` refuses. Existing tiles are kept where the grids
 * overlap; shrinking crops the excess. Warns (warn-by-default, never blocks)
 * about any event now left outside the new bounds so the caller can move or
 * remove it. Writes through the commit choke point (dry-run/diff aware).
 */
export async function resizeMap(
  projectPath: string,
  mapId: number,
  width: number,
  height: number,
): Promise<{
  mapId: number;
  width: number;
  height: number;
  previousWidth: number;
  previousHeight: number;
  warnings?: string[];
}> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Map dimensions must be positive integers (got ${width}x${height})`);
  }

  const map = await getMap(projectPath, mapId);
  const previousWidth = map.width;
  const previousHeight = map.height;

  map.data = resizeMapData(map.data, previousWidth, previousHeight, width, height);
  map.width = width;
  map.height = height;

  // Shrinking can leave events outside the new grid. They aren't deleted (the
  // caller may want to reposition them), just flagged.
  const warnings: string[] = [];
  for (const event of map.events) {
    if (event && (event.x >= width || event.y >= height)) {
      warnings.push(
        `Event ${event.id} "${event.name}" at (${event.x},${event.y}) is now outside the ${width}x${height} map bounds`,
      );
    }
  }

  // If this is the game's start map, shrinking can push the player's starting
  // position off the grid — the party would spawn out of bounds. Read System.json
  // fail-soft (a bare fixture may not have startX/Y); never throw over it.
  try {
    const sys = await readJsonFile<{ startMapId?: number; startX?: number; startY?: number }>(
      getDataPath(projectPath, 'System.json'),
    );
    if (sys.startMapId === mapId && ((sys.startX ?? 0) >= width || (sys.startY ?? 0) >= height)) {
      warnings.push(
        `Start position (${sys.startX ?? 0},${sys.startY ?? 0}) on this start map is now outside the ${width}x${height} map bounds — update it with update_starting_position`,
      );
    }
  } catch {
    // System.json missing/unreadable — skip the start-position check.
  }

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  const result = { mapId, width, height, previousWidth, previousHeight };
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/**
 * Set a map's random-encounter list (and optionally its `encounterStep`, the
 * average number of steps between encounters). Replaces `encounterList` wholesale
 * with the given troops — each entry is `{ troopId, weight?, regionSet? }` where
 * `weight` biases the random pick (editor default 5) and `regionSet` restricts the
 * encounter to those map region ids (empty = anywhere). Every `troopId` is
 * validated to exist in Troops.json (throws otherwise, matching create_troop's
 * enemy check), so a bad troop can't sail through the way it does via update_map's
 * raw field-poking. Writes through the commit choke point (dry-run/diff aware).
 */
export async function setEncounters(
  projectPath: string,
  mapId: number,
  encounters: Array<{ troopId: number; weight?: number; regionSet?: number[] }>,
  encounterStep?: number,
): Promise<{ mapId: number; encounterList: Encounter[]; encounterStep: number }> {
  const troops = await readJsonArraySoft(getDataPath(projectPath, 'Troops.json'));

  const encounterList: Encounter[] = encounters.map((e, i) => {
    // Skip the check only when Troops.json couldn't be loaded at all (fail-soft),
    // so a real project always validates the troopId.
    if (troops.length > 0 && !refExists(troops, e.troopId)) {
      throw new Error(`Encounter ${i} references troopId ${e.troopId}, which does not exist`);
    }
    return {
      troopId: e.troopId,
      weight: e.weight ?? 5,
      regionSet: e.regionSet ?? [],
    };
  });

  const map = await getMap(projectPath, mapId);
  map.encounterList = encounterList;
  if (encounterStep !== undefined) map.encounterStep = encounterStep;

  await commitChange(getMapPath(projectPath, mapId), map);
  return { mapId, encounterList, encounterStep: map.encounterStep };
}

/**
 * Get events from a specific map
 */
export async function getMapEvents(
  projectPath: string,
  mapId: number,
): Promise<(MapEvent | null)[]> {
  const map = await getMap(projectPath, mapId);
  return map.events;
}

/**
 * Get a specific event from a map
 */
export async function getMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<MapEvent | null> {
  const events = await getMapEvents(projectPath, mapId);
  return events[eventId] || null;
}

/**
 * Update a map event
 */
export async function updateMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
  updates: Partial<MapEvent>,
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }

  // Normalize any supplied pages onto a blank page (same as create_map_event):
  // a partial page taken raw would be missing engine-required fields and crash
  // on load (the class of bug Phase 6.1 fixed for actors).
  const normalized: Partial<MapEvent> = { ...updates };
  if (updates.pages !== undefined) {
    normalized.pages = updates.pages.map((page) => normalizeEventPage(page as Partial<EventPage>));
  }

  const nextX = normalized.x ?? map.events[eventId]!.x;
  const nextY = normalized.y ?? map.events[eventId]!.y;
  if (nextX < 0 || nextX >= map.width || nextY < 0 || nextY >= map.height) {
    throw new Error(`Event position (${nextX}, ${nextY}) is out of map bounds`);
  }

  map.events[eventId] = { ...map.events[eventId]!, ...normalized, id: eventId };

  for (const page of map.events[eventId]!.pages) assertMvCompatibility(page.list);
  await precommit?.(map.events[eventId]!);

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return map.events[eventId]!;
}

/**
 * Build a blank event page mirroring what the RPG Maker MV editor writes for a
 * freshly-created event: no graphic, an empty (code-0-terminated) command list,
 * action-button trigger, priority below characters, and default movement. Field
 * values verified against the editor's own output. Pure so the template can be
 * unit-tested and reused (by `create_npc` and `normalizeEventPage`).
 */
export function blankEventPage(): EventPage {
  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: 'A',
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { characterName: '', characterIndex: 0, direction: 2, pattern: 0, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
  };
}

/**
 * Merge a partial event page onto a blank page so a caller can specify only the
 * fields that differ from the editor's "New Event" default. Top-level fields
 * overwrite; the nested `image` and `conditions` objects deep-merge (so passing
 * just `image.characterName` keeps the other graphic defaults). `list` and
 * `moveRoute`, when omitted, fall back to the blank page's (a valid code-0
 * terminated list / route). A page passed in full round-trips unchanged, so this
 * is safe for callers like `create_npc` that already build a complete page.
 */
export function normalizeEventPage(partial: Partial<EventPage>): EventPage {
  const blank = blankEventPage();
  return {
    ...blank,
    ...partial,
    conditions: { ...blank.conditions, ...(partial.conditions ?? {}) },
    image: { ...blank.image, ...(partial.image ?? {}) },
    list: partial.list ?? blank.list,
    moveRoute: partial.moveRoute ?? blank.moveRoute,
  };
}

/**
 * Create a new event on a map. Each supplied page is merged onto a blank page
 * (see {@link normalizeEventPage}), so a caller can pass a partial page — only the
 * fields that differ from the editor's "New Event" default — without needing the
 * full RPG Maker page schema. An event with no pages gets one blank page.
 */
export async function createMapEvent(
  projectPath: string,
  mapId: number,
  eventData: Omit<MapEvent, 'id' | 'pages'> & { pages?: Partial<EventPage>[] },
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  // Find the next available event ID
  const maxId = map.events.reduce((max, event, index) => {
    return event && index > max ? index : max;
  }, 0);

  const suppliedPages = eventData.pages ?? [];
  const pages = suppliedPages.length ? suppliedPages.map(normalizeEventPage) : [blankEventPage()];

  // Spread first so the computed id always wins, even if a caller passes one.
  const newEvent: MapEvent = {
    ...eventData,
    pages,
    id: maxId + 1,
  };

  map.events[maxId + 1] = newEvent;

  for (const page of newEvent.pages) assertMvCompatibility(page.list);
  await precommit?.(newEvent);

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return newEvent;
}

/**
 * Scan a map's remaining events for command parameters that reference the given
 * (about-to-be-deleted) event id, so the caller can be warned about pages that
 * will point at a now-gone event. Covers the commands whose parameter carries an
 * event id: Set Event Location (203), Show Animation (212), Show Balloon (213),
 * and forced Set Movement Route (205). For 212/213/205 the character id follows
 * the -1 player / 0 this event / N event id convention, so only a value === the
 * deleted id **and > 0** is a real reference. Pure (no I/O); warn-only.
 */
export function eventReferenceWarnings(events: (MapEvent | null)[], deletedId: number): string[] {
  const warnings: string[] = [];
  for (const event of events) {
    if (!event || event.id === deletedId || !Array.isArray(event.pages)) continue;
    event.pages.forEach((page, pi) => {
      const list = page?.list;
      if (!Array.isArray(list)) return;
      for (const cmd of list) {
        if (!cmd || !Array.isArray(cmd.parameters)) continue;
        // Set Event Location: parameters[0] is the moved event's id (>0).
        // 212/213/205: parameters[0] is a characterId (-1 player/0 this event/N).
        const target =
          cmd.code === 203
            ? cmd.parameters[0]
            : cmd.code === 212 || cmd.code === 213 || cmd.code === 205
              ? cmd.parameters[0]
              : undefined;
        if (target === deletedId && deletedId > 0) {
          const what =
            cmd.code === 203
              ? 'Set Event Location'
              : cmd.code === 212
                ? 'Show Animation'
                : cmd.code === 213
                  ? 'Show Balloon'
                  : 'Set Movement Route';
          warnings.push(
            `Event ${event.id} "${event.name}" page ${pi} has a ${what} command (code ${cmd.code}) referencing deleted event ${deletedId}`,
          );
        }
      }
    });
  }
  return warnings;
}

/**
 * Delete an event from a map. Warns (never blocks) when other events' pages still
 * reference the deleted event id via Set Event Location / Show Animation / Show
 * Balloon / forced Set Movement Route (see {@link eventReferenceWarnings}).
 */
export async function deleteMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<{ success: boolean; warnings?: string[] }> {
  const map = await getMap(projectPath, mapId);

  // Mutators throw on a missing target (consistent with delete_map / update_map_event);
  // getters are the ones that return null.
  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }

  // Scan the other events BEFORE nulling the slot so the reference warnings see
  // the full event set (they already skip the deleted id anyway).
  const warnings = eventReferenceWarnings(map.events, eventId);

  map.events[eventId] = null;

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return warnings.length > 0 ? { success: true, warnings } : { success: true };
}

/**
 * Search events by name
 */
export async function searchMapEvents(
  projectPath: string,
  mapId: number,
  searchTerm: string,
): Promise<MapEvent[]> {
  const events = await getMapEvents(projectPath, mapId);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return events.filter(
    (event) => event && event.name.toLowerCase().includes(lowerSearchTerm),
  ) as MapEvent[];
}

/**
 * Add a command to an event page
 */
export async function addEventCommand(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  command: EventCommand,
  position?: number,
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }

  const event = map.events[eventId]!;

  if (!event.pages[pageIndex]) {
    throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
  }

  // add_event_command is the single-command case of the shared splice path.
  spliceIntoList(event.pages[pageIndex].list, [command], position);

  for (const page of event.pages) assertMvCompatibility(page.list);
  await precommit?.(event);

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return event;
}

/**
 * Get map dimensions
 */
export async function getMapDimensions(
  projectPath: string,
  mapId: number,
): Promise<{ width: number; height: number }> {
  const map = await getMap(projectPath, mapId);
  return {
    width: map.width,
    height: map.height,
  };
}

/**
 * Read the raw tile ids in a rectangular window of one z-layer — a token-cheap
 * windowed alternative to {@link getMap} for inspecting part of a big painted map.
 * Returns `tiles` as a 2D array (rows top→bottom, each left→right). The rectangle
 * must lie fully within the map bounds (throws otherwise). Uses the pure
 * {@link tileIndex} helper for the flat-array index math. Read-only.
 */
export async function getMapRegion(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  width: number,
  height: number,
  layer: number = 0,
): Promise<{
  mapId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  tiles: number[][];
}> {
  const map = await getMap(projectPath, mapId);

  if (x < 0 || y < 0 || x + width > map.width || y + height > map.height) {
    throw new Error(
      `Region (${x}, ${y}) ${width}x${height} is out of bounds for the ${map.width}x${map.height} map`,
    );
  }

  const tiles: number[][] = [];
  for (let row = 0; row < height; row++) {
    const cols: number[] = [];
    for (let col = 0; col < width; col++) {
      cols.push(map.data[tileIndex(map.width, map.height, x + col, y + row, layer)]);
    }
    tiles.push(cols);
  }

  return { mapId, x, y, width, height, layer, tiles };
}

/**
 * Set map tile at specific position
 */
export async function setMapTile(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  layer: number,
  tileId: number,
): Promise<void> {
  assertLayerTileValue(layer, tileId);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Tile coordinates must be integers');
  const map = await getMap(projectPath, mapId);

  if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
    throw new Error(`Position (${x}, ${y}) is out of map bounds`);
  }

  // RPG Maker MV stores tiles in a 1D array with 6 layers
  // Index = (layer * height + y) * width + x
  const index = tileIndex(map.width, map.height, x, y, layer);
  map.data[index] = tileId;

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);
}

/**
 * Compute the flat `data` array index for a tile at (x, y) on a z-layer.
 *
 * RPG Maker MV stores map tiles in a single 1D array of `width * height * 6`
 * entries (6 stacked layers: 2 lower, 2 upper, shadow pen, region ID). Kept as
 * a pure function so the index math can be unit-tested without file I/O.
 */
export function tileIndex(
  width: number,
  height: number,
  x: number,
  y: number,
  layer: number,
): number {
  return (layer * height + y) * width + x;
}

export const mapToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_map',
    description:
      'Get map data by ID. The tile `data` array can be huge on a painted map (width*height*6 ints) and blow the MCP token limit, so pass includeData:false to omit it (you get dataTileCount instead) and read tiles with get_map_region when needed. includeData defaults to true for backward compatibility.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to retrieve'),
      includeData: z
        .boolean()
        .optional()
        .describe(
          'Include the full tile `data` array (default true). Pass false to omit it (returns dataTileCount) and avoid the token cost of a big painted map.',
        ),
    },
    handler: async (ctx, args) => {
      const map = await getMap(ctx.projectPath, args.mapId);
      if (args.includeData === false) {
        // Drop the large tile `data` array; report its length instead. Mirrors
        // create_map/update_map's dataTileCount echo (P2-6) so clients can inspect
        // a map's shape without paying for every tile (read tiles via get_map_region).
        const { data, ...mapWithoutData } = map;
        return { ...mapWithoutData, dataTileCount: data.length };
      }
      return map;
    },
  },
  {
    name: 'get_map_region',
    description:
      'Read the raw tile ids in a rectangular window of one map layer — a token-cheap alternative to get_map for inspecting part of a painted map. Returns `tiles` as a 2D array (rows top→bottom, each left→right) of raw engine tile ids. The rectangle must lie fully within the map bounds (throws otherwise). layer defaults to 0 (see set_map_tile for the z-layer meanings).',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      x: z.number().int().min(0).describe('Left edge of the window (tile column)'),
      y: z.number().int().min(0).describe('Top edge of the window (tile row)'),
      width: z.number().int().positive().describe('Window width in tiles'),
      height: z.number().int().positive().describe('Window height in tiles'),
      layer: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Z-layer 0-5 (0-1 lower, 2-3 upper, 4 shadow, 5 region); default 0'),
    },
    handler: (ctx, args) =>
      getMapRegion(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.width,
        args.height,
        args.layer,
      ),
  },
  {
    name: 'get_map_infos',
    description: 'Get information about all maps',
    inputSchema: {},
    handler: (ctx) => getMapInfos(ctx.projectPath),
  },
  {
    name: 'create_map',
    mutates: true,
    description:
      'Create a new blank map: writes a new data/MapNNN.json (all tiles unpainted) and registers it in the map tree (MapInfos.json). Allocates the next unused map id and returns it. Paint tiles afterward with paint_tiles/fill_area (autotile-aware) and add events with create_map_event/create_npc.',
    inputSchema: {
      name: z.string().describe('Map name shown in the editor map tree'),
      width: z.number().int().positive().optional().describe('Width in tiles (default 17)'),
      height: z.number().int().positive().optional().describe('Height in tiles (default 13)'),
      parentId: z
        .number()
        .int()
        .optional()
        .describe('Parent map id in the tree; 0 (default) = top level'),
      tilesetId: z.number().int().positive().optional().describe('Tileset id (default 1)'),
    },
    handler: async (ctx, args) => {
      const { mapId, mapInfo, map } = await createMap(ctx.projectPath, {
        name: args.name,
        width: args.width,
        height: args.height,
        parentId: args.parentId,
        tilesetId: args.tilesetId,
      });
      // Drop the large all-zero blank tile array from the response — a fresh map
      // is unpainted by definition, so echoing ~w*h*6 zeros is pure bloat (P2-6).
      // get_map returns the full `data` when it's actually needed.
      const { data, ...mapWithoutData } = map;
      return { mapId, mapInfo, map: { ...mapWithoutData, dataTileCount: data.length } };
    },
  },
  {
    name: 'delete_map',
    mutates: true,
    description:
      "Delete a map: remove its entry from the map tree (MapInfos.json) and delete its data/MapNNN.json file. The deleted map's direct children are reparented onto its parent (not deleted), so removing one node doesn't wipe a whole sub-tree. Does not touch System.json.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to delete'),
    },
    handler: (ctx, args) => deleteMap(ctx.projectPath, args.mapId),
  },
  {
    name: 'update_map_tree',
    mutates: true,
    description:
      'Edit the map tree (MapInfos.json) only — reparent, reorder, rename, or expand/collapse maps without touching their tiles or events. Takes a batch of per-map updates; every referenced map (and any non-zero parentId) must exist, and the resulting tree must stay acyclic.',
    inputSchema: {
      updates: z
        .array(
          z.object({
            mapId: z.number().int().positive().describe('The map to update'),
            parentId: z.number().int().optional().describe('New parent map id; 0 = top level'),
            order: z.number().int().optional().describe('New sort order among siblings'),
            name: z.string().optional().describe('New tree display name'),
            expanded: z.boolean().optional().describe('Whether the node is expanded in the tree'),
          }),
        )
        .describe('One or more per-map tree edits to apply together'),
    },
    handler: (ctx, args) => updateMapTree(ctx.projectPath, args.updates),
  },
  {
    name: 'get_map_events',
    description: 'Get all events from a specific map',
    inputSchema: { mapId: z.number().int().positive().describe('The ID of the map') },
    handler: (ctx, args) => getMapEvents(ctx.projectPath, args.mapId),
  },
  {
    name: 'get_map_event',
    description: 'Get a specific event from a map',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
    },
    handler: (ctx, args) => getMapEvent(ctx.projectPath, args.mapId, args.eventId),
  },
  {
    name: 'update_map_event',
    mutates: true,
    forceable: true,
    summarize: summarizeEventResult,
    description:
      "Update a map event's properties. Refuses the write (nothing is saved) if the resulting event is structurally invalid — pass force: true to override.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing event properties to update'),
    },
    handler: async (ctx, args) => {
      const gate = eventWriteGate(ctx.projectPath, args.mapId, args.force);
      const event = await updateMapEvent(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.updates,
        gate.precommit,
      );
      return gate.respond({ event });
    },
  },
  {
    name: 'create_map_event',
    mutates: true,
    forceable: true,
    description:
      'Create a new event on a map. Each page is merged onto a blank "New Event" page (trigger 0 action-button, priority 0 below characters, no graphic, empty command list, standing move type), so you only supply the fields that differ — pass e.g. `{ image: { characterName: \'Actor1\', characterIndex: 0 }, trigger: 3, list: [...] }` and the rest is filled in. Nested `image`/`conditions` deep-merge; an omitted `list` becomes a valid empty (code-0-terminated) list. Omit `pages` entirely for a bare one-page event. For the common "talking NPC" case prefer create_npc. An action-button page meant to fire from facing (doors, entrances, signs) needs `priorityType: 1` — with the default 0 (below) it only fires when stood on, so on an impassable tile it can never trigger (this is refused, not written; pass force: true to override). A structurally invalid command list is refused the same way. A page with no graphic, priority 1 and through off on a walkable tile is an invisible wall — warned (not refused); give it priority 0 or through: true if it should be walked past. Exempt: an action-button page over a drawn upper-layer (B–E) object — the solid-landmark idiom. Page fields: `image` { characterName, characterIndex, direction (2 down/4 left/6 right/8 up), pattern, tileId }, `trigger` (0 action-button/1 player-touch/2 event-touch/3 autorun/4 parallel), `priorityType` (0 below/1 same/2 above), `moveType` (0 fixed/1 random/2 approach/3 custom), `conditions`, `list`.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      name: z.string().describe('Event name'),
      x: z.number().int().min(0).describe('X tile position'),
      y: z.number().int().min(0).describe('Y tile position'),
      note: z.string().optional().describe('Event note field'),
      pages: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          'Event pages; each is merged onto a blank page so you can pass only the differing fields. Omit for one blank page.',
        ),
    },
    handler: async (ctx, args) => {
      // dryRun/force are dispatcher arguments, not event fields — strip them so
      // they can't leak into the event body via the spread below.
      const { mapId, dryRun: _dryRun, force, ...eventData } = args;
      const gate = eventWriteGate(ctx.projectPath, mapId, force);
      const event = await createMapEvent(
        ctx.projectPath,
        mapId,
        eventData as Omit<MapEvent, 'id' | 'pages'> & { pages?: Partial<EventPage>[] },
        gate.precommit,
      );
      // Return a compact summary, not the full event with every defaulted page
      // field — a huge token cost on every authoring call (re-read via get_map_event).
      return gate.respond({ event: summarizeCreatedEvent(event) });
    },
  },
  {
    name: 'search_map_events',
    description: 'Search events on a map by name',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      searchTerm: z.string().describe('The search term to find events'),
    },
    handler: (ctx, args) => searchMapEvents(ctx.projectPath, args.mapId, args.searchTerm),
  },
  {
    name: 'add_event_command',
    mutates: true,
    forceable: true,
    summarize: summarizeEventResult,
    description:
      'Add a command to an event page. Refuses the write (nothing is saved) if the resulting page is structurally invalid — e.g. the command has the wrong parameter count for its code. Pass force: true to override.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
      pageIndex: z.number().int().min(0).describe('Zero-based page index'),
      command: z
        .object({
          code: z.number().int().describe('Event command code (see RPG Maker MV documentation)'),
          indent: z.number().int().min(0).optional().default(0).describe('Indentation level'),
          parameters: z.array(z.unknown()).describe('Command parameters'),
        })
        .describe('The event command to insert'),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Insertion index; defaults to end of the list'),
    },
    handler: async (ctx, args) => {
      const gate = eventWriteGate(ctx.projectPath, args.mapId, args.force);
      const event = await addEventCommand(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.pageIndex,
        args.command,
        args.position,
        gate.precommit,
      );
      return gate.respond({ event });
    },
  },
  {
    name: 'update_map',
    mutates: true,
    summarize: summarizeMapResult,
    description:
      "Update a map's top-level properties (name, display name, bgm, encounters, etc.). Does not repaint tiles. Cannot change width/height (that would desync the tile data array) — use resize_map for that. The echo omits the tile `data` array and the `events` map (neither is touched here) and reports dataTileCount/eventCount instead; pass verbose: true or use get_map for the full record.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      updates: z.record(z.string(), z.unknown()).describe('Partial MapData properties to merge'),
    },
    handler: async (ctx, args) => {
      const map = await updateMap(ctx.projectPath, args.mapId, args.updates);
      // Drop the large tile `data` array (~w*h*6 ints) from the echo — update_map
      // never edits tiles, so returning them is pure token bloat (on a painted
      // 40x40 map it blew past the MCP token limit; the write still applied).
      // Mirrors create_map (P2-6); get_map returns the full data when needed.
      const { data, ...mapWithoutData } = map;
      return { ...mapWithoutData, dataTileCount: data.length };
    },
  },
  {
    name: 'resize_map',
    mutates: true,
    summarize: summarizeMapResult,
    description:
      "Resize a map to new width/height, safely repadding every z-layer of its tile data (existing tiles kept where the old and new grids overlap; new cells blank; shrinking crops). This is the ONLY safe way to change a map's dimensions — update_map refuses a width/height change because it would not resize the tile array. Warns about any event left outside the new bounds.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to resize'),
      width: z.number().int().positive().describe('New width in tiles'),
      height: z.number().int().positive().describe('New height in tiles'),
    },
    handler: (ctx, args) => resizeMap(ctx.projectPath, args.mapId, args.width, args.height),
  },
  {
    name: 'set_encounters',
    mutates: true,
    description:
      "Set a map's random-encounter list (replaces it wholesale) and optionally its encounterStep (average steps between encounters). Each encounter is { troopId, weight?, regionSet? }: weight biases the random pick (default 5), regionSet restricts it to those map region ids (empty/omitted = anywhere). Every troopId is validated against Troops.json — a non-existent troop throws. Prefer this over update_map for encounters (it validates and hides the on-disk shape).",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      encounters: z
        .array(
          z.object({
            troopId: z.number().int().describe('Troop id from Troops.json'),
            weight: z.number().int().optional().describe('Relative encounter weight (default 5)'),
            regionSet: z
              .array(z.number().int())
              .optional()
              .describe('Region ids this encounter is restricted to (empty = anywhere)'),
          }),
        )
        .describe('The full encounter list to set (replaces any existing entries)'),
      encounterStep: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Average number of steps between encounters (unchanged if omitted)'),
    },
    handler: (ctx, args) =>
      setEncounters(ctx.projectPath, args.mapId, args.encounters, args.encounterStep),
  },
  {
    name: 'get_map_dimensions',
    description: 'Get the width and height (in tiles) of a map',
    inputSchema: { mapId: z.number().int().positive().describe('The ID of the map') },
    handler: (ctx, args) => getMapDimensions(ctx.projectPath, args.mapId),
  },
  {
    name: 'set_map_tile',
    mutates: true,
    description:
      'Set a single raw tile ID at (x, y) on a given z-layer (0-5). Note: tile IDs are raw engine integers; this is a low-level primitive without autotile/passability awareness.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      x: z.number().int().nonnegative().describe('X tile position'),
      y: z.number().int().nonnegative().describe('Y tile position'),
      layer: z
        .number()
        .int()
        .min(0)
        .max(5)
        .describe('Z-layer 0-5 (0-1 lower, 2-3 upper, 4 shadow, 5 region)'),
      tileId: z.number().int().nonnegative().describe('Raw tile ID'),
    },
    handler: async (ctx, args) => {
      await setMapTile(ctx.projectPath, args.mapId, args.x, args.y, args.layer, args.tileId);
      return { success: true };
    },
  },
  {
    name: 'delete_map_event',
    mutates: true,
    description: 'Delete an event from a map by ID',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
    },
    handler: (ctx, args) => deleteMapEvent(ctx.projectPath, args.mapId, args.eventId),
  },
];
