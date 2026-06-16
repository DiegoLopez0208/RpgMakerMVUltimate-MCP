import path from "path";
import { readFile, access } from 'fs/promises';
import type { MapEvent, TilesetConfig, GeneratorOptions, MapTemplate } from '../types/rpgmaker.js';
import { applyAutotileShapes } from './autotile.js';
import { pickStamp, stampObject, hasStamps, type StampCategory } from './stamps.js';

// Tileset whose stamp library the current generation should use. Set by
// generateTileLayoutV3 before running a theme generator (stamps are per-tileset).
let _stampTileset = 2;

// ─── mapGenerator.ts — RPG Maker MV Procedural Map Generator ───
// Features: Perlin noise 2D, BSP dungeon, cellular automata caves,
// parametric seed, 20+ themes, automatic event generation,
// correct 6-layer data format (layers 0-3 = tile IDs, 4 = shadow bits, 5 = region IDs)

// ════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ════════════════════════════════════════════════════════════════

interface BSPRoom {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

interface BSPCorridor {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface TransferPoint {
  x: number;
  y: number;
  destMapId: number;
  destX: number;
  destY: number;
  trigger?: number;
}

// ════════════════════════════════════════════════════════════════
// PERLIN NOISE 2D (pure JS, no dependencies)
// ════════════════════════════════════════════════════════════════

class PerlinNoise {
  private perm: Uint8Array;
  private grad: number[][];

  constructor(seed: number) {
    this.perm = new Uint8Array(512);
    this.grad = [
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [1, 0], [-1, 0], [0, 1], [0, -1]
    ];
    const p = new Uint8Array(256);
    let s = seed || 0;
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
  }

  private dot2(g: number[], x: number, y: number): number {
    return g[0] * x + g[1] * y;
  }

  noise2d(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this.fade(x);
    const v = this.fade(y);
    const p = this.perm;
    const A = p[X] + Y;
    const B = p[X + 1] + Y;
    const g = this.grad;
    return this.lerp(
      this.lerp(this.dot2(g[p[A] & 15], x, y), this.dot2(g[p[B] & 15], x - 1, y), u),
      this.lerp(this.dot2(g[p[A + 1] & 15], x, y - 1), this.dot2(g[p[B + 1] & 15], x - 1, y - 1), u),
      v
    );
  }

  fbm(x: number, y: number, octaves: number, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0, amp = 1, freq = 1, max = 0;
    octaves = octaves || 4;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2d(x * freq, y * freq) * amp;
      max += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / max;
  }
}

// ════════════════════════════════════════════════════════════════
// PRNG (Linear Congruential Generator)
// ════════════════════════════════════════════════════════════════

class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed || 42;
  }

  next(): number {
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
    return this.state;
  }

  nextFloat(): number {
    return this.next() / 0x7fffffff;
  }

  nextInt(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }

  nextBool(chance: number = 0.5): boolean {
    return this.nextFloat() < chance;
  }
}

// ════════════════════════════════════════════════════════════════
// MAP DATA HELPERS (correct layer format)
// ════════════════════════════════════════════════════════════════
// Layer 0: Lower tile 1 (ground: A1, A2, A5)
// Layer 1: Lower tile 2 (ground overlay: A2, A5)
// Layer 2: Upper tile 1 (walls/roofs: A3, A4, B-E decorations)
// Layer 3: Upper tile 2 (extra decorations: B-E)
// Layer 4: Shadow bits (bitmask 0-15, NOT a tile ID)
// Layer 5: Region ID (1-255, NOT a tile ID)

const LAYER_GROUND1 = 0;
const LAYER_GROUND2 = 1;
const LAYER_UPPER1 = 2;
const LAYER_UPPER2 = 3;
const LAYER_SHADOW = 4;
const LAYER_REGION = 5;

function setTile(data: number[], w: number, h: number, x: number, y: number, layer: number, tileId: number): void {
  if (x >= 0 && x < w && y >= 0 && y < h && layer >= 0 && layer < 6)
    data[(layer * h + y) * w + x] = tileId;
}

function getTile(data: number[], w: number, h: number, x: number, y: number, layer: number): number {
  if (x < 0 || x >= w || y < 0 || y >= h || layer < 0 || layer >= 6) return 0;
  return data[(layer * h + y) * w + x];
}

function fillRect(data: number[], w: number, h: number, x1: number, y1: number, x2: number, y2: number, layer: number, tileId: number): void {
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      setTile(data, w, h, x, y, layer, tileId);
}

function fillLayer(data: number[], w: number, h: number, layer: number, tileId: number): void {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, layer, tileId);
}

function setShadow(data: number[], w: number, h: number, x: number, y: number, bits: number): void {
  if (x >= 0 && x < w && y >= 0 && y < h)
    data[(LAYER_SHADOW * h + y) * w + x] = data[(LAYER_SHADOW * h + y) * w + x] | bits;
}

function setRegion(data: number[], w: number, h: number, x1: number, y1: number, x2?: number, y2?: number, rid?: number): void {
  if (x2 !== undefined && y2 !== undefined && rid !== undefined) {
    for (let ry = y1; ry <= y2; ry++)
      for (let rx = x1; rx <= x2; rx++)
        if (rx >= 0 && rx < w && ry >= 0 && ry < h && rid >= 0 && rid <= 255)
          data[(LAYER_REGION * h + ry) * w + rx] = rid;
  } else {
    const regionId = (arguments.length >= 7 && rid !== undefined) ? rid : (x2 as number);
    if (x1 >= 0 && x1 < w && y1 >= 0 && y1 < h && regionId >= 0 && regionId <= 255)
      data[(LAYER_REGION * h + y1) * w + x1] = regionId;
  }
}

// MV autotile id = sheetBase + kind*48 + shape, where sheetBase is the start of
// the autotile sheet (A1 2048, A2 2816, A3 4352, A4 5888) and `kind` is the
// local autotile index within that sheet. Historically the 3rd argument was
// dropped, so every floor/wall collapsed to base 2048 (A1 animated water) and
// interiors/dungeons rendered as water. It is now honored.
function makeAutotileId(kind: number, shape: number = 0, sheetBase: number = 2048): number {
  return (sheetBase || 2048) + kind * 48 + (shape || 0);
}

// ════════════════════════════════════════════════════════════════
// TILESET CONFIG: Per-tileset tile ID mappings
// ════════════════════════════════════════════════════════════════

const TILESETS: Record<string, Record<string, number>> = {
  overworld: {
    water: 2048, deepWater: makeAutotileId(1, 0),
    ground: makeAutotileId(16, 0), dirt: makeAutotileId(20, 0),
    forest: makeAutotileId(18, 0), mountain: makeAutotileId(24, 0),
    tree: 0, town: 2, castle: 4, port: 6
  },
  outside: {
    water: 2048, deepWater: makeAutotileId(1, 0),
    // Ground types are A2 autotile kinds (16-47), NOT low kinds — kinds < 16
    // resolve to the A1 animated-water sheet, which is why dirt roads rendered
    // as water. Kinds verified against the ProjectR Outside tileset (id 2):
    // k16 grass, k18 dirt/road, plus k17/24/32 for other ground.
    grass: makeAutotileId(16, 0), dirt: makeAutotileId(18, 0), stone: makeAutotileId(32, 0),
    sand: makeAutotileId(24, 0), darkGrass: makeAutotileId(17, 0),
    lava: makeAutotileId(20, 0), swampWater: 2048,
    wallSide: makeAutotileId(8, 0, 4352), wallTop: 4352,
    roof: 4352, roof2: makeAutotileId(1, 0, 4352), roof3: makeAutotileId(2, 0, 4352),
    // Decorations are real object tiles confirmed used by the ProjectR Outside
    // tileset (id 2). tree/bush/flower/rock/flower2 keep the A5 ids that the
    // reference maps actually place (1538-1541, 1549); the rest were unused A5
    // slots (often blank in the sheet) and are remapped to common single-tile
    // B/C objects from the reference maps.
    tree: 1538, bush: 1539, flower: 1540, rock: 1541, pillar: 101, stump: 168,
    fence: 77, well: 107, barrel: 68, crate: 48,
    chest: 56, sign: 176, lamp: 91, flower2: 1549,
    magicDeco: 393, magicDeco2: 417, magicDeco3: 425
  },
  inside: {
    floor: makeAutotileId(0, 0, 2816), carpet: makeAutotileId(2, 0, 2816),
    woodFloor: makeAutotileId(4, 0, 2816), tileFloor: makeAutotileId(6, 0, 2816),
    wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
    // Interior furniture lives in the B/C object pages, NOT A5 (which is floor
    // patterns) — the old A5 ids 1537-1547 were blank cells, so furniture
    // rendered as nothing. Remapped to real object tiles the ProjectR Inside
    // tileset (id 3) actually uses.
    door: 1536, bookshelf: 104, table: 209, chair: 105,
    bed: 387, chest: 88, pot: 69, lamp: 77,
    stairs: 142, window: 33, fireplace: 41, cabinet: 80,
    magicDeco: 466, magicDeco2: 474, magicDeco3: 387, magicDeco4: 88
  },
  dungeon: {
    floor: makeAutotileId(0, 0, 2816), darkFloor: makeAutotileId(2, 0, 2816),
    brickFloor: makeAutotileId(4, 0, 2816),
    wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
    wallDark: makeAutotileId(2, 0, 5888), wallStone: makeAutotileId(4, 0, 5888),
    water: 2048, lava: makeAutotileId(4, 0),
    pillar: 1536, rock: 1537, torch: 1538, chest: 1539,
    bones: 1540, crate: 1541, barrel: 1542, crystal: 1543
  },
  sf_outside: {
    water: 2048, grass: makeAutotileId(16, 0), concrete: makeAutotileId(32, 0),
    metal: makeAutotileId(34, 0), asphalt: makeAutotileId(40, 0),
    wallSide: makeAutotileId(8, 0, 4352), wallTop: makeAutotileId(0, 0, 4352),
    roof: makeAutotileId(0, 0, 4352),
    lamp: 1536, sign: 1537, vehicle: 1538, container: 1539,
    antenna: 1540, satellite: 1541, fence: 1542, barrier: 1543,
    sifiDeco: 512, sifiDeco2: 513
  },
  sf_inside: {
    floor: makeAutotileId(0, 0, 2816), metalFloor: makeAutotileId(2, 0, 2816),
    tileFloor: makeAutotileId(4, 0, 2816),
    wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
    screen: 1536, console: 1537, locker: 1538, bed: 1539,
    table: 1540, chair: 1541, door: 1542, vent: 1543,
    sifiDeco: 512, sifiDeco2: 513
  },
  magic_exterior: {
    water: 2048, grass: makeAutotileId(16, 0), dirt: makeAutotileId(18, 0), stone: makeAutotileId(32, 0),
    wallSide: makeAutotileId(8, 0, 4352), wallTop: 4352,
    roof: 4352, roof2: makeAutotileId(1, 0, 4352),
    tree: 1538, bush: 1539, flower: 1540, rock: 1541,
    magicTree: 512, magicCrystal: 513, magicRune: 514, magicArch: 515,
    magicPillar: 516, magicFountain: 517, magicTorch: 518, magicFlower: 519
  },
  space_interior: {
    floor: makeAutotileId(0, 0, 2816), metalFloor: makeAutotileId(2, 0, 2816),
    wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
    screen: 1536, console: 1537, locker: 1538, bed: 1539,
    table: 1540, chair: 1541, door: 1542, vent: 1543,
    sifiPanel: 512, sifiMonitor: 513, sifiTank: 514, sifiCore: 515
  }
};

// ════════════════════════════════════════════════════════════════
// BSP DUNGEON GENERATOR
// ════════════════════════════════════════════════════════════════

class BSPNode {
  x: number;
  y: number;
  w: number;
  h: number;
  left: BSPNode | null;
  right: BSPNode | null;
  room: BSPRoom | null;
  corridor: BSPCorridor | null;

  constructor(x: number, y: number, w: number, h: number) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.left = null; this.right = null;
    this.room = null; this.corridor = null;
  }

  split(rng: PRNG, minSize: number): boolean {
    if (this.left || this.right) return false;
    let horizontal = rng.nextBool(0.5);
    if (this.w > this.h && this.w / this.h >= 1.25) horizontal = false;
    else if (this.h > this.w && this.h / this.w >= 1.25) horizontal = true;

    const max = (horizontal ? this.h : this.w) - minSize;
    if (max < minSize) return false;

    const split = rng.nextInt(minSize, max);
    if (horizontal) {
      this.left = new BSPNode(this.x, this.y, this.w, split);
      this.right = new BSPNode(this.x, this.y + split, this.w, this.h - split);
    } else {
      this.left = new BSPNode(this.x, this.y, split, this.h);
      this.right = new BSPNode(this.x + split, this.y, this.w - split, this.h);
    }
    return true;
  }

  createRooms(rng: PRNG, minRoom: number, margin: number): void {
    if (this.left || this.right) {
      if (this.left) this.left.createRooms(rng, minRoom, margin);
      if (this.right) this.right.createRooms(rng, minRoom, margin);
    } else {
      const rw = rng.nextInt(minRoom, Math.max(minRoom, this.w - margin * 2));
      const rh = rng.nextInt(minRoom, Math.max(minRoom, this.h - margin * 2));
      const rx = rng.nextInt(this.x + margin, Math.max(this.x + margin, this.x + this.w - rw - margin));
      const ry = rng.nextInt(this.y + margin, Math.max(this.y + margin, this.y + this.h - rh - margin));
      this.room = { x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) };
    }
  }

  getRooms(): BSPRoom[] {
    if (this.room) return [this.room];
    const rooms: BSPRoom[] = [];
    if (this.left) rooms.push(...this.left.getRooms());
    if (this.right) rooms.push(...this.right.getRooms());
    return rooms;
  }

  getCorridors(rng: PRNG): BSPCorridor[] {
    const corridors: BSPCorridor[] = [];
    if (this.left && this.right) {
      const lr = this.left.getRooms();
      const rr = this.right.getRooms();
      if (lr.length > 0 && rr.length > 0) {
        const a = lr[rng.nextInt(0, lr.length - 1)];
        const b = rr[rng.nextInt(0, rr.length - 1)];
        corridors.push({ x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy });
      }
      corridors.push(...this.left.getCorridors(rng));
      corridors.push(...this.right.getCorridors(rng));
    }
    return corridors;
  }
}

function generateBSPDungeon(data: number[], w: number, h: number, rng: PRNG, ts: Record<string, number>, opts: GeneratorOptions = {}): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  const depth: number = (opts as Record<string, number>).depth || 4;
  const minRoom: number = (opts as Record<string, number>).minRoom || 3;
  const margin: number = (opts as Record<string, number>).margin || 1;
  const wallThick: number = (opts as Record<string, number>).wallThick || 1;

  const floorTile = ts.floor || 2816;
  const wallTile = ts.wallSide || 5888;
  const wallTopTile = ts.wallTop || makeAutotileId(1, 0, 5888);

  fillRect(data, w, h, 0, 0, w - 1, h - 1, LAYER_GROUND1, wallTile);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      setTile(data, w, h, x, y, LAYER_UPPER1, wallTopTile);

  const root = new BSPNode(wallThick, wallThick, w - wallThick * 2, h - wallThick * 2);
  for (let i = 0; i < depth; i++) {
    const leaves = getLeaves(root);
    for (let j = 0; j < leaves.length; j++) {
      leaves[j].split(rng, Math.max(3, Math.floor(Math.min(w, h) / (depth + 1))));
    }
  }
  root.createRooms(rng, minRoom, margin);

  const rooms = root.getRooms();
  const corridors = root.getCorridors(rng);

  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    fillRect(data, w, h, r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, LAYER_GROUND1, floorTile);
    for (let ry = r.y; ry < r.y + r.h; ry++)
      for (let rx = r.x; rx < r.x + r.w; rx++) {
        setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
        setRegion(data, w, h, rx, ry, 1);
      }
  }

  for (let ci = 0; ci < corridors.length; ci++) {
    const c = corridors[ci];
    const cx = Math.min(c.x1, c.x2);
    const cy = Math.min(c.y1, c.y2);
    const cw = Math.abs(c.x2 - c.x1) + 1;
    const ch = Math.abs(c.y2 - c.y1) + 1;
    if (rng.nextBool()) {
      fillRect(data, w, h, cx, c.y1, cx + cw - 1, c.y1, LAYER_GROUND1, floorTile);
      fillRect(data, w, h, c.x2, cy, c.x2, cy + ch - 1, LAYER_GROUND1, floorTile);
    } else {
      fillRect(data, w, h, c.x1, cy, c.x1, cy + ch - 1, LAYER_GROUND1, floorTile);
      fillRect(data, w, h, cx, c.y2, cx + cw - 1, c.y2, LAYER_GROUND1, floorTile);
    }
    for (let py = cy; py < cy + ch; py++)
      for (let px = cx; px < cx + cw; px++) {
        if (getTile(data, w, h, px, py, LAYER_GROUND1) === floorTile) {
          setTile(data, w, h, px, py, LAYER_UPPER1, 0);
          setRegion(data, w, h, px, py, 1);
        }
      }
  }

  const decoTiles = [ts.pillar, ts.torch, ts.rock, ts.crystal, ts.bones, ts.barrel].filter(Boolean);
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    if (decoTiles.length > 0) {
      const numDeco = rng.nextInt(0, Math.min(4, Math.floor(r.w * r.h / 8)));
      for (let d = 0; d < numDeco; d++) {
        const dx = rng.nextInt(r.x + 1, r.x + r.w - 2);
        const dy = rng.nextInt(r.y + 1, r.y + r.h - 2);
        setTile(data, w, h, dx, dy, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
      }
    }
  }

  const bossRoom = rooms.length > 1 ? rooms[rooms.length - 1] : rooms[0];
  setRegion(data, w, h, bossRoom.cx, bossRoom.cy, 2);

  return { rooms: rooms, corridors: corridors, bossRoom: bossRoom };
}

function getLeaves(node: BSPNode): BSPNode[] {
  if (!node.left && !node.right) return [node];
  const l: BSPNode[] = [];
  if (node.left) l.push(...getLeaves(node.left));
  if (node.right) l.push(...getLeaves(node.right));
  return l;
}

// ════════════════════════════════════════════════════════════════
// CELLULAR AUTOMATA CAVE GENERATOR
// ════════════════════════════════════════════════════════════════

function generateCellularCave(data: number[], w: number, h: number, rng: PRNG, ts: Record<string, number>, opts: GeneratorOptions = {}): { grid: number[][] } {
  const fillProb: number = (opts as Record<string, number>).fillProb || 0.45;
  const iterations: number = (opts as Record<string, number>).iterations || 5;
  const birthLimit: number = (opts as Record<string, number>).birthLimit || 4;
  const deathLimit: number = (opts as Record<string, number>).deathLimit || 3;

  const floorTile = ts.floor || 2816;
  const wallTile = ts.wallSide || makeAutotileId(0, 0, 5888);
  const wallTopTile = ts.wallTop || makeAutotileId(1, 0, 5888);

  let grid: number[][] = [];
  for (let y = 0; y < h; y++) {
    grid[y] = [];
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
        grid[y][x] = 1;
      else
        grid[y][x] = rng.nextFloat() < fillProb ? 1 : 0;
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const newGrid: number[][] = [];
    for (let y = 0; y < h; y++) {
      newGrid[y] = [];
      for (let x = 0; x < w; x++) {
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) neighbors++;
            else if (grid[ny][nx] === 1) neighbors++;
          }
        if (grid[y][x] === 1)
          newGrid[y][x] = neighbors < deathLimit ? 0 : 1;
        else
          newGrid[y][x] = neighbors > birthLimit ? 1 : 0;
      }
    }
    grid = newGrid;
  }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === 0) {
        setTile(data, w, h, x, y, LAYER_GROUND1, floorTile);
        setTile(data, w, h, x, y, LAYER_UPPER1, 0);
        setRegion(data, w, h, x, y, 1);
      } else {
        setTile(data, w, h, x, y, LAYER_GROUND1, wallTile);
        setTile(data, w, h, x, y, LAYER_UPPER1, wallTopTile);
      }
    }

  const decoTiles = [ts.rock, ts.crystal, ts.bones, ts.torch].filter(Boolean);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      if (grid[y][x] === 0 && decoTiles.length > 0 && rng.nextBool(0.06)) {
        setTile(data, w, h, x, y, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
      }
    }

  return { grid: grid };
}

// ════════════════════════════════════════════════════════════════
// THEME GENERATORS (20+ themes)
// ════════════════════════════════════════════════════════════════

function applyPerlinTerrain(data: number[], w: number, h: number, perlin: PerlinNoise, ts: Record<string, number>, opts: GeneratorOptions = {}): void {
  const scale: number = (opts as Record<string, number>).scale || 0.08;
  const waterThreshold: number = (opts as Record<string, number>).waterThreshold || -0.2;
  const deepThreshold: number = (opts as Record<string, number>).deepThreshold || -0.4;
  const sandThreshold: number = (opts as Record<string, number>).sandThreshold || -0.05;
  const waterTile = (opts as Record<string, number>).waterTile || ts.water;
  const deepTile = (opts as Record<string, number>).deepTile || ts.deepWater;
  const sandTile = (opts as Record<string, number>).sandTile || ts.sand;
  const grassTile = (opts as Record<string, number>).grassTile || ts.grass;

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = perlin.fbm(x * scale, y * scale, 4);
      if (n < deepThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, deepTile);
      else if (n < waterThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, waterTile);
      else if (n < sandThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, sandTile);
      else setTile(data, w, h, x, y, LAYER_GROUND1, grassTile);
    }
}

// Place real multi-tile building stamps, non-overlapping (with a 1-tile margin)
// and avoiding `blocked` cells (e.g. roads). Returns each footprint + door.
function placeHouseStamps(
  data: number[], w: number, h: number, rng: PRNG, count: number, blocked?: (x: number, y: number) => boolean
): { x: number; y: number; w: number; h: number; doorX: number; doorY: number }[] {
  const houses: { x: number; y: number; w: number; h: number; doorX: number; doorY: number }[] = [];
  const occ = new Uint8Array(w * h);
  for (let attempt = 0; houses.length < count && attempt < count * 40; attempt++) {
    const stamp = pickStamp(_stampTileset, 'house', rng);
    if (!stamp) break;
    if (stamp.w + 2 >= w || stamp.h + 2 >= h) continue;
    const hx = rng.nextInt(1, w - stamp.w - 1);
    const hy = rng.nextInt(1, h - stamp.h - 1);
    let ok = true;
    for (let yy = hy - 1; yy <= hy + stamp.h && ok; yy++)
      for (let xx = hx - 1; xx <= hx + stamp.w && ok; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (occ[yy * w + xx] || (blocked && blocked(xx, yy))) ok = false;
      }
    if (!ok) continue;
    const res = stampObject(data, w, h, hx, hy, stamp);
    for (let yy = hy; yy < hy + stamp.h; yy++)
      for (let xx = hx; xx < hx + stamp.w; xx++) { if (xx < w && yy < h) { occ[yy * w + xx] = 1; setShadow(data, w, h, xx, yy, 15); } }
    const doorX = res.door ? res.door.x : hx + Math.floor(stamp.w / 2);
    const doorY = res.door ? res.door.y : hy + stamp.h - 1;
    houses.push({ x: hx, y: hy, w: stamp.w, h: stamp.h, doorX: doorX, doorY: doorY });
  }
  return houses;
}

// Scatter real multi-tile decoration stamps (trees/props), only where the upper
// layers are empty and the cell isn't `blocked`. Replaces single-tile scatter.
function placeDecoStamps(
  data: number[], w: number, h: number, rng: PRNG, count: number,
  cats: StampCategory[], blocked?: (x: number, y: number) => boolean
): void {
  const usable = cats.filter(function (c) { return hasStamps(_stampTileset, c); });
  if (usable.length === 0) return;
  for (let attempt = 0, placed = 0; placed < count && attempt < count * 25; attempt++) {
    const stamp = pickStamp(_stampTileset, usable[rng.nextInt(0, usable.length - 1)], rng);
    if (!stamp) continue;
    const x = rng.nextInt(0, w - stamp.w), y = rng.nextInt(0, h - stamp.h);
    let ok = true;
    for (let yy = y; yy < y + stamp.h && ok; yy++)
      for (let xx = x; xx < x + stamp.w && ok; xx++) {
        if (getTile(data, w, h, xx, yy, LAYER_UPPER1) !== 0 || getTile(data, w, h, xx, yy, LAYER_UPPER2) !== 0) ok = false;
        else if (blocked && blocked(xx, yy)) ok = false;
      }
    if (!ok) continue;
    stampObject(data, w, h, x, y, stamp);
    placed++;
  }
}

function generateForestTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.outside;
  applyPerlinTerrain(data, w, h, perlin, ts, { scale: 0.06, waterThreshold: -0.25, deepThreshold: -0.45 });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = getTile(data, w, h, x, y, LAYER_GROUND1);
      if (g === ts.water) setRegion(data, w, h, x, y, 3);
      else if (g === ts.grass) setRegion(data, w, h, x, y, 1);
    }
  // Whole multi-tile tree/rock objects on grass, not single scattered tiles.
  const onWater = function (x: number, y: number) { return getTile(data, w, h, x, y, LAYER_GROUND1) !== ts.grass; };
  if (hasStamps(_stampTileset, 'tree') || hasStamps(_stampTileset, 'prop')) {
    placeDecoStamps(data, w, h, rng, Math.floor(w * h / 18), ['tree', 'tree', 'prop'], onWater);
  } else {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (getTile(data, w, h, x, y, LAYER_GROUND1) === ts.grass && rng.nextBool(0.12))
          setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : (rng.nextBool() ? ts.bush : ts.flower));
      }
  }
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const cr = Math.max(3, Math.floor(Math.min(w, h) / 5));
  for (let dy = -cr; dy <= cr; dy++)
    for (let dx = -cr; dx <= cr; dx++) {
      const rx = cx + dx, ry = cy + dy;
      if (dx * dx + dy * dy < cr * cr) {
        setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.dirt);
        setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
        setTile(data, w, h, rx, ry, LAYER_UPPER2, 0);
        setRegion(data, w, h, rx, ry, 1);
      }
    }
}

function generateTownTheme(data: number[], w: number, h: number, rng: PRNG, _perlin?: PerlinNoise): { houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] } {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.grass);
  const roadX = Math.floor(w / 2);
  const roadY = Math.floor(h / 2);
  fillRect(data, w, h, roadX - 1, 0, roadX + 1, h - 1, LAYER_GROUND1, ts.dirt);
  fillRect(data, w, h, 0, roadY - 1, w - 1, roadY + 1, LAYER_GROUND1, ts.dirt);
  setRegion(data, w, h, 0, 0, w - 1, h - 1, 1);
  const onRoad = function (x: number, y: number) { return Math.abs(x - roadX) <= 1 || Math.abs(y - roadY) <= 1; };
  const numHouses = Math.max(3, Math.floor(w * h / 150));
  let houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[];

  if (hasStamps(_stampTileset, 'house')) {
    // Stamp real building objects from the reference maps (coherent, not generic
    // autotile boxes). createMapV3 reads doorX/doorY for the enterable-house warp.
    houses = placeHouseStamps(data, w, h, rng, numHouses, onRoad);
  } else {
    // Fallback: simple autotile-rect houses (projects without a stamp library).
    houses = [];
    for (let i = 0; i < numHouses; i++) {
      const hw = rng.nextInt(4, 6), hh = rng.nextInt(3, 5);
      const hx = rng.nextInt(2, w - hw - 2), hy = rng.nextInt(2, h - hh - 2);
      if (onRoad(hx + Math.floor(hw / 2), hy + Math.floor(hh / 2))) continue;
      let overlap = false;
      for (let j = 0; j < houses.length; j++) {
        const oh = houses[j];
        if (hx < oh.x + oh.w + 1 && hx + hw + 1 > oh.x && hy < oh.y + oh.h + 1 && hy + hh + 1 > oh.y) { overlap = true; break; }
      }
      if (overlap) continue;
      houses.push({ x: hx, y: hy, w: hw, h: hh });
      fillRect(data, w, h, hx, hy, hx + hw - 1, hy, LAYER_UPPER1, ts.roof);
      fillRect(data, w, h, hx, hy + 1, hx + hw - 1, hy + hh - 1, LAYER_UPPER1, ts.wallSide);
      setTile(data, w, h, hx + Math.floor(hw / 2), hy + hh - 1, LAYER_UPPER1, 0);
      for (let dy = hy; dy < hy + hh; dy++) for (let dx = hx; dx < hx + hw; dx++) setShadow(data, w, h, dx, dy, 15);
    }
  }

  if (hasStamps(_stampTileset, 'tree') || hasStamps(_stampTileset, 'prop')) {
    placeDecoStamps(data, w, h, rng, Math.floor(w * h / 70), ['tree', 'prop'], onRoad);
  } else {
    const decoTiles = [ts.well, ts.barrel, ts.sign, ts.lamp, ts.flower, ts.flower2];
    for (let i = 0; i < Math.floor(w * h / 40); i++) {
      const dx = rng.nextInt(0, w - 1), dy = rng.nextInt(0, h - 1);
      if (getTile(data, w, h, dx, dy, LAYER_UPPER1) === 0)
        setTile(data, w, h, dx, dy, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
    }
  }
  return { houses: houses };
}

function generateInteriorTheme(data: number[], w: number, h: number, rng: PRNG): void {
  const ts = TILESETS.inside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.floor);
  fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, 0, w - 1, 0, LAYER_UPPER2, ts.wallTop);
  fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, 2, 0, h - 3, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, w - 1, 2, w - 1, h - 3, LAYER_UPPER1, ts.wallSide);
  const doorX = Math.floor(w / 2);
  setTile(data, w, h, doorX, h - 1, LAYER_UPPER1, 0);
  setTile(data, w, h, doorX - 1, h - 1, LAYER_UPPER1, 0);
  fillRect(data, w, h, 2, 2, w - 3, h - 3, LAYER_REGION, 0);
  setRegion(data, w, h, 2, 2, w - 3, h - 3, 1);
  const cw = Math.max(2, Math.floor(w / 4)), ch = Math.max(2, Math.floor(h / 4));
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  fillRect(data, w, h, cx - Math.floor(cw / 2), cy - Math.floor(ch / 2), cx + Math.floor(cw / 2), cy + Math.floor(ch / 2), LAYER_GROUND1, ts.carpet);
  setTile(data, w, h, cx, cy, LAYER_UPPER2, ts.table);
  setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.chair);
  setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.chair);
  setTile(data, w, h, 2, 2, LAYER_UPPER2, ts.bookshelf);
  setTile(data, w, h, 3, 2, LAYER_UPPER2, ts.bookshelf);
  setTile(data, w, h, w - 3, 2, LAYER_UPPER2, ts.bed);
}

function generateCastleTheme(data: number[], w: number, h: number, rng: PRNG): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
  fillRect(data, w, h, 0, 0, w - 1, 2, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, 0, 0, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, w - 1, 0, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 1, 1, w - 2, h - 2, LAYER_REGION, 0);
  setRegion(data, w, h, 2, 2, w - 3, h - 3, 1);
  const midX = Math.floor(w / 2);
  fillRect(data, w, h, midX - 1, 3, midX + 1, h - 4, LAYER_UPPER1, 0);
  setTile(data, w, h, midX - 1, 3, LAYER_UPPER1, ts.wallSide);
  setTile(data, w, h, midX + 1, 3, LAYER_UPPER1, ts.wallSide);
  for (let y = 3; y < h - 3; y += 3) {
    setTile(data, w, h, 2, y, LAYER_UPPER2, ts.pillar);
    setTile(data, w, h, w - 3, y, LAYER_UPPER2, ts.pillar);
  }
  const throneX = Math.floor(w * 0.75), throneY = Math.floor(h * 0.25);
  setTile(data, w, h, throneX, throneY, LAYER_UPPER2, 1536);
  setRegion(data, w, h, throneX - 2, throneY - 2, throneX + 2, throneY + 2, 2);
  setTile(data, w, h, midX, h - 2, LAYER_UPPER1, 0);
  setTile(data, w, h, midX, h - 1, LAYER_UPPER1, 0);
}

function generateBeachTheme(data: number[], w: number, h: number, rng: PRNG, _perlin?: PerlinNoise): void {
  const ts = TILESETS.outside;
  const waterLine = Math.floor(h * 0.4);
  const sandLine = Math.floor(h * 0.6);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const offset = Math.floor(Math.sin(x * 0.5) * 2);
      const ey = y + offset;
      if (ey < waterLine) {
        setTile(data, w, h, x, y, LAYER_GROUND1, ey < waterLine - 3 ? ts.deepWater : ts.water);
        setRegion(data, w, h, x, y, 3);
      } else if (ey < sandLine) {
        setTile(data, w, h, x, y, LAYER_GROUND1, ts.sand || ts.dirt);
        setRegion(data, w, h, x, y, 1);
      } else {
        setTile(data, w, h, x, y, LAYER_GROUND1, ts.grass);
        setRegion(data, w, h, x, y, 1);
      }
    }
  for (let i = 0; i < Math.floor(w * h / 60); i++) {
    const x = rng.nextInt(0, w - 1), y = rng.nextInt(sandLine, h - 1);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
      setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : ts.rock);
  }
}

function generateDesertTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.sand || ts.dirt);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.05, y * 0.05, 3);
      if (v > 0.35) setTile(data, w, h, x, y, LAYER_GROUND1, ts.stone);
      if (rng.nextBool(0.04))
        setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.rock : ts.stump);
      setRegion(data, w, h, x, y, 1);
    }
  const ox = Math.floor(w * 0.75), oy = Math.floor(h * 0.75);
  const or = Math.max(3, Math.floor(Math.min(w, h) / 6));
  for (let dy = -or; dy <= or; dy++)
    for (let dx = -or; dx <= or; dx++) {
      if (dx * dx + dy * dy < or * or) {
        const rx = ox + dx, ry = oy + dy;
        if (dx * dx + dy * dy < (or * 0.5) * (or * 0.5))
          setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.deepWater);
        else
          setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.water);
        setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
        setRegion(data, w, h, rx, ry, 2);
      }
    }
  setTile(data, w, h, ox - 1, oy - or + 1, LAYER_UPPER1, ts.tree);
  setTile(data, w, h, ox + 1, oy - or + 1, LAYER_UPPER1, ts.tree);
}

function generateSwampTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.outside;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.07, y * 0.07, 4);
      if (v < -0.1) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.swampWater || ts.water); setRegion(data, w, h, x, y, 3); }
      else if (v < 0.1) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt); setRegion(data, w, h, x, y, 1); setShadow(data, w, h, x, y, 15); }
      else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.darkGrass || ts.grass); setRegion(data, w, h, x, y, 1); setShadow(data, w, h, x, y, 15); }
    }
  for (let i = 0; i < Math.floor(w * h / 30); i++) {
    const x = rng.nextInt(0, w - 1), y = rng.nextInt(0, h - 1);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0 && getTile(data, w, h, x, y, LAYER_GROUND1) !== ts.water)
      setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.stump : ts.rock);
  }
}

function generateRuinsTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.1, y * 0.1, 3);
      if (v > 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && rng.nextBool(0.75))
        setTile(data, w, h, x, y, LAYER_UPPER1, ts.wallSide);
    }
  const wallXs = [Math.floor(w * 0.3), Math.floor(w * 0.6)];
  for (let wi = 0; wi < wallXs.length; wi++) {
    for (let y = 2; y < h - 2; y++) {
      if (rng.nextBool(0.65))
        setTile(data, w, h, wallXs[wi], y, LAYER_UPPER1, ts.wallSide);
    }
  }
  setRegion(data, w, h, 1, 1, w - 2, h - 2, 1);
  for (let i = 0; i < Math.floor(w * h / 25); i++) {
    const x = rng.nextInt(1, w - 2), y = rng.nextInt(1, h - 2);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
      setTile(data, w, h, x, y, LAYER_UPPER2, rng.nextBool() ? ts.rock : (rng.nextBool() ? ts.bush : ts.stump));
  }
}

function generateVillageTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): { houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] } {
  return generateTownTheme(data, w, h, rng, perlin);
}

function generateDungeonTheme(data: number[], w: number, h: number, rng: PRNG): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 15)), minRoom: 3, margin: 1 });
}

function generateCaveTheme(data: number[], w: number, h: number, rng: PRNG): { grid: number[][] } {
  return generateCellularCave(data, w, h, rng, TILESETS.dungeon, { fillProb: 0.48, iterations: 5 });
}

function generateSnowTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.06, y * 0.06, 4);
      if (v < -0.15) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.water); setRegion(data, w, h, x, y, 3); }
      else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.stone); setRegion(data, w, h, x, y, 1); }
    }
  for (let i = 0; i < Math.floor(w * h / 20); i++) {
    const x = rng.nextInt(0, w - 1), y = rng.nextInt(0, h - 1);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
      setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : ts.rock);
  }
}

function generateHarborTheme(data: number[], w: number, h: number, rng: PRNG): void {
  const ts = TILESETS.outside;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (y < Math.floor(h * 0.35)) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.deepWater); setRegion(data, w, h, x, y, 3); }
      else if (y < Math.floor(h * 0.45)) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.water); setRegion(data, w, h, x, y, 3); }
      else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt); setRegion(data, w, h, x, y, 1); }
    }
  const dockY = Math.floor(h * 0.45);
  fillRect(data, w, h, Math.floor(w * 0.2), dockY, Math.floor(w * 0.8), dockY + 1, LAYER_GROUND1, ts.stone);
}

function generateVolcanoTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.dungeon;
  fillLayer(data, w, h, LAYER_GROUND1, ts.darkFloor || ts.floor);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.08, y * 0.08, 4);
      if (v < -0.3) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.lava); setRegion(data, w, h, x, y, 4); }
      else if (rng.nextBool(0.04))
        setTile(data, w, h, x, y, LAYER_UPPER1, ts.rock);
      else setRegion(data, w, h, x, y, 1);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && rng.nextBool(0.8))
        setTile(data, w, h, x, y, LAYER_UPPER1, ts.wallStone || ts.wallSide);
}

function generateSewerTheme(data: number[], w: number, h: number, rng: PRNG): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 18)), minRoom: 3, margin: 1 });
}

function generateFortressTheme(data: number[], w: number, h: number, rng: PRNG): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(3, Math.floor(Math.min(w, h) / 12)), minRoom: 4, margin: 1 });
}

function generateMagicForestTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.magic_exterior;
  applyPerlinTerrain(data, w, h, perlin, ts, { scale: 0.05, waterThreshold: -0.3 });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = getTile(data, w, h, x, y, LAYER_GROUND1);
      if (g === ts.grass && rng.nextBool(0.12))
        setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : (rng.nextBool() ? ts.magicTree : ts.magicFlower));
      else if (g === ts.grass && rng.nextBool(0.04))
        setTile(data, w, h, x, y, LAYER_UPPER1, ts.magicCrystal);
      setRegion(data, w, h, x, y, g === ts.water ? 3 : 1);
    }
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  setTile(data, w, h, cx, cy, LAYER_UPPER2, ts.magicRune);
  setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.magicPillar);
  setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.magicPillar);
  setRegion(data, w, h, cx - 3, cy - 3, cx + 3, cy + 3, 2);
}

function generateMagicInteriorTheme(data: number[], w: number, h: number, rng: PRNG): void {
  const ts = TILESETS.inside;
  generateInteriorTheme(data, w, h, rng);
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  setTile(data, w, h, cx, cy - 2, LAYER_UPPER2, ts.magicDeco || 512);
  setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.magicDeco2 || 513);
  setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.magicDeco3 || 514);
}

function generateSpaceInteriorTheme(data: number[], w: number, h: number, rng: PRNG): void {
  const ts = TILESETS.space_interior;
  fillLayer(data, w, h, LAYER_GROUND1, ts.metalFloor);
  fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, 0, 0, 0, h - 1, LAYER_UPPER1, ts.wallSide);
  fillRect(data, w, h, w - 1, 0, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
  setRegion(data, w, h, 1, 1, w - 2, h - 2, 1);
  const doorX = Math.floor(w / 2);
  setTile(data, w, h, doorX, h - 1, LAYER_UPPER1, 0);
  let deco = [ts.console, ts.screen, ts.locker, ts.sifiPanel, ts.sifiMonitor, ts.sifiTank, ts.sifiCore];
  deco = deco.filter(Boolean);
  for (let i = 0; i < Math.floor(w * h / 20); i++) {
    const x = rng.nextInt(2, w - 3), y = rng.nextInt(2, h - 3);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0 && deco.length > 0)
      setTile(data, w, h, x, y, LAYER_UPPER2, deco[rng.nextInt(0, deco.length - 1)]);
  }
}

function generateSpaceExteriorTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.sf_outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.metal);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.1, y * 0.1, 3);
      if (v > 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.asphalt);
      else if (v < -0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.concrete);
      setRegion(data, w, h, x, y, 1);
    }
  let deco = [ts.antenna, ts.satellite, ts.container, ts.vehicle, ts.sifiDeco, ts.sifiDeco2];
  deco = deco.filter(Boolean);
  for (let i = 0; i < Math.floor(w * h / 30); i++) {
    const x = rng.nextInt(1, w - 2), y = rng.nextInt(1, h - 2);
    if (deco.length > 0) setTile(data, w, h, x, y, LAYER_UPPER1, deco[rng.nextInt(0, deco.length - 1)]);
  }
}

function generateWorldTheme(data: number[], w: number, h: number, _rng: PRNG, perlin: PerlinNoise): void {
  const ts = TILESETS.overworld;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * 0.03, y * 0.03, 5, 2.0, 0.5);
      if (v < -0.3) setTile(data, w, h, x, y, LAYER_GROUND1, ts.deepWater);
      else if (v < -0.1) setTile(data, w, h, x, y, LAYER_GROUND1, ts.water);
      else if (v < 0.05) setTile(data, w, h, x, y, LAYER_GROUND1, ts.ground);
      else if (v < 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.forest);
      else setTile(data, w, h, x, y, LAYER_GROUND1, ts.mountain);
    }
}

// ════════════════════════════════════════════════════════════════
// EVENT GENERATION
// ════════════════════════════════════════════════════════════════

function generateEvents(w: number, h: number, rng: PRNG, theme: string, opts: GeneratorOptions = {}): (MapEvent | null)[] {
  // RPG Maker MV event arrays are 1-indexed: index 0 is null and the first real
  // event has id 1. The id MUST match the array index — events.push uses
  // events.length as the id below, so starting from [null] yields id 1 at
  // index 1, etc. This also matters for correctness, not just convention: MV's
  // Control Self Switch (command 123) is guarded by `if (this._eventId > 0)`,
  // so an event with id 0 silently never sets its self switch — the first
  // generated chest/boss/NPC used to reopen/respawn/repeat forever.
  const events: (MapEvent | null)[] = [null];
  const addEvents = (opts as Record<string, boolean>).addEvents !== false;
  if (!addEvents) return events;

  const teleportPositions: TransferPoint[] = [];
  const transferPoints = (opts as Record<string, TransferPoint[]>).transferPoints;
  if (transferPoints) {
    for (let i = 0; i < transferPoints.length; i++) {
      teleportPositions.push(transferPoints[i]);
    }
  }

  if (theme === 'dungeon' || theme === 'cave' || theme === 'fortress' || theme === 'sewer' || theme === 'volcano') {
    const numChests = rng.nextInt(1, 3);
    for (let i = 0; i < numChests; i++) {
      const cx = rng.nextInt(3, w - 4), cy = rng.nextInt(3, h - 4);
      events.push(makeChestEvent(events.length, cx, cy));
    }
    const bossX = Math.floor(w * 0.75), bossY = Math.floor(h * 0.25);
    events.push(makeBossEvent(events.length, bossX, bossY, 1));
  }

  if (theme === 'town' || theme === 'village') {
    const npcNames = ['Merchant', 'Guard', 'Elder', 'Child', 'Traveler', 'Scholar', 'Blacksmith', 'Healer'];
    const numNpcs = rng.nextInt(2, 5);
    for (let i = 0; i < numNpcs; i++) {
      const nx = rng.nextInt(3, w - 4), ny = rng.nextInt(3, h - 4);
      events.push(makeNpcEvent(events.length, nx, ny, npcNames[i % npcNames.length]));
    }
  }

  if (theme === 'interior' || theme === 'magic_interior' || theme === 'space_interior') {
    events.push(makeNpcEvent(events.length, Math.floor(w / 2) + 1, Math.floor(h / 2), 'Inhabitant'));
  }

  for (let i = 0; i < teleportPositions.length; i++) {
    const tp = teleportPositions[i];
    events.push(makeTransferEvent(events.length, tp.x, tp.y, tp.destMapId, tp.destX, tp.destY, tp.trigger || 1));
  }

  return events;
}

function makeNpcEvent(id: number, x: number, y: number, name: string): MapEvent {
  return {
    id: id, name: name || 'NPC', note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: false,
      // Visible NPC sprite (People1 has 8 villagers; vary by id). Was '' = invisible.
      image: { characterIndex: id % 8, characterName: 'People1', direction: 2, pattern: 1, tileId: 0 },
      list: [
        { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
        { code: 401, indent: 0, parameters: ['...'] },
        { code: 0, indent: 0, parameters: [] }
      ],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 1, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
    }]
  };
}

function makeChestEvent(id: number, x: number, y: number): MapEvent {
  return {
    id: id, name: 'Chest', note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: true,
      image: { characterIndex: 0, characterName: '!Chest', direction: 2, pattern: 0, tileId: 0 },
      list: [
        { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
        { code: 401, indent: 0, parameters: ['Found treasure!'] },
        // Self Switch A = ON (MV: command123 sets value = params[1] === 0) so
        // page 2 takes over and the chest stays open. Was ['A', 1] (= OFF),
        // which left the chest reopenable forever.
        { code: 123, indent: 0, parameters: ['A', 0] },
        { code: 0, indent: 0, parameters: [] }
      ],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
    }, {
      conditions: Object.assign({}, defaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
      directionFix: true,
      image: { characterIndex: 0, characterName: '!Chest', direction: 2, pattern: 1, tileId: 0 },
      list: [{ code: 0, indent: 0, parameters: [] as unknown[] }],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
    }]
  };
}

function makeBossEvent(id: number, x: number, y: number, troopId: number = 1): MapEvent {
  return {
    id: id, name: 'Boss', note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: true,
      // Visible boss sprite (Monster sheet). Was '' = invisible boss.
      image: { characterIndex: (Math.max(1, troopId) - 1) % 8, characterName: 'Monster', direction: 2, pattern: 1, tileId: 0 },
      list: [
        { code: 301, indent: 0, parameters: [0, troopId || 1, 0, 1] },
        { code: 601, indent: 0, parameters: [] },
        // Win branch: Self Switch A = ON (params[1] === 0) so the boss stays
        // defeated. Was ['A', 1] (= OFF), so the boss respawned after victory.
        { code: 123, indent: 1, parameters: ['A', 0] },
        { code: 0, indent: 1, parameters: [] },
        { code: 602, indent: 0, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 603, indent: 0, parameters: [] },
        { code: 353, indent: 1, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
      ],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
    }, {
      conditions: Object.assign({}, defaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
      directionFix: true,
      image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
      list: [{ code: 0, indent: 0, parameters: [] as unknown[] }],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: 0, walkAnime: false
    }]
  };
}

function makeTransferEvent(id: number, x: number, y: number, destMapId: number, destX: number, destY: number, trigger: number = 1): MapEvent {
  return {
    id: id, name: 'Transfer to Map' + destMapId, note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: false,
      image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
      list: [
        { code: 201, indent: 0, parameters: [0, destMapId, destX, destY, 0, 0] },
        { code: 0, indent: 0, parameters: [] }
      ],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: trigger || 1, walkAnime: false
    }]
  };
}

// Action-button door (e.g. a house entrance): press to transfer. Unlike
// makeTransferEvent (a walk-on, walk-through transfer zone) the player stops at
// it (through:false, priorityType 1) and must press the action button.
function makeDoorEvent(id: number, x: number, y: number, destMapId: number, destX: number, destY: number): MapEvent {
  return {
    id: id, name: 'Door to Map' + destMapId, note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: true,
      image: { characterIndex: 0, characterName: '!Door1', direction: 2, pattern: 1, tileId: 0 },
      list: [
        { code: 201, indent: 0, parameters: [0, destMapId, destX, destY, 0, 0] },
        { code: 0, indent: 0, parameters: [] }
      ],
      moveFrequency: 3, moveRoute: { list: [{ code: 0, indent: 0, parameters: [] as unknown[] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
    }]
  };
}

function defaultConditions() {
  return { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 };
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY: generateTileLayoutV3
// ════════════════════════════════════════════════════════════════

const THEMES = [
  'forest', 'town', 'village', 'castle', 'dungeon', 'cave',
  'beach', 'desert', 'swamp', 'ruins', 'interior',
  'snow', 'harbor', 'volcano', 'sewer', 'fortress',
  'magic_forest', 'magic_interior', 'space_interior', 'space_exterior',
  'world'
];

// Default tileset id per theme, matching the tile semantics each generator
// emits (Outside=2, Inside=3, Dungeon=4, Overworld=1 in the ProjectR/RTP
// defaults). Used when the caller doesn't pass a tilesetId — otherwise a town
// (Outside tiles) on the Overworld tileset renders as garbage.
const THEME_TILESET: Record<string, number> = {
  forest: 2, town: 2, village: 2, castle: 2, beach: 2, desert: 2, swamp: 2,
  ruins: 2, snow: 2, harbor: 2, magic_forest: 2, space_exterior: 2,
  interior: 3, magic_interior: 3, space_interior: 3,
  dungeon: 4, cave: 4, volcano: 4, sewer: 4, fortress: 4,
  world: 1
};

function generateTileLayoutV3(width: number, height: number, theme: string, opts: GeneratorOptions = {}, _unused1?: unknown, _unused2?: unknown): {
  data: number[];
  events: (MapEvent | null)[];
  seed: number;
  theme: string;
  width: number;
  height: number;
  houses?: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[];
} {
  const seed = opts.seed || Math.floor(Math.random() * 2147483647);
  const rng = new PRNG(seed);
  const perlin = new PerlinNoise(seed);
  const data = new Array(width * height * 6).fill(0) as number[];

  // Stamps are per-tileset; use the caller's tilesetId or the theme's default.
  _stampTileset = ((opts as Record<string, unknown>).tilesetId as number) || THEME_TILESET[theme] || 1;

  const themeMap: Record<string, (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown> = {
    'forest': generateForestTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'town': generateTownTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'village': generateVillageTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'castle': generateCastleTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'dungeon': generateDungeonTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'cave': generateCaveTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'beach': generateBeachTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'desert': generateDesertTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'swamp': generateSwampTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'ruins': generateRuinsTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'interior': generateInteriorTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'snow': generateSnowTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'harbor': generateHarborTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'volcano': generateVolcanoTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'sewer': generateSewerTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'fortress': generateFortressTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'magic_forest': generateMagicForestTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'magic_interior': generateMagicInteriorTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'space_interior': generateSpaceInteriorTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'space_exterior': generateSpaceExteriorTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown,
    'world': generateWorldTheme as (data: number[], w: number, h: number, rng: PRNG, ...args: unknown[]) => unknown
  };

  const genFn = themeMap[theme];
  let genResult: unknown;
  if (genFn) {
    if (genFn.length >= 5)
      genResult = genFn(data, width, height, rng, perlin);
    else
      genResult = genFn(data, width, height, rng);
  } else {
    fillLayer(data, width, height, LAYER_GROUND1, 2816);
  }
  // town/village generators return the house rectangles; surface them so the
  // caller can wire up enterable-house doors and interiors.
  const houses = (genResult && typeof genResult === 'object' && 'houses' in (genResult as object))
    ? (genResult as { houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] }).houses
    : undefined;

  // Border every autotile against its neighbours (shorelines, ground edges,
  // roof/wall corners). Generators lay tiles down at shape 0; without this the
  // map renders as flat blocks with hard square edges. Opt out with
  // opts.autotile === false to keep raw shape-0 tiles.
  if ((opts as Record<string, unknown>).autotile !== false) {
    applyAutotileShapes(data, width, height);
  }

  const events = generateEvents(width, height, rng, theme, opts);

  return {
    data: data,
    events: events,
    seed: seed,
    theme: theme,
    width: width,
    height: height,
    houses: houses
  };
}

// ════════════════════════════════════════════════════════════════
// TEMPLATE SYSTEM
// ════════════════════════════════════════════════════════════════

let TEMPLATE_INDEX: MapTemplate[] | null = null;

async function loadTemplateIndex(): Promise<MapTemplate[]> {
  if (TEMPLATE_INDEX) return TEMPLATE_INDEX;
  const idxPath = path.join(import.meta.dirname, "..", "knowledge", "map-templates.json");
  try {
    await access(idxPath);
    TEMPLATE_INDEX = JSON.parse(await readFile(idxPath, "utf8")) as MapTemplate[];
  } catch { TEMPLATE_INDEX = []; }
  return TEMPLATE_INDEX;
}

async function searchTemplates(category: string, theme: string): Promise<MapTemplate[]> {
  const idx = await loadTemplateIndex();
  return idx.filter(function(t: MapTemplate): boolean {
    if (category && t.category !== category) return false;
    if (theme && t.theme !== theme) return false;
    return true;
  });
}

async function generateFromTemplate(templateId: number, opts: GeneratorOptions = {}): Promise<{ data: number[]; width: number; height: number; events: (MapEvent | null)[] } | null> {
  const fn = "Map" + String(templateId).padStart(3, "0") + ".json";
  const fp = path.join(import.meta.dirname, "..", "knowledge", "maps", fn);
  var map: { width: number; height: number; data: number[]; events?: (MapEvent | null)[] };
  try {
    await access(fp);
    map = JSON.parse(await readFile(fp, "utf8")) as { width: number; height: number; data: number[]; events?: (MapEvent | null)[] };
  } catch {
    return null;
  }
  const w = (opts as Record<string, number>).width || map.width;
  const h = (opts as Record<string, number>).height || map.height;
  if (w === map.width && h === map.height) {
    return { data: map.data.slice(), width: w, height: h, events: (opts as Record<string, boolean>).keepEvents ? (map.events || []) : [] };
  }
  const data = new Array(w * h * 6).fill(0) as number[];
  for (let layer = 0; layer < 6; layer++) {
    for (let y = 0; y < Math.min(h, map.height); y++) {
      for (let x = 0; x < Math.min(w, map.width); x++) {
        const srcIdx = (layer * map.height + y) * map.width + x;
        const dstIdx = (layer * h + y) * w + x;
        data[dstIdx] = map.data[srcIdx];
      }
    }
  }
  return { data: data, width: w, height: h, events: [] };
}

async function generateMap(opts: GeneratorOptions = {}): Promise<{
  data: number[];
  width: number;
  height: number;
  events?: (MapEvent | null)[];
  seed?: number;
  theme?: string;
} | null> {
  const optsExtra = opts as Record<string, unknown>;
  const method = optsExtra.method || "procedural";
  if (method === "template" && optsExtra.templateId) {
    return await generateFromTemplate(optsExtra.templateId as number, opts);
  }
  return generateTileLayoutV3(
    optsExtra.width as number,
    optsExtra.height as number,
    optsExtra.theme as string,
    optsExtra.tilesetConfig as GeneratorOptions,
    optsExtra.seed,
    optsExtra.tilesetId
  );
}

export { generateTileLayoutV3, makeNpcEvent, makeChestEvent, makeBossEvent, makeTransferEvent, makeDoorEvent };
export { generateMap };
export { generateFromTemplate };
export { searchTemplates };
export { loadTemplateIndex };
export { THEMES };
export { THEME_TILESET };
export { TILESETS };
export { PerlinNoise };
export { PRNG };
