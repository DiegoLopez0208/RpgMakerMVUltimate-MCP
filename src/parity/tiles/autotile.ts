/**
 * Autotile shape calculator — the deterministic geometry that turns "which of my
 * 8 neighbours are the same autotile kind" into the correct 0–47 shape slot.
 *
 * RPG Maker autotiles (A1–A4) don't store a fixed graphic; the editor picks one
 * of up to 48 shape variants per cell so borders, corners and interiors line up.
 * The runtime never computes this (shapes are baked into the map by the editor),
 * so we reconstruct the editor's logic here. This is a solved geometry problem
 * and must never be left to model reasoning — it's pure and exhaustively tested,
 * the same way {@link tileIndex} is.
 *
 * Method (from the RPG Maker MV/MZ autotile shape-solver spec + the engine's own
 * FLOOR/WALL/WATERFALL_AUTOTILE_TABLE render tables in rpg_core.js v1.6.2):
 *   1. Normalise diagonals — a diagonal only "connects" if BOTH its adjacent
 *      edges also connect (an isolated diagonal can't round a corner).
 *   2. Reduce each of the tile's 4 quarters to a canonical state (solid / inner
 *      corner / vertical edge / horizontal edge / outer corner) from its two
 *      edges + normalised diagonal.
 *   3. Look the resulting (TL,TR,BL,BR) signature up in a signature→shape map
 *      derived from the engine's render tables (see test/autotile.test.ts, which
 *      re-derives these maps from the authoritative tables and asserts a match).
 *
 * Three geometries share this shape; see {@link autotileType}. Floor uses all 5
 * quarter states (47 of 48 slots; slot 46 is unused — the isolated tile has its
 * own dedicated slot 47). Wall uses 4 states (no inner corner, 16 slots).
 * Waterfall tiles only left↔right (4 slots).
 */
import { AutotileType, autotileType, getAutotileKind, makeAutotileId } from './tileCodec.js';

/**
 * Connectivity of a cell's 8 neighbours: `true` = the neighbour is the *same
 * autotile kind* (see {@link isSameKindTile}), so it should tile seamlessly.
 * Off-map / different-kind / empty neighbours are `false`.
 */
export interface Neighbors {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
  ne: boolean;
  se: boolean;
  sw: boolean;
  nw: boolean;
}

/** All-disconnected neighbours — the isolated-cell default. */
export const NO_NEIGHBORS: Neighbors = {
  n: false,
  e: false,
  s: false,
  w: false,
  ne: false,
  se: false,
  sw: false,
  nw: false,
};

/** A quarter's canonical appearance, from its two edges + (normalised) diagonal. */
type QuarterState = 'solid' | 'inner' | 'vedge' | 'hedge' | 'outer';

/**
 * Reduce one quarter to its canonical state. `v` = the quarter's vertical edge
 * connected, `h` = its horizontal edge connected, `d` = its diagonal connected
 * (already normalised — caller ANDs it with both edges). Wall geometry never
 * passes `d=true`, so it never yields `inner`.
 */
function quarterState(v: boolean, h: boolean, d: boolean): QuarterState {
  if (v && h && d) return 'solid';
  if (v && h) return 'inner';
  if (v) return 'vedge';
  if (h) return 'hedge';
  return 'outer';
}

/**
 * Signature→shape map for FLOOR autotiles (A1 water/ground, A2, A4 wall tops).
 * Key is `TL|TR|BL|BR` quarter states. Derived from FLOOR_AUTOTILE_TABLE; 47
 * reachable signatures (slot 46 is unused, and the all-`outer` isolated cell
 * maps to the dedicated slot 47).
 */
const FLOOR_SHAPES: Record<string, number> = {
  'solid|solid|solid|solid': 0,
  'inner|solid|solid|solid': 1,
  'solid|inner|solid|solid': 2,
  'inner|inner|solid|solid': 3,
  'solid|solid|solid|inner': 4,
  'inner|solid|solid|inner': 5,
  'solid|inner|solid|inner': 6,
  'inner|inner|solid|inner': 7,
  'solid|solid|inner|solid': 8,
  'inner|solid|inner|solid': 9,
  'solid|inner|inner|solid': 10,
  'inner|inner|inner|solid': 11,
  'solid|solid|inner|inner': 12,
  'inner|solid|inner|inner': 13,
  'solid|inner|inner|inner': 14,
  'inner|inner|inner|inner': 15,
  'vedge|solid|vedge|solid': 16,
  'vedge|inner|vedge|solid': 17,
  'vedge|solid|vedge|inner': 18,
  'vedge|inner|vedge|inner': 19,
  'hedge|hedge|solid|solid': 20,
  'hedge|hedge|solid|inner': 21,
  'hedge|hedge|inner|solid': 22,
  'hedge|hedge|inner|inner': 23,
  'solid|vedge|solid|vedge': 24,
  'solid|vedge|inner|vedge': 25,
  'inner|vedge|solid|vedge': 26,
  'inner|vedge|inner|vedge': 27,
  'solid|solid|hedge|hedge': 28,
  'inner|solid|hedge|hedge': 29,
  'solid|inner|hedge|hedge': 30,
  'inner|inner|hedge|hedge': 31,
  'vedge|vedge|vedge|vedge': 32,
  'hedge|hedge|hedge|hedge': 33,
  'outer|hedge|vedge|solid': 34,
  'outer|hedge|vedge|inner': 35,
  'hedge|outer|solid|vedge': 36,
  'hedge|outer|inner|vedge': 37,
  'solid|vedge|hedge|outer': 38,
  'inner|vedge|hedge|outer': 39,
  'vedge|solid|outer|hedge': 40,
  'vedge|inner|outer|hedge': 41,
  'outer|outer|vedge|vedge': 42,
  'outer|hedge|outer|hedge': 43,
  'vedge|vedge|outer|outer': 44,
  'hedge|outer|hedge|outer': 45,
  'outer|outer|outer|outer': 47,
};

/**
 * Signature→shape map for WALL autotiles (A3 roofs, A3/A4 wall sides). Only 4
 * cardinal edges matter (no diagonals, no inner corner). Derived from
 * WALL_AUTOTILE_TABLE; a clean 16-entry bijection.
 */
const WALL_SHAPES: Record<string, number> = {
  'solid|solid|solid|solid': 0,
  'vedge|solid|vedge|solid': 1,
  'hedge|hedge|solid|solid': 2,
  'outer|hedge|vedge|solid': 3,
  'solid|vedge|solid|vedge': 4,
  'vedge|vedge|vedge|vedge': 5,
  'hedge|outer|solid|vedge': 6,
  'outer|outer|vedge|vedge': 7,
  'solid|solid|hedge|hedge': 8,
  'vedge|solid|outer|hedge': 9,
  'hedge|hedge|hedge|hedge': 10,
  'outer|hedge|outer|hedge': 11,
  'solid|vedge|hedge|outer': 12,
  'vedge|vedge|outer|outer': 13,
  'hedge|outer|hedge|outer': 14,
  'outer|outer|outer|outer': 15,
};

/** FLOOR signature from neighbours: diagonals normalised by both adjacent edges. */
function floorSignature(nb: Neighbors): string {
  const nw = nb.nw && nb.n && nb.w;
  const ne = nb.ne && nb.n && nb.e;
  const sw = nb.sw && nb.s && nb.w;
  const se = nb.se && nb.s && nb.e;
  return [
    quarterState(nb.n, nb.w, nw), // TL
    quarterState(nb.n, nb.e, ne), // TR
    quarterState(nb.s, nb.w, sw), // BL
    quarterState(nb.s, nb.e, se), // BR
  ].join('|');
}

/**
 * WALL signature: cardinal edges only, no diagonals and no inner corner. Passing
 * `d = both edges` makes a both-edges quarter resolve to `solid` (walls never
 * round a diagonal), so `inner` never appears — matching WALL_SHAPES' keys.
 */
function wallSignature(nb: Neighbors): string {
  return [
    quarterState(nb.n, nb.w, nb.n && nb.w),
    quarterState(nb.n, nb.e, nb.n && nb.e),
    quarterState(nb.s, nb.w, nb.s && nb.w),
    quarterState(nb.s, nb.e, nb.s && nb.e),
  ].join('|');
}

/** The 0–47 shape for a FLOOR-type autotile given its neighbours. */
export function computeFloorShape(nb: Neighbors): number {
  return FLOOR_SHAPES[floorSignature(nb)] ?? 0;
}

/** The 0–15 shape for a WALL-type autotile (roof / wall-side) given its neighbours. */
export function computeWallShape(nb: Neighbors): number {
  return WALL_SHAPES[wallSignature(nb)] ?? 0;
}

/**
 * The 0–3 shape for a WATERFALL-type autotile. Waterfalls flow vertically and
 * only tile left↔right: shape = whether the same fall continues to each side
 * (none 0, left 1, right 2, both 3). Derived from WATERFALL_AUTOTILE_TABLE.
 */
export function computeWaterfallShape(nb: Neighbors): number {
  return (nb.w ? 1 : 0) + (nb.e ? 2 : 0);
}

/** Dispatch to the right shape calculator for an autotile geometry. */
export function computeAutotileShape(type: AutotileType, nb: Neighbors): number {
  switch (type) {
    case 'floor':
      return computeFloorShape(nb);
    case 'wall':
      return computeWallShape(nb);
    case 'waterfall':
      return computeWaterfallShape(nb);
  }
}

/**
 * The finished tile id for an autotile cell: keep the base tile's kind, but swap
 * in the shape its neighbours dictate. Non-autotile base ids are returned as-is
 * (flat tiles have no shape to compute). This is what paint commands (3d) call
 * per cell after gathering same-kind neighbours.
 */
export function autotileIdFor(baseTileId: number, nb: Neighbors): number {
  const type = autotileType(baseTileId);
  if (type === null) return baseTileId;
  const shape = computeAutotileShape(type, nb);
  return makeAutotileId(getAutotileKind(baseTileId), shape);
}
