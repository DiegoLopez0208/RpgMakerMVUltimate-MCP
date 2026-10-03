// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import { DecodedImage } from '../src/parity/tiles/png.js';
import { tileTransparentFraction, needsBase } from '../src/parity/tiles/transparency.js';
import { autotileSample } from '../src/parity/tiles/tilegeom.js';

/**
 * The transparency classifier measures the see-through fraction of a tile's
 * representative sample — shape-0 quarters for autotiles, the whole 48px cell for
 * flat tiles. These build synthetic sheets with known alpha so the geometry +
 * fraction math is exact and font/PNG-independent.
 */

/** A blank RGBA image with every pixel opaque (alpha 255) unless overridden. */
function opaqueImage(width: number, height: number): DecodedImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = 255;
  return { width, height, data };
}

function setAlphaRect(
  img: DecodedImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
  alpha: number,
): void {
  for (let y = sy; y < sy + h; y++) {
    for (let x = sx; x < sx + w; x++) {
      img.data[(y * img.width + x) * 4 + 3] = alpha;
    }
  }
}

describe('tile transparency classifier', () => {
  it('reports 0 for a fully opaque flat tile and 1 for a fully transparent one', () => {
    const opaque = opaqueImage(48, 48);
    expect(tileTransparentFraction(opaque, 'B', 0)).toBe(0);
    expect(needsBase(0)).toBe(false);

    const clear = opaqueImage(48, 48);
    setAlphaRect(clear, 0, 0, 48, 48, 0);
    expect(tileTransparentFraction(clear, 'B', 0)).toBe(1);
    expect(needsBase(1)).toBe(true);
  });

  it('measures a partially transparent flat tile', () => {
    const img = opaqueImage(48, 48);
    setAlphaRect(img, 0, 0, 24, 24, 0); // one quarter transparent
    expect(tileTransparentFraction(img, 'B', 0)).toBeCloseTo(0.25, 5);
    expect(needsBase(0.25)).toBe(true);
  });

  it('ignores a sub-cutoff sliver of transparency (anti-aliasing noise)', () => {
    // 40 transparent px of 2304 ≈ 1.7% (below the 2% cutoff).
    const below = opaqueImage(48, 48);
    for (let i = 0; i < 40; i++) below.data[i * 4 + 3] = 0;
    expect(needsBase(tileTransparentFraction(below, 'B', 0))).toBe(false);

    // 60 transparent px ≈ 2.6% (above the cutoff).
    const above = opaqueImage(48, 48);
    for (let i = 0; i < 60; i++) above.data[i * 4 + 3] = 0;
    expect(needsBase(tileTransparentFraction(above, 'B', 0))).toBe(true);
  });

  it("samples an autotile's shape-0 quarters (A2 kind 16)", () => {
    // Build a sheet where only kind-16's four shape-0 quarters are opaque.
    const img = opaqueImage(96, 120);
    setAlphaRect(img, 0, 0, 96, 120, 0); // everything transparent
    for (const [sx, sy] of autotileSample(16)) setAlphaRect(img, sx, sy, 24, 24, 255);
    expect(tileTransparentFraction(img, 'A2', 0)).toBe(0); // its quarters are opaque

    // Inverse: quarters transparent, everything else opaque.
    const inv = opaqueImage(96, 120);
    for (const [sx, sy] of autotileSample(16)) setAlphaRect(inv, sx, sy, 24, 24, 0);
    expect(tileTransparentFraction(inv, 'A2', 0)).toBe(1);
  });
});
