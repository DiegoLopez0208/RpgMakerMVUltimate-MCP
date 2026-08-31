/**
 * mapMetrics.ts — measurable properties of a map, as opposed to opinions.
 *
 * critique.ts answers "is this good?" with designer heuristics. This module
 * answers "what is actually true about this layout?" with numbers that come
 * from the procedural-generation literature and can be recomputed, compared
 * across maps, and regression-tested:
 *
 *  - reachability   flood fill from the player's entry point; anything the
 *                   player cannot walk to is a softlock waiting to happen
 *  - dead space     how much of the rectangle is not accessible playable area
 *  - shape          the walkable area thinned to a one-cell skeleton, then read
 *                   as a graph: endpoints, junctions, cycles, critical path.
 *                   Linearity near 1 is a corridor; near 0 is a wide open blob
 *  - variety        Shannon entropy over 5x5 tile windows — low entropy across
 *                   the board is the monotonous-floor problem, measured
 *  - tension        for maps with random encounters, how far the player is from
 *                   somewhere safe
 *
 * Everything is pure and synchronous: give it a map, passage flags and the
 * event list, and it hands back numbers. No I/O, no dependencies.
 */

import { isStandable, type PlaceableMap } from '../utils/placement.js';

export interface MetricEvent {
  id: number;
  name: string;
  x: number;
  y: number;
  /** True when the event is a shop, inn, save point or healing spot. */
  safe?: boolean;
}

export interface MapMetricsOptions {
  /** Where the player enters. Defaults to the largest walkable region. */
  entry?: { x: number; y: number } | null;
  /** Random encounters defined on the map, used for the tension metric. */
  encounterCount?: number;
  /** What kind of space this is meant to be, which sets the dead-space band. */
  expected?: 'interior' | 'dungeon' | 'exterior';
}

export interface MetricVerdict {
  metric: string;
  value: number;
  band: 'ok' | 'low' | 'high' | 'critical';
  message: string;
}

export interface MapMetrics {
  mapId?: number;
  passability: 'flags' | 'none';
  size: { width: number; height: number; totalTiles: number };
  space: {
    walkableTiles: number;
    accessibleTiles: number;
    deadSpaceRatio: number;
    regions: number;
    largestRegionShare: number;
  };
  reachability: {
    entry: { x: number; y: number } | null;
    strandedTiles: number;
    unreachableEvents: { id: number; name: string; x: number; y: number }[];
  };
  shape: {
    skeletonCells: number;
    endpoints: number;
    junctions: number;
    cycles: number;
    criticalPathLength: number;
    linearity: number;
  };
  variety: {
    distinctTiles: number;
    meanEntropy: number;
    minEntropy: number;
    monotonousWindowPct: number;
  };
  tension: {
    hasEncounters: boolean;
    safePoints: number;
    meanStepsToSafety: number;
    maxStepsToSafety: number;
  } | null;
  verdicts: MetricVerdict[];
}

const TILE_LAYERS = 4;
/** Entropy below this over a 5x5 window means "nothing is happening here". */
const MONOTONY_THRESHOLD = 0.5;
const WINDOW = 5;

function tileAt(map: PlaceableMap, x: number, y: number, z: number): number {
  return map.data[(z * map.height + y) * map.width + x] | 0;
}

function round(n: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Shannon entropy in bits of a multiset of values. */
export function shannonEntropy(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / values.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Zhang-Suen thinning: erode a binary mask to a one-cell-wide skeleton while
 * preserving connectivity. This is what turns "a big walkable blob" into
 * something a graph metric can be read off.
 *
 * The mask is row-major, `true` meaning foreground. The result is a new mask.
 */
export function thinZhangSuen(mask: boolean[], width: number, height: number): boolean[] {
  const img = mask.slice();
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return img[y * width + x] ? 1 : 0;
  };

  let changed = true;
  let guard = 0;
  // Each pass removes at least one cell or stops; the guard is belt-and-braces
  // against a pathological mask on a very large map.
  while (changed && guard++ < 1000) {
    changed = false;
    for (const step of [0, 1]) {
      const doomed: number[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!img[y * width + x]) continue;
          // Neighbours clockwise from north, as in the original paper.
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          const b = ring.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (ring[i] === 0 && ring[(i + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          doomed.push(y * width + x);
        }
      }
      if (doomed.length) {
        for (const i of doomed) img[i] = false;
        changed = true;
      }
    }
  }
  return img;
}

/** 4-connected BFS distances from a set of sources. -1 means unreachable. */
function bfsDistances(mask: boolean[], width: number, height: number, sources: number[]): Int32Array {
  const dist = new Int32Array(width * height).fill(-1);
  const queue: number[] = [];
  for (const s of sources) {
    if (s >= 0 && s < mask.length && mask[s] && dist[s] === -1) { dist[s] = 0; queue.push(s); }
  }
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const cx = c % width, cy = (c - cx) / width;
    const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (!mask[n] || dist[n] !== -1) continue;
      dist[n] = dist[c] + 1;
      queue.push(n);
    }
  }
  return dist;
}

/** Count 4-connected components of a mask and return the largest. */
function components(mask: boolean[], width: number, height: number): { count: number; largest: number[] } {
  const seen = new Uint8Array(mask.length);
  let count = 0;
  let largest: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    count++;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      comp.push(c);
      const cx = c % width, cy = (c - cx) / width;
      const nbrs = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (comp.length > largest.length) largest = comp;
  }
  return { count, largest };
}

/** Skeleton read as a graph: 8-connected degree gives endpoints and junctions. */
function skeletonShape(skel: boolean[], width: number, height: number) {
  const cells: number[] = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) cells.push(i);
  if (cells.length === 0) {
    return { skeletonCells: 0, endpoints: 0, junctions: 0, cycles: 0, criticalPathLength: 0, linearity: 0 };
  }

  const deg = new Map<number, number>();
  let edges = 0;
  for (const c of cells) {
    const cx = c % width, cy = (c - cx) / width;
    let d = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (skel[ny * width + nx]) d++;
      }
    }
    deg.set(c, d);
    edges += d;
  }
  edges /= 2; // each adjacency is counted from both ends

  let endpoints = 0, junctions = 0;
  for (const d of deg.values()) {
    if (d === 1) endpoints++;
    else if (d >= 3) junctions++;
  }

  // Longest shortest path (graph diameter), via the standard double sweep:
  // farthest node from any start, then farthest from that one.
  const sweep = (from: number): { node: number; dist: number } => {
    const seen = new Map<number, number>([[from, 0]]);
    const queue = [from];
    let best = { node: from, dist: 0 };
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head];
      const d = seen.get(c) as number;
      if (d > best.dist) best = { node: c, dist: d };
      const cx = c % width, cy = (c - cx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (!skel[n] || seen.has(n)) continue;
          seen.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    return best;
  };
  const seed = cells.find((c) => deg.get(c) === 1) ?? cells[0];
  const criticalPathLength = sweep(sweep(seed).node).dist;

  const comps = components(skel, width, height).count;
  // Cyclomatic number of the skeleton: loops the player can walk around.
  const cycles = Math.max(0, Math.round(edges) - cells.length + comps);

  return {
    skeletonCells: cells.length,
    endpoints,
    junctions,
    cycles,
    criticalPathLength,
    linearity: round(criticalPathLength / cells.length),
  };
}

/** Dead-space bands per space type, from the shape these layouts normally take. */
const DEAD_SPACE_BANDS: Record<string, [number, number]> = {
  interior: [0.35, 0.6],
  dungeon: [0.5, 0.78],
  exterior: [0.15, 0.55],
};

/**
 * Measure one map. `flags` is the tileset's passage array; without it the space
 * and reachability metrics cannot be computed and are reported as zero with
 * `passability: "none"`.
 */
export function computeMapMetrics(
  map: PlaceableMap,
  flags: number[] | null,
  events: MetricEvent[],
  opts: MapMetricsOptions = {},
  mapId?: number,
): MapMetrics {
  const w = map.width, h = map.height;
  const totalTiles = w * h;
  const verdicts: MetricVerdict[] = [];

  // ── Variety: entropy over the tile signature, independent of passability ──
  const signature = new Array<number>(totalTiles);
  const distinct = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Fold the four tile layers into one value so a decorated floor reads as
      // different from the same floor left bare.
      let s = 0;
      for (let z = 0; z < TILE_LAYERS; z++) s = (s * 8209 + tileAt(map, x, y, z)) | 0;
      signature[y * w + x] = s;
      distinct.add(s);
    }
  }
  const entropies: number[] = [];
  for (let y = 0; y + WINDOW <= h; y++) {
    for (let x = 0; x + WINDOW <= w; x++) {
      const window: number[] = [];
      for (let dy = 0; dy < WINDOW; dy++) for (let dx = 0; dx < WINDOW; dx++) window.push(signature[(y + dy) * w + x + dx]);
      entropies.push(shannonEntropy(window));
    }
  }
  const meanEntropy = entropies.length ? entropies.reduce((a, b) => a + b, 0) / entropies.length : 0;
  const minEntropy = entropies.length ? Math.min(...entropies) : 0;
  const monotonous = entropies.filter((e) => e < MONOTONY_THRESHOLD).length;
  const monotonousPct = entropies.length ? round((monotonous / entropies.length) * 100, 1) : 0;

  const variety = {
    distinctTiles: distinct.size,
    meanEntropy: round(meanEntropy),
    minEntropy: round(minEntropy),
    monotonousWindowPct: monotonousPct,
  };

  if (entropies.length && monotonousPct > 60) {
    verdicts.push({
      metric: 'variety.monotonousWindowPct', value: monotonousPct, band: 'high',
      message: `${monotonousPct}% of the map is visually flat (5x5 windows with almost no tile variation). Break it up with ground variation, paths or props.`,
    });
  }

  if (!flags || flags.length === 0) {
    return {
      mapId,
      passability: 'none',
      size: { width: w, height: h, totalTiles },
      space: { walkableTiles: 0, accessibleTiles: 0, deadSpaceRatio: 0, regions: 0, largestRegionShare: 0 },
      reachability: { entry: null, strandedTiles: 0, unreachableEvents: [] },
      shape: { skeletonCells: 0, endpoints: 0, junctions: 0, cycles: 0, criticalPathLength: 0, linearity: 0 },
      variety,
      tension: null,
      verdicts,
    };
  }

  // ── Space & reachability ──
  const walkable = new Array<boolean>(totalTiles).fill(false);
  let walkableTiles = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isStandable(map, flags, x, y)) { walkable[y * w + x] = true; walkableTiles++; }
    }
  }

  const { count: regions, largest } = components(walkable, w, h);
  const largestShare = walkableTiles ? round(largest.length / walkableTiles) : 0;

  // The entry point decides what "accessible" means. Without one, the largest
  // region stands in for it — that is where the player almost certainly is.
  let entryIndex = -1;
  if (opts.entry && opts.entry.x >= 0 && opts.entry.y >= 0 && opts.entry.x < w && opts.entry.y < h) {
    const i = opts.entry.y * w + opts.entry.x;
    if (walkable[i]) entryIndex = i;
  }
  if (entryIndex === -1 && largest.length) entryIndex = largest[0];

  const fromEntry = entryIndex >= 0 ? bfsDistances(walkable, w, h, [entryIndex]) : new Int32Array(totalTiles).fill(-1);
  let accessible = 0;
  for (let i = 0; i < totalTiles; i++) if (fromEntry[i] >= 0) accessible++;

  const unreachableEvents = events
    .filter((e) => {
      if (e.x < 0 || e.y < 0 || e.x >= w || e.y >= h) return true;
      const i = e.y * w + e.x;
      // An event standing on a blocked tile is fine (a sign on a wall); what
      // matters is whether the player can reach a tile next to it.
      if (fromEntry[i] >= 0) return false;
      const nbrs = [[e.x + 1, e.y], [e.x - 1, e.y], [e.x, e.y + 1], [e.x, e.y - 1]];
      return !nbrs.some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < w && ny < h && fromEntry[ny * w + nx] >= 0);
    })
    .map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y }));

  const deadSpaceRatio = round(1 - accessible / totalTiles);
  const strandedTiles = walkableTiles - accessible;

  const space = {
    walkableTiles,
    accessibleTiles: accessible,
    deadSpaceRatio,
    regions,
    largestRegionShare: largestShare,
  };

  const expected = opts.expected ?? 'exterior';
  // "a exterior map" reads as a bug in the tool, so pick the article.
  const kind = `${'aeiou'.includes(expected[0]) ? 'an' : 'a'} ${expected}`;
  const band = DEAD_SPACE_BANDS[expected];
  if (deadSpaceRatio > band[1]) {
    verdicts.push({
      metric: 'space.deadSpaceRatio', value: deadSpaceRatio, band: 'high',
      message: `${Math.round(deadSpaceRatio * 100)}% of the rectangle is unreachable — above the ${Math.round(band[1] * 100)}% expected for ${kind} map. Shrink the map or open up the blocked area.`,
    });
  } else if (deadSpaceRatio < band[0]) {
    verdicts.push({
      metric: 'space.deadSpaceRatio', value: deadSpaceRatio, band: 'low',
      message: `Only ${Math.round(deadSpaceRatio * 100)}% of the map is non-playable — below the ${Math.round(band[0] * 100)}% expected for ${kind} map. Wide open space with no structure reads as unfinished.`,
    });
  }
  if (strandedTiles > 0) {
    verdicts.push({
      metric: 'reachability.strandedTiles', value: strandedTiles, band: 'critical',
      message: `${strandedTiles} walkable tiles cannot be reached from the entry point. Connect them or remove them — the player will never see them.`,
    });
  }
  for (const e of unreachableEvents) {
    verdicts.push({
      metric: 'reachability.unreachableEvents', value: e.id, band: 'critical',
      message: `Event ${e.id} ("${e.name}") at ${e.x},${e.y} has no reachable walkable tile next to it. It can never be triggered.`,
    });
  }

  // ── Shape ──
  const accessibleMask = new Array<boolean>(totalTiles);
  for (let i = 0; i < totalTiles; i++) accessibleMask[i] = fromEntry[i] >= 0;
  const shape = skeletonShape(thinZhangSuen(accessibleMask, w, h), w, h);

  if (shape.skeletonCells > 12 && shape.junctions === 0 && shape.cycles === 0) {
    verdicts.push({
      metric: 'shape.linearity', value: shape.linearity, band: 'high',
      message: 'The playable space is one unbranching path with no junctions or loops. Add a side route or a loop so the player has a choice to make.',
    });
  }

  // ── Tension ──
  const hasEncounters = (opts.encounterCount ?? 0) > 0;
  const safeIndices = events
    .filter((e) => e.safe && e.x >= 0 && e.y >= 0 && e.x < w && e.y < h)
    .map((e) => e.y * w + e.x);
  let tension: MapMetrics['tension'] = null;
  if (hasEncounters) {
    // Measure from the tiles beside each safe event, since the event tile
    // itself is usually blocked (a shopkeeper you talk to, not walk onto).
    const sources: number[] = [];
    for (const i of safeIndices) {
      const x = i % w, y = (i - x) / w;
      for (const [nx, ny] of [[x, y], [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && accessibleMask[ny * w + nx]) sources.push(ny * w + nx);
      }
    }
    const toSafety = sources.length ? bfsDistances(accessibleMask, w, h, sources) : null;
    let sum = 0, max = 0, counted = 0;
    if (toSafety) {
      for (let i = 0; i < totalTiles; i++) {
        if (!accessibleMask[i] || toSafety[i] < 0) continue;
        sum += toSafety[i];
        if (toSafety[i] > max) max = toSafety[i];
        counted++;
      }
    }
    tension = {
      hasEncounters,
      safePoints: safeIndices.length,
      meanStepsToSafety: counted ? round(sum / counted, 1) : -1,
      maxStepsToSafety: counted ? max : -1,
    };
    if (safeIndices.length === 0) {
      verdicts.push({
        metric: 'tension.safePoints', value: 0, band: 'critical',
        message: 'The map has random encounters but no inn, shop or save point. The player can be worn down with nowhere to recover.',
      });
    }
  }

  return {
    mapId,
    passability: 'flags',
    size: { width: w, height: h, totalTiles },
    space,
    reachability: {
      entry: entryIndex >= 0 ? { x: entryIndex % w, y: Math.floor(entryIndex / w) } : null,
      strandedTiles,
      unreachableEvents,
    },
    shape,
    variety,
    tension,
    verdicts,
  };
}
