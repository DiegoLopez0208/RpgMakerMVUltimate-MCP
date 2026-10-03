import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import {
  getMap,
  getMapInfos,
  getMapEvent,
  loadCellWalkable,
  cellHasObject,
  eventPassabilityFindings,
} from './mapTools.js';
import { validateEvent, validateEvents, ValidationWarning } from '../validation/eventCommands.js';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { checkReferences, ProjectData, ReferenceWarning } from '../validation/references.js';
import {
  checkAssets,
  AssetProjectData,
  AvailableAssets,
  AssetWarning,
  MvAnimationAssets,
} from '../validation/assets.js';
import { listAssets, AssetType } from './assetTools.js';
import {
  SystemData,
  MapInfo,
  Actor,
  Enemy,
  Tileset,
  Troop,
  CommonEvent,
  MapData,
} from '../utils/types.js';

/**
 * Validate a single event's command lists against the known-command table.
 * Warn-by-default: this reports problems, it never modifies anything.
 */
export async function validateEventTool(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<{ mapId: number; eventId: number; ok: boolean; warnings: ValidationWarning[] }> {
  const event = await getMapEvent(projectPath, mapId, eventId);
  if (!event) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }
  const map = await getMap(projectPath, mapId);
  const warnings = [
    ...validateEvent(event).warnings,
    ...eventPassabilityFindings(
      event,
      await loadCellWalkable(projectPath, map),
      cellHasObject(map),
    ),
  ];
  return { mapId, eventId, ok: warnings.length === 0, warnings };
}

/**
 * Validate the event command lists of every map in the project. Aggregates each
 * map's warnings, tagging them with the map ID so callers can locate them.
 */
export async function validateProjectTool(projectPath: string): Promise<{
  ok: boolean;
  mapsChecked: number;
  warnings: Array<ValidationWarning & { mapId: number }>;
}> {
  const infos = (await getMapInfos(projectPath)) as (MapInfo | null)[];
  const mapIds = infos.filter((info): info is MapInfo => info != null).map((info) => info.id);

  const warnings: Array<ValidationWarning & { mapId: number }> = [];
  let mapsChecked = 0;

  for (const mapId of mapIds) {
    let map;
    try {
      map = await getMap(projectPath, mapId);
    } catch {
      // A map listed in MapInfos may not have a MapNNN.json file yet; skip it.
      continue;
    }
    mapsChecked++;
    const report = validateEvents(map.events);
    for (const warning of report.warnings) {
      warnings.push({ mapId, ...warning });
    }
    const walkable = await loadCellWalkable(projectPath, map);
    const hasObject = cellHasObject(map);
    for (const event of map.events ?? []) {
      if (!event) continue;
      for (const warning of eventPassabilityFindings(event, walkable, hasObject)) {
        warnings.push({ mapId, ...warning });
      }
    }
  }

  return { ok: warnings.length === 0, mapsChecked, warnings };
}

/**
 * Read a 1-indexed database array by filename, failing soft to `[]` if the file is
 * absent. Thin (projectPath, file) convenience over the shared {@link readJsonArraySoft}.
 */
async function loadArray<T>(projectPath: string, file: string): Promise<(T | null)[]> {
  return readJsonArraySoft<T>(getDataPath(projectPath, file));
}

/**
 * Load the whole project snapshot the reference linter needs. Every read fails
 * soft: a missing/unreadable file yields an empty array (or `null` for
 * `Animations.json`/`System.json`), so the audit degrades to fewer checks rather
 * than throwing.
 *
 * Shared with the id-allocation scan (`tools/idTools.ts`), which needs the same
 * whole-project snapshot.
 */
export async function loadProjectData(projectPath: string): Promise<ProjectData> {
  const mapInfos = await loadArray<MapInfo>(projectPath, 'MapInfos.json');

  const maps: ProjectData['maps'] = [];
  for (const info of mapInfos) {
    if (!info) continue;
    try {
      const map = await getMap(projectPath, info.id);
      maps.push({ id: info.id, events: map.events, encounterList: map.encounterList });
    } catch {
      // A map listed in MapInfos may not have a MapNNN.json file yet; skip it.
    }
  }

  let animations: (unknown | null)[] | null = null;
  try {
    animations = await readJsonFile<(unknown | null)[]>(
      getDataPath(projectPath, 'Animations.json'),
    );
  } catch {
    animations = null; // absent -> skip animation-id checks rather than flag everything
  }

  let system: SystemData | null = null;
  try {
    system = await readJsonFile<SystemData>(getDataPath(projectPath, 'System.json'));
  } catch {
    system = null;
  }

  return {
    mapInfos,
    maps,
    actors: await loadArray(projectPath, 'Actors.json'),
    classes: await loadArray(projectPath, 'Classes.json'),
    skills: await loadArray(projectPath, 'Skills.json'),
    items: await loadArray(projectPath, 'Items.json'),
    weapons: await loadArray(projectPath, 'Weapons.json'),
    armors: await loadArray(projectPath, 'Armors.json'),
    enemies: await loadArray(projectPath, 'Enemies.json'),
    troops: await loadArray(projectPath, 'Troops.json'),
    states: await loadArray(projectPath, 'States.json'),
    commonEvents: await loadArray(projectPath, 'CommonEvents.json'),
    animations,
    system,
  };
}

/**
 * Cross-file reference-integrity audit for the whole project. Read-only and
 * warn-by-default: reports dangling/cyclic references (a Transfer Player to a
 * missing map, a skill effect adding a non-existent state, a troop member for a
 * deleted enemy, a cyclic map tree, …) without changing anything. Complements
 * `validate_project`, which only checks event-command *shape*.
 */
export async function validateReferencesTool(
  projectPath: string,
): Promise<{ ok: boolean; warnings: ReferenceWarning[] }> {
  const data = await loadProjectData(projectPath);
  const warnings = checkReferences(data);
  return { ok: warnings.length === 0, warnings };
}

/** The asset types the filename audit scans (a subset of list_assets' kinds). */
const AUDITED_ASSET_TYPES: AssetType[] = [
  'characters',
  'faces',
  'sv_actors',
  'enemies',
  'sv_enemies',
  'tilesets',
  'titles1',
  'titles2',
  'battlebacks1',
  'battlebacks2',
  'parallaxes',
  'pictures',
  'animations',
  'bgm',
  'bgs',
  'me',
  'se',
];

/**
 * Enumerate the available basenames for every audited asset type into a lookup
 * the pure checker can test against. `listAssets` fails soft (a missing dir →
 * `[]`), so an unused asset kind maps to an empty set and its references are
 * skipped rather than flagged.
 */
async function buildAvailableAssets(projectPath: string): Promise<AvailableAssets> {
  const assets: AvailableAssets = {};
  for (const type of AUDITED_ASSET_TYPES) {
    const { names } = await listAssets(projectPath, type);
    assets[type] = new Set(names);
  }
  return assets;
}

/**
 * Load the project records that carry asset-filename fields (the maps in full,
 * for their map-level audio/images and event lists). Every read fails soft to an
 * empty array (or `null` for `System.json`), so a missing file degrades the audit
 * rather than throwing.
 */
async function loadAssetData(projectPath: string): Promise<AssetProjectData> {
  const mapInfos = await loadArray<MapInfo>(projectPath, 'MapInfos.json');
  const maps: AssetProjectData['maps'] = [];
  for (const info of mapInfos) {
    if (!info) continue;
    try {
      maps.push({ id: info.id, map: (await getMap(projectPath, info.id)) as MapData });
    } catch {
      // A map listed in MapInfos may not have a MapNNN.json file yet; skip it.
    }
  }

  let system: SystemData | null = null;
  try {
    system = await readJsonFile<SystemData>(getDataPath(projectPath, 'System.json'));
  } catch {
    system = null;
  }

  return {
    actors: await loadArray<Actor>(projectPath, 'Actors.json'),
    enemies: await loadArray<Enemy>(projectPath, 'Enemies.json'),
    tilesets: await loadArray<Tileset>(projectPath, 'Tilesets.json'),
    maps,
    troops: await loadArray<Troop>(projectPath, 'Troops.json'),
    commonEvents: await loadArray<CommonEvent>(projectPath, 'CommonEvents.json'),
    animations: await loadArray<MvAnimationAssets>(projectPath, 'Animations.json'),
    system,
  };
}

/**
 * Project-wide asset-*filename* audit (read-only, warn-by-default). Scans supported
 * static asset-name fields across the database, maps, and system against files that
 * actually exist on disk, reporting each dangling reference — the systematic
 * complement to the per-record create-time warnings (a `battlerName` typo would
 * otherwise only surface as a runtime "Failed to load …" error). The *id*-
 * integrity sibling is `validate_references`.
 */
export async function validateAssetsTool(
  projectPath: string,
): Promise<{ ok: boolean; warnings: AssetWarning[] }> {
  const [data, assets] = await Promise.all([
    loadAssetData(projectPath),
    buildAvailableAssets(projectPath),
  ]);
  const warnings = checkAssets(data, assets);
  return { ok: warnings.length === 0, warnings };
}

export const validationToolDefinitions: ToolDefinition[] = [
  {
    name: 'validate_event',
    description:
      "Validate a single event's command lists against the known RPG Maker MV command table, plus its placement against the tile it sits on: an action-button page with priority below on an impassable tile (can never trigger) and an invisible wall (a graphic-less, priority-same, non-through page on a walkable tile — the player bumps into nothing; an action-button page over a drawn B–E object is exempt, as the solid-landmark idiom). Read-only: reports warnings without changing anything.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event to validate'),
    },
    handler: (ctx, args) => validateEventTool(ctx.projectPath, args.mapId, args.eventId),
  },
  {
    name: 'validate_project',
    description:
      "Validate the event command lists of every map in the project, plus each event's placement (action-button-below on an impassable tile; graphic-less priority-same invisible walls on walkable tiles, except action-button pages over a drawn B–E object). Read-only: returns aggregated, map-tagged warnings for auditing before or after a batch of edits.",
    inputSchema: {},
    handler: (ctx) => validateProjectTool(ctx.projectPath),
  },
  {
    name: 'validate_references',
    description:
      'Audit cross-file reference integrity across the whole project (read-only, warn-by-default): Transfer Player targets and starting position point at existing maps; starting party, actor classes, class/enemy skills, troop members, enemy drops, and skill/item effects (states, learned skills, common events, animations) all resolve; event commands that name a record (Change Items/Weapons/Armors, Change Party Member, Battle Processing, Shop Processing, Change State/Skill, Common Event) and map random encounters point at existing rows; and the map tree has no dangling or cyclic parentId. Complements validate_project (which checks command shape). Returns { ok, warnings[] }.',
    inputSchema: {},
    handler: (ctx) => validateReferencesTool(ctx.projectPath),
  },
  {
    name: 'validate_assets',
    description:
      'Audit supported static image/audio filename fields (read-only, warn-by-default): actor characterName/faceName/battlerName, enemy battlerName, tileset sheets, MV animation sheets and timing sounds, map bgm/bgs/parallax/battlebacks, event page graphics, event Play BGM/BGS/ME/SE / Show Picture / Show Text face / Change Actor Images, forced and autonomous movement-route Change Image/Play SE steps, and system titles/battlebacks/default audio/vehicle graphics. Checks plaintext and encrypted MV asset basenames under img/ and audio/. Script/plugin-generated filenames and unlisted command fields are not inspected; an empty/missing asset directory is skipped. Complements validate_references (id integrity). Returns { ok, warnings[] }; a clean result confirms only the inspected fields.',
    inputSchema: {},
    handler: (ctx) => validateAssetsTool(ctx.projectPath),
  },
];
