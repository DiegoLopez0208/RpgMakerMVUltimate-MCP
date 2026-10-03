import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getDataPath, readJsonFile } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, Tileset } from '../utils/types.js';
import { getMap, tileIndex } from './mapTools.js';
import {
  Direction,
  FlagUpdate,
  decodeFlags,
  encodeFlags,
  layeredPassability,
  layeredTerrainTag,
} from '../tiles/tileFlags.js';
import {
  AUTOTILE_SLOTS_PER_KIND,
  decodeTile,
  getAutotileKind,
  isAutotile,
  makeAutotileId,
} from '../tiles/tileCodec.js';

/**
 * Tools over a tileset's `flags[]` array (read side + passability
 * editing) — the bit-packed per-tile-id metadata the editor sets and the engine
 * reads for movement. `get_tile_flags` decodes one tile's flag word;
 * `check_passability` reproduces the engine's *layered* passage logic for a real
 * map cell (the stacked tiles decide, upper layer first); `set_tile_flags`
 * writes the passability/terrain/behaviour flags back. Independent of the paint
 * pipeline.
 */

/** Slot labels for `Tileset.tilesetNames[9]` — the 9 image sheets in fixed order. */
const SHEET_SLOTS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'] as const;

/**
 * List every tileset with its id, name, mode, and the image sheets it uses
 * (`tilesetNames`, labelled by slot; empty slots omitted). The paint / catalog /
 * flag tools all need a `tilesetId`, and `list_names('tilesets')` gives id→name,
 * but this also exposes which sheets a tileset is built from — so a caller can
 * pick the right tileset and know which `find_tile`/`get_tile_catalog` sheets
 * apply. Read-only.
 */
export async function getTilesets(projectPath: string): Promise<{
  count: number;
  tilesets: Array<{ id: number; name: string; mode: number; sheets: Record<string, string> }>;
}> {
  const tilesets = await readJsonFile<(Tileset | null)[]>(
    getDataPath(projectPath, 'Tilesets.json'),
  );
  const entries = tilesets
    .filter((t): t is Tileset => t != null)
    .map((t) => {
      const sheets: Record<string, string> = {};
      SHEET_SLOTS.forEach((label, i) => {
        const name = t.tilesetNames[i];
        if (name) sheets[label] = name;
      });
      return { id: t.id, name: t.name, mode: t.mode, sheets };
    });
  return { count: entries.length, tilesets: entries };
}

/** Load one tileset from the project's data/Tilesets.json (1-indexed, slot 0 null). */
export async function getTileset(projectPath: string, tilesetId: number): Promise<Tileset> {
  const tilesets = await readJsonFile<(Tileset | null)[]>(
    getDataPath(projectPath, 'Tilesets.json'),
  );
  const tileset = tilesets[tilesetId];
  if (!tileset) {
    throw new Error(`Tileset ${tilesetId} not found`);
  }
  return tileset;
}

/** Collect the caller's supplied flag fields into a FlagUpdate (omitting untouched ones). */
function flagUpdateFromArgs(args: Record<string, unknown>): FlagUpdate {
  const update: FlagUpdate = {};
  if (args.passage !== undefined) update.passage = args.passage as Partial<FlagUpdate['passage']>;
  if (args.star !== undefined) update.star = args.star as boolean;
  if (args.ladder !== undefined) update.ladder = args.ladder as boolean;
  if (args.bush !== undefined) update.bush = args.bush as boolean;
  if (args.counter !== undefined) update.counter = args.counter as boolean;
  if (args.damage !== undefined) update.damage = args.damage as boolean;
  if (args.terrainTag !== undefined) update.terrainTag = args.terrainTag as number;
  return update;
}

/**
 * The tile ids a `set_tile_flags` write should touch. For a flat tile it's just
 * the tile itself; for an autotile it's every shape slot of the kind (so painting
 * any border shape keeps the same passability) unless the caller opts out.
 */
function flagTargetIds(tileId: number, applyToKind: boolean): number[] {
  if (applyToKind && isAutotile(tileId)) {
    const kind = getAutotileKind(tileId);
    return Array.from({ length: AUTOTILE_SLOTS_PER_KIND }, (_, shape) =>
      makeAutotileId(kind, shape),
    );
  }
  return [tileId];
}

/** The four stacked tile ids at a cell, upper layer first (z 3,2,1,0) — the engine's `layeredTiles` order. */
function layeredTileIds(map: MapData, x: number, y: number): number[] {
  const ids: number[] = [];
  for (let z = 3; z >= 0; z--) {
    ids.push(map.data[tileIndex(map.width, map.height, x, y, z)] || 0);
  }
  return ids;
}

export const tilesetToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_tilesets',
    description:
      'List every tileset in the project with its id, name, mode (0 world / 1 area), and the image sheets it uses (labelled A1–A4, A5, B–E; empty slots omitted). Use this to discover valid tilesetId values (needed by find_tile, get_tile_catalog, paint_tiles, fill_area, place_object, get_tile_flags, set_tile_flags, check_passability) and to see which sheets each tileset is built from. For a plain id→name list, list_names(type:"tilesets") is even cheaper. Read-only.',
    inputSchema: {},
    handler: (ctx) => getTilesets(ctx.projectPath),
  },
  {
    name: 'get_tile_flags',
    description:
      "Decode a tileset's flag word for a single tile id into a legible view: 4-direction passability (down/left/right/up — true = walkable that way), the [*] 'star' overlay bit, ladder/bush/counter/damage-floor flags, and terrain tag (0–7). Read-only inspection of data/Tilesets.json flags[]. Note passability here is for the tile in isolation; a real cell's passability layers its stacked tiles — use check_passability for that. Returns { tilesetId, tileId, tile, flags }.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      tileId: z.number().int().nonnegative().max(8191).describe('The raw tile id whose flags to decode'),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const flag = tileset.flags[args.tileId] ?? 0;
      return {
        tilesetId: args.tilesetId,
        tilesetName: tileset.name,
        tileId: args.tileId,
        tile: decodeTile(args.tileId),
        flags: decodeFlags(flag),
      };
    },
  },
  {
    name: 'check_passability',
    description:
      "Check whether a map cell can be walked onto, reproducing the engine's layered passage rule: the stacked tiles at (x, y) are examined upper-layer first, and the first non-[*] tile decides each direction. Reads the map's tileset flags. Returns per-direction passability (down/left/right/up — true = a character can walk off the cell that way), the cell's terrain tag, the stacked tile ids, and — when `direction` is given — a single `passable` boolean for that direction. Read-only.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The map id to inspect'),
      x: z.number().int().nonnegative().describe('Tile x coordinate'),
      y: z.number().int().nonnegative().describe('Tile y coordinate'),
      direction: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Optional: also report a single passable boolean for this direction'),
    },
    handler: async (ctx, args) => {
      const map = await getMap(ctx.projectPath, args.mapId);
      if (args.x < 0 || args.x >= map.width || args.y < 0 || args.y >= map.height) {
        throw new Error(
          `Position (${args.x}, ${args.y}) is out of map bounds (${map.width}x${map.height})`,
        );
      }
      const tileset = await getTileset(ctx.projectPath, map.tilesetId);
      const stack = layeredTileIds(map, args.x, args.y);
      const stackFlags = stack.map((id) => tileset.flags[id] ?? 0);
      const passable = layeredPassability(stackFlags);
      return {
        mapId: args.mapId,
        x: args.x,
        y: args.y,
        tilesetId: map.tilesetId,
        stack,
        passable,
        terrainTag: layeredTerrainTag(stackFlags),
        ...(args.direction
          ? {
              direction: args.direction,
              passableInDirection: passable[args.direction as Direction],
            }
          : {}),
      };
    },
  },
  {
    name: 'set_tile_flags',
    mutates: true,
    description:
      "Edit a tile's passability/terrain/behaviour flags in a tileset's flags[] array (the write side of get_tile_flags). Only the fields you pass change — everything else on the tile is preserved (a non-destructive merge onto the current flag word). `passage` is walkability (down/left/right/up, true = a character can walk off that way). Also settable: star ([*] overlay), ladder, bush, counter, damage (damage floor), and terrainTag (0–7). For an autotile id (A1–A4) the change is applied to all 48 shape slots of its kind by default (set applyToAutotileKind:false to touch only the exact id) so painting any border shape keeps the same passability. Writes data/Tilesets.json through the commit choke point (dry-run/diff). Returns { tilesetId, tileId, appliedTileCount, before, after }.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      tileId: z.number().int().nonnegative().max(8191).describe('The raw tile id whose flags to edit'),
      passage: z
        .object({
          down: z.boolean().optional(),
          left: z.boolean().optional(),
          right: z.boolean().optional(),
          up: z.boolean().optional(),
        })
        .optional()
        .describe('Walkability per direction (true = walkable). Only the given directions change.'),
      star: z.boolean().optional().describe('[*] overlay: tile drawn above the character.'),
      ladder: z.boolean().optional(),
      bush: z.boolean().optional(),
      counter: z.boolean().optional(),
      damage: z.boolean().optional().describe('Damage floor (standing on it hurts).'),
      terrainTag: z.number().int().min(0).max(7).optional().describe('Terrain tag 0–7 (0 = none).'),
      applyToAutotileKind: z
        .boolean()
        .optional()
        .describe(
          'When the tile is an autotile (A1–A4), apply the change to all 48 shape slots of its kind (default true). Ignored for flat tiles.',
        ),
    },
    handler: async (ctx, args) => {
      const update = flagUpdateFromArgs(args);
      if (Object.keys(update).length === 0) {
        throw new Error(
          'No flag fields to update — pass at least one of passage/star/ladder/bush/counter/damage/terrainTag',
        );
      }

      const path = getDataPath(ctx.projectPath, 'Tilesets.json');
      const tilesets = await readJsonFile<(Tileset | null)[]>(path);
      const tileset = tilesets[args.tilesetId];
      if (!tileset) {
        throw new Error(`Tileset ${args.tilesetId} not found`);
      }

      const targetIds = flagTargetIds(args.tileId, args.applyToAutotileKind ?? true);
      const before = decodeFlags(tileset.flags[args.tileId] ?? 0);
      for (const id of targetIds) {
        tileset.flags[id] = encodeFlags(tileset.flags[id] ?? 0, update);
      }
      const after = decodeFlags(tileset.flags[args.tileId] ?? 0);

      await commitChange(path, tilesets);
      return {
        tilesetId: args.tilesetId,
        tilesetName: tileset.name,
        tileId: args.tileId,
        appliedTileCount: targetIds.length,
        before,
        after,
      };
    },
  },
];
