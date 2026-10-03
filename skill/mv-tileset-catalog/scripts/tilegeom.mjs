/**
 * RPG Maker MV tileset-sheet geometry: where, in pixels, each tile's
 * representative sample lives on its sheet PNG.
 *
 * Mirrors `Tilemap.prototype._addAutotile` / `_addNormalTile` from rpg_core.js
 * (v1.6.2) verbatim, restricted to the *static shape-0* (fully-surrounded)
 * appearance of each autotile kind — the exact tile a paint command places as an
 * autotile base — plus the flat-sheet grid formula. Tiles are 48px; autotile
 * quarters are 24px. Everything here is pure integer arithmetic.
 */

export const TILE = 48;
const Q = TILE / 2; // 24 — autotile quarter size

// Shape-0 (all-neighbours-connected) quarter source coords [TL,TR,BL,BR], in
// 24px units, from the engine's *_AUTOTILE_TABLE first entries.
const FLOOR0 = [
  [2, 4],
  [1, 4],
  [2, 3],
  [1, 3],
];
const WALL0 = [
  [2, 2],
  [1, 2],
  [2, 1],
  [1, 1],
];
const WATERFALL0 = [
  [2, 0],
  [1, 0],
  [2, 1],
  [1, 1],
];

/** First autotile kind on each A-sheet. */
export const BASE_KIND = { A1: 0, A2: 16, A3: 48, A4: 80 };

/** Sheet dimensions (tiles) → kind count, matching the engine block layout. */
export function autotileKindCount(role, widthPx, heightPx) {
  const cols = Math.floor(widthPx / TILE);
  const rows = Math.floor(heightPx / TILE);
  switch (role) {
    case 'A1':
      return 16; // fixed special layout (water/waterfall blocks)
    case 'A2':
      return Math.floor(cols / 2) * Math.floor(rows / 3); // 96×144 blocks
    case 'A3':
      return Math.floor(cols / 2) * Math.floor(rows / 2); // 96×96 blocks
    case 'A4':
      return Math.floor(cols / 2) * Math.floor((rows / 120) * TILE); // 96×120 blocks
    default:
      return 0;
  }
}

/**
 * For an autotile `kind`, return `{ table, quarters:[[sx,sy]×4] }` giving the
 * top-left pixel of each 24px source quarter for its shape-0 sample. Reproduces
 * the engine's bx/by block math for A1–A4.
 */
export function autotileSample(kind) {
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  let bx = 0;
  let by = 0;
  let table = FLOOR0;
  if (kind < 16) {
    // A1 (animated water / waterfall). Static frame 0 (waterSurfaceIndex 0).
    if (kind === 0) {
      bx = 0;
      by = 0;
    } else if (kind === 1) {
      bx = 0;
      by = 3;
    } else if (kind === 2) {
      bx = 6;
      by = 0;
    } else if (kind === 3) {
      bx = 6;
      by = 3;
    } else {
      bx = Math.floor(tx / 4) * 8;
      by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
      if (kind % 2 === 0) {
        // water: bx += waterSurfaceIndex(0)
      } else {
        bx += 6; // waterfall
        table = WATERFALL0;
      }
    }
  } else if (kind < 48) {
    // A2 ground: bx = tx*2, by = (ty-2)*3
    bx = tx * 2;
    by = (ty - 2) * 3;
  } else if (kind < 80) {
    // A3 buildings/walls: bx = tx*2, by = (ty-6)*2, WALL table
    bx = tx * 2;
    by = (ty - 6) * 2;
    table = WALL0;
  } else {
    // A4 walls: alternating wall-top (even ty, FLOOR) / wall-side (odd ty, WALL)
    bx = tx * 2;
    by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
    if (ty % 2 === 1) table = WALL0;
  }
  const quarters = table.map(([qsx, qsy]) => [(bx * 2 + qsx) * Q, (by * 2 + qsy) * Q]);
  return { quarters };
}

/**
 * Flat-sheet (A5/B–E) tile → top-left pixel of its 48px cell. Mirrors
 * `_addNormalTile`: each sheet is two side-by-side 8-wide half-columns.
 */
export function flatSample(localIndex) {
  const col = (Math.floor(localIndex / 128) % 2) * 8 + (localIndex % 8);
  const row = Math.floor((localIndex % 256) / 8) % 16;
  return { sx: col * TILE, sy: row * TILE };
}

/** How many flat tiles a sheet of the given pixel size holds. */
export function flatTileCount(widthPx, heightPx) {
  return (widthPx / TILE) * (heightPx / TILE);
}
