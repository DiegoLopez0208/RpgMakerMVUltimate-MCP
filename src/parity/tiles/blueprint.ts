/**
 * Blueprint painting core — the pure half of `paint_blueprint`. A blueprint is
 * a list of equal-length ASCII rows plus a legend mapping each glyph to what the
 * cell holds: `[layer, tileId]` pairs (multi-layer cells, e.g. ground on 0 + a
 * fence autotile on 1) and/or an A3/A4 **wall** whose vertical runs get their
 * bottom cell(s) converted from the wall-top kind to the wall-side (face) kind.
 *
 * Pure (no I/O): the caller resolves catalog names to tile ids first and hands
 * in a {@link LayerAccess} per z-layer; {@link applyBlueprint} writes every
 * layer, derives the wall faces, then recomputes autotile shapes once per layer.
 */
import { LayerAccess, applyAutotiling } from './paint.js';
import {
  AUTOTILE_SLOTS_PER_KIND,
  getAutotileKind,
  isAutotile,
  isRoofTile,
  isWallTopTile,
} from './tileCodec.js';

/** Tile layers 0-3 (4 = shadow pen, 5 = region id — never cleared by a blueprint). */
const TILE_LAYERS = 4;

/**
 * A3/A4 kinds come in bands of 16: kinds `% 16 < 8` are the roof / wall-top row,
 * the next 8 are the matching wall sides. So a top kind's face is exactly
 * 8 kinds (8 × 48 = 384 ids) further on — the offset `isWallTopTile` /
 * `isWallSideTile` in tileCodec encode.
 */
export const WALL_SIDE_KIND_OFFSET = 8;

/** The wall-side (face) tile for an A3 roof / A4 wall-top tile id. */
export function wallSideFor(topTileId: number): number {
  if (!isWallTopTile(topTileId) && !isRoofTile(topTileId)) {
    throw new Error(
      `tile ${topTileId} is not an A4 wall-top or A3 roof autotile — pass the wall's "side" tile explicitly`,
    );
  }
  return topTileId + WALL_SIDE_KIND_OFFSET * AUTOTILE_SLOTS_PER_KIND;
}

/** A resolved wall: top kind everywhere, side kind on the bottom `faceHeight` cells of each vertical run. */
export interface ResolvedWall {
  top: number;
  side: number;
  faceHeight: number;
  layer: number;
}

/** A resolved legend entry: `null` = leave the cell untouched. */
export type ResolvedEntry = null | { tiles: Map<number, number>; wall?: ResolvedWall };

/** Split a row into glyphs (code points, so a non-BMP glyph counts as one cell). */
function glyphsOf(row: string): string[] {
  return Array.from(row);
}

/**
 * Validate a blueprint's shape up front: at least one row, every row the same
 * length, every legend key a single glyph, every glyph in the legend. Collects
 * every problem into one error rather than failing on the first. Returns the
 * glyph grid (rows top→bottom, each left→right).
 */
export function parseBlueprint(rows: string[], legendKeys: string[]): string[][] {
  const problems: string[] = [];
  if (rows.length === 0) throw new Error('blueprint has no rows');
  for (const key of legendKeys) {
    if (glyphsOf(key).length !== 1) problems.push(`legend key "${key}" must be a single character`);
  }
  const grid = rows.map(glyphsOf);
  const width = grid[0].length;
  if (width === 0) problems.push('blueprint rows are empty');
  grid.forEach((row, y) => {
    if (row.length !== width) {
      problems.push(`row ${y} has ${row.length} cells, expected ${width} (row 0's length)`);
    }
  });
  const known = new Set(legendKeys);
  const unknown = new Map<string, [number, number]>();
  grid.forEach((row, y) =>
    row.forEach((g, x) => {
      if (!known.has(g) && !unknown.has(g)) unknown.set(g, [x, y]);
    }),
  );
  for (const [g, [x, y]] of unknown) {
    problems.push(`glyph "${g}" (first at column ${x}, row ${y}) is not in the legend`);
  }
  if (problems.length) throw new Error(`Invalid blueprint:\n- ${problems.join('\n- ')}`);
  return grid;
}

/** Per-layer outcome of an applied blueprint. */
export interface BlueprintStats {
  /** Cells written per layer (keyed by layer number). */
  painted: Record<number, number>;
  /** Tile-layer cells zeroed by `clearUpperLayers`. */
  cleared: number;
  /** Wall cells converted from top to side (face) kind. */
  wallFaces: number;
  /** Every cell written (painted or cleared), with its layer and final pre-autotile id. */
  cells: { x: number; y: number; layer: number; tileId: number }[];
}

/**
 * Write a parsed blueprint onto a map via per-layer accessors.
 *
 * 1. Each cell's layers are set; with `clearUpperLayers`, every tile layer (0-3)
 *    **above the cell's lowest specified layer** that the cell doesn't specify is
 *    zeroed (all four when the entry specifies none — `[]` erases the cell).
 * 2. Wall faces: a wall cell ends its vertical run when the cell below — as the
 *    map now stands — isn't that wall's top or side kind on the wall layer. Off
 *    the map's bottom edge counts as the run continuing (no face). The bottom
 *    `faceHeight` cells of each run (only blueprint cells of the same wall)
 *    become the side kind.
 * 3. Autotile shapes are recomputed once per touched layer (painted + cleared
 *    cells and their neighbour rings).
 */
export function applyBlueprint(
  layerOf: (layer: number) => LayerAccess,
  grid: string[][],
  legend: Record<string, ResolvedEntry>,
  originX: number,
  originY: number,
  clearUpperLayers: boolean,
): BlueprintStats {
  const painted: Record<number, number> = {};
  const touched = new Map<number, { x: number; y: number }[]>();
  const touch = (layer: number, x: number, y: number) => {
    const list = touched.get(layer) ?? [];
    list.push({ x, y });
    touched.set(layer, list);
  };
  let cleared = 0;

  grid.forEach((row, dy) =>
    row.forEach((glyph, dx) => {
      const entry = legend[glyph];
      if (!entry) return;
      const x = originX + dx;
      const y = originY + dy;
      for (const [layer, tileId] of entry.tiles) {
        layerOf(layer).set(x, y, tileId);
        painted[layer] = (painted[layer] ?? 0) + 1;
        touch(layer, x, y);
      }
      if (clearUpperLayers) {
        const lowest = Math.min(TILE_LAYERS, ...entry.tiles.keys());
        const from = entry.tiles.size === 0 ? 0 : lowest + 1;
        for (let layer = from; layer < TILE_LAYERS; layer++) {
          if (entry.tiles.has(layer)) continue;
          const access = layerOf(layer);
          if (access.get(x, y) === 0) continue;
          access.set(x, y, 0);
          cleared++;
          touch(layer, x, y);
        }
      }
    }),
  );

  // Wall faces — decided after every layer is written, so "the cell below"
  // reflects the blueprint itself (and the existing map past its edge).
  const faces: { x: number; y: number; wall: ResolvedWall }[] = [];
  const height = grid.length;
  grid.forEach((row, dy) =>
    row.forEach((glyph, dx) => {
      const wall = legend[glyph]?.wall;
      if (!wall) return;
      const access = layerOf(wall.layer);
      const x = originX + dx;
      const below = originY + dy + 1;
      if (below >= access.height) return; // run continues off the map's bottom edge
      const belowKind = isAutotile(access.get(x, below))
        ? getAutotileKind(access.get(x, below))
        : -1;
      if (belowKind === getAutotileKind(wall.top) || belowKind === getAutotileKind(wall.side)) {
        return; // not the bottom of the run
      }
      for (let k = 0; k < wall.faceHeight && dy - k >= 0 && dy - k < height; k++) {
        if (legend[grid[dy - k][dx]]?.wall !== wall) break;
        faces.push({ x, y: originY + dy - k, wall });
      }
    }),
  );
  for (const { x, y, wall } of faces) {
    layerOf(wall.layer).set(x, y, wall.side);
  }

  for (const [layer, cells] of touched) applyAutotiling(layerOf(layer), cells);

  const cells: BlueprintStats['cells'] = [];
  for (const [layer, list] of touched) {
    const access = layerOf(layer);
    for (const { x, y } of list) cells.push({ x, y, layer, tileId: access.get(x, y) });
  }
  return { painted, cleared, wallFaces: faces.length, cells };
}
