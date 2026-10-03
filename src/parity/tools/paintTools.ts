import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, Tileset } from '../utils/types.js';
import { getMap, tileIndex } from './mapTools.js';
import { LayerAccess, applyAutotiling } from '../tiles/paint.js';
import { assertLayerTileValue } from '../tiles/tileCodec.js';
import { getTileset } from './tilesetTools.js';
import { baseAwareTransparencyWarning } from './tileTransparency.js';
import { loadCatalogOverlay } from './catalogTools.js';
import { impassableMask } from './objectTools.js';
import { CatalogOverlay, resolveTileName } from '../tiles/catalog/index.js';
import {
  ResolvedEntry,
  ResolvedWall,
  applyBlueprint,
  parseBlueprint,
  wallSideFor,
} from '../tiles/blueprint.js';

/** The 6 z-layers: 0-1 lower tiles, 2-3 upper tiles, 4 shadow, 5 region id. */
const MAX_LAYER = 5;
/** Layers that hold real tiles (autotiles only make sense here). */
const TILE_LAYERS = 4;

/** A LayerAccess bound to one z-layer of a map's flat `data` array (mutates in place). */
function layerAccess(map: MapData, layer: number): LayerAccess {
  return {
    width: map.width,
    height: map.height,
    get: (x, y) => map.data[tileIndex(map.width, map.height, x, y, layer)],
    set: (x, y, tileId) => {
      map.data[tileIndex(map.width, map.height, x, y, layer)] = tileId;
    },
  };
}

/** Response shape for a paint op: how much changed, plus any advisory warnings. */
interface PaintResult {
  mapId: number;
  layer: number;
  painted: number;
  warnings?: string[];
}

/**
 * Paint tiles onto a map layer, then autotile: each painted cell is set to the
 * given tile id and — for autotiles — every painted cell and its neighbours get
 * their shape recomputed from same-kind adjacency. Out-of-bounds cells are
 * skipped with a warning. Writes through the commit choke point (dry-run/diff).
 */
async function paintCells(
  projectPath: string,
  mapId: number,
  cells: { x: number; y: number; tileId: number }[],
  layer: number,
): Promise<PaintResult> {
  for (const cell of cells) {
    assertLayerTileValue(layer, cell.tileId);
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) throw new Error('Tile coordinates must be integers');
  }
  const map = await getMap(projectPath, mapId);
  const grid = layerAccess(map, layer);
  const warnings: string[] = [];
  const painted: { x: number; y: number; tileId: number }[] = [];

  for (const cell of cells) {
    if (cell.x < 0 || cell.x >= map.width || cell.y < 0 || cell.y >= map.height) {
      warnings.push(
        `(${cell.x}, ${cell.y}) is out of bounds (${map.width}x${map.height}) — skipped`,
      );
      continue;
    }
    grid.set(cell.x, cell.y, cell.tileId);
    painted.push({ x: cell.x, y: cell.y, tileId: cell.tileId });
  }

  if (layer < TILE_LAYERS) applyAutotiling(grid, painted);

  // Base-aware transparency check (tile layers only — shadow/region hold no tiles):
  // a see-through tile with no opaque tile beneath shows the map's void. Advisory
  // only — a missing/unreadable tileset must never break a paint, so fail soft.
  if (layer < TILE_LAYERS && painted.length > 0) {
    try {
      const tileset = await getTileset(projectPath, map.tilesetId);
      const warning = await baseAwareTransparencyWarning(
        projectPath,
        map,
        tileset,
        painted.map((c) => ({ ...c, layer })),
      );
      if (warning) warnings.push(warning);
    } catch {
      // No tileset / unreadable sheets → skip the advisory transparency warning.
    }
  }

  await commitChange(getMapPath(projectPath, mapId), map);

  return warnings.length > 0
    ? { mapId, layer, painted: painted.length, warnings }
    : { mapId, layer, painted: painted.length };
}

/** A tile reference in a blueprint legend: a raw tile id or a catalog name. */
type TileRef = number | string;
/** A blueprint wall: A4 wall-top (or A3 roof) kind, with its side kind on each run's bottom cell(s). */
interface WallInput {
  top: TileRef;
  side?: TileRef;
  faceHeight?: number;
  layer?: number;
}
/** One legend value, as the caller passes it. */
type LegendInput =
  null | string | [number, TileRef][] | { wall?: WallInput; tiles?: [number, TileRef][] };

/** Cap on the explicit impassable-cell list (the `rows` overview is always complete). */
const IMPASSABLE_LIST_CAP = 100;

interface BlueprintResult {
  mapId: number;
  origin: [number, number];
  width: number;
  height: number;
  /** Cells written per layer. */
  layers: Record<string, number>;
  cleared: number;
  wallFaces: number;
  passability?: {
    /** Cells the player can't stand on (see `impassableMask`). */
    impassableCount: number;
    /**
     * One string per blueprint row: `#` = impassable (no walkable direction, or
     * part of a region whose own edge flags refuse entry, e.g. an A4 wall-top
     * mass), `.` = walkable.
     */
    rows: string[];
    /** Impassable cells as [x, y] map coordinates (capped). */
    impassable: [number, number][];
    truncated?: boolean;
  };
  warnings?: string[];
}

/**
 * Resolve every legend entry's tile references (ids pass through; names go
 * through the catalog, loaded lazily and only once) into {@link ResolvedEntry}s.
 * All problems are collected into one error so a bad legend fails before any write.
 */
async function resolveLegend(
  projectPath: string,
  legend: Record<string, LegendInput>,
  tileset: () => Promise<Tileset>,
): Promise<Record<string, ResolvedEntry>> {
  const problems: string[] = [];
  let catalog: { names: string[]; overlay: CatalogOverlay | undefined } | undefined;
  const named = new Map<string, number>();
  const resolve = async (ref: TileRef, where: string): Promise<number | undefined> => {
    if (typeof ref === 'number') return ref;
    if (named.has(ref)) return named.get(ref);
    try {
      if (!catalog) {
        const names = (await tileset()).tilesetNames;
        catalog = { names, overlay: await loadCatalogOverlay(projectPath, names) };
      }
      const id = resolveTileName(catalog.names, ref, catalog.overlay);
      named.set(ref, id);
      return id;
    } catch (err) {
      problems.push(`${where}: ${(err as Error).message}`);
      return undefined;
    }
  };

  const out: Record<string, ResolvedEntry> = {};
  for (const [glyph, input] of Object.entries(legend)) {
    if (input === null) {
      out[glyph] = null;
      continue;
    }
    const pairs: [number, TileRef][] =
      typeof input === 'string' ? [[0, input]] : Array.isArray(input) ? input : (input.tiles ?? []);
    const tiles = new Map<number, number>();
    for (const [layer, ref] of pairs) {
      const id = await resolve(ref, `legend "${glyph}" layer ${layer}`);
      if (id === undefined) continue;
      try { assertLayerTileValue(layer, id); } catch (error) { problems.push(`legend "${glyph}": ${(error as Error).message}`); continue; }
      if (tiles.has(layer)) problems.push(`legend "${glyph}" sets layer ${layer} twice`);
      tiles.set(layer, id);
    }
    let wall: ResolvedWall | undefined;
    const wallInput = typeof input === 'object' && !Array.isArray(input) ? input.wall : undefined;
    if (wallInput) {
      const layer = wallInput.layer ?? 0;
      const top = await resolve(wallInput.top, `legend "${glyph}" wall top`);
      const side =
        wallInput.side !== undefined
          ? await resolve(wallInput.side, `legend "${glyph}" wall side`)
          : undefined;
      if (top !== undefined) {
        try {
          wall = {
            top,
            side: side ?? wallSideFor(top),
            faceHeight: wallInput.faceHeight ?? 1,
            layer,
          };
          assertLayerTileValue(layer, wall.top);
          assertLayerTileValue(layer, wall.side);
          if (layer > 3) throw new Error('Walls require a tile layer (0-3)');
          if (tiles.has(layer)) {
            problems.push(`legend "${glyph}" sets layer ${layer} in both "wall" and "tiles"`);
          }
          tiles.set(layer, top);
        } catch (err) {
          problems.push(`legend "${glyph}" wall: ${(err as Error).message}`);
        }
      }
    }
    out[glyph] = wall ? { tiles, wall } : { tiles };
  }
  if (problems.length) throw new Error(`Invalid legend:\n- ${problems.join('\n- ')}`);
  return out;
}

/**
 * Paint a whole blueprint (ASCII rows + legend) onto a map in one write: every
 * layer set, wall faces derived, autotiling recomputed once per layer, then a
 * cheap passability overview of the painted rectangle.
 */
async function paintBlueprint(
  projectPath: string,
  mapId: number,
  rows: string[],
  legend: Record<string, LegendInput>,
  origin: [number, number],
  clearUpperLayers: boolean,
): Promise<BlueprintResult> {
  const grid = parseBlueprint(rows, Object.keys(legend));
  const map = await getMap(projectPath, mapId);
  const [ox, oy] = origin;
  if (!Number.isInteger(ox) || !Number.isInteger(oy)) throw new Error('Blueprint coordinates must be integers');
  const width = grid[0].length;
  const height = grid.length;
  if (ox < 0 || oy < 0 || ox + width > map.width || oy + height > map.height) {
    throw new Error(
      `blueprint ${width}x${height} at (${ox}, ${oy}) does not fit map ${mapId} (${map.width}x${map.height})`,
    );
  }

  let tilesetPromise: Promise<Tileset> | undefined;
  const tileset = () => (tilesetPromise ??= getTileset(projectPath, map.tilesetId));
  const resolved = await resolveLegend(projectPath, legend, tileset);

  const accessors = new Map<number, LayerAccess>();
  const layerOf = (layer: number): LayerAccess => {
    let access = accessors.get(layer);
    if (!access) {
      access = layerAccess(map, layer);
      accessors.set(layer, access);
    }
    return access;
  };
  const stats = applyBlueprint(layerOf, grid, resolved, ox, oy, clearUpperLayers);

  const warnings: string[] = [];
  // Advisory checks need the tileset's sheets/flags — fail soft if it's missing.
  let passability: BlueprintResult['passability'];
  try {
    const ts = await tileset();
    const warning = await baseAwareTransparencyWarning(
      projectPath,
      map,
      ts,
      stats.cells.filter((c) => c.layer < TILE_LAYERS),
    );
    if (warning) warnings.push(warning);

    const mask = impassableMask(map, ts);
    const passRows: string[] = [];
    const impassable: [number, number][] = [];
    let impassableCount = 0;
    for (let dy = 0; dy < height; dy++) {
      let line = '';
      for (let dx = 0; dx < width; dx++) {
        const blocked = mask[(oy + dy) * map.width + ox + dx];
        line += blocked ? '#' : '.';
        if (blocked) {
          impassableCount++;
          if (impassable.length < IMPASSABLE_LIST_CAP) impassable.push([ox + dx, oy + dy]);
        }
      }
      passRows.push(line);
    }
    passability = {
      impassableCount,
      rows: passRows,
      impassable,
      ...(impassableCount > IMPASSABLE_LIST_CAP ? { truncated: true } : {}),
    };
  } catch {
    warnings.push(`tileset ${map.tilesetId} unavailable — passability overview skipped`);
  }

  await commitChange(getMapPath(projectPath, mapId), map);

  const layers: Record<string, number> = {};
  for (const [layer, n] of Object.entries(stats.painted)) layers[layer] = n;
  return {
    mapId,
    origin: [ox, oy],
    width,
    height,
    layers,
    cleared: stats.cleared,
    wallFaces: stats.wallFaces,
    ...(passability ? { passability } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

const tileRefSchema = z
  .union([z.number().int().nonnegative().max(8191), z.string().min(1)])
  .describe(
    'A tile id, or a catalog tile name (exact name, else a unique substring — see find_tile)',
  );
const layerPairSchema = z
  .tuple([z.number().int().min(0).max(MAX_LAYER), tileRefSchema])
  .describe('[layer, tile] — layer 0-5 (0-1 lower, 2-3 upper, 4 shadow, 5 region)');

export const paintToolDefinitions: ToolDefinition[] = [
  {
    name: 'paint_tiles',
    mutates: true,
    description:
      "Paint specific tiles onto a map, with automatic autotiling. Each cell is set to its tile id; if that id is an autotile (A1-A4, e.g. a catalog 'kind' base from find_tile), its shape and its neighbours' shapes are recomputed from same-kind adjacency so borders/corners line up. Flat tiles are painted as-is. Defaults to the lower ground layer (0). Higher-level than set_map_tile, which is a single raw tile with no autotiling.",
    inputSchema: {
      mapId: z.number().int().describe('The ID of the map'),
      tiles: z
        .array(
          z.object({
            x: z.number().int().describe('X tile position'),
            y: z.number().int().describe('Y tile position'),
            tileId: z
              .number()
              .int()
              .nonnegative()
              .describe('Tile id to paint (autotile base id from find_tile, or a raw id)'),
          }),
        )
        .min(1)
        .describe('Cells to paint'),
      layer: z
        .number()
        .int()
        .min(0)
        .max(MAX_LAYER)
        .optional()
        .describe('Z-layer 0-5 (default 0 = lower ground; 0-3 tiles, 4 shadow, 5 region id)'),
    },
    handler: (ctx, args) => paintCells(ctx.projectPath, args.mapId, args.tiles, args.layer ?? 0),
  },
  {
    name: 'fill_area',
    mutates: true,
    description:
      'Fill a rectangular area of a map with one tile id, with automatic autotiling — a filled autotile region borders itself correctly (and re-borders any same-kind tiles it touches). Flat tiles fill uniformly. Defaults to the lower ground layer (0). For region ids, fill layer 5 with the region number as tileId.',
    inputSchema: {
      mapId: z.number().int().describe('The ID of the map'),
      x: z.number().int().describe('Left tile position of the rectangle'),
      y: z.number().int().describe('Top tile position of the rectangle'),
      width: z.number().int().positive().describe('Rectangle width in tiles'),
      height: z.number().int().positive().describe('Rectangle height in tiles'),
      tileId: z
        .number()
        .int()
        .nonnegative()
        .describe('Tile id to fill with (autotile base or raw)'),
      layer: z
        .number()
        .int()
        .min(0)
        .max(MAX_LAYER)
        .optional()
        .describe('Z-layer 0-5 (default 0 = lower ground; 5 = region id)'),
    },
    handler: (ctx, args) => {
      const cells: { x: number; y: number; tileId: number }[] = [];
      for (let dy = 0; dy < args.height; dy++) {
        for (let dx = 0; dx < args.width; dx++) {
          cells.push({ x: args.x + dx, y: args.y + dy, tileId: args.tileId });
        }
      }
      return paintCells(ctx.projectPath, args.mapId, cells, args.layer ?? 0);
    },
  },
  {
    name: 'paint_blueprint',
    mutates: true,
    description:
      "Paint a whole map area from an ASCII blueprint in ONE call and one write. `rows` are equal-length strings (one glyph per cell); `legend` maps each glyph to what that cell holds: `[[layer, tile], ...]` pairs (multi-layer cells, e.g. ground on 0 + fence on 1); a bare string = a catalog tile name on layer 0; `{ wall: { top, side?, faceHeight?, layer? }, tiles?: [...] }` = an A4 wall (or A3 roof) — every cell gets the wall-top kind and the bottom `faceHeight` (default 1) cell(s) of each vertical run get the wall-side kind (derived as top + 8 kinds = +384 ids unless `side` is given; a run continuing off the map's bottom edge gets no face); or `null` = leave the cell untouched. Tiles may be ids or catalog names (exact name, else a unique substring — unknown/ambiguous names are an error). Row lengths, unknown glyphs, names and fit are all validated before anything is written. With `clearUpperLayers` (default true) each painted cell zeroes the tile layers (0-3) above its lowest specified layer that it does not specify, so stale objects vanish (`[]` erases the cell). Autotiling is recomputed once per layer, as in paint_tiles. Returns cells painted per layer, cleared count, wall faces made, and a passability overview of the rectangle, judged like the engine's canPass (a step needs the source to allow leaving and the target to allow entry): `rows` with `#` = impassable — a cell with no walkable direction (face, water, solid object) or part of a region whose own edge flags refuse entry from the walkable cells around it (an A4 wall-top mass, a stair-less plateau) — and `.` = walkable ground, plus the impassable [x, y] cells. Stamp multi-tile B/C objects afterwards with place_object.",
    inputSchema: {
      mapId: z.number().int().describe('The ID of the map'),
      rows: z
        .array(z.string())
        .min(1)
        .describe('Blueprint rows, top to bottom; every row the same length, one glyph per cell'),
      legend: z
        .record(
          z.string(),
          z.union([
            z.null(),
            z.string().min(1),
            z.array(layerPairSchema),
            z
              .object({
                wall: z
                  .object({
                    top: tileRefSchema.describe(
                      'Wall-top tile: an A4 wall-top or A3 roof autotile',
                    ),
                    side: tileRefSchema
                      .optional()
                      .describe('Wall-side (face) tile; default = top + 8 kinds (+384 ids)'),
                    faceHeight: z
                      .number()
                      .int()
                      .min(1)
                      .optional()
                      .describe('Face cells at the bottom of each vertical run (default 1)'),
                    layer: z
                      .number()
                      .int()
                      .min(0)
                      .max(3)
                      .optional()
                      .describe('Tile layer for the wall (default 0)'),
                  })
                  .strict()
                  .optional(),
                tiles: z.array(layerPairSchema).optional().describe('Extra [layer, tile] pairs'),
              })
              .strict(),
          ]),
        )
        .describe('Glyph → cell contents (see the tool description for the value forms)'),
      origin: z
        .tuple([z.number().int(), z.number().int()])
        .optional()
        .describe("[x, y] map position of the blueprint's top-left cell (default [0, 0])"),
      clearUpperLayers: z
        .boolean()
        .optional()
        .describe(
          "Zero the tile layers above each cell's lowest specified layer that it does not specify (default true)",
        ),
    },
    handler: (ctx, args) =>
      paintBlueprint(
        ctx.projectPath,
        args.mapId,
        args.rows,
        args.legend,
        args.origin ?? [0, 0],
        args.clearUpperLayers ?? true,
      ),
  },
];
