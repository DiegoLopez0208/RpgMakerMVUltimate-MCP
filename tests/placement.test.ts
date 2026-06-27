import { describe, it, expect } from "vitest";
import { isStandable, nearestStandable, walkableSummary, chooseSpawn } from "../src/utils/placement.js";
import type { RpgMakerMap } from "../src/types/rpgmaker.js";

// Tile flag conventions (RPG Maker MV Tilesets.flags):
//   0x0f all set  -> impassable from every direction (wall / roof)
//   0          -> fully passable (floor)
//   0x10          -> star "☆" (passable, drawn above the player)
const FLOOR = 10;   // flags = 0
const WALL = 20;    // flags = 0x0f (15)
const STAR = 30;    // flags = 0x10 (16)

function makeFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[FLOOR] = 0;
  flags[WALL] = 0x0f;
  flags[STAR] = 0x10;
  return flags;
}

// Build a 6x5 map. Lower tile layer (z=0) only.
// Layout (F=floor, W=wall, .=void):
//   (0,0) is an ISOLATED floor tile.
//   A connected 3x3 floor block sits at x=2..4, y=1..3 (the "usable" region).
//   Everything else is wall, except we leave some void to prove void != standable.
function makeMap(): RpgMakerMap {
  const width = 6, height = 5;
  const data = new Array(width * height * 6).fill(0);
  const set = (x: number, y: number, tile: number) => { data[0 * width * height + y * width + x] = tile; };
  // fill everything with wall first
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, WALL);
  // isolated floor
  set(0, 0, FLOOR);
  // connected 3x3 region
  for (let y = 1; y <= 3; y++) for (let x = 2; x <= 4; x++) set(x, y, FLOOR);
  // a void column at x=5 (no tile in any layer)
  for (let y = 0; y < height; y++) set(5, y, 0);
  return { width, height, data, tilesetId: 1, events: [] } as unknown as RpgMakerMap;
}

describe("placement passability", () => {
  const flags = makeFlags();

  it("isStandable: floor yes, wall no, void no, star-over-floor yes", () => {
    const m = makeMap();
    expect(isStandable(m, flags, 3, 2)).toBe(true);   // floor
    expect(isStandable(m, flags, 1, 1)).toBe(false);  // wall
    expect(isStandable(m, flags, 5, 2)).toBe(false);  // void
    // star tile drawn over the floor block: still standable
    m.data[2 * m.width * m.height + 2 * m.width + 3] = STAR; // z=2 layer over (3,2)
    expect(isStandable(m, flags, 3, 2)).toBe(true);
  });

  it("nearestStandable keeps an already-good coordinate", () => {
    const m = makeMap();
    expect(nearestStandable(m, flags, 3, 2)).toEqual({ x: 3, y: 2, relocated: false });
  });

  it("nearestStandable relocates a void/wall coordinate to the usable region", () => {
    const m = makeMap();
    const r = nearestStandable(m, flags, 5, 1); // void column, nearest region tile is (4,1)
    expect(r.relocated).toBe(true);
    expect(isStandable(m, flags, r.x, r.y)).toBe(true);
    expect({ x: r.x, y: r.y }).toEqual({ x: 4, y: 1 });
  });

  it("nearestStandable ignores an isolated/inaccessible tile in favor of the largest region", () => {
    const m = makeMap();
    // (0,0) is itself standable but isolated; asking to place there must snap into the big region
    const r = nearestStandable(m, flags, 0, 0);
    expect(r.relocated).toBe(true);
    expect({ x: r.x, y: r.y }).not.toEqual({ x: 0, y: 0 });
    expect(r.x >= 2 && r.x <= 4 && r.y >= 1 && r.y <= 3).toBe(true);
  });

  it("chooseSpawn returns a standable, reachable, bottom-biased tile", () => {
    const m = makeMap();
    const s = chooseSpawn(m, flags);
    expect(isStandable(m, flags, s.x, s.y)).toBe(true);
    // must be in the main 3x3 region, never the isolated tile or void
    expect(s.x >= 2 && s.x <= 4 && s.y >= 1 && s.y <= 3).toBe(true);
    // bottom-centre bias → the lowest row of the region (y=3), centre column (x=3)
    expect(s).toEqual({ x: 3, y: 3 });
  });

  it("chooseSpawn falls back to map centre when nothing is standable", () => {
    const width = 4, height = 4;
    const data = new Array(width * height * 6).fill(WALL);
    const m = { width, height, data, tilesetId: 1, events: [] } as unknown as RpgMakerMap;
    expect(chooseSpawn(m, flags)).toEqual({ x: 2, y: 2 });
  });

  it("walkableSummary reports the usable region bounds and suggested points", () => {
    const m = makeMap();
    const s = walkableSummary(m, flags);
    expect(s.usableRegionTiles).toBe(9);          // the 3x3 block, not the isolated tile
    expect(s.bounds).toEqual({ minX: 2, minY: 1, maxX: 4, maxY: 3 });
    expect(s.suggestedPoints.length).toBeGreaterThan(0);
    for (const p of s.suggestedPoints) expect(isStandable(m, flags, p.x, p.y)).toBe(true);
  });
});
