/**
 * semantic.ts — the tile-agnostic vocabulary that decouples a map's LAYOUT from
 * the ART it is drawn with.
 *
 * The bundled reference maps are raw MV map JSON, so a template only works when
 * the project uses the same tileset the template was authored against: the tile
 * IDs are indices into one specific set of sheets. Change the tileset and the
 * map turns to noise.
 *
 * A semantic template stores what each cell *is* — ground, wall, water, a door,
 * a prop anchor — and a TilesetProfile says which concrete tile ID plays each
 * role in a given tileset. Materialising a template against a profile produces a
 * real map, so one layout can be a stone dungeon, a sci-fi corridor or a snow
 * fort, and third-party tilesets work as soon as someone (or the miner) fills in
 * a profile for them.
 */

import {
  autotileKind, isAutotile, isTileA1, isTileA2, isTileA5,
  isRoofTile, isWallTopTile, isWallSideTile, isWaterfallTile,
} from '../utils/engine.js';

/**
 * The token vocabulary. Deliberately small: every token must be answerable for
 * any tileset, including a custom one, or a profile cannot be written for it.
 */
export const SEMANTIC_TOKENS = [
  'void',      // nothing painted — off-limits, not even a floor
  'ground',    // the default walkable surface (A2 grass, dirt, stone floor)
  'ground_alt',// a second walkable surface used for paths and patches (A5/B-E)
  'water',     // impassable liquid (A1 surfaces)
  'waterfall', // animated vertical water (A1 kinds 4-7)
  'wall',      // wall side — what the player sees face-on and cannot cross
  'wall_top',  // the top surface of a wall or cliff (A4 wall-top)
  'roof',      // A3 roof, the top of a building
  'prop',      // a decoration on an upper layer; its identity lives in the stamp
  'door',      // a cell an event transfers the player through
  'poi',       // a cell the player interacts with (shop, sign, chest, NPC)
] as const;

export type SemanticToken = typeof SEMANTIC_TOKENS[number];

export function isSemanticToken(v: unknown): v is SemanticToken {
  return typeof v === 'string' && (SEMANTIC_TOKENS as readonly string[]).includes(v);
}

/** One prop instance: a multi-tile object kept whole rather than shredded. */
export interface SemanticProp {
  /** Anchor in template coordinates (top-left of the bounding box). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Cells relative to the anchor: [dx, dy, layer, tileId]. */
  cells: [number, number, number, number][];
  /** Stable identity so the same object can be recognised across maps. */
  signature: string;
}

/** A layout with no art attached. */
export interface SemanticTemplate {
  id: string;
  name: string;
  /** Which project map this came from, when mined rather than authored. */
  sourceMapId?: number;
  /** The tileset it was observed on, which is the profile most likely to fit. */
  sourceTilesetId?: number;
  width: number;
  height: number;
  /** Row-major, width*height tokens. */
  grid: SemanticToken[];
  props: SemanticProp[];
  /** Cells worth annotating: doors, shops, chests, spawn points. */
  markers: { x: number; y: number; role: string; note?: string }[];
}

/**
 * Which concrete tile ID plays each role in one tileset. Autotiles are stored as
 * the base ID for shape 0; the shape is recomputed by applyAutotileShapes after
 * the grid is laid down, which is the only correct order — the shape is a
 * consequence of the neighbourhood, never a free choice.
 */
export interface TilesetProfile {
  tilesetId: number;
  tilesetName?: string;
  /** token -> base tile ID. A token with no entry is skipped when materialising. */
  tiles: Partial<Record<SemanticToken, number>>;
  /** How many cells each mapping was observed on, so a better sample can win. */
  confidence: Partial<Record<SemanticToken, number>>;
}

export function emptyProfile(tilesetId: number, tilesetName?: string): TilesetProfile {
  return { tilesetId, tilesetName, tiles: {}, confidence: {} };
}

/**
 * Classify one cell into a token.
 *
 * `lower` is the tile on layers 0/1 and `upper` the tile on layers 2/3; the
 * upper layer decides "prop" only when something is actually painted there.
 * Passage flags, when available, override the guess for impassable ground — a
 * custom tileset can put a wall on any sheet, and the flags are what the engine
 * itself believes.
 */
export function classifyTile(lower: number, upper: number, flags?: number[] | null): SemanticToken {
  if (upper > 0) return 'prop';
  if (lower <= 0) return 'void';

  if (isAutotile(lower)) {
    if (isTileA1(lower)) {
      if (isWaterfallTile(lower)) return 'waterfall';
      // A1 kinds 0-3 are open water; the rest are ground/shore combinations.
      return autotileKind(lower) < 4 ? 'water' : 'ground';
    }
    if (isTileA2(lower)) return 'ground';
    if (isRoofTile(lower)) return 'roof';
    if (isWallTopTile(lower)) return 'wall_top';
    if (isWallSideTile(lower)) return 'wall';
    return 'ground';
  }

  if (isTileA5(lower)) {
    // A5 is static ground, but a project can use it for solid blocks; trust the
    // flags when they say the player cannot walk there.
    if (flags && (flags[lower] & 0x0f) === 0x0f) return 'wall';
    return 'ground_alt';
  }

  // B-E painted on a lower layer: a decoration used as ground. Impassable ones
  // read as walls, the rest as an alternative surface.
  if (flags && (flags[lower] & 0x0f) === 0x0f) return 'wall';
  return 'ground_alt';
}

/** The tokens that must resolve to a tile for a materialised map to be playable. */
export const REQUIRED_TOKENS: SemanticToken[] = ['ground', 'wall'];

/**
 * Resolve a token to a tile ID, falling back the way a human would: an
 * alternative ground is still ground, a roof is still a wall top, a waterfall is
 * still water. Returns 0 (paint nothing) when even the fallback is missing.
 */
const TOKEN_FALLBACKS: Partial<Record<SemanticToken, SemanticToken[]>> = {
  ground_alt: ['ground'],
  waterfall: ['water'],
  roof: ['wall_top', 'wall'],
  wall_top: ['roof', 'ground'],
  door: ['ground'],
  poi: ['ground'],
};

export function profileTileFor(profile: TilesetProfile, token: SemanticToken): number {
  const direct = profile.tiles[token];
  if (direct !== undefined) return direct;
  for (const alt of TOKEN_FALLBACKS[token] ?? []) {
    const v = profile.tiles[alt];
    if (v !== undefined) return v;
  }
  return 0;
}
