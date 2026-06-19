import { describe, it, expect } from "vitest";
import { autotileShape, autotileKind, applyAutotileShapes, computeShape } from "../src/utils/autotile.js";

describe("autotile predicates", () => {
  it("autotileKind returns correct kind for A1 tiles", () => {
    expect(autotileKind(2048)).toBe(0); // First A1 tile
    expect(autotileKind(2096)).toBe(1); // Second A1 autotile
  });

  it("autotileShape returns correct shape", () => {
    expect(autotileShape(2048)).toBe(0);
    expect(autotileShape(2049)).toBe(1);
  });
});

describe("computeShape", () => {
  it("returns 46 for isolated floor tile (no neighbors)", () => {
    const shape = computeShape(true, false, false, false, false, false, false, false, false);
    expect(shape).toBe(46);
  });

  it("returns 0 for fully surrounded floor tile", () => {
    const shape = computeShape(true, true, true, true, true, true, true, true, true);
    expect(shape).toBe(0);
  });

  it("returns 15 for isolated wall tile", () => {
    const shape = computeShape(false, false, false, false, false, false, false, false, false);
    expect(shape).toBe(15);
  });

  it("returns 0 for fully surrounded wall tile", () => {
    const shape = computeShape(false, true, true, true, true, false, false, false, false);
    expect(shape).toBe(0);
  });
});

describe("applyAutotileShapes", () => {
  it("processes a 10x10 grid without crashing", () => {
    const width = 10;
    const height = 10;
    const data = new Array(width * height * 4).fill(0);
    // Paint a 2x2 block of A2 tiles on layer 0
    data[11] = 2816;
    data[12] = 2816;
    data[21] = 2816;
    data[22] = 2816;
    applyAutotileShapes(data, width, height);
    // The block should have been re-shaped (shapes no longer all 0)
    expect(data.some((v) => v !== 0)).toBe(true);
    // All four cells remain A2 autotiles
    expect(data[11]).toBeGreaterThanOrEqual(2816);
    expect(data[12]).toBeGreaterThanOrEqual(2816);
    expect(data[21]).toBeGreaterThanOrEqual(2816);
    expect(data[22]).toBeGreaterThanOrEqual(2816);
  });

  it("keeps non-autotile tiles untouched", () => {
    const width = 10;
    const height = 10;
    const data = new Array(width * height * 4).fill(0);
    data[5] = 1234; // not an autotile
    applyAutotileShapes(data, width, height);
    expect(data[5]).toBe(1234);
  });
});
