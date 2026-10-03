/**
 * Tile transparency classification (pure, no I/O). Given a decoded tileset sheet
 * and a tile's slot role + local index, measure how much of the tile's
 * *representative sample* is transparent (alpha below opaque) — the signal behind
 * the catalog's "needs a base" flag and the paint-time layer-0 warning.
 *
 * Why shape-0 for autotiles: shape-0 is the interior fill of a tiled field, so
 * "is shape-0 transparent?" is exactly "does a field of this tile leave the map's
 * void showing?". Flat tiles have no shape — the whole 48px cell is the sample.
 */
import { DecodedImage } from './png.js';
import { TILE, BASE_KIND, autotileSample, flatSample } from './tilegeom.js';

const Q = TILE / 2; // 24 — autotile quarter size

/** A tileset sheet's slot role (the 9 `tilesetNames` positions). */
export type TileRole = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'B' | 'C' | 'D' | 'E';

/** A pixel with alpha below this counts as transparent. */
const ALPHA_OPAQUE_MIN = 128;

/**
 * A tile "needs a base" when more than this fraction of its sample is
 * transparent. A small non-zero cutoff ignores stray anti-aliasing at a flat
 * tile's edge while still catching any real see-through interior.
 */
const NEEDS_BASE_CUTOFF = 0.02;

function isAutotileRole(role: TileRole): role is 'A1' | 'A2' | 'A3' | 'A4' {
  return role === 'A1' || role === 'A2' || role === 'A3' || role === 'A4';
}

/** Accumulate {transparent, total} pixels over a rectangle, clamped to the image. */
function sampleRect(
  img: DecodedImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
): { transparent: number; total: number } {
  let transparent = 0;
  let total = 0;
  for (let y = sy; y < sy + h; y++) {
    if (y < 0 || y >= img.height) continue;
    for (let x = sx; x < sx + w; x++) {
      if (x < 0 || x >= img.width) continue;
      total++;
      if (img.data[(y * img.width + x) * 4 + 3] < ALPHA_OPAQUE_MIN) transparent++;
    }
  }
  return { transparent, total };
}

/**
 * The fraction (0–1) of a tile's representative sample that is transparent.
 * Returns 0 when the tile's sample falls entirely outside the image (a sheet
 * smaller than the catalog expects) — treated as "no measurable transparency".
 */
export function tileTransparentFraction(
  img: DecodedImage,
  role: TileRole,
  localIndex: number,
): number {
  let transparent = 0;
  let total = 0;
  if (isAutotileRole(role)) {
    const kind = BASE_KIND[role] + localIndex;
    for (const [sx, sy] of autotileSample(kind)) {
      const r = sampleRect(img, sx, sy, Q, Q);
      transparent += r.transparent;
      total += r.total;
    }
  } else {
    const { sx, sy } = flatSample(localIndex);
    const r = sampleRect(img, sx, sy, TILE, TILE);
    transparent += r.transparent;
    total += r.total;
  }
  return total ? transparent / total : 0;
}

/** Whether a tile's transparent fraction is high enough that it needs a base. */
export function needsBase(fraction: number): boolean {
  return fraction > NEEDS_BASE_CUTOFF;
}
