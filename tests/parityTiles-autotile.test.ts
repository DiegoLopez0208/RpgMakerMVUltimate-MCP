// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
  Neighbors,
  NO_NEIGHBORS,
  computeFloorShape,
  computeWallShape,
  computeWaterfallShape,
  autotileIdFor,
} from '../src/parity/tiles/autotile.js';
import { TILE_ID, makeAutotileId, getAutotileShape } from '../src/parity/tiles/tileCodec.js';

/**
 * Authoritative engine render tables (Tilemap.*_AUTOTILE_TABLE, rmmz_core.js
 * v1.7.0): shape index → the 4 quarter source coords [TL,TR,BL,BR]. The module's
 * baked signature→shape maps are *derived* from these; this test re-derives the
 * neighbour→shape mapping independently from these tables and asserts the module
 * reproduces it for every neighbour combination — so the maps can't silently rot.
 */
// prettier-ignore
const FLOOR = [
  [[2,4],[1,4],[2,3],[1,3]],[[2,0],[1,4],[2,3],[1,3]],[[2,4],[3,0],[2,3],[1,3]],[[2,0],[3,0],[2,3],[1,3]],
  [[2,4],[1,4],[2,3],[3,1]],[[2,0],[1,4],[2,3],[3,1]],[[2,4],[3,0],[2,3],[3,1]],[[2,0],[3,0],[2,3],[3,1]],
  [[2,4],[1,4],[2,1],[1,3]],[[2,0],[1,4],[2,1],[1,3]],[[2,4],[3,0],[2,1],[1,3]],[[2,0],[3,0],[2,1],[1,3]],
  [[2,4],[1,4],[2,1],[3,1]],[[2,0],[1,4],[2,1],[3,1]],[[2,4],[3,0],[2,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],
  [[0,4],[1,4],[0,3],[1,3]],[[0,4],[3,0],[0,3],[1,3]],[[0,4],[1,4],[0,3],[3,1]],[[0,4],[3,0],[0,3],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[2,2],[1,2],[2,3],[3,1]],[[2,2],[1,2],[2,1],[1,3]],[[2,2],[1,2],[2,1],[3,1]],
  [[2,4],[3,4],[2,3],[3,3]],[[2,4],[3,4],[2,1],[3,3]],[[2,0],[3,4],[2,3],[3,3]],[[2,0],[3,4],[2,1],[3,3]],
  [[2,4],[1,4],[2,5],[1,5]],[[2,0],[1,4],[2,5],[1,5]],[[2,4],[3,0],[2,5],[1,5]],[[2,0],[3,0],[2,5],[1,5]],
  [[0,4],[3,4],[0,3],[3,3]],[[2,2],[1,2],[2,5],[1,5]],[[0,2],[1,2],[0,3],[1,3]],[[0,2],[1,2],[0,3],[3,1]],
  [[2,2],[3,2],[2,3],[3,3]],[[2,2],[3,2],[2,1],[3,3]],[[2,4],[3,4],[2,5],[3,5]],[[2,0],[3,4],[2,5],[3,5]],
  [[0,4],[1,4],[0,5],[1,5]],[[0,4],[3,0],[0,5],[1,5]],[[0,2],[3,2],[0,3],[3,3]],[[0,2],[1,2],[0,5],[1,5]],
  [[0,4],[3,4],[0,5],[3,5]],[[2,2],[3,2],[2,5],[3,5]],[[0,2],[3,2],[0,5],[3,5]],[[0,0],[1,0],[0,1],[1,1]],
];
// prettier-ignore
const WALL = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],[[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],[[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],[[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]],
];

type Corner = 'solid' | 'inner' | 'vedge' | 'hedge' | 'outer';
const co = (p: number[]) => p.join(',');

/** Independently derive neighbour(mask)→shape from an engine table via anchoring. */
function deriveFloorTable(): (number | undefined)[] {
  const S: Record<string, Corner>[] = [{}, {}, {}, {}];
  const freq = (c: number) => {
    const f: Record<string, number> = {};
    for (const sh of FLOOR) f[co(sh[c])] = (f[co(sh[c])] || 0) + 1;
    return f;
  };
  for (let c = 0; c < 4; c++) {
    const f = freq(c);
    const solid = co(FLOOR[0][c]);
    const iso = co(FLOOR[47][c]);
    const f13 = Object.keys(f).filter((k) => f[k] === 13);
    const f5 = Object.keys(f).filter((k) => f[k] === 5);
    S[c][solid] = 'solid';
    S[c][f13.find((k) => k !== solid)!] = 'inner';
    S[c][f5[0]] = 'outer';
    S[c][iso] = 'outer';
  }
  const f8 = (c: number) => Object.keys(freq(c)).filter((k) => freq(c)[k] === 8);
  const find = (t: (Corner | 'edge')[]): number => {
    for (let i = 0; i < FLOOR.length; i++) {
      let ok = true;
      for (let c = 0; c < 4; c++) {
        const k = co(FLOOR[i][c]);
        if (t[c] === 'edge') {
          if (!f8(c).includes(k)) {
            ok = false;
            break;
          }
        } else if (S[c][k] !== t[c]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  };
  const top = find(['edge', 'edge', 'solid', 'solid']);
  S[0][co(FLOOR[top][0])] = 'hedge';
  S[1][co(FLOOR[top][1])] = 'hedge';
  const bot = find(['solid', 'solid', 'edge', 'edge']);
  S[2][co(FLOOR[bot][2])] = 'hedge';
  S[3][co(FLOOR[bot][3])] = 'hedge';
  const left = find(['edge', 'solid', 'edge', 'solid']);
  S[0][co(FLOOR[left][0])] = 'vedge';
  S[2][co(FLOOR[left][2])] = 'vedge';
  const right = find(['solid', 'edge', 'solid', 'edge']);
  S[1][co(FLOOR[right][1])] = 'vedge';
  S[3][co(FLOOR[right][3])] = 'vedge';

  const sig2shape = new Map<string, number>();
  FLOOR.forEach((sh, i) => {
    const k = sh.map((p, c) => S[c][co(p)]).join('|');
    if (!sig2shape.has(k)) sig2shape.set(k, i);
  });
  sig2shape.set('outer|outer|outer|outer', 47);

  const qs = (v: boolean, h: boolean, d: boolean): Corner =>
    v && h && d ? 'solid' : v && h ? 'inner' : v ? 'vedge' : h ? 'hedge' : 'outer';
  return [...Array(256)].map((_, m) => {
    const n = !!(m & 1),
      s = !!(m & 2),
      w = !!(m & 4),
      e = !!(m & 8),
      nw = !!(m & 16),
      ne = !!(m & 32),
      sw = !!(m & 64),
      se = !!(m & 128);
    const sig = [
      qs(n, w, nw && n && w),
      qs(n, e, ne && n && e),
      qs(s, w, sw && s && w),
      qs(s, e, se && s && e),
    ].join('|');
    return sig2shape.get(sig);
  });
}

/** Turn an 8-bit mask (n,s,w,e,nw,ne,sw,se) into a Neighbors for the module. */
function maskToNeighbors(m: number): Neighbors {
  return {
    n: !!(m & 1),
    s: !!(m & 2),
    w: !!(m & 4),
    e: !!(m & 8),
    nw: !!(m & 16),
    ne: !!(m & 32),
    sw: !!(m & 64),
    se: !!(m & 128),
  };
}

describe('computeFloorShape', () => {
  it('matches the mapping independently derived from the engine table (all 256 configs)', () => {
    const ref = deriveFloorTable();
    for (let m = 0; m < 256; m++) {
      expect(computeFloorShape(maskToNeighbors(m)), `mask ${m}`).toBe(ref[m]);
    }
  });

  it('has intuitive anchor cases', () => {
    const all: Neighbors = {
      n: true,
      e: true,
      s: true,
      w: true,
      ne: true,
      se: true,
      sw: true,
      nw: true,
    };
    expect(computeFloorShape(all)).toBe(0); // fully surrounded → interior
    expect(computeFloorShape(NO_NEIGHBORS)).toBe(47); // isolated → island tile
    // Plus-shape: all 4 edges connected but no diagonals → all inner corners.
    expect(computeFloorShape({ ...NO_NEIGHBORS, n: true, e: true, s: true, w: true })).toBe(15);
  });
});

describe('computeWallShape', () => {
  it('matches the WALL engine table (all 16 cardinal-edge configs)', () => {
    // Derive wall neighbour→shape from the WALL table by anchoring, like floor.
    const S: Record<string, Corner>[] = [{}, {}, {}, {}];
    for (let c = 0; c < 4; c++) {
      S[c][co(WALL[0][c])] = 'solid';
      S[c][co(WALL[15][c])] = 'outer';
    }
    const find = (t: (Corner | 'edge')[]): number => {
      for (let i = 0; i < WALL.length; i++) {
        let ok = true;
        for (let c = 0; c < 4; c++) {
          const st = S[c][co(WALL[i][c])];
          if (t[c] === 'edge') {
            if (st === 'solid' || st === 'outer') {
              ok = false;
              break;
            }
          } else if (st !== t[c]) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    };
    const top = find(['edge', 'edge', 'solid', 'solid']);
    S[0][co(WALL[top][0])] = 'hedge';
    S[1][co(WALL[top][1])] = 'hedge';
    const bot = find(['solid', 'solid', 'edge', 'edge']);
    S[2][co(WALL[bot][2])] = 'hedge';
    S[3][co(WALL[bot][3])] = 'hedge';
    for (let c = 0; c < 4; c++)
      for (const sh of WALL) if (!S[c][co(sh[c])]) S[c][co(sh[c])] = 'vedge';
    const sig2shape = new Map<string, number>();
    WALL.forEach((sh, i) => sig2shape.set(sh.map((p, c) => S[c][co(p)]).join('|'), i));
    const qs = (v: boolean, h: boolean): Corner =>
      v && h ? 'solid' : v ? 'vedge' : h ? 'hedge' : 'outer';
    for (let m = 0; m < 16; m++) {
      const n = !!(m & 1),
        s = !!(m & 2),
        w = !!(m & 4),
        e = !!(m & 8);
      const sig = [qs(n, w), qs(n, e), qs(s, w), qs(s, e)].join('|');
      expect(computeWallShape({ ...NO_NEIGHBORS, n, s, w, e }), `wall mask ${m}`).toBe(
        sig2shape.get(sig),
      );
    }
  });
});

describe('computeWaterfallShape', () => {
  it('tiles only left↔right (none 0, left 1, right 2, both 3)', () => {
    expect(computeWaterfallShape(NO_NEIGHBORS)).toBe(0);
    expect(computeWaterfallShape({ ...NO_NEIGHBORS, w: true })).toBe(1);
    expect(computeWaterfallShape({ ...NO_NEIGHBORS, e: true })).toBe(2);
    expect(computeWaterfallShape({ ...NO_NEIGHBORS, w: true, e: true })).toBe(3);
    // Vertical neighbours are ignored.
    expect(computeWaterfallShape({ ...NO_NEIGHBORS, n: true, s: true })).toBe(0);
  });
});

describe('autotileIdFor', () => {
  it('keeps the base kind and applies the neighbour-driven shape', () => {
    const base = TILE_ID.A2; // an A2 ground autotile, kind 16, shape 0
    const all: Neighbors = {
      n: true,
      e: true,
      s: true,
      w: true,
      ne: true,
      se: true,
      sw: true,
      nw: true,
    };
    expect(autotileIdFor(base, all)).toBe(makeAutotileId(16, 0)); // surrounded → interior shape 0
    expect(getAutotileShape(autotileIdFor(base, NO_NEIGHBORS))).toBe(47); // isolated
  });

  it('returns non-autotile (flat) ids unchanged', () => {
    expect(autotileIdFor(5, NO_NEIGHBORS)).toBe(5); // a B-sheet tile
    expect(autotileIdFor(TILE_ID.A5 + 3, NO_NEIGHBORS)).toBe(TILE_ID.A5 + 3);
  });
});
