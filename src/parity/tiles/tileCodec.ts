/**
 * RPG Maker MV tile-ID codec.
 *
 * A raw map tile is a single integer that encodes *which tileset sheet* it comes
 * from and, for autotiles, *which "kind"* (a themed autotile, e.g. a grass or
 * water set) and *which of the 48 shape slots* within that kind. None of that is
 * legible from the integer alone — this module is the decode/encode layer every
 * higher tile tool (catalog, autotile calculator, paint commands) builds on.
 *
 * All functions are pure (no I/O) and mirror the engine's own `Tilemap` helpers
 * in `rpg_core.js` name-for-name, so anyone cross-referencing the core script
 * recognises them. Constants and boundaries are taken verbatim from the engine
 * (MV corescript v1.6.2).
 */

/**
 * Base ids for each region of the tile-id number line. A tile id `>=` one base
 * and `<` the next belongs to that sheet. Autotile sheets (A1–A4) pack 48 shape
 * slots per "kind"; A5/B/C/D/E are flat sheets of single tiles.
 */
export const TILE_ID = {
  B: 0,
  C: 256,
  D: 512,
  E: 768,
  A5: 1536,
  A1: 2048,
  A2: 2816,
  A3: 4352,
  A4: 5888,
  MAX: 8192,
} as const;

/** Number of shape slots a single autotile "kind" occupies (47 usable + 1). */
export const AUTOTILE_SLOTS_PER_KIND = 48;

/** The tilesets image sheets a tile id can come from. */
export type TileSheet = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'B' | 'C' | 'D' | 'E';

/** The three autotile geometries — each picks a different shape table (see 3b). */
export type AutotileType = 'floor' | 'wall' | 'waterfall';

// --- Core autotile arithmetic (mirrors Tilemap.*) --------------------------

/** True if the tile id is an autotile (A1–A4), i.e. shape-driven by neighbours. */
export function isAutotile(tileId: number): boolean {
  return tileId >= TILE_ID.A1;
}

/** The autotile "kind" (which themed set), or a nonsense value for non-autotiles. */
export function getAutotileKind(tileId: number): number {
  return Math.floor((tileId - TILE_ID.A1) / AUTOTILE_SLOTS_PER_KIND);
}

/** The shape slot 0–47 within the kind (which of the 48 adjacency variants). */
export function getAutotileShape(tileId: number): number {
  return (tileId - TILE_ID.A1) % AUTOTILE_SLOTS_PER_KIND;
}

/** Rebuild a tile id from an autotile kind + shape slot. Inverse of the two above. */
export function makeAutotileId(kind: number, shape: number): number {
  return TILE_ID.A1 + kind * AUTOTILE_SLOTS_PER_KIND + shape;
}

/**
 * Whether two tiles are "the same kind" for autotile-adjacency purposes: same
 * autotile kind if both are autotiles, else an exact id match. This is the
 * predicate the shape calculator (3b) uses to decide if a neighbour connects.
 */
export function isSameKindTile(a: number, b: number): boolean {
  if (isAutotile(a) && isAutotile(b)) {
    return getAutotileKind(a) === getAutotileKind(b);
  }
  return a === b;
}

// --- Sheet classification (mirrors Tilemap.isTileA1 … isTileA5) -------------

export function isTileA1(tileId: number): boolean {
  return tileId >= TILE_ID.A1 && tileId < TILE_ID.A2;
}
export function isTileA2(tileId: number): boolean {
  return tileId >= TILE_ID.A2 && tileId < TILE_ID.A3;
}
export function isTileA3(tileId: number): boolean {
  return tileId >= TILE_ID.A3 && tileId < TILE_ID.A4;
}
export function isTileA4(tileId: number): boolean {
  return tileId >= TILE_ID.A4 && tileId < TILE_ID.MAX;
}
export function isTileA5(tileId: number): boolean {
  return tileId >= TILE_ID.A5 && tileId < TILE_ID.A1;
}

// --- Autotile sub-type predicates (mirrors Tilemap.*) ----------------------

/** A1 water autotiles: the animated sea/lake sets (kinds without a waterfall). */
export function isWaterTile(tileId: number): boolean {
  if (!isTileA1(tileId)) return false;
  return !(tileId >= TILE_ID.A1 + 96 && tileId < TILE_ID.A1 + 192);
}

/** A1 waterfall autotiles: the vertically-tiling falls (odd kinds in the fall band). */
export function isWaterfallTile(tileId: number): boolean {
  if (tileId >= TILE_ID.A1 + 192 && tileId < TILE_ID.A2) {
    return getAutotileKind(tileId) % 2 === 1;
  }
  return false;
}

/** A3 roof autotiles (the upper half of each A3 kind pair). */
export function isRoofTile(tileId: number): boolean {
  return isTileA3(tileId) && getAutotileKind(tileId) % 16 < 8;
}

/** A4 wall-top autotiles (floor-type tops that cap a wall). */
export function isWallTopTile(tileId: number): boolean {
  return isTileA4(tileId) && getAutotileKind(tileId) % 16 < 8;
}

/** A3/A4 wall-side autotiles (the vertical wall faces). */
export function isWallSideTile(tileId: number): boolean {
  return (isTileA3(tileId) || isTileA4(tileId)) && getAutotileKind(tileId) % 16 >= 8;
}

/**
 * The autotile geometry of a tile — which of the three shape tables governs it —
 * or `null` for non-autotiles. Floor-type: A1 water/ground, A2, and A4 wall
 * tops (tile in all 8 directions, 47 shapes). Wall-type: A3 roofs and A3/A4 wall
 * sides (tile with the 16-shape wall table). Waterfall-type: A1 falls (4 shapes).
 */
export function autotileType(tileId: number): AutotileType | null {
  if (!isAutotile(tileId)) return null;
  if (isWaterfallTile(tileId)) return 'waterfall';
  if (isRoofTile(tileId) || isWallSideTile(tileId)) return 'wall';
  // Floor-type: A1 (non-waterfall), A2, and A4 wall tops.
  if ((isTileA1(tileId) && !isWaterfallTile(tileId)) || isTileA2(tileId) || isWallTopTile(tileId)) {
    return 'floor';
  }
  // A3 roofs are handled above; anything left (shouldn't occur) is floor-ish.
  return 'floor';
}

// --- High-level decode ------------------------------------------------------

/** Which flat sheet a non-autotile id belongs to, or `null` if it's an autotile. */
export function flatSheet(tileId: number): TileSheet | null {
  if (isAutotile(tileId)) return null;
  if (isTileA5(tileId)) return 'A5';
  if (tileId >= TILE_ID.E && tileId < TILE_ID.A5) return 'E';
  if (tileId >= TILE_ID.D) return 'D';
  if (tileId >= TILE_ID.C) return 'C';
  if (tileId >= TILE_ID.B) return 'B';
  return null;
}

/** The base id for a flat sheet, used to compute an index within that sheet. */
function flatSheetBase(sheet: TileSheet): number {
  return TILE_ID[sheet as keyof typeof TILE_ID];
}

/** A fully decoded view of a raw tile id — the shape `describe_tile` returns. */
export interface DecodedTile {
  tileId: number;
  /** tileId 0 is the "no tile" marker (a blank cell on that layer). */
  empty: boolean;
  sheet: TileSheet | null;
  /** Index within its sheet (autotile kind for A1–A4, else offset from sheet base). */
  sheetIndex: number;
  autotile: boolean;
  kind?: number;
  shape?: number;
  autotileType?: AutotileType;
}

/** Which A-sheet an autotile kind lives on, from its raw id. */
function autotileSheet(tileId: number): TileSheet {
  if (isTileA1(tileId)) return 'A1';
  if (isTileA2(tileId)) return 'A2';
  if (isTileA3(tileId)) return 'A3';
  return 'A4';
}

/**
 * Decode a raw tile id into its sheet, kind/shape and autotile geometry. This is
 * the single lens the `describe_tile` tool exposes and that the catalog builds
 * meanings on top of.
 */
export function decodeTile(tileId: number): DecodedTile {
  if (tileId === 0) {
    return { tileId, empty: true, sheet: 'B', sheetIndex: 0, autotile: false };
  }
  if (isAutotile(tileId)) {
    const sheet = autotileSheet(tileId);
    return {
      tileId,
      empty: false,
      sheet,
      sheetIndex: getAutotileKind(tileId),
      autotile: true,
      kind: getAutotileKind(tileId),
      shape: getAutotileShape(tileId),
      autotileType: autotileType(tileId) ?? undefined,
    };
  }
  const sheet = flatSheet(tileId);
  return {
    tileId,
    empty: false,
    sheet,
    sheetIndex: sheet ? tileId - flatSheetBase(sheet) : tileId,
    autotile: false,
  };
}

/** Reject values which cannot represent an MV tile, shadow mask or region ID. */
export function assertLayerTileValue(layer: number, value: number): void {
  if (!Number.isInteger(layer) || layer < 0 || layer > 5) {
    throw new Error('Map layer must be an integer from 0 to 5');
  }
  const maximum = layer === 4 ? 15 : layer === 5 ? 255 : TILE_ID.MAX - 1;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Layer ${layer} value must be an integer from 0 to ${maximum}`);
  }
}
