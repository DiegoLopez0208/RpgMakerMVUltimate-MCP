/**
 * stamps.ts — multi-tile object "stamps" (houses, trees, props) mined from the
 * reference maps (knowledge/stamps.json, built by scripts/extract-stamps.mjs).
 *
 * The generator stamps these real, coherent objects instead of scattering
 * single tiles, which is what made houses look generic and decorations look
 * like random tiles strewn everywhere.
 */
import { readFileSync } from 'fs';
import path from 'path';

export interface StampCell { l: number; dx: number; dy: number; t: number; }
export interface Stamp { w: number; h: number; cells: StampCell[]; door?: { dx: number; dy: number }; count: number; }
export type StampCategory = 'house' | 'tree' | 'prop';

type Library = Record<string, Partial<Record<StampCategory, Stamp[]>>>;

let LIB: Library | null = null;
function lib(): Library {
  if (LIB) return LIB;
  // Built layout: dist/utils -> ../knowledge = dist/knowledge.
  // Source/test layout (tsx, vitest): src/utils -> ../../knowledge = repo-root/knowledge.
  for (const rel of [['..', 'knowledge'], ['..', '..', 'knowledge']]) {
    try {
      LIB = JSON.parse(readFileSync(path.join(import.meta.dirname, ...rel, 'stamps.json'), 'utf8')) as Library;
      return LIB;
    } catch { /* try next */ }
  }
  LIB = {};
  return LIB;
}

export function getStamps(tilesetId: number, category: StampCategory): Stamp[] {
  const t = lib()[String(tilesetId)];
  return (t && t[category]) || [];
}

export function hasStamps(tilesetId: number, category: StampCategory): boolean {
  return getStamps(tilesetId, category).length > 0;
}

/** Pick a stamp for (tileset, category), or null if none exist. */
export function pickStamp(tilesetId: number, category: StampCategory, rng: { nextInt(a: number, b: number): number }): Stamp | null {
  const arr = getStamps(tilesetId, category);
  if (arr.length === 0) return null;
  return arr[rng.nextInt(0, arr.length - 1)];
}

/**
 * Write a stamp's cells onto the map at top-left (x, y). Cells outside the map
 * are skipped. Returns the absolute door tile position for houses (or null).
 * Layer index in cells is the MV tile layer (2 = upper1, 3 = upper2).
 */
export function stampObject(
  data: number[], width: number, height: number, x: number, y: number, stamp: Stamp
): { door: { x: number; y: number } | null } {
  for (const c of stamp.cells) {
    const tx = x + c.dx, ty = y + c.dy;
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    data[(c.l * height + ty) * width + tx] = c.t;
  }
  return { door: stamp.door ? { x: x + stamp.door.dx, y: y + stamp.door.dy } : null };
}
