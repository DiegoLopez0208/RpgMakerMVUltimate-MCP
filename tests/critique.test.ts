import { describe, it, expect } from "vitest";
import { critiqueMap, type CritiqueEvent } from "../src/intel/critique.js";
import type { PlaceableMap } from "../src/utils/placement.js";

const W = 10, H = 10, LAYERS = 6;
const FLOOR = 10; // flags = 0 (passable)
const WALL = 20;  // flags = 0x0f (impassable)
const PROP = 30;  // an object-layer decoration

function blankData(): number[] {
  return new Array(W * H * LAYERS).fill(0);
}
function set(data: number[], x: number, y: number, z: number, id: number): void {
  data[(z * H + y) * W + x] = id;
}
function flags(): number[] {
  const f = new Array(8192).fill(0);
  f[FLOOR] = 0; f[WALL] = 0x0f; f[PROP] = 0;
  return f;
}

function allFloor(): PlaceableMap {
  const data = blankData();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(data, x, y, 0, FLOOR);
  return { width: W, height: H, data };
}

describe("critiqueMap", () => {
  it("flags an empty, monotonous, low-interactivity open map", () => {
    const map = allFloor();
    const c = critiqueMap(map, flags(), [{ id: 1, name: "Sign", x: 1, y: 1 } as CritiqueEvent], 5);
    expect(c.mapId).toBe(5);
    expect(c.hasPassability).toBe(true);
    expect(c.metrics.walkablePct).toBe(100);
    expect(c.metrics.distinctGroundTiles).toBe(1);
    const cats = c.findings.map((f) => f.category);
    expect(cats).toContain("monotony");    // single ground tile
    expect(cats).toContain("empty");       // open + undecorated
    expect(cats).toContain("pacing");      // events bunched in one corner
    expect(c.score).toBeLessThan(80);
  });

  it("praises a balanced map and gives it a high score", () => {
    const data = blankData();
    // varied ground + a wall border (dead space kept modest) + decoration + spread events
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(data, x, y, 0, (x + y) % 2 === 0 ? FLOOR : 11);
    for (let x = 0; x < W; x++) { set(data, x, 0, 0, FLOOR); }
    // decoration scattered on object layer
    for (let i = 0; i < 8; i++) set(data, (i * 7) % W, (i * 3) % H, 2, PROP);
    const f = flags(); f[11] = 0;
    const map: PlaceableMap = { width: W, height: H, data };
    // events spread across all four quadrants
    const events: CritiqueEvent[] = [
      { id: 1, name: "a", x: 2, y: 2 }, { id: 2, name: "b", x: 7, y: 2 },
      { id: 3, name: "c", x: 2, y: 7 }, { id: 4, name: "d", x: 7, y: 7 },
      { id: 5, name: "e", x: 5, y: 5 },
    ];
    const c = critiqueMap(map, f, events);
    expect(c.metrics.distinctGroundTiles).toBeGreaterThan(1);
    expect(c.metrics.emptyQuadrants).toEqual([]);
    expect(c.findings.some((fd) => fd.kind === "praise")).toBe(true);
    expect(c.score).toBeGreaterThanOrEqual(85);
  });

  it("degrades gracefully without passability data", () => {
    const c = critiqueMap(allFloor(), null, []);
    expect(c.hasPassability).toBe(false);
    expect(c.findings.some((f) => f.category === "passability")).toBe(true);
    expect(c.findings.some((f) => f.category === "interactivity")).toBe(true); // no events
  });

  it("reports disconnected walkable regions", () => {
    const data = blankData();
    // two 3x3 floor blocks separated by walls
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) set(data, x, y, 0, FLOOR);
    for (let y = 1; y <= 3; y++) for (let x = 6; x <= 8; x++) set(data, x, y, 0, FLOOR);
    // everything else is wall
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(0 * H + y) * W + x] === 0) set(data, x, y, 0, WALL);
    const c = critiqueMap({ width: W, height: H, data }, flags(), []);
    expect(c.metrics.standableRegions).toBe(2);
    expect(c.findings.some((f) => f.category === "fragmentation")).toBe(true);
  });
});
