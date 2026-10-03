/**
 * Autotile-aware painting core. Given a single map layer and the cells
 * just painted on it, recompute the autotile shapes so borders/corners line up —
 * the glue between the shape calculator and the map-writing paint tools.
 *
 * Pure (no I/O): the caller supplies a {@link LayerAccess} over one z-layer of a
 * map's flat `data` array. A painted autotile cell is set to *any* tile id of the
 * right kind (shape is irrelevant); {@link applyAutotiling} then fixes the shape
 * of every affected cell from its same-kind neighbours.
 */
import { Neighbors } from './autotile.js';
import { computeAutotileShape } from './autotile.js';
import { autotileType, getAutotileKind, isSameKindTile, makeAutotileId } from './tileCodec.js';

/** Read/write access to one z-layer of a map, addressed by tile (x, y). */
export interface LayerAccess {
  width: number;
  height: number;
  get(x: number, y: number): number;
  set(x: number, y: number, tileId: number): void;
}

/**
 * Same-kind connectivity of a cell's 8 neighbours (off-map = not connected, i.e.
 * a border). `ref` is the cell's own tile id, so autotile kinds compare by kind
 * and flat tiles by exact id (see {@link isSameKindTile}).
 */
function neighborsOf(layer: LayerAccess, x: number, y: number, ref: number): Neighbors {
  const same = (dx: number, dy: number): boolean => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= layer.width || ny < 0 || ny >= layer.height) return false;
    return isSameKindTile(layer.get(nx, ny), ref);
  };
  return {
    n: same(0, -1),
    s: same(0, 1),
    w: same(-1, 0),
    e: same(1, 0),
    nw: same(-1, -1),
    ne: same(1, -1),
    sw: same(-1, 1),
    se: same(1, 1),
  };
}

/**
 * Recompute one cell's autotile shape in place from its neighbours. No-op for
 * flat (non-autotile) tiles and empty cells — they have no shape to fit.
 */
function reshapeCell(layer: LayerAccess, x: number, y: number): void {
  const tile = layer.get(x, y);
  const type = autotileType(tile);
  if (type === null) return;
  const shape = computeAutotileShape(type, neighborsOf(layer, x, y, tile));
  layer.set(x, y, makeAutotileId(getAutotileKind(tile), shape));
}

/**
 * After painting `cells` (each already set to its target tile id), fix autotile
 * shapes across the painted cells **and their 1-cell border ring** — a painted
 * cell changes the neighbour set of everything adjacent to it, so those must be
 * reshaped too. Order-independent: a cell's shape depends only on neighbour
 * *kinds*, which are fixed once painting is done, so a single deduped pass is
 * exact.
 */
export function applyAutotiling(layer: LayerAccess, cells: { x: number; y: number }[]): void {
  const seen = new Set<number>();
  for (const { x, y } of cells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= layer.width || ny < 0 || ny >= layer.height) continue;
        const key = ny * layer.width + nx;
        if (seen.has(key)) continue;
        seen.add(key);
        reshapeCell(layer, nx, ny);
      }
    }
  }
}
