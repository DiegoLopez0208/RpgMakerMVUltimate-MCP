import { describe, it, expect } from "vitest";
import {
  generateTileLayoutV3,
  scoreTemplate,
  bestCropOffset,
  dominantGround,
} from "../src/utils/mapGenerator.js";

// Layers in MV map data: GROUND1=0, GROUND2=1, UPPER1=2, UPPER2=3.
function fingerprint(data: number[], w: number, h: number): number {
  let acc = 0;
  for (const layer of [0, 1, 2, 3])
    for (let i = 0; i < w * h; i++) acc = (acc * 31 + (data[layer * w * h + i] || 0)) & 0x7fffffff;
  return acc;
}
function groundVoid(data: number[], w: number, h: number): number {
  let v = 0;
  for (let i = 0; i < w * h; i++) if (!data[i]) v++;
  return v;
}

describe("template search — scoring", () => {
  const base = { id: 1, category: "town", theme: "town", width: 20, height: 15, tilesetId: 2 };

  it("prefers a template whose tileset matches the project tileset", () => {
    const match = scoreTemplate(base, 20, 15, "town", 2);
    const mismatch = scoreTemplate({ ...base, tilesetId: 5 }, 20, 15, "town", 2);
    expect(match).toBeLessThan(mismatch);
  });

  it("prefers an exact theme match over a category-only match", () => {
    const exact = scoreTemplate(base, 20, 15, "town", 2);
    const categoryOnly = scoreTemplate({ ...base, theme: "exterior" }, 20, 15, "town", 2);
    expect(exact).toBeLessThan(categoryOnly);
  });

  it("penalises templates smaller than the request (would pad with void)", () => {
    const exact = scoreTemplate(base, 20, 15, "town", 2);
    const tooSmall = scoreTemplate({ ...base, width: 10, height: 8 }, 20, 15, "town", 2);
    expect(tooSmall).toBeGreaterThan(exact);
  });
});

describe("template search — content-aware crop", () => {
  it("crops the window with the most object-layer content", () => {
    const tw = 10, th = 10;
    const data = new Array(tw * th * 6).fill(0) as number[];
    // Put object content (UPPER1, layer 2) in the bottom-right quadrant.
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) data[(2 * th + y) * tw + x] = 100;
    const { ox, oy } = bestCropOffset({ width: tw, height: th, data }, 4, 4);
    expect(ox).toBe(6);
    expect(oy).toBe(6);
  });

  it("returns origin when the template is not larger than the request", () => {
    const data = new Array(8 * 8 * 6).fill(0) as number[];
    expect(bestCropOffset({ width: 8, height: 8, data }, 8, 8)).toEqual({ ox: 0, oy: 0 });
  });
});

describe("template search — dominant ground", () => {
  it("returns the most common walkable ground tile", () => {
    const tw = 5, th = 5;
    const data = new Array(tw * th * 6).fill(0) as number[];
    // A2 grass kind tile id (walkable) repeated; a couple of others.
    const grass = 2816; // A2 base autotile id (kind 16)
    for (let i = 0; i < tw * th; i++) data[i] = grass;
    data[0] = 2864; // a different walkable tile, minority
    expect(dominantGround({ width: tw, height: th, data })).toBe(grass);
  });
});

describe("template search — generated maps", () => {
  it("produces varied layouts across seeds (no longer always the same template)", async () => {
    const seen = new Set<number>();
    for (let s = 1; s <= 8; s++) {
      const r = await generateTileLayoutV3(20, 15, "town", { seed: s * 1000 + 7 });
      seen.add(fingerprint(r.data, 20, 15));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is deterministic for a fixed seed", async () => {
    const a = await generateTileLayoutV3(20, 15, "town", { seed: 12345 });
    const b = await generateTileLayoutV3(20, 15, "town", { seed: 12345 });
    expect(fingerprint(a.data, 20, 15)).toBe(fingerprint(b.data, 20, 15));
  });

  it("leaves no void ground frame on cloned town maps", async () => {
    const r = await generateTileLayoutV3(20, 15, "town", { seed: 4242 });
    expect(groundVoid(r.data, 20, 15)).toBe(0);
  });
});
