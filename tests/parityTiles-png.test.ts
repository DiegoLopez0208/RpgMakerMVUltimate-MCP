// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import { decodePng, encodePng } from '../src/parity/tiles/png.js';

/**
 * The src/ PNG codec is a decode-first port of the skill's dependency-free codec;
 * these round-trips prove the TypeScript port reads back what it wrote, alpha
 * intact — the alpha channel is the whole point (transparency classification).
 */
describe('png codec', () => {
  it('round-trips an RGBA image, preserving alpha', () => {
    const width = 3;
    const height = 2;
    const rgba = Buffer.alloc(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      rgba[p * 4] = p * 10; // r
      rgba[p * 4 + 1] = 255 - p * 10; // g
      rgba[p * 4 + 2] = p * 5; // b
      rgba[p * 4 + 3] = p % 2 === 0 ? 255 : 0; // alternating opaque/transparent
    }
    const decoded = decodePng(encodePng(width, height, rgba));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Buffer.from(decoded.data).equals(rgba)).toBe(true);
  });

  it('preserves per-pixel alpha across many rows (exercises row filtering)', () => {
    const width = 8;
    const height = 8;
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 128;
      rgba[i * 4 + 3] = i < 32 ? 255 : 0; // top half opaque, bottom half transparent
    }
    const decoded = decodePng(encodePng(width, height, rgba));
    expect(decoded.data[3]).toBe(255); // first pixel opaque
    expect(decoded.data[32 * 4 + 3]).toBe(0); // first pixel of bottom half transparent
  });

  it('rejects a non-PNG buffer', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/not a PNG/);
  });
});
