// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import { tileIndex, resizeMapData } from '../src/parity/tools/mapTools.js';

describe('tileIndex', () => {
  const width = 20;
  const height = 15;

  it('returns 0 for the top-left tile of layer 0', () => {
    expect(tileIndex(width, height, 0, 0, 0)).toBe(0);
  });

  it('advances by 1 per column (x)', () => {
    expect(tileIndex(width, height, 5, 0, 0)).toBe(5);
  });

  it('advances by `width` per row (y)', () => {
    expect(tileIndex(width, height, 0, 1, 0)).toBe(width);
    expect(tileIndex(width, height, 3, 2, 0)).toBe(2 * width + 3);
  });

  it('advances by `width * height` per layer', () => {
    const layerSize = width * height;
    expect(tileIndex(width, height, 0, 0, 1)).toBe(layerSize);
    expect(tileIndex(width, height, 0, 0, 5)).toBe(5 * layerSize);
  });

  it('composes layer, row, and column offsets', () => {
    // region layer (5), tile (7, 4)
    expect(tileIndex(width, height, 7, 4, 5)).toBe((5 * height + 4) * width + 7);
  });
});

describe('resizeMapData', () => {
  // Build a small 2x2 map where each cell across all 6 layers carries a unique,
  // decodable value so we can assert exactly where each tile lands after resize.
  function seed(width: number, height: number): number[] {
    const data: number[] = [];
    for (let layer = 0; layer < 6; layer++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          data[(layer * height + y) * width + x] = layer * 1000 + y * 100 + x + 1;
        }
      }
    }
    return data;
  }

  it('produces an array sized width*height*6', () => {
    const out = resizeMapData(seed(2, 2), 2, 2, 3, 4);
    expect(out.length).toBe(3 * 4 * 6);
  });

  it('preserves overlapping tiles on every layer and zero-fills new cells when growing', () => {
    const old = seed(2, 2);
    const out = resizeMapData(old, 2, 2, 3, 3);
    for (let layer = 0; layer < 6; layer++) {
      // Overlapping region (0..1, 0..1) keeps its values at the new stride.
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          expect(out[(layer * 3 + y) * 3 + x]).toBe(layer * 1000 + y * 100 + x + 1);
        }
      }
      // Newly exposed column x=2 and row y=2 are blank.
      expect(out[(layer * 3 + 0) * 3 + 2]).toBe(0);
      expect(out[(layer * 3 + 2) * 3 + 0]).toBe(0);
    }
  });

  it('crops the excess when shrinking', () => {
    const out = resizeMapData(seed(3, 3), 3, 3, 2, 2);
    expect(out.length).toBe(2 * 2 * 6);
    // Layer 2, cell (1,1) survives; (2,*) is gone (no index for it).
    expect(out[(2 * 2 + 1) * 2 + 1]).toBe(2 * 1000 + 1 * 100 + 1 + 1);
  });
});
