/**
 * autotile.ts — RPG Maker MV autotile shape computation.
 *
 * MV stores an autotile as `tileId = 2048 + kind*48 + shape`, where `shape`
 * (0-47) encodes how the tile borders its neighbours. Painting a solid region
 * with shape 0 produces a flat texture with no shorelines, edges or corners.
 * This module recomputes the correct shape for every autotile cell from its
 * neighbours.
 *
 * Classification (floor-type vs wall-type, wall-top vs wall-side) comes from the
 * engine's own predicates in engine.ts (transcribed from rpg_core.js), so it
 * matches RPG Maker MV exactly — in particular A4 wall-TOPS are floor-type
 * (8-neighbour) and A4 wall-SIDES are wall-type (4-cardinal), which a naive
 * even/odd split got wrong. The neighbour→shape lookup tables themselves were
 * mined from the 106 reference maps (the engine ships shape→pixel tables, not
 * the inverse the editor uses); validated to round-trip the maps at A1 97% /
 * A2 99% / A3 93% / A4 wall-top 95% / A4 wall-side 87%.
 */
import {
  TILE_ID_A1, isAutotile, autotileKind, autotileShape,
  isFloorTypeAutotile, isWallTypeAutotile,
} from './engine.js';

export { TILE_ID_A1, isAutotile, autotileKind, autotileShape } from './engine.js';

// Floor-type neighbour→shape: 8-bit mask. Bits 0-3 = N,E,S,W (same kind).
// Bits 4-7 = NE,SE,SW,NW, each set ONLY when both adjacent cardinals are also
// same (a diagonal is irrelevant when an edge already borders it — MV's rule).
const FLOOR_SHAPE: Record<number, number> = {
  0: 46, 1: 44, 2: 43, 3: 41, 4: 42, 5: 32, 6: 35, 7: 19, 8: 45, 9: 39,
  10: 33, 11: 31, 12: 37, 13: 27, 14: 23, 15: 15, 19: 40, 23: 18, 27: 29,
  31: 13, 38: 34, 39: 17, 46: 22, 47: 11, 55: 16, 63: 9, 76: 36, 77: 26,
  78: 21, 79: 7, 95: 5, 110: 20, 111: 3, 127: 1, 137: 38, 139: 30, 141: 25,
  143: 14, 155: 28, 159: 12, 175: 10, 191: 8, 205: 24, 207: 6, 223: 4,
  239: 2, 255: 0
};

// Wall-type (A3 roofs, A4 wall-sides): 4-bit cardinal mask N,E,S,W → shape.
const WALL_SHAPE: number[] = [15, 13, 11, 9, 7, 5, 3, 1, 14, 12, 10, 8, 6, 4, 2, 0];

/**
 * Compute the autotile shape for a cell given which of its 8 neighbours are the
 * SAME autotile kind, and the tile's engine type.
 */
export function computeShape(
  floorType: boolean,
  n: boolean, e: boolean, s: boolean, w: boolean,
  ne: boolean, se: boolean, sw: boolean, nw: boolean
): number {
  const cardinal = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
  if (!floorType) return WALL_SHAPE[cardinal];
  const NE = ne && n && e, SE = se && s && e, SW = sw && s && w, NW = nw && n && w;
  const mask = cardinal | (NE ? 16 : 0) | (SE ? 32 : 0) | (SW ? 64 : 0) | (NW ? 128 : 0);
  const shape = FLOOR_SHAPE[mask];
  return shape === undefined ? 0 : shape;
}

/**
 * Recompute autotile shapes in-place for tile layers 0-3 of an MV map data
 * array. Off-map cells count as the same kind (MV extends autotiles past the
 * edge). Waterfall autotiles (A1 kinds 4-7) and non-autotiles are left as-is;
 * shadow (layer 4) and region (layer 5) are untouched.
 */
export function applyAutotileShapes(data: number[], width: number, height: number): void {
  const layerSize = width * height;
  for (let layer = 0; layer < 4; layer++) {
    const base = layer * layerSize;
    const orig = data.slice(base, base + layerSize);
    const kindAt = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= width || y >= height) return -1; // off-map sentinel
      const id = orig[y * width + x];
      return id >= TILE_ID_A1 ? autotileKind(id) : -2; // -2 = not an autotile
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = orig[y * width + x];
        if (!isAutotile(id)) continue;
        const floor = isFloorTypeAutotile(id);
        const wall = isWallTypeAutotile(id);
        if (!floor && !wall) continue; // waterfalls etc. — leave untouched
        const k = autotileKind(id);
        const same = (nx: number, ny: number): boolean => {
          const nk = kindAt(nx, ny);
          return nk === -1 /* off-map */ || nk === k;
        };
        const n = same(x, y - 1), e = same(x + 1, y), s = same(x, y + 1), w = same(x - 1, y);
        const shape = computeShape(
          floor, n, e, s, w,
          same(x + 1, y - 1), same(x + 1, y + 1), same(x - 1, y + 1), same(x - 1, y - 1)
        );
        data[base + y * width + x] = TILE_ID_A1 + k * 48 + shape;
      }
    }
  }
}
