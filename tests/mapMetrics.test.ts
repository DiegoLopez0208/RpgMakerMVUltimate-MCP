import { describe, it, expect } from 'vitest';
import { computeMapMetrics, thinZhangSuen, shannonEntropy, type MetricEvent } from '../src/intel/mapMetrics.js';

const FLOOR = 1;
const WALL = 2;
/** flags[tileId]: 0 = passable, 15 = blocked on all four sides. */
const FLAGS: number[] = [];
FLAGS[FLOOR] = 0;
FLAGS[WALL] = 15;

/**
 * Build a map from an ASCII picture: '.' floor, '#' wall, ' ' void.
 * Layer 0 carries the tile; the other five layers stay empty, as MV does.
 */
function mapFrom(rows: string[]) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Array<number>(width * height * 6).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      data[(0 * height + y) * width + x] = ch === '.' ? FLOOR : ch === '#' ? WALL : 0;
    }
  }
  return { width, height, data };
}

/** A map whose ground varies, so entropy checks are not fighting monotony. */
function noisyMap(width: number, height: number) {
  const data = new Array<number>(width * height * 6).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[(0 * height + y) * width + x] = FLOOR;
      // Scatter a decoration so 5x5 windows are not all identical.
      if ((x * 7 + y * 13) % 5 === 0) data[(2 * height + y) * width + x] = 40 + ((x + y) % 9);
    }
  }
  return { width, height, data };
}

describe('shannonEntropy', () => {
  it('is zero when everything is the same', () => {
    expect(shannonEntropy([7, 7, 7, 7])).toBe(0);
  });

  it('is one bit for an even two-way split', () => {
    expect(shannonEntropy([1, 2])).toBe(1);
    expect(shannonEntropy([1, 1, 2, 2])).toBe(1);
  });

  it('is zero for an empty sample', () => {
    expect(shannonEntropy([])).toBe(0);
  });
});

describe('thinZhangSuen', () => {
  it('reduces a solid band to roughly one cell wide', () => {
    const width = 11, height = 7;
    const mask = new Array<boolean>(width * height).fill(false);
    for (let y = 2; y <= 4; y++) for (let x = 1; x <= 9; x++) mask[y * width + x] = true;
    const before = mask.filter(Boolean).length;

    const skel = thinZhangSuen(mask, width, height);
    const after = skel.filter(Boolean).length;

    expect(after).toBeLessThan(before);
    // A 9x3 band thins towards its 9-cell centre line.
    expect(after).toBeLessThanOrEqual(12);
    expect(after).toBeGreaterThan(0);
  });

  it('leaves an already-thin line alone', () => {
    const width = 9, height = 3;
    const mask = new Array<boolean>(width * height).fill(false);
    for (let x = 1; x <= 7; x++) mask[1 * width + x] = true;
    expect(thinZhangSuen(mask, width, height).filter(Boolean).length).toBe(7);
  });
});

describe('computeMapMetrics — passability', () => {
  it('reports "none" and skips space metrics without tileset flags', () => {
    const m = computeMapMetrics(mapFrom(['....', '....']), null, []);
    expect(m.passability).toBe('none');
    expect(m.space.walkableTiles).toBe(0);
    expect(m.tension).toBeNull();
    // Variety does not need passability, so it is still measured.
    expect(m.variety.distinctTiles).toBeGreaterThan(0);
  });
});

describe('computeMapMetrics — reachability', () => {
  const walledOff = [
    '#########',
    '#...#...#',
    '#...#...#',
    '#...#...#',
    '#########',
  ];

  it('counts tiles the player can never reach as stranded', () => {
    const m = computeMapMetrics(mapFrom(walledOff), FLAGS, [], { entry: { x: 1, y: 1 } });
    expect(m.space.walkableTiles).toBe(18);
    expect(m.space.regions).toBe(2);
    expect(m.space.accessibleTiles).toBe(9);
    expect(m.reachability.strandedTiles).toBe(9);
    expect(m.verdicts.some((v) => v.metric === 'reachability.strandedTiles' && v.band === 'critical')).toBe(true);
  });

  it('flags an event the player can never trigger', () => {
    const events: MetricEvent[] = [
      { id: 1, name: 'Reachable NPC', x: 2, y: 2 },
      { id: 2, name: 'Sealed Chest', x: 6, y: 2 },
    ];
    const m = computeMapMetrics(mapFrom(walledOff), FLAGS, events, { entry: { x: 1, y: 1 } });
    expect(m.reachability.unreachableEvents.map((e) => e.id)).toEqual([2]);
    expect(m.verdicts.find((v) => v.metric === 'reachability.unreachableEvents')?.message).toContain('Sealed Chest');
  });

  it('accepts an event standing on a wall as long as a reachable tile touches it', () => {
    // A sign mounted on the wall at 4,2 — blocked itself, but read from 3,2.
    const events: MetricEvent[] = [{ id: 3, name: 'Sign', x: 4, y: 2 }];
    const m = computeMapMetrics(mapFrom(walledOff), FLAGS, events, { entry: { x: 1, y: 1 } });
    expect(m.reachability.unreachableEvents).toHaveLength(0);
  });

  it('falls back to the largest region when the entry point is not walkable', () => {
    const m = computeMapMetrics(mapFrom(walledOff), FLAGS, [], { entry: { x: 0, y: 0 } });
    expect(m.reachability.entry).not.toBeNull();
    expect(m.space.accessibleTiles).toBe(9);
  });
});

describe('computeMapMetrics — shape', () => {
  it('reads a corridor as linear with two endpoints and no loop', () => {
    // Long enough to be worth warning about; a 9-tile nook is not.
    const corridor = [
      '######################',
      '#....................#',
      '######################',
    ];
    const m = computeMapMetrics(mapFrom(corridor), FLAGS, [], { entry: { x: 1, y: 1 } });
    expect(m.shape.junctions).toBe(0);
    expect(m.shape.cycles).toBe(0);
    expect(m.shape.endpoints).toBe(2);
    expect(m.shape.linearity).toBeGreaterThan(0.8);
    expect(m.verdicts.some((v) => v.metric === 'shape.linearity')).toBe(true);
  });

  it('finds the loop in a ring corridor', () => {
    const ring = [
      '#########',
      '#.......#',
      '#.#####.#',
      '#.#####.#',
      '#.......#',
      '#########',
    ];
    const m = computeMapMetrics(mapFrom(ring), FLAGS, [], { entry: { x: 1, y: 1 } });
    expect(m.shape.cycles).toBeGreaterThanOrEqual(1);
    // A loop is not a dead-end corridor, so the linearity warning stays away.
    expect(m.verdicts.some((v) => v.metric === 'shape.linearity')).toBe(false);
  });
});

describe('computeMapMetrics — variety', () => {
  it('calls out a floor painted with one tile', () => {
    const flat = Array.from({ length: 8 }, () => '........');
    const m = computeMapMetrics(mapFrom(flat), FLAGS, [], { entry: { x: 0, y: 0 } });
    expect(m.variety.distinctTiles).toBe(1);
    expect(m.variety.meanEntropy).toBe(0);
    expect(m.variety.monotonousWindowPct).toBe(100);
    expect(m.verdicts.some((v) => v.metric === 'variety.monotonousWindowPct')).toBe(true);
  });

  it('stays quiet when the ground is varied', () => {
    const m = computeMapMetrics(noisyMap(14, 12), FLAGS, [], { entry: { x: 0, y: 0 } });
    expect(m.variety.meanEntropy).toBeGreaterThan(0.5);
    expect(m.verdicts.some((v) => v.metric === 'variety.monotonousWindowPct')).toBe(false);
  });
});

describe('computeMapMetrics — dead space bands', () => {
  const roomy = [
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ];

  it('accepts an open room against the exterior band', () => {
    const m = computeMapMetrics(mapFrom(roomy), FLAGS, [], { entry: { x: 1, y: 1 }, expected: 'exterior' });
    // 28 of 60 tiles are walls: 0.467 dead space, inside the exterior band.
    expect(m.space.deadSpaceRatio).toBeCloseTo(0.467, 2);
    expect(m.verdicts.some((v) => v.metric === 'space.deadSpaceRatio')).toBe(false);
  });

  it('complains when a dungeon is too open', () => {
    const m = computeMapMetrics(mapFrom(roomy), FLAGS, [], { entry: { x: 1, y: 1 }, expected: 'dungeon' });
    const verdict = m.verdicts.find((v) => v.metric === 'space.deadSpaceRatio');
    expect(verdict?.band).toBe('low');
  });
});

describe('computeMapMetrics — tension', () => {
  const field = [
    '############',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];

  it('is not computed for a map without encounters', () => {
    const m = computeMapMetrics(mapFrom(field), FLAGS, [], { entry: { x: 1, y: 1 } });
    expect(m.tension).toBeNull();
  });

  it('measures the walk back to safety', () => {
    const events: MetricEvent[] = [{ id: 1, name: 'Inn', x: 1, y: 1, safe: true }];
    const m = computeMapMetrics(mapFrom(field), FLAGS, events, { entry: { x: 1, y: 1 }, encounterCount: 3 });
    expect(m.tension?.hasEncounters).toBe(true);
    expect(m.tension?.safePoints).toBe(1);
    expect(m.tension?.maxStepsToSafety).toBeGreaterThan(0);
    expect(m.tension?.meanStepsToSafety).toBeGreaterThan(0);
  });

  it('warns when encounters exist with nowhere to recover', () => {
    const m = computeMapMetrics(mapFrom(field), FLAGS, [], { entry: { x: 1, y: 1 }, encounterCount: 3 });
    expect(m.tension?.safePoints).toBe(0);
    expect(m.verdicts.some((v) => v.metric === 'tension.safePoints' && v.band === 'critical')).toBe(true);
  });
});
