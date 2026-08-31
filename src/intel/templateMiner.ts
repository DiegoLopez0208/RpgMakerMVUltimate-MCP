/**
 * templateMiner.ts — learn templates, tileset profiles and adjacency rules from
 * the project the server is installed in.
 *
 * The bundled reference maps come from the RTP, which means they only fit
 * projects using RTP tilesets and they ride along in the npm package. Mining the
 * user's own maps addresses both: the knowledge is derived from art the user
 * already licensed, and what comes out matches the style they actually build in
 * — corridor widths, prop density, which ground tile they treat as default.
 *
 * Three things come out of one pass:
 *  - semantic templates   layouts with the art stripped out (see semantic.ts)
 *  - tileset profiles     which concrete tile ID plays each role, by observed
 *                         frequency, so a layout can be re-materialised onto any
 *                         tileset the project uses
 *  - adjacency counts     which tokens sit next to which, the statistics a
 *                         constraint-based generator needs
 *
 * Everything is written to .mcp-cache/, which is derived data: delete it and the
 * next mine rebuilds it.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { readJson } from '../utils/fileHandler.js';
import { resolveSafePath } from '../utils/security.js';
import { TILE_ID_A1, autotileKind, isAutotile } from '../utils/engine.js';
import {
  classifyTile, emptyProfile, SEMANTIC_TOKENS,
  type SemanticProp, type SemanticTemplate, type SemanticToken, type TilesetProfile,
} from '../knowledge/semantic.js';

export const CACHE_DIR = '.mcp-cache';
export const CACHE_FILE = 'project-templates.json';
export const MINE_VERSION = 1;

export interface AdjacencyCounts {
  /** "tokenA>tokenB" -> how often B sits to the right of A. */
  horizontal: Record<string, number>;
  /** "tokenA>tokenB" -> how often B sits below A. */
  vertical: Record<string, number>;
}

export interface MineResult {
  version: number;
  minedAt: string;
  mapsScanned: number;
  mapsKept: number;
  skipped: { mapId: number; reason: string }[];
  templates: SemanticTemplate[];
  profiles: Record<string, TilesetProfile>;
  adjacency: AdjacencyCounts;
}

export interface MineOptions {
  /** Maps with fewer distinct tiles than this are test scratch, not content. */
  minDistinctTiles?: number;
  /** Maps smaller than this many cells are ignored. */
  minCells?: number;
  /** Cap on templates kept, largest maps first. 0 means no cap. */
  limit?: number;
  /** Skip writing the cache file (used by callers that only want the result). */
  noWrite?: boolean;
}

interface RawMap {
  width: number;
  height: number;
  data: number[];
  tilesetId: number;
  events?: (Record<string, unknown> | null)[];
}

/** Command codes that tell us what a cell is FOR. */
const CODE_TRANSFER = 201;
const SAFE_CODES = new Set([302, 314, 352]);

function tileAt(map: RawMap, x: number, y: number, z: number): number {
  return map.data[(z * map.height + y) * map.width + x] | 0;
}

/**
 * The base ID a tile should be remembered as. An autotile's shape depends on its
 * neighbours, so storing the shaped ID in a profile would bake one specific
 * corner into every future map; shape 0 is the canonical form.
 */
function baseTileId(tileId: number): number {
  return isAutotile(tileId) ? TILE_ID_A1 + autotileKind(tileId) * 48 : tileId;
}

/** Topmost non-empty tile across a range of layers. */
function topmost(map: RawMap, x: number, y: number, from: number, to: number): number {
  for (let z = to; z >= from; z--) {
    const t = tileAt(map, x, y, z);
    if (t !== 0) return t;
  }
  return 0;
}

/**
 * Group the upper-layer tiles into connected props. A tree is 2x3 cells that
 * only mean anything together, so they are lifted out whole instead of being
 * scattered as independent decorations.
 */
function extractProps(map: RawMap): SemanticProp[] {
  const w = map.width, h = map.height;
  const occupied = new Array<boolean>(w * h).fill(false);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tileAt(map, x, y, 2) !== 0 || tileAt(map, x, y, 3) !== 0) occupied[y * w + x] = true;
    }
  }

  const seen = new Uint8Array(w * h);
  const props: SemanticProp[] = [];
  for (let i = 0; i < occupied.length; i++) {
    if (!occupied[i] || seen[i]) continue;
    const cells: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      cells.push(c);
      const cx = c % w, cy = (c - cx) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (occupied[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }

    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (const c of cells) {
      const x = c % w, y = (c - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // A prop spanning most of the map is a painted backdrop, not an object.
    if ((maxX - minX + 1) * (maxY - minY + 1) > w * h * 0.4) continue;

    const propCells: [number, number, number, number][] = [];
    for (const c of cells) {
      const x = c % w, y = (c - x) / w;
      for (const layer of [2, 3]) {
        const t = tileAt(map, x, y, layer);
        if (t !== 0) propCells.push([x - minX, y - minY, layer, t]);
      }
    }
    propCells.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    props.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      cells: propCells,
      signature: propCells.map((c) => c.join(':')).join('|'),
    });
  }
  return props;
}

/** Read the events for what they say about their cell: a door, a shop, an NPC. */
function markersFromEvents(map: RawMap): SemanticTemplate['markers'] {
  const markers: SemanticTemplate['markers'] = [];
  for (const raw of map.events ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as Record<string, unknown>;
    const pages = Array.isArray(ev.pages) ? (ev.pages as Record<string, unknown>[]) : [];
    let role = 'event';
    for (const page of pages) {
      const list = Array.isArray(page?.list) ? (page.list as { code?: number }[]) : [];
      if (list.some((c) => Number(c?.code) === CODE_TRANSFER)) { role = 'door'; break; }
      if (list.some((c) => SAFE_CODES.has(Number(c?.code)))) { role = 'safe'; break; }
      if (list.length > 1) role = 'poi';
    }
    markers.push({ x: Number(ev.x), y: Number(ev.y), role, note: String(ev.name ?? '') || undefined });
  }
  return markers;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Mine one loaded map into a template, folding stats into the accumulators. */
function mineMap(
  map: RawMap,
  mapId: number,
  name: string,
  flags: number[] | null,
  profiles: Map<number, TilesetProfile>,
  tokenTileCounts: Map<number, Map<SemanticToken, Map<number, number>>>,
  adjacency: AdjacencyCounts,
): SemanticTemplate {
  const w = map.width, h = map.height;
  const grid = new Array<SemanticToken>(w * h);

  if (!profiles.has(map.tilesetId)) profiles.set(map.tilesetId, emptyProfile(map.tilesetId));
  if (!tokenTileCounts.has(map.tilesetId)) tokenTileCounts.set(map.tilesetId, new Map());
  const perToken = tokenTileCounts.get(map.tilesetId) as Map<SemanticToken, Map<number, number>>;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lower = topmost(map, x, y, 0, 1);
      const upper = topmost(map, x, y, 2, 3);
      grid[y * w + x] = classifyTile(lower, upper, flags);

      // Learn the profile from the LOWER tile even under a prop: the ground a
      // barrel stands on is still this tileset's ground.
      if (lower > 0) {
        const groundToken = classifyTile(lower, 0, flags);
        if (!perToken.has(groundToken)) perToken.set(groundToken, new Map());
        const byTile = perToken.get(groundToken) as Map<number, number>;
        const base = baseTileId(lower);
        byTile.set(base, (byTile.get(base) ?? 0) + 1);
      }
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = grid[y * w + x];
      if (x + 1 < w) bump(adjacency.horizontal, here + '>' + grid[y * w + x + 1]);
      if (y + 1 < h) bump(adjacency.vertical, here + '>' + grid[(y + 1) * w + x]);
    }
  }

  const markers = markersFromEvents(map);
  // Doors and interaction points are part of the layout, not decoration.
  for (const m of markers) {
    if (m.x < 0 || m.y < 0 || m.x >= w || m.y >= h) continue;
    const i = m.y * w + m.x;
    if (m.role === 'door') grid[i] = 'door';
    else if ((m.role === 'poi' || m.role === 'safe') && grid[i] !== 'door') grid[i] = 'poi';
  }

  return {
    id: 'mined-' + mapId,
    name,
    sourceMapId: mapId,
    sourceTilesetId: map.tilesetId,
    width: w,
    height: h,
    grid,
    props: extractProps(map),
    markers,
  };
}

/** Pick each token's tile ID by how often it was actually used. */
function resolveProfiles(
  profiles: Map<number, TilesetProfile>,
  tokenTileCounts: Map<number, Map<SemanticToken, Map<number, number>>>,
): Record<string, TilesetProfile> {
  const out: Record<string, TilesetProfile> = {};
  for (const [tilesetId, profile] of profiles) {
    const perToken = tokenTileCounts.get(tilesetId);
    if (perToken) {
      for (const token of SEMANTIC_TOKENS) {
        const byTile = perToken.get(token);
        if (!byTile || byTile.size === 0) continue;
        let bestTile = 0, bestCount = 0;
        for (const [tile, count] of byTile) {
          if (count > bestCount) { bestTile = tile; bestCount = count; }
        }
        profile.tiles[token] = bestTile;
        profile.confidence[token] = bestCount;
      }
    }
    out[String(tilesetId)] = profile;
  }
  return out;
}

/**
 * Scan the project and cache what it learns. Read-only with respect to the
 * project's own data — the only thing written is .mcp-cache/.
 */
export async function mineProject(projectPath: string, opts: MineOptions = {}): Promise<MineResult> {
  if (!projectPath) throw new Error('No project path set. Use set_project_path or RPGMAKER_PROJECT_PATH first.');
  const minDistinct = opts.minDistinctTiles ?? 10;
  const minCells = opts.minCells ?? 64;

  const infos = (await readJson(projectPath, 'MapInfos.json')) as (Record<string, unknown> | null)[];
  let tilesets: ({ name?: string; flags?: number[] } | null)[] = [];
  try {
    tilesets = (await readJson(projectPath, 'Tilesets.json')) as ({ name?: string; flags?: number[] } | null)[];
  } catch { /* a project without tilesets still yields layouts, just no flags */ }

  const profiles = new Map<number, TilesetProfile>();
  const tokenTileCounts = new Map<number, Map<SemanticToken, Map<number, number>>>();
  const adjacency: AdjacencyCounts = { horizontal: {}, vertical: {} };
  const templates: SemanticTemplate[] = [];
  const skipped: { mapId: number; reason: string }[] = [];
  let scanned = 0;

  for (const info of Array.isArray(infos) ? infos : []) {
    if (!info || typeof info !== 'object') continue;
    const mapId = Number((info as Record<string, unknown>).id);
    if (!mapId) continue;
    scanned++;

    let map: RawMap;
    try {
      map = (await readJson(projectPath, `Map${String(mapId).padStart(3, '0')}.json`)) as unknown as RawMap;
    } catch {
      skipped.push({ mapId, reason: 'map file missing or unreadable' });
      continue;
    }
    if (!map || !Array.isArray(map.data) || !map.width || !map.height) {
      skipped.push({ mapId, reason: 'no tile data' });
      continue;
    }
    if (map.width * map.height < minCells) {
      skipped.push({ mapId, reason: `smaller than ${minCells} cells` });
      continue;
    }
    const distinct = new Set(map.data.slice(0, map.width * map.height * 4).filter((t) => t !== 0));
    if (distinct.size < minDistinct) {
      skipped.push({ mapId, reason: `only ${distinct.size} distinct tiles — looks like scratch` });
      continue;
    }

    const ts = tilesets[map.tilesetId] ?? null;
    const flags = ts && Array.isArray(ts.flags) && ts.flags.length ? ts.flags : null;
    const name = String((info as Record<string, unknown>).name ?? `Map ${mapId}`);
    const template = mineMap(map, mapId, name, flags, profiles, tokenTileCounts, adjacency);
    if (ts?.name) {
      const p = profiles.get(map.tilesetId);
      if (p) p.tilesetName = ts.name;
    }
    templates.push(template);
  }

  templates.sort((a, b) => b.width * b.height - a.width * a.height);
  const kept = opts.limit && opts.limit > 0 ? templates.slice(0, opts.limit) : templates;

  const result: MineResult = {
    version: MINE_VERSION,
    minedAt: new Date().toISOString(),
    mapsScanned: scanned,
    mapsKept: kept.length,
    skipped,
    templates: kept,
    profiles: resolveProfiles(profiles, tokenTileCounts),
    adjacency,
  };

  if (!opts.noWrite) {
    const dir = resolveSafePath(projectPath, CACHE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(resolveSafePath(projectPath, CACHE_DIR, CACHE_FILE), JSON.stringify(result), 'utf-8');
  }
  return result;
}

/** Read a previous mine, or null when there is none. */
export async function loadMinedTemplates(projectPath: string): Promise<MineResult | null> {
  try {
    const raw = await readFile(resolveSafePath(projectPath, CACHE_DIR, CACHE_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as MineResult;
    return parsed.version === MINE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** The mined profile for one tileset, or null when it was never observed. */
export async function getMinedProfile(projectPath: string, tilesetId: number): Promise<TilesetProfile | null> {
  const mined = await loadMinedTemplates(projectPath);
  return mined?.profiles[String(tilesetId)] ?? null;
}
