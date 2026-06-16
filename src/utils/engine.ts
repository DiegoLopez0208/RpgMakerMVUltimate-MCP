/**
 * engine.ts — RPG Maker MV engine ground truth.
 *
 * Tile-type predicates transcribed verbatim from the engine's rpg_core.js
 * (Tilemap.*), so the MCP classifies autotiles exactly as the engine does
 * instead of guessing. The autotile render tables and DB templates are baked
 * by scripts/extract-engine.mjs into engineDefaults.ts; loadEngineTables can
 * override the tables at runtime from the active project's own rpg_core.js
 * (for plugin/modified engines).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { FLOOR_AUTOTILE_TABLE, WALL_AUTOTILE_TABLE } from '../data/engineDefaults.js';

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

// Tilemap.isWaterfallTile: A1 autotile kinds 4..7 are waterfalls.
export function isWaterfallTile(id: number): boolean {
  if (isTileA1(id)) { const k = autotileKind(id); return k % 2 === 1 && k >= 4 && k <= 7; }
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

export interface EngineTables { FLOOR_AUTOTILE_TABLE: number[][][]; WALL_AUTOTILE_TABLE: number[][][]; }

const cache = new Map<string, EngineTables>();

function parseTable(src: string, name: string): number[][][] | null {
  const marker = 'Tilemap.' + name + ' = [';
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('[', start + marker.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  try { return JSON.parse(src.slice(open, i).replace(/\s+/g, '')); } catch { return null; }
}

/**
 * Engine autotile tables: the baked defaults, overridden by the active
 * project's own js/rpg_core.js when present (plugin/modified engines).
 */
export function loadEngineTables(projectPath?: string): EngineTables {
  const baked: EngineTables = { FLOOR_AUTOTILE_TABLE, WALL_AUTOTILE_TABLE };
  if (!projectPath) return baked;
  if (cache.has(projectPath)) return cache.get(projectPath)!;
  let tables = baked;
  try {
    const corePath = path.join(projectPath, 'js', 'rpg_core.js');
    if (existsSync(corePath)) {
      const src = readFileSync(corePath, 'utf8');
      const f = parseTable(src, 'FLOOR_AUTOTILE_TABLE');
      const w = parseTable(src, 'WALL_AUTOTILE_TABLE');
      if (f && w) tables = { FLOOR_AUTOTILE_TABLE: f, WALL_AUTOTILE_TABLE: w };
    }
  } catch { /* fall back to baked */ }
  cache.set(projectPath, tables);
  return tables;
}
