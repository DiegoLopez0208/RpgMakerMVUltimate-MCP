/**
 * placement.ts — passability-aware tile placement.
 *
 * Where mapGenerator's isWalkableGround classifies tiles by autotile *range*
 * (good enough for generated maps), this module uses the project tileset's
 * REAL passage flags (Tilesets[id].flags, one entry per tileId). That makes
 * event placement correct on ANY map — hand-authored, plugin-modified, or
 * custom tileset — by asking the same question the engine asks: "can the player
 * stand on this tile?".
 *
 * MV flag semantics (per tileId in Tilesets.flags):
 *   bits 0x0f  → the four cardinal passage bits; all four set (0x0f) = fully
 *                impassable (wall / roof / closed door).
 *   bit  0x10  → "☆" star/overhead: the tile is drawn above the player and does
 *                NOT affect passage — so it is skipped, and the tile beneath it
 *                decides standability (a lantern over a floor is still walkable).
 *
 * A coordinate is "void" when no tile layer has a tile there: there is nothing
 * to stand on, so it is never standable.
 */

// Structural subset of RpgMakerMap — accepts the full map or any {w,h,data}.
export interface PlaceableMap {
  width: number;
  height: number;
  data: number[];
}

// MV stores 6 layers in `data`; only the 4 tile layers (0..3) carry passage.
const TILE_LAYERS = 4;
const STAR_FLAG = 0x10;
const PASSAGE_MASK = 0x0f;

function tileAt(map: PlaceableMap, x: number, y: number, z: number): number {
  return map.data[(z * map.height + y) * map.width + x] | 0;
}

/**
 * Can the player stand on (x, y)? Mirrors the engine's top-down layer scan:
 * the topmost non-star tile decides passage; star tiles are transparent to
 * passage; an all-empty column (void) is not standable.
 */
export function isStandable(map: PlaceableMap, flags: number[], x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  let hasTile = false;
  for (let z = TILE_LAYERS - 1; z >= 0; z--) {
    const t = tileAt(map, x, y, z);
    if (t === 0) continue;
    hasTile = true;
    const f = flags[t] || 0;
    if (f & STAR_FLAG) continue;             // overhead tile — does not block
    return (f & PASSAGE_MASK) !== PASSAGE_MASK; // passable unless blocked all 4 ways
  }
  // Reaching here means every present tile was a star (passable), or the column
  // was empty. Stars are walkable; void is not.
  return hasTile;
}

// 4-connected flood fill returning the largest connected region of standable
// tiles as flat indices (y*width + x). The largest region is the map's main
// playable area — isolated one-off standable tiles (a floor cell walled in on
// all sides) are intentionally excluded so we never place an event somewhere
// the player can't reach.
function largestStandableRegion(map: PlaceableMap, flags: number[]): number[] {
  const w = map.width, h = map.height;
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seen[start]) continue;
      seen[start] = 1;
      if (!isStandable(map, flags, x, y)) continue;
      const comp: number[] = [];
      const stack: number[] = [start];
      while (stack.length) {
        const c = stack.pop() as number;
        comp.push(c);
        const cx = c % w, cy = (c - cx) / w;
        const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (let i = 0; i < nbrs.length; i++) {
          const nx = nbrs[i][0], ny = nbrs[i][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          if (isStandable(map, flags, nx, ny)) stack.push(ni);
        }
      }
      if (comp.length > best.length) best = comp;
    }
  }
  return best;
}

export interface NearestResult { x: number; y: number; relocated: boolean; }

/**
 * Snap (x, y) to a standable tile inside the map's main playable region. If the
 * coordinate is already in that region it's returned untouched (relocated:
 * false); otherwise the nearest region tile is chosen (relocated: true). A
 * standable-but-isolated coordinate still relocates, because the player can't
 * actually get there.
 */
export function nearestStandable(map: PlaceableMap, flags: number[], x: number, y: number): NearestResult {
  const region = largestStandableRegion(map, flags);
  if (region.length === 0) return { x: x, y: y, relocated: false }; // nowhere to stand
  const w = map.width;
  const target = y * w + x;
  if (region.indexOf(target) >= 0) return { x: x, y: y, relocated: false };
  let best = { x: x, y: y }, bestD = Infinity;
  for (let i = 0; i < region.length; i++) {
    const ri = region[i];
    const rx = ri % w, ry = (ri - rx) / w;
    const dx = rx - x, dy = ry - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = { x: rx, y: ry }; }
  }
  return { x: best.x, y: best.y, relocated: true };
}

/**
 * Pick a safe spawn/start point for a map: a tile that is standable AND reachable
 * (a member of the main playable region — never void, a wall, or a walled-in
 * pocket the player can't leave). Biased toward the bottom-centre of that region,
 * the natural "player walks in from the south" entrance, which reads correctly
 * for towns, exteriors and dungeons alike. Falls back to the map centre only if
 * the map has no standable tiles at all (a degenerate/broken map).
 */
export function chooseSpawn(map: PlaceableMap, flags: number[]): { x: number; y: number } {
  const region = largestStandableRegion(map, flags);
  if (region.length === 0) return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
  const w = map.width;
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < region.length; i++) {
    const rx = region[i] % w, ry = (region[i] - (region[i] % w)) / w;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry > maxY) maxY = ry;
  }
  // Aim at the bottom-centre of the playable area, then snap to the nearest
  // reachable tile — guaranteed standable and inside the main region.
  const centerX = Math.floor((minX + maxX) / 2);
  const near = nearestStandable(map, flags, centerX, maxY);
  return { x: near.x, y: near.y };
}

export interface WalkableSummary {
  usableRegionTiles: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  suggestedPoints: { x: number; y: number }[];
}

/**
 * Describe the map's main playable region: its tile count, bounding box, and a
 * handful of spread-out standable points (useful as default spawn/event spots).
 */
export function walkableSummary(map: PlaceableMap, flags: number[]): WalkableSummary {
  const region = largestStandableRegion(map, flags);
  const w = map.width;
  if (region.length === 0) {
    return { usableRegionTiles: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, suggestedPoints: [] };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < region.length; i++) {
    const rx = region[i] % w, ry = (region[i] - (region[i] % w)) / w;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  // Suggested points: the region tile nearest the centroid, plus evenly-spaced
  // samples. All are region members, hence guaranteed standable.
  const cx = Math.floor((minX + maxX) / 2), cy = Math.floor((minY + maxY) / 2);
  const near = nearestStandable(map, flags, cx, cy);
  const suggested: { x: number; y: number }[] = [{ x: near.x, y: near.y }];
  const step = Math.max(1, Math.floor(region.length / 5));
  for (let i = 0; i < region.length && suggested.length < 5; i += step) {
    const rx = region[i] % w, ry = (region[i] - (region[i] % w)) / w;
    if (!suggested.some(function (p) { return p.x === rx && p.y === ry; })) suggested.push({ x: rx, y: ry });
  }
  return {
    usableRegionTiles: region.length,
    bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY },
    suggestedPoints: suggested,
  };
}
