/**
 * materialize.ts — turn a semantic template into a real RPG Maker MV tile array.
 *
 * This is the compiler pass that makes layouts portable: the template says
 * "wall here, ground there, a prop anchored at 4,7" and the profile says which
 * tile ID plays each of those roles in the target tileset. The same layout can
 * then be a stone dungeon or a sci-fi corridor.
 *
 * Order matters. Every autotile is written at shape 0 first and the shapes are
 * recomputed at the end by applyAutotileShapes, because a shape is a function of
 * the finished neighbourhood — deciding it cell by cell while painting produces
 * seams and stray corners.
 */

import {
  profileTileFor, type SemanticTemplate, type SemanticToken, type TilesetProfile,
} from '../knowledge/semantic.js';
import { applyAutotileShapes } from './autotile.js';

export interface MaterializeOptions {
  /**
   * Paint the template's props. They are concrete B-E tile IDs, so they only
   * make sense when the target tileset shares those sheets; by default they are
   * kept for the tileset they were mined from and dropped for any other.
   */
  keepProps?: boolean;
  /** Tileset the result declares. Defaults to the profile's. */
  tilesetId?: number;
}

export interface MaterializedMap {
  width: number;
  height: number;
  tilesetId: number;
  /** width * height * 6, the layout of MV's Map.data. */
  data: number[];
  /** Props that could not be painted because the tileset does not match. */
  droppedProps: number;
  markers: { x: number; y: number; role: string; note?: string }[];
}

/** Tokens that are holes in the floor rather than something to paint. */
const NOTHING: SemanticToken[] = ['void'];

/**
 * A prop needs something under it, and so do the cells the player interacts
 * with; otherwise a chest would float over a void tile.
 */
const NEEDS_GROUND_BENEATH: SemanticToken[] = ['prop', 'door', 'poi'];

export function materializeTemplate(
  template: SemanticTemplate,
  profile: TilesetProfile,
  opts: MaterializeOptions = {},
): MaterializedMap {
  const w = template.width;
  const h = template.height;
  const data = new Array<number>(w * h * 6).fill(0);
  const put = (x: number, y: number, z: number, tileId: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h || z < 0 || z > 5) return;
    data[(z * h + y) * w + x] = tileId;
  };

  const groundTile = profileTileFor(profile, 'ground');

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const token = template.grid[y * w + x];
      if (!token || NOTHING.includes(token)) continue;

      if (NEEDS_GROUND_BENEATH.includes(token)) {
        put(x, y, 0, groundTile);
        continue;
      }
      const tileId = profileTileFor(profile, token);
      if (tileId > 0) put(x, y, 0, tileId);
    }
  }

  // Props carry raw upper-layer tile IDs, so they are only valid on the tileset
  // they were mined from unless the caller insists.
  const sameTileset = template.sourceTilesetId !== undefined && template.sourceTilesetId === profile.tilesetId;
  const paintProps = opts.keepProps ?? sameTileset;
  let droppedProps = 0;
  for (const prop of template.props) {
    if (!paintProps) { droppedProps++; continue; }
    for (const [dx, dy, layer, tileId] of prop.cells) {
      put(prop.x + dx, prop.y + dy, layer, tileId);
    }
  }

  // Now that every cell is final, give the autotiles their real shapes.
  applyAutotileShapes(data, w, h);

  return {
    width: w,
    height: h,
    tilesetId: opts.tilesetId ?? profile.tilesetId,
    data,
    droppedProps,
    markers: template.markers.slice(),
  };
}
