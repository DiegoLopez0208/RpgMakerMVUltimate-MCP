/**
 * engine.ts — RPG Maker MV engine ground truth.
 *
 * Tile-type predicates transcribed verbatim from the engine's rpg_core.js
 * (Tilemap.*), so the MCP classifies autotiles exactly as the engine does
 * instead of guessing. The DB templates are baked by scripts/extract-engine.mjs
 * into engineDefaults.ts.
 */

export const TILE_ID_A5 = 1536;
export const TILE_ID_A1 = 2048;
export const TILE_ID_A2 = 2816;
export const TILE_ID_A3 = 4352;
export const TILE_ID_A4 = 5888;
export const TILE_ID_MAX = 8192;

export function isAutotile(id: number): boolean { return id >= TILE_ID_A1; }
export function autotileKind(id: number): number { return Math.floor((id - TILE_ID_A1) / 48); }
export function autotileShape(id: number): number { return (id - TILE_ID_A1) % 48; }
export function isTileA1(id: number): boolean { return id >= TILE_ID_A1 && id < TILE_ID_A2; }
export function isTileA2(id: number): boolean { return id >= TILE_ID_A2 && id < TILE_ID_A3; }
export function isTileA3(id: number): boolean { return id >= TILE_ID_A3 && id < TILE_ID_A4; }
export function isTileA4(id: number): boolean { return id >= TILE_ID_A4 && id < TILE_ID_MAX; }
export function isTileA5(id: number): boolean { return id >= TILE_ID_A5 && id < TILE_ID_A1; }

// Tilemap.isWaterfallTile: every odd A1 kind from 4 on (5, 7, 9, 11, 13, 15) is a waterfall
// (rpg_core: tileId >= TILE_ID_A1 + 192 && tileId < TILE_ID_A2 && kind % 2 === 1).
export function isWaterfallTile(id: number): boolean {
  if (isTileA1(id)) { const k = autotileKind(id); return k % 2 === 1 && k >= 4; }
  return false;
}
export function isRoofTile(id: number): boolean { return isTileA3(id) && autotileKind(id) % 16 < 8; }
export function isWallTopTile(id: number): boolean { return isTileA4(id) && autotileKind(id) % 16 < 8; }
export function isWallSideTile(id: number): boolean { return (isTileA3(id) || isTileA4(id)) && autotileKind(id) % 16 >= 8; }

/** Floor-type autotiles border on all 8 directions (A1 non-waterfall, A2, A4 wall-tops). */
export function isFloorTypeAutotile(id: number): boolean {
  return (isTileA1(id) && !isWaterfallTile(id)) || isTileA2(id) || isWallTopTile(id);
}
/** Wall-type autotiles border on the 4 cardinals only (A3 roofs, A4 wall-sides). */
export function isWallTypeAutotile(id: number): boolean {
  return isRoofTile(id) || isWallSideTile(id);
}

