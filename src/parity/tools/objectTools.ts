import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, Tileset } from '../utils/types.js';
import { getMap, tileIndex } from './mapTools.js';
import { getTileset } from './tilesetTools.js';
import { Passability, layeredPassability, layeredTerrainTag } from '../tiles/tileFlags.js';
import { isAutotile, flatSheet, TILE_ID, TileSheet } from '../tiles/tileCodec.js';
import { baseAwareTransparencyWarning } from './tileTransparency.js';

/**
 * Smart multi-tile object placement. A B/C "object" (a house, tree,
 * fountain, …) is a rectangular block of *flat* sheet tiles that occupies more
 * than one cell. `place_object` stamps such a block onto a map — by default the
 * upper tile layer (2), so the object draws over the ground — and, using the
 * tileset flags, reports the placement's passability: which ground it
 * covered was walkable, and which footprint cells the object turns into a solid
 * (impassable) obstacle. Warn-by-default, like the rest of the validation layer:
 * it never refuses a placement, it tells you what the placement did.
 *
 * The differentiator from `paint_tiles`: no autotiling (objects are flat), plus
 * the passability site-check + collision report that `paint_tiles` has no notion
 * of. The object grid is supplied explicitly (rows of tile ids, 0 = a transparent
 * hole so L-shaped objects work) — obtain the ids from `find_tile`/`get_tile_catalog`.
 */

/** Upper tile layer — objects draw above the ground tiles on layers 0-1. */
const DEFAULT_LAYER = 2;
/** Layers that hold real tiles (0-3); 4 is the shadow pen, 5 region ids. */
const MAX_TILE_LAYER = 3;

/** The four stacked tile ids at a cell, upper layer first (z 3,2,1,0). */
function layeredTileIds(map: MapData, x: number, y: number): number[] {
  const ids: number[] = [];
  for (let z = 3; z >= 0; z--) {
    ids.push(map.data[tileIndex(map.width, map.height, x, y, z)] || 0);
  }
  return ids;
}

/** Layered passability + terrain tag of a cell as the map currently stands. */
export function cellPassability(
  map: MapData,
  tileset: Tileset,
  x: number,
  y: number,
): { passable: Passability; terrainTag: number } {
  const flags = layeredTileIds(map, x, y).map((id) => tileset.flags[id] ?? 0);
  return { passable: layeredPassability(flags), terrainTag: layeredTerrainTag(flags) };
}

/** A cell with no walkable direction is impassable ground (water, cliff, wall, …). */
export function isBlocked(p: Passability): boolean {
  return !p.down && !p.left && !p.right && !p.up;
}

/** Step per direction, and the direction pointing back (engine `reverseDir`). */
const STEPS: { dir: keyof Passability; dx: number; dy: number; back: keyof Passability }[] = [
  { dir: 'down', dx: 0, dy: 1, back: 'up' },
  { dir: 'left', dx: -1, dy: 0, back: 'right' },
  { dir: 'right', dx: 1, dy: 0, back: 'left' },
  { dir: 'up', dx: 0, dy: -1, back: 'down' },
];

/**
 * Whole-map "can the player stand here" mask (index `y * width + x`, true =
 * impassable), mirroring `Game_CharacterBase.canPass`: a step from a to its
 * neighbour b needs `isPassable(a, d) && isPassable(b, reverseDir(d))`.
 *
 * Per-cell `isBlocked` is not enough for edge-flagged terrain: MV flags an A4
 * wall top only on its outer edges (an interior top is fully open), so a wall
 * mass is walkable *within* itself but can't be entered from the floor. So:
 *  1. cells with no walkable direction (faces, water, solid objects) are impassable;
 *  2. the rest split into regions joined by open steps; a region is impassable
 *     when it borders at least one walkable cell of another region and every such
 *     border is closed by the region's *own* edge flags (it refuses entry — a
 *     wall-top mass, a stair-less plateau). Ground closed off by someone else's
 *     flags (a room floor ringed by wall tops/faces) stays walkable.
 * Map edges don't count as borders (nothing enters from off-map). A region that
 * only touches fully-blocked cells and map edges can't be told apart from a
 * sealed room by flags alone, so it stays walkable.
 */
export function impassableMask(map: MapData, tileset: Tileset): boolean[] {
  const { width, height } = map;
  const pass: Passability[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pass.push(cellPassability(map, tileset, x, y).passable);
  }
  const blocked = pass.map(isBlocked);

  // Label regions of non-blocked cells joined by steps the engine allows.
  const region = new Array<number>(width * height).fill(-1);
  const regionCells: number[][] = [];
  for (let start = 0; start < region.length; start++) {
    if (blocked[start] || region[start] !== -1) continue;
    const id = regionCells.length;
    const cells = [start];
    region[start] = id;
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      const ax = a % width;
      const ay = Math.floor(a / width);
      for (const { dir, dx, dy, back } of STEPS) {
        const bx = ax + dx;
        const by = ay + dy;
        if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
        const b = by * width + bx;
        if (blocked[b] || region[b] !== -1 || !pass[a][dir] || !pass[b][back]) continue;
        region[b] = id;
        cells.push(b);
      }
    }
    regionCells.push(cells);
  }

  const mask = blocked.slice();
  for (const cells of regionCells) {
    let borders = false;
    let selfSealed = true;
    for (const a of cells) {
      const ax = a % width;
      const ay = Math.floor(a / width);
      for (const { dir, dx, dy } of STEPS) {
        const bx = ax + dx;
        const by = ay + dy;
        if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
        const b = by * width + bx;
        if (blocked[b] || region[b] === region[a]) continue;
        borders = true;
        if (pass[a][dir]) selfSealed = false; // closed by the neighbour, not by us
      }
    }
    if (borders && selfSealed) for (const a of cells) mask[a] = true;
  }
  return mask;
}

/** Per-cell report of what the object did at one footprint cell. */
interface FootprintCell {
  x: number;
  y: number;
  tileId: number;
  /** Resulting layered passability of the cell after the object is placed. */
  passable: Passability;
  /** Terrain tag now reported at the cell. */
  terrainTag: number;
}

interface PlaceObjectResult {
  mapId: number;
  layer: number;
  /** Number of footprint cells actually written (skips 0-holes and out-of-bounds). */
  placed: number;
  footprint: FootprintCell[];
  /** Footprint cells the object turns into a fully-impassable obstacle. */
  collision: { x: number; y: number }[];
  warnings?: string[];
}

/**
 * Stamp a rectangular grid of flat object tiles onto a map layer and report the
 * placement's passability. `tiles` is rows (top→bottom) of tile ids (left→right);
 * a 0 leaves that cell untouched so non-rectangular objects can be described.
 */
async function placeObject(
  projectPath: string,
  mapId: number,
  originX: number,
  originY: number,
  tiles: number[][],
  layer: number,
): Promise<PlaceObjectResult> {
  const width = tiles[0].length;
  if (tiles.some((row) => row.length !== width)) {
    throw new Error('Object grid must be rectangular (every row the same length)');
  }

  const map = await getMap(projectPath, mapId);
  const tileset = await getTileset(projectPath, map.tilesetId);
  const warnings: string[] = [];
  const written: { x: number; y: number; tileId: number }[] = [];

  for (let dy = 0; dy < tiles.length; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const tileId = tiles[dy][dx];
      if (tileId === 0) continue; // transparent hole in the stamp — leave the cell as-is
      const x = originX + dx;
      const y = originY + dy;
      if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
        warnings.push(`(${x}, ${y}) is out of bounds (${map.width}x${map.height}) — skipped`);
        continue;
      }
      if (isAutotile(tileId)) {
        warnings.push(
          `tile ${tileId} at (${x}, ${y}) is an autotile — place_object does not autotile; use paint_tiles for terrain`,
        );
      }
      // Site check against the ground *before* we cover it.
      if (isBlocked(cellPassability(map, tileset, x, y).passable)) {
        warnings.push(`(${x}, ${y}) sits on impassable terrain — object placed over it`);
      }
      const existing = map.data[tileIndex(map.width, map.height, x, y, layer)] || 0;
      if (existing !== 0) {
        warnings.push(`overwrote existing tile ${existing} on layer ${layer} at (${x}, ${y})`);
      }
      map.data[tileIndex(map.width, map.height, x, y, layer)] = tileId;
      written.push({ x, y, tileId });
    }
  }

  // Resulting passability, now that the object tiles are in the stack.
  const footprint: FootprintCell[] = written.map(({ x, y, tileId }) => {
    const { passable, terrainTag } = cellPassability(map, tileset, x, y);
    return { x, y, tileId, passable, terrainTag };
  });
  const collision = footprint.filter((c) => isBlocked(c.passable)).map(({ x, y }) => ({ x, y }));

  // A see-through object tile with no opaque tile beneath shows the map's void
  // (e.g. placed over bare ground with nothing on a lower layer).
  const voidWarning = await baseAwareTransparencyWarning(
    projectPath,
    map,
    tileset,
    written.map((c) => ({ ...c, layer })),
  );
  if (voidWarning) warnings.push(voidWarning);

  await commitChange(getMapPath(projectPath, mapId), map);

  const result: PlaceObjectResult = {
    mapId,
    layer,
    placed: written.length,
    footprint,
    collision,
  };
  return warnings.length > 0 ? { ...result, warnings } : result;
}

// --- object_tiles: expand a top-left flat id into an id grid (P2-5) ----------

/**
 * Flat sheets (A5/B–E) are laid out as two side-by-side 8-wide half-columns, so
 * a sheet is visually 16 tiles wide × 16 tall (256 tiles). A local index maps to
 * a visual (col, row): the first 128 indices fill the left half (cols 0–7), the
 * next 128 the right half (cols 8–15). "The tile below index i" is therefore NOT
 * `i + 16` — these two helpers convert between a local index and its visual cell
 * so a multi-tile object's grid can be reconstructed correctly.
 */
function flatIndexToColRow(localIndex: number): { col: number; row: number } {
  const half = Math.floor(localIndex / 128) % 2; // 0 = left half (cols 0-7), 1 = right (8-15)
  const x = localIndex % 8;
  const row = Math.floor((localIndex % 128) / 8); // 0..15
  return { col: half * 8 + x, row };
}
function flatColRowToIndex(col: number, row: number): number {
  const half = Math.floor(col / 8); // 0 (cols 0-7) or 1 (cols 8-15)
  const x = col % 8;
  return half * 128 + row * 8 + x;
}

/**
 * Expand a top-left flat tile id + a WxH size into the rectangular grid of tile
 * ids that object occupies on the sheet, handling the two-half-column wrap (the
 * fiddly bit `place_object` deferred). Pure (no I/O) so the wrap math is
 * unit-testable. Throws when `topLeftId` isn't a flat id (0/autotile), when it's
 * outside a sheet's 0–255 local range, or when the WxH rectangle runs off the
 * 16×16 sheet.
 */
export function flatObjectGrid(topLeftId: number, width: number, height: number): number[][] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`object_tiles width/height must be positive integers (got ${width}x${height})`);
  }
  const sheet = flatSheet(topLeftId);
  if (topLeftId <= 0 || sheet === null) {
    const why = isAutotile(topLeftId) ? ', an autotile — use paint_tiles for terrain' : '';
    throw new Error(
      `object_tiles needs a flat B/C/D/E/A5 tile id as topLeftId (got ${topLeftId}${why})`,
    );
  }
  const base = TILE_ID[sheet as keyof typeof TILE_ID];
  const local0 = topLeftId - base;
  if (local0 < 0 || local0 > 255) {
    throw new Error(`topLeftId ${topLeftId} is out of sheet ${sheet}'s flat range`);
  }
  const { col: col0, row: row0 } = flatIndexToColRow(local0);
  if (col0 + width > 16 || row0 + height > 16) {
    throw new Error(
      `a ${width}x${height} object at sheet ${sheet} position (col ${col0}, row ${row0}) runs off the 16x16 sheet`,
    );
  }
  const grid: number[][] = [];
  for (let r = 0; r < height; r++) {
    const rowIds: number[] = [];
    for (let c = 0; c < width; c++) {
      rowIds.push(base + flatColRowToIndex(col0 + c, row0 + r));
    }
    grid.push(rowIds);
  }
  return grid;
}

/** Which `tilesetNames` slot each flat sheet occupies (A1–A4 are 0–3). */
const FLAT_SHEET_SLOT: Record<string, number> = { A5: 4, B: 5, C: 6, D: 7, E: 8 };

export const objectToolDefinitions: ToolDefinition[] = [
  {
    name: 'object_tiles',
    description:
      "Expand a top-left flat tile id + a width×height size into the grid of tile ids that object occupies on the sheet — feed the returned `tiles` straight into place_object. This handles the flat sheets' two-half-column layout, where the tile below id N is NOT N+16 (indices 0–127 are the left half of the sheet, 128–255 the right), which is otherwise painful to compute by hand. Get the top-left id from find_tile/get_tile_catalog. Read-only. Throws if topLeftId isn't a flat id or the rectangle runs off the 16×16 sheet; warns if the tileset lacks that sheet.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('The tileset id the object belongs to'),
      topLeftId: z
        .number()
        .int()
        .describe(
          "Raw flat tile id of the object's top-left cell (from find_tile/get_tile_catalog)",
        ),
      width: z.number().int().positive().describe('Object width in tiles'),
      height: z.number().int().positive().describe('Object height in tiles'),
    },
    handler: async (ctx, args) => {
      const tiles = flatObjectGrid(args.topLeftId, args.width, args.height);
      const sheet = flatSheet(args.topLeftId) as TileSheet; // flatObjectGrid validated it
      const tileset = await getTileset(ctx.projectPath, args.tilesetId); // throws if missing
      const sheetName = tileset.tilesetNames[FLAT_SHEET_SLOT[sheet]] ?? '';
      const warnings: string[] = [];
      if (!sheetName) {
        warnings.push(
          `tileset ${args.tilesetId} has no ${sheet} sheet — these ids may not render on it`,
        );
      }
      const result = {
        tilesetId: args.tilesetId,
        sheet,
        sheetName,
        topLeftId: args.topLeftId,
        width: args.width,
        height: args.height,
        tiles,
      };
      return warnings.length > 0 ? { ...result, warnings } : result;
    },
  },
  {
    name: 'place_object',
    mutates: true,
    description:
      "Place a multi-tile B/C object (a house, tree, fountain, …) on a map and report its passability. `tiles` is the object's block of flat tile ids as rows (top to bottom), each row left to right; a 0 leaves that cell untouched so L-shaped/irregular objects work. Stamped onto the upper tile layer (2) by default so it draws over the ground. Unlike paint_tiles this does NOT autotile (objects are flat sheet tiles) — instead it uses the tileset flags to warn when a footprint cell sits on impassable terrain or overwrites an existing tile, and returns the resulting per-cell passability plus the `collision` cells the object turns into a solid obstacle. Warn-by-default: never refuses a placement. Get tile ids from find_tile/get_tile_catalog.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      x: z.number().int().describe('Left (top-left) tile x of where the object is placed'),
      y: z.number().int().describe('Top (top-left) tile y of where the object is placed'),
      tiles: z
        .array(z.array(z.number().int().nonnegative()).min(1))
        .min(1)
        .describe(
          'The object as a rectangular grid of tile ids: rows top→bottom, each row left→right. 0 = a transparent cell (left untouched).',
        ),
      layer: z
        .number()
        .int()
        .min(0)
        .max(MAX_TILE_LAYER)
        .optional()
        .describe(
          'Z-layer 0-3 to stamp onto (default 2 = upper tile layer, drawn over the ground)',
        ),
    },
    handler: (ctx, args) =>
      placeObject(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.tiles,
        args.layer ?? DEFAULT_LAYER,
      ),
  },
];
