/**
 * graphGenerator.ts — layouts built from a mission, not from geometry.
 *
 * BSP splits a rectangle and hopes the result is interesting; cellular automata
 * make a cave-shaped blob. Neither knows what the space is FOR, so the key ends
 * up behind the door it opens as often as not.
 *
 * This generates the mission first — entrance, key, locked door, treasure, boss,
 * exit, plus optional side rooms — as a graph whose edges are the only ways
 * through. Then it lays that graph out as rooms and corridors. Because the lock
 * is an edge in the graph and the key sits on the entrance side of it, the
 * result is solvable by construction, and the shape metrics in mapMetrics have
 * real junctions and loops to find.
 *
 * The output is a semantic template, so the same mission can be materialised
 * onto any tileset (see materialize.ts).
 */

import type { SemanticTemplate, SemanticToken } from '../knowledge/semantic.js';

export type RoomRole = 'entrance' | 'key' | 'lock' | 'treasure' | 'boss' | 'exit' | 'hall' | 'side';

export interface MissionNode {
  id: number;
  role: RoomRole;
  /** Depth from the entrance along the critical path. */
  depth: number;
}

export interface MissionEdge {
  from: number;
  to: number;
  /** A locked edge needs the key from the node named here before it opens. */
  lockedBy?: number;
}

export interface MissionGraph {
  nodes: MissionNode[];
  edges: MissionEdge[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Same seed and options produce the same layout. */
  seed?: number;
  /** How many rooms on the critical path, before side rooms. Default 5. */
  rooms?: number;
  /** Add a key and a locked door. Default true when there are 4+ rooms. */
  locked?: boolean;
  /** Add dead-end side rooms with something in them. Default 2. */
  sideRooms?: number;
  /** Join two rooms with an extra corridor so the map has a loop. Default true. */
  loop?: boolean;
  name?: string;
}

/** Deterministic PRNG so a seed always reproduces a layout. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the mission. The spine is entrance to exit through the boss; the key
 * sits on a node strictly before the locked edge, which is what makes the map
 * solvable rather than merely connected.
 */
export function buildMissionGraph(opts: { rooms: number; locked: boolean; sideRooms: number; rand: () => number }): MissionGraph {
  const count = Math.max(2, opts.rooms);
  const nodes: MissionNode[] = [];
  const edges: MissionEdge[] = [];

  for (let i = 0; i < count; i++) {
    let role: RoomRole = 'hall';
    if (i === 0) role = 'entrance';
    else if (i === count - 1) role = 'exit';
    else if (i === count - 2) role = 'boss';
    nodes.push({ id: i, role, depth: i });
  }

  for (let i = 1; i < count; i++) edges.push({ from: i - 1, to: i });

  if (opts.locked && count >= 4) {
    // Lock the way into the boss, and hide the key in an earlier room.
    const lockEdge = edges[count - 3];
    const keyNodeId = 1 + Math.floor(opts.rand() * Math.max(1, count - 3));
    nodes[keyNodeId].role = 'key';
    lockEdge.lockedBy = keyNodeId;
  }

  for (let s = 0; s < opts.sideRooms; s++) {
    // Hang side rooms off the spine, never off the exit — a dead end past the
    // goal is a room nobody visits.
    const anchor = 1 + Math.floor(opts.rand() * Math.max(1, count - 2));
    const id = nodes.length;
    nodes.push({ id, role: s === 0 ? 'treasure' : 'side', depth: nodes[anchor].depth + 1 });
    edges.push({ from: anchor, to: id });
  }

  return { nodes, edges };
}

interface Rect { x: number; y: number; w: number; h: number; }

function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) };
}

function overlaps(a: Rect, b: Rect, margin = 1): boolean {
  return !(a.x + a.w + margin <= b.x || b.x + b.w + margin <= a.x ||
           a.y + a.h + margin <= b.y || b.y + b.h + margin <= a.y);
}

/**
 * Place one rectangle per node without overlaps. Rooms are placed in mission
 * order and biased left-to-right by depth, so the critical path reads as a
 * journey across the map rather than a random scatter.
 */
function placeRooms(graph: MissionGraph, width: number, height: number, rand: () => number): Map<number, Rect> {
  const placed = new Map<number, Rect>();
  const maxDepth = Math.max(1, ...graph.nodes.map((n) => n.depth));

  for (const node of graph.nodes) {
    const w = 3 + Math.floor(rand() * 4);
    const h = 3 + Math.floor(rand() * 3);
    // Horizontal band this room prefers, from its depth along the mission.
    const bandCentre = ((node.depth + 0.5) / (maxDepth + 1)) * (width - 2);
    let room: Rect | null = null;
    for (let attempt = 0; attempt < 200 && !room; attempt++) {
      const jitter = (rand() - 0.5) * (width / (maxDepth + 1)) * (attempt < 60 ? 1 : 3);
      const x = Math.round(Math.min(width - w - 2, Math.max(1, bandCentre - w / 2 + jitter)));
      const y = 1 + Math.floor(rand() * Math.max(1, height - h - 2));
      const candidate = { x, y, w, h };
      if (candidate.x < 1 || candidate.y < 1 || candidate.x + candidate.w >= width - 1 || candidate.y + candidate.h >= height - 1) continue;
      let clash = false;
      for (const other of placed.values()) if (overlaps(candidate, other)) { clash = true; break; }
      if (!clash) room = candidate;
    }
    // A map too small for every room still returns the ones that fit, rather
    // than looping forever or throwing on a legitimate request.
    if (room) placed.set(node.id, room);
  }
  return placed;
}

/** Carve an L-shaped corridor between two points, horizontal leg first. */
function carveCorridor(
  grid: SemanticToken[], width: number, height: number,
  from: { x: number; y: number }, to: { x: number; y: number },
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const put = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return;
    const i = y * width + x;
    if (grid[i] === 'wall') grid[i] = 'ground';
    cells.push({ x, y });
  };
  const stepX = from.x <= to.x ? 1 : -1;
  for (let x = from.x; x !== to.x + stepX; x += stepX) put(x, from.y);
  const stepY = from.y <= to.y ? 1 : -1;
  for (let y = from.y; y !== to.y + stepY; y += stepY) put(to.x, y);
  return cells;
}

/** Generate a mission-shaped layout as a semantic template. */
export function generateSemanticLayout(opts: LayoutOptions): SemanticTemplate {
  const width = Math.max(9, Math.floor(opts.width));
  const height = Math.max(9, Math.floor(opts.height));
  const rand = mulberry32(opts.seed ?? 12345);
  const rooms = opts.rooms ?? 5;
  const locked = opts.locked ?? rooms >= 4;
  const sideRooms = opts.sideRooms ?? 2;

  const graph = buildMissionGraph({ rooms, locked, sideRooms, rand });
  const placed = placeRooms(graph, width, height, rand);

  const grid = new Array<SemanticToken>(width * height).fill('wall');
  const markers: SemanticTemplate['markers'] = [];

  // Rooms first, so corridors can tell room floor from solid rock.
  for (const [, rect] of placed) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) grid[y * width + x] = 'ground';
    }
  }

  // Corridors along mission edges. A locked edge gets a door partway along it,
  // which is exactly the choke point the mission describes.
  for (const edge of graph.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) continue;
    const path = carveCorridor(grid, width, height, centre(a), centre(b));
    if (edge.lockedBy !== undefined && path.length) {
      const doorAt = path[Math.max(0, path.length - 2)];
      grid[doorAt.y * width + doorAt.x] = 'door';
      markers.push({ x: doorAt.x, y: doorAt.y, role: 'door', note: `locked by the key in room ${edge.lockedBy}` });
    }
  }

  // One extra connection turns a tree into a graph with a loop, which reads as a
  // real place rather than a branching corridor.
  if ((opts.loop ?? true) && placed.size >= 4) {
    const ids = [...placed.keys()];
    const a = placed.get(ids[1]);
    const b = placed.get(ids[ids.length - 1]);
    if (a && b) carveCorridor(grid, width, height, centre(a), centre(b));
  }

  // Mission roles become points of interest the caller can populate with events.
  for (const node of graph.nodes) {
    const rect = placed.get(node.id);
    if (!rect) continue;
    const c = centre(rect);
    if (node.role === 'hall') continue;
    if (node.role !== 'entrance' && node.role !== 'exit') grid[c.y * width + c.x] = 'poi';
    markers.push({ x: c.x, y: c.y, role: node.role, note: `room ${node.id}` });
  }

  return {
    id: 'graph-' + (opts.seed ?? 12345),
    name: opts.name ?? 'Generated layout',
    width,
    height,
    grid,
    props: [],
    markers,
  };
}
