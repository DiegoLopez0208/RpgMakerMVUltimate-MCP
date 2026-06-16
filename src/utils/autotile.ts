/**
 * autotile.ts — RPG Maker MV autotile shape computation.
 *
 * MV stores an autotile as `tileId = 2048 + kind*48 + shape`, where `shape`
 * (0-47) encodes how the tile borders its neighbours. Painting a solid region
 * with shape 0 produces a flat texture with no shorelines, edges or corners —
 * the map looks "wrong" even when the tile family is correct. This module
 * recomputes the correct shape for every autotile cell from its 8 neighbours.
 *
 * The shape lookup tables were derived empirically from the 106 bundled
 * reference maps (knowledge/maps): for every autotile cell the neighbour
 * configuration was measured and mapped to the artist/editor-assigned shape,
 * then the dominant shape per configuration was taken. This reproduces MV's
 * autotiler from ground truth rather than a hand-transcribed table, and was
 * validated to round-trip the reference maps (see tests).
 */

// ── Tile classification ───────────────────────────────────────────
export const TILE_ID_A1 = 2048;

export function isAutotile(tileId: number): boolean {
  return tileId >= TILE_ID_A1;
}

/** Global autotile kind (A1 0-15, A2 16-47, A3 48-79, A4 80-127). */
export function autotileKind(tileId: number): number {
  return Math.floor((tileId - TILE_ID_A1) / 48);
}

export function autotileShape(tileId: number): number {
  return (tileId - TILE_ID_A1) % 48;
}

/**
 * Floor-type autotiles border on all 8 directions (A1 water, A2 ground/floors).
 * A3 roofs/exterior walls are cardinal-only wall-type. A4 interior walls are a
 * separate "tall wall" type (see computeA4WallShape).
 */
export function isFloorType(tileId: number): boolean {
  return autotileKind(tileId) < 48; // A1, A2
}

export function isA4Wall(tileId: number): boolean {
  return autotileKind(tileId) >= 80; // A4 interior wall/floor sheet
}

// ── Shape tables (derived from reference maps) ────────────────────
// Key: normalised neighbour bitmask. Value: MV shape 0-47.

// Floor-type: 8-bit mask. Bits 0-3 = N,E,S,W (same kind). Bits 4-7 =
// NE,SE,SW,NW, each set ONLY when both adjacent cardinals are also same
// (a diagonal is irrelevant when an edge already borders it — MV's rule).
const FLOOR_SHAPE: Record<number, number> = {
  0: 46, 1: 44, 2: 43, 3: 41, 4: 42, 5: 32, 6: 35, 7: 19, 8: 45, 9: 39,
  10: 33, 11: 31, 12: 37, 13: 27, 14: 23, 15: 15, 19: 40, 23: 18, 27: 29,
  31: 13, 38: 34, 39: 17, 46: 22, 47: 11, 55: 16, 63: 9, 76: 36, 77: 26,
  78: 21, 79: 7, 95: 5, 110: 20, 111: 3, 127: 1, 137: 38, 139: 30, 141: 25,
  143: 14, 155: 28, 159: 12, 175: 10, 191: 8, 205: 24, 207: 6, 223: 4,
  239: 2, 255: 0
};

// Wall-type (A3 roofs/exterior walls): 4-bit cardinal mask N,E,S,W → shape.
// Clean bijection (all-same interior cell is shape 0, isolated cell shape 15).
const WALL_SHAPE: number[] = [15, 13, 11, 9, 7, 5, 3, 1, 14, 12, 10, 8, 6, 4, 2, 0];

// A4 interior walls render as a pseudo-3D vertical structure: a top cap (no
// wall above), a repeating body, and a bottom face (no wall below). The shape
// can't be recovered from a flat 8-neighbour mask — it depends on the cell's
// vertical zone within the wall — so it is keyed by (zone, wallEast, wallWest).
// Zones: 0 TOP (!n), 1 BODY (n&&s), 2 FACE (n&&!s), 3 SINGLE (!n&&!s).
// Derived from the bundled maps; the high-traffic fills/edges/corners are
// 86-91% confident, mixed junctions less so (a heuristic, ~70% overall, vs the
// near-exact A1/A2/A3 tables — but far better than the flat shape 0 it replaces).
const A4_WALL_SHAPE: number[] = [7, 3, 6, 2, 32, 16, 24, 0, 13, 9, 12, 8, 46, 43, 45, 33];

export function computeA4WallShape(n: boolean, e: boolean, s: boolean, w: boolean): number {
  const zone = (!n && !s) ? 3 : !n ? 0 : !s ? 2 : 1;
  return A4_WALL_SHAPE[zone * 4 + (e ? 1 : 0) + (w ? 2 : 0)];
}

/**
 * Compute the autotile shape for a cell given which of its 8 neighbours are
 * the SAME autotile kind. Directions are booleans.
 */
export function computeShape(
  floorType: boolean,
  n: boolean, e: boolean, s: boolean, w: boolean,
  ne: boolean, se: boolean, sw: boolean, nw: boolean
): number {
  const cardinal = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
  if (!floorType) return WALL_SHAPE[cardinal];

  // A diagonal only matters when both adjacent cardinals are also same.
  const NE = ne && n && e, SE = se && s && e, SW = sw && s && w, NW = nw && n && w;
  const mask = cardinal | (NE ? 16 : 0) | (SE ? 32 : 0) | (SW ? 64 : 0) | (NW ? 128 : 0);
  const shape = FLOOR_SHAPE[mask];
  return shape === undefined ? 0 : shape;
}

/**
 * Recompute autotile shapes in-place for tile layers 0-3 of an MV map data
 * array, so every autotile borders its neighbours correctly. Off-map cells
 * count as the same kind (MV extends autotiles past the map edge), so borders
 * render as interior rather than as a hard cut. Non-autotile tiles, shadow
 * (layer 4) and region (layer 5) layers are left untouched.
 */
export function applyAutotileShapes(data: number[], width: number, height: number): void {
  const layerSize = width * height;
  for (let layer = 0; layer < 4; layer++) {
    const base = layer * layerSize;
    // Snapshot the layer so neighbour lookups use original kinds, not
    // shapes we have already rewritten this pass.
    const orig = data.slice(base, base + layerSize);
    const kindAt = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= width || y >= height) return -1; // off-map sentinel
      const id = orig[y * width + x];
      return id >= TILE_ID_A1 ? autotileKind(id) : -2; // -2 = not an autotile
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = orig[y * width + x];
        if (id < TILE_ID_A1) continue;
        const k = autotileKind(id);
        const same = (nx: number, ny: number): boolean => {
          const nk = kindAt(nx, ny);
          return nk === -1 /* off-map */ || nk === k;
        };
        const n = same(x, y - 1), e = same(x + 1, y), s = same(x, y + 1), w = same(x - 1, y);
        let shape: number;
        if (k >= 80) {
          // A4 interior wall — pseudo-3D vertical structure.
          shape = computeA4WallShape(n, e, s, w);
        } else {
          shape = computeShape(
            isFloorType(id), n, e, s, w,
            same(x + 1, y - 1), same(x + 1, y + 1), same(x - 1, y + 1), same(x - 1, y - 1)
          );
        }
        data[base + y * width + x] = TILE_ID_A1 + k * 48 + shape;
      }
    }
  }
}
