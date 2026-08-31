/**
 * semanticMapTools.ts — build a map from a mission graph or a mined layout,
 * materialised against the project's own tileset.
 *
 * The difference from createMapV3 is where the art comes from. V3 clones a
 * bundled RTP map, so the result only looks right on an RTP tileset. This path
 * keeps the layout abstract until the last moment and then asks a TilesetProfile
 * which tile plays each role, so the same mission works on a DLC pack, an
 * itch.io tileset, or anything the project already uses.
 *
 * The profile comes from what the project actually does — mined by
 * templateMiner from the user's existing maps — and falls back to the tileset
 * scan for any role that has never been used.
 */

import { readJson, writeJson, getMapPath, safeWrite } from '../utils/fileHandler.js';
import type { RpgMakerMap } from '../types/rpgmaker.js';
import { getNextMapId } from './mapTools.js';
import { getTileIdsForTileset } from './assetTools.js';
import { getMinedProfile, loadMinedTemplates } from '../intel/templateMiner.js';
import { emptyProfile, type SemanticTemplate, type SemanticToken, type TilesetProfile } from '../knowledge/semantic.js';
import { materializeTemplate } from '../utils/materialize.js';
import { generateSemanticLayout } from '../utils/graphGenerator.js';
import { TILE_ID_A1, autotileKind, isAutotile } from '../utils/engine.js';

export interface SemanticMapParams {
  name?: string;
  displayName?: string;
  width?: number;
  height?: number;
  tilesetId?: number;
  seed?: number;
  /** Rooms on the critical path. */
  rooms?: number;
  sideRooms?: number;
  locked?: boolean;
  loop?: boolean;
  /** Use a mined layout by its id ("mined-3") instead of generating one. */
  templateId?: string;
  /** Paint the mined props even onto a different tileset. */
  keepProps?: boolean;
}

/** An autotile's shape depends on its neighbours, so a profile stores shape 0. */
function baseTileId(tileId: number): number {
  return isAutotile(tileId) ? TILE_ID_A1 + autotileKind(tileId) * 48 : tileId;
}

/**
 * The profile for a tileset: what the project already does with it, topped up
 * from the tileset scan for any role it has never used.
 */
export async function buildTilesetProfile(projectPath: string, tilesetId: number): Promise<TilesetProfile> {
  const profile = (await getMinedProfile(projectPath, tilesetId)) ?? emptyProfile(tilesetId);

  try {
    const scan = await getTileIdsForTileset(projectPath, tilesetId) as unknown as {
      name?: string;
      availableTiles?: Record<string, number[]>;
    };
    const available = scan?.availableTiles;
    if (available) {
      const fill = (token: SemanticToken, list?: number[]) => {
        if (profile.tiles[token] === undefined && list && list.length) profile.tiles[token] = baseTileId(list[0]);
      };
      fill('ground', available.ground);
      fill('wall', available.wallSide);
      fill('wall_top', available.wallTop);
      fill('water', available.water);
      fill('roof', available.roof);
      if (profile.tilesetName === undefined && scan?.name) profile.tilesetName = scan.name;
    }
  } catch { /* the scan needs img/tilesets on disk; the mined profile may be enough */ }

  return profile;
}

/** Find a mined layout by id, with a message that says how to produce one. */
async function loadMinedTemplate(projectPath: string, templateId: string): Promise<SemanticTemplate> {
  const mined = await loadMinedTemplates(projectPath);
  if (!mined) {
    throw new Error('No mined templates yet. Run manage_system action "mine_templates" first to learn layouts from this project.');
  }
  const template = mined.templates.find((t) => t.id === templateId);
  if (!template) {
    const available = mined.templates.slice(0, 10).map((t) => t.id).join(', ');
    throw new Error(`No mined template "${templateId}". Available: ${available || '(none)'}`);
  }
  return template;
}

/**
 * Create a map from a semantic layout. Returns the new map plus the mission
 * markers, so the caller knows where the entrance, the boss and the treasure
 * are and can populate them with manage_map_event.
 */
export async function createMapSemantic(projectPath: string, params: SemanticMapParams) {
  const tilesetId = params.tilesetId ?? 5; // 5 = Dungeon in the default project
  const profile = await buildTilesetProfile(projectPath, tilesetId);
  if (profile.tiles.ground === undefined) {
    throw new Error(
      `Tileset ${tilesetId} has no known ground tile, so a layout cannot be painted onto it. ` +
      'Run manage_system action "mine_templates" to learn this project\'s tilesets, or pass a tilesetId the project already uses.'
    );
  }

  const width = params.width ?? 30;
  const height = params.height ?? 25;

  const template = params.templateId
    ? await loadMinedTemplate(projectPath, params.templateId)
    : generateSemanticLayout({
      width, height,
      seed: params.seed,
      rooms: params.rooms,
      sideRooms: params.sideRooms,
      locked: params.locked,
      loop: params.loop,
      name: params.name,
    });

  const built = materializeTemplate(template, profile, { tilesetId, keepProps: params.keepProps });

  const map: RpgMakerMap = {
    autoplayBgm: false, autoplayBgs: false,
    battleback1Name: '', battleback2Name: '',
    bgm: { name: '', pan: 0, pitch: 100, volume: 90 },
    bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
    disableDashing: false,
    displayName: params.displayName ?? '',
    encounterList: [], encounterStep: 30,
    width: built.width, height: built.height,
    note: '',
    parallaxLoopX: false, parallaxLoopY: false,
    parallaxName: '', parallaxShow: true,
    parallaxSx: 0, parallaxSy: 0,
    scrollType: 0, specifyBattleback: false,
    tilesetId: built.tilesetId,
    data: built.data,
    events: [null],
  };

  const mapId = await getNextMapId(projectPath);
  await safeWrite(getMapPath(projectPath, mapId), JSON.stringify(map));

  const mapInfos = (await readJson(projectPath, 'MapInfos.json')) as unknown[];
  while (mapInfos.length <= mapId) mapInfos.push(null);
  let maxOrder = 0;
  for (const info of mapInfos) {
    const order = info ? Number((info as Record<string, unknown>).order) : 0;
    if (Number.isFinite(order) && order > maxOrder) maxOrder = order;
  }
  mapInfos[mapId] = {
    id: mapId, expanded: false,
    name: params.name || 'MAP' + String(mapId).padStart(3, '0'),
    order: maxOrder + 1, parentId: 0,
    scrollX: Math.floor(built.width * 32 * 0.8),
    scrollY: Math.floor(built.height * 32 * 0.8),
  };
  await writeJson(projectPath, 'MapInfos.json', mapInfos);

  return {
    mapId,
    width: built.width,
    height: built.height,
    tilesetId: built.tilesetId,
    source: params.templateId ? { kind: 'mined', templateId: params.templateId } : { kind: 'mission-graph', seed: params.seed ?? 12345 },
    profileUsed: { tiles: profile.tiles, tilesetName: profile.tilesetName },
    droppedProps: built.droppedProps,
    /** Where to put events: entrance, key, lock, treasure, boss, exit, doors. */
    markers: built.markers,
  };
}
