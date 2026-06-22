import path from "path";
import { readFile, access } from 'fs/promises';
import type { MapEvent, TilesetConfig, GeneratorOptions, MapTemplate } from '../types/rpgmaker.js';
import { applyAutotileShapes } from './autotile.js';
import { pickStamp, stampObject, hasStamps, getStamps, type StampCategory, type Stamp } from './stamps.js';
import { isTileA1, isRoofTile, isWallSideTile } from './engine.js';

// Real scanned tiles for the active project's tileset (optional, set by
// generateTileLayoutV3 when the caller passes availableTiles). Used by theme
// fallbacks so custom tilesets don't emit blank/garbage decoration.
interface AvailableTiles { ground?: number[]; water?: number[]; decoration?: number[]; }

interface GeneratorContext {
  stampTileset: number;
  availableTiles?: AvailableTiles;
  interiorRoom: string;
}

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
  // Reject a falsy sheetBase explicitly instead of silently falling back to the
  // A1 animated-water sheet (2048) — that fallback is what once turned every
  // floor/wall into water. The 2-arg default (2048) is intentional and stays.
  if (!Number.isFinite(sheetBase) || sheetBase <= 0)
    throw new Error('makeAutotileId: invalid sheetBase=' + sheetBase + ' (kind=' + kind + '); pass an explicit autotile sheet base (A1=2048, A2=2816, A3=4352, A4=5888).');
  return sheetBase + kind * 48 + (Number.isFinite(shape) ? shape : 0);
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
    // A4 wall kinds: even = wall-top (cap), odd = wall-side (face). Reference
    // interior maps (House templates) use kind 19 (wall-side) for house walls —
    // kind 0 is a floor-like top, which rendered as a flat slab, not a wall.
    wallSide: makeAutotileId(19, 0, 5888), wallTop: makeAutotileId(18, 0, 5888),
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
    // A4 wall-side = odd kind (the vertical face). Reference cave maps use kind
    // 1; kind 0 is the wall-TOP (a floor-like cap), which made dungeon walls
    // read as flat slabs instead of stone faces.
    wallSide: makeAutotileId(1, 0, 5888), wallTop: makeAutotileId(0, 0, 5888),
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
    wallSide: makeAutotileId(1, 0, 5888), wallTop: makeAutotileId(0, 0, 5888),
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
    wallSide: makeAutotileId(1, 0, 5888), wallTop: makeAutotileId(0, 0, 5888),
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

function generateBSPDungeon(data: number[], w: number, h: number, rng: PRNG, ts: Record<string, number>, opts: GeneratorOptions = {}, ctx: GeneratorContext): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  const depth: number = (opts as Record<string, number>).depth || 4;
  const minRoom: number = (opts as Record<string, number>).minRoom || 3;
  const margin: number = (opts as Record<string, number>).margin || 1;
  const wallThick: number = (opts as Record<string, number>).wallThick || 1;

  const floorTile = ts.floor || 2816;
  const wallTile = ts.wallSide || 5888;
  // RPGMV A4 walls render their own pseudo-3D (top cap + side face + corners)
  // from a SINGLE ground-layer tile via the 48 autotile shapes. The reference
  // dungeon maps place walls on the ground layer ONLY — the upper layer is
  // empty. Previously we also filled the upper layer with wallTop on every
  // cell, which overlaid a floating cap and made the map read as "destroyed".
  fillRect(data, w, h, 0, 0, w - 1, h - 1, LAYER_GROUND1, wallTile);

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

  // Floor-texture variation breaks the flat stone (a key anti-"flat-map" trick):
  // sprinkle a darker/moss floor across room tiles.
  const altFloor = ts.darkFloor || ts.brickFloor || floorTile;
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    fillRect(data, w, h, r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, LAYER_GROUND1, floorTile);
    for (let ry = r.y; ry < r.y + r.h; ry++)
      for (let rx = r.x; rx < r.x + r.w; rx++) {
        if (altFloor !== floorTile && rng.nextBool(0.08)) setTile(data, w, h, rx, ry, LAYER_GROUND1, altFloor);
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

  // Per-room features so rooms don't all feel identical: a columned hall, a
  // water pool, or scattered dungeon props (real multi-tile stamps). Features
  // avoid the room's centre cross so corridors stay traversable.
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    const x0 = r.x + 1, y0 = r.y + 1, x1 = r.x + r.w - 2, y1 = r.y + r.h - 2;
    if (x1 < x0 || y1 < y0) continue;
    // Real, coherent dungeon props (mined upright objects: torches/statues/
    // pillars). A5 tiles are floor-material, so we use full prop stamps placed
    // against walls — the way RPG Maker dungeons are decorated.
    const hasProps = getStamps(ctx.stampTileset, 'prop').length > 0;
    // Props flanking the top wall for an "inhabited", lit feel.
    if (hasProps && r.w >= 5) {
      for (let tx = r.x + 1; tx < r.x + r.w - 1; tx += 4) {
        const p = pickFullProp(rng, ctx);
        if (p && p.w <= 2) tryStampProp(data, w, h, tx, r.y, p);
      }
    }
    const feature = rng.nextInt(0, 3);
    if (feature === 0 && r.w >= 6 && r.h >= 6 && hasProps) {
      // Columned hall: matching props standing at the four inner corners.
      const p = pickFullProp(rng, ctx);
      if (p) for (const [px, py] of [[x0, y1], [x1, y1]] as [number, number][]) tryStampProp(data, w, h, px, py, p);
    } else if (feature === 1 && r.w >= 7 && r.h >= 7) {
      // Small water pool in a corner (room stays walkable around it).
      fillRect(data, w, h, x0, y0, x0 + 1, y0 + 1, LAYER_GROUND1, ts.water || 2048);
    } else if (hasProps) {
      // Scattered props clustered toward a corner (not random across the floor).
      const n = rng.nextInt(1, 2);
      for (let d = 0; d < n; d++) {
        const p = pickFullProp(rng, ctx);
        if (p) tryStampProp(data, w, h, rng.nextBool() ? x0 : x1, rng.nextBool() ? y1 : y0 + p.h - 1, p);
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

function generateCellularCave(data: number[], w: number, h: number, rng: PRNG, ts: Record<string, number>, opts: GeneratorOptions = {}, ctx: GeneratorContext): { grid: number[][] } {
  const fillProb: number = (opts as Record<string, number>).fillProb || 0.45;
  const iterations: number = (opts as Record<string, number>).iterations || 5;
  const birthLimit: number = (opts as Record<string, number>).birthLimit || 4;
  const deathLimit: number = (opts as Record<string, number>).deathLimit || 3;

  const floorTile = ts.floor || 2816;
  const wallTile = ts.wallSide || makeAutotileId(0, 0, 5888);
  // A4 walls go on the ground layer only (the engine renders the 3D wall from
  // the single tile). Upper layer stays empty for wall cells — filling it with
  // a wallTop cap made cave walls read as "destroyed".

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
        // Wall: ground-layer A4 only (renders its own 3D). Upper stays 0.
        setTile(data, w, h, x, y, LAYER_GROUND1, wallTile);
      }
    }

  // Scatter real prop stamps in open cave floor (against a rock above so the
  // object reads correctly), instead of flat single A5 tiles.
  if (getStamps(ctx.stampTileset, 'prop').length > 0) {
    const target = Math.floor(w * h / 60);
    for (let attempt = 0, placed = 0; placed < target && attempt < target * 20; attempt++) {
      const x = rng.nextInt(1, w - 2), y = rng.nextInt(2, h - 2);
      if (grid[y][x] !== 0 || grid[y - 1][x] !== 1) continue; // floor with rock behind
      const p = pickFullProp(rng, ctx);
      if (p && tryStampProp(data, w, h, x, y, p)) placed++;
    }
  }

  return { grid: grid };
}

// ════════════════════════════════════════════════════════════════
// THEME GENERATORS (20+ themes)
// ════════════════════════════════════════════════════════════════

// Normalize a Perlin frequency to the map size: a 30-tile map uses `base` as-is,
// smaller maps get proportionally higher frequency (so noise still varies across
// the few tiles) and larger maps get lower (so features stay broad). Without this
// a small procedural map is a near-uniform single-biome slab because the hardcoded
// scale barely completes one noise period. Clamped so extreme aspect ratios don't
// blow up.
function noiseScale(base: number, w: number, h: number): number {
  const m = Math.max(8, Math.min(w, h));
  return base * (30 / m);
}

function applyPerlinTerrain(data: number[], w: number, h: number, perlin: PerlinNoise, ts: Record<string, number>, opts: GeneratorOptions = {}): void {
  const baseScale: number = (opts as Record<string, number>).scale || 0.08;
  const scale = noiseScale(baseScale, w, h); // size-normalized so small maps vary
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
// Prefers SMALLER stamps (they fit more easily on a dense town grid) but still
// picks a larger one occasionally for variety. More attempts than before so a
// town fills with real buildings instead of falling back to flat autotile boxes.
function placeHouseStamps(
  data: number[], w: number, h: number, rng: PRNG, count: number, blocked: ((x: number, y: number) => boolean) | undefined, ctx: GeneratorContext
): { x: number; y: number; w: number; h: number; doorX: number; doorY: number }[] {
  const houses: { x: number; y: number; w: number; h: number; doorX: number; doorY: number }[] = [];
  const occ = new Uint8Array(w * h);
  // Sort stamps by area (smallest first) so they fit on a tight town grid, but
  // keep some larger ones in the mix for visual variety.
  const allStamps = getStamps(ctx.stampTileset, 'house').slice().sort(function (a, b) { return (a.w * a.h) - (b.w * b.h); });
  if (allStamps.length === 0) return houses;
  for (let attempt = 0; houses.length < count && attempt < count * 60; attempt++) {
    // 70% chance of a small stamp (first half), 30% a larger one — variety.
    const idx = rng.nextBool(0.7)
      ? rng.nextInt(0, Math.max(0, Math.floor(allStamps.length / 2) - 1))
      : rng.nextInt(0, allStamps.length - 1);
    const stamp = allStamps[idx];
    if (!stamp) continue;
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
  cats: StampCategory[], blocked: ((x: number, y: number) => boolean) | undefined, ctx: GeneratorContext
): void {
  const usable = cats.filter(function (c) { return hasStamps(ctx.stampTileset, c); });
  if (usable.length === 0) return;
  for (let attempt = 0, placed = 0; placed < count && attempt < count * 25; attempt++) {
    const stamp = pickStamp(ctx.stampTileset, usable[rng.nextInt(0, usable.length - 1)], rng);
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

// Like placeDecoStamps but clusters decorations into natural groves: pick a few
// seed points, then place several stamps tightly around each so trees/props
// clump (the way real vegetation grows) instead of an even random sprinkle.
function placeDecoClusters(
  data: number[], w: number, h: number, rng: PRNG, groves: number, perGrove: number,
  cats: StampCategory[], blocked: ((x: number, y: number) => boolean) | undefined, ctx: GeneratorContext
): void {
  const usable = cats.filter(function (c) { return hasStamps(ctx.stampTileset, c); });
  if (usable.length === 0) return;
  for (let g = 0; g < groves; g++) {
    const gx = rng.nextInt(2, w - 3), gy = rng.nextInt(2, h - 3);
    for (let p = 0, placed = 0, attempts = 0; placed < perGrove && attempts < perGrove * 12; attempts++) {
      const stamp = pickStamp(ctx.stampTileset, usable[rng.nextInt(0, usable.length - 1)], rng);
      if (!stamp) break;
      // Bias placement near the grove centre (Gaussian-ish via summed randoms).
      const x = Math.max(0, Math.min(w - stamp.w, gx + rng.nextInt(-2, 2) - Math.floor(stamp.w / 2)));
      const y = Math.max(0, Math.min(h - stamp.h, gy + rng.nextInt(-2, 2) - Math.floor(stamp.h / 2)));
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
}

// Pick a "full" prop stamp — one whose footprint is completely filled with real
// tiles (a coherent upright object: torch, statue, pillar, crate). Dungeons need
// these instead of single A5 tiles, which are floor-material (they render as flat
// or blank squares, never as objects).
function pickFullProp(rng: PRNG, ctx: GeneratorContext): Stamp | null {
  const arr = getStamps(ctx.stampTileset, 'prop').filter(function (s) {
    return s.cells.length >= s.w * s.h && s.cells.every(function (c) { return c.t > 0; });
  });
  if (arr.length === 0) return null;
  return arr[rng.nextInt(0, arr.length - 1)];
}

// Stamp a prop so its BASE sits at (bx, by) and its body extends upward against
// the wall behind it (how RPG Maker dungeon props are placed). Returns true if
// it fit on empty upper-layer cells.
function tryStampProp(data: number[], w: number, h: number, bx: number, by: number, stamp: Stamp): boolean {
  const x = bx, y = by - stamp.h + 1;
  if (x < 0 || y < 0 || x + stamp.w > w || y + stamp.h > h) return false;
  for (let yy = y; yy < y + stamp.h; yy++)
    for (let xx = x; xx < x + stamp.w; xx++)
      if (getTile(data, w, h, xx, yy, LAYER_UPPER1) !== 0 || getTile(data, w, h, xx, yy, LAYER_UPPER2) !== 0) return false;
  stampObject(data, w, h, x, y, stamp);
  return true;
}

// Carve a walkable dirt path straight down from a house door to the nearest
// road, so every house is reachable and the town reads as planned rather than
// houses floating in empty grass. Stops at the road OR at any placed object
// (house/deco/tree) blocking the column — previously it overwrote whatever was
// in the way, plowing straight through a neighbouring building.
function carveDoorPath(data: number[], w: number, h: number, doorX: number, doorY: number, dirt: number, onRoad: (x: number, y: number) => boolean): void {
  for (let y = doorY + 1; y < h && y <= doorY + 18; y++) {
    if (onRoad(doorX, y)) break; // reached the road — connected, done
    // An obstacle (non-empty upper layer = a placed house/tree/prop) blocks the
    // path. Stop instead of carving through it.
    if (getTile(data, w, h, doorX, y, LAYER_UPPER1) !== 0 || getTile(data, w, h, doorX, y, LAYER_UPPER2) !== 0) break;
    setTile(data, w, h, doorX, y, LAYER_GROUND1, dirt);
    setTile(data, w, h, doorX, y, LAYER_UPPER1, 0);
    setTile(data, w, h, doorX, y, LAYER_UPPER2, 0);
  }
}

// Outside_A3 roof autotile kinds that the reference maps actually use (each has
// its matching wall at roof+8). Gives houses varied roof colours/styles.
const ROOF_KINDS = [48, 50, 52, 54, 55, 64, 66, 68, 69, 70];

// Build a coherent RPG-Maker house from autotiles: a multi-row roof (A3 roof
// kind) over a wall strip (A3 wall-side kind), with a door opening near the
// bottom. The autotiler then shapes the roof eaves/peak and wall edges.
// `style` adds footprint variety so a town isn't all identical boxes:
//   0 = plain rectangle (the classic RTP cottage)
//   1 = L-shape (notch the top-right corner — reads as an extension/wing)
//   2 = wide manor (broader + taller roof, a wealthier building)
// `fenceTile` (optional, a confirmed B/C object id) lays a front fence/garden
// edge along the bottom for a tended look. Door is offset from centre by `doorBias`
// so doors aren't all identically centred. Returns the footprint + door tile.
function buildAutotileHouse(data: number[], w: number, h: number, hx: number, hy: number, bw: number, bh: number, roof: number, wall: number, style: number = 0, fenceTile?: number, doorBias: number = 0): { x: number; y: number; w: number; h: number; doorX: number; doorY: number } {
  // Wider manors get a taller roof so they read as bigger buildings.
  const roofRows = style === 2 ? Math.max(3, Math.ceil(bh * 0.7)) : Math.max(2, Math.ceil(bh * 0.55));
  // L-shape: omit the top-right quadrant (an inset wing). Kept small so the
  // autotiler still closes the roof around it.
  const notch = style === 1 ? { x: hx + Math.floor(bw * 0.6), y: hy, w: bw - Math.floor(bw * 0.6), h: Math.floor(bh * 0.45) } : null;
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      if (notch && x >= notch.x - hx && y < notch.h) continue; // carved-out corner
      setTile(data, w, h, hx + x, hy + y, LAYER_UPPER1, y < roofRows ? roof : wall);
      setTile(data, w, h, hx + x, hy + y, LAYER_UPPER2, 0);
      setShadow(data, w, h, hx + x, hy + y, 15);
    }
  // Door near bottom-centre, with an optional off-centre bias for variety.
  const doorX = Math.max(hx + 1, Math.min(hx + bw - 2, hx + Math.floor(bw / 2) + doorBias));
  const doorY = hy + bh - 1;
  setTile(data, w, h, doorX, doorY, LAYER_UPPER1, 0); // doorway (the door event sprite sits here)
  // Front fence/garden edge along the bottom row (skipping the door tile).
  if (fenceTile) {
    for (let x = 0; x < bw; x++) {
      if (hx + x === doorX) continue;
      const fy = hy + bh;
      if (fy < h && getTile(data, w, h, hx + x, fy, LAYER_UPPER1) === 0 && getTile(data, w, h, hx + x, fy, LAYER_UPPER2) === 0)
        setTile(data, w, h, hx + x, fy, LAYER_UPPER2, fenceTile);
    }
  }
  return { x: hx, y: hy, w: bw, h: bh, doorX: doorX, doorY: doorY };
}

function generateForestTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
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
  if (hasStamps(ctx.stampTileset, 'tree') || hasStamps(ctx.stampTileset, 'prop')) {
    // A few natural groves (clumped trees) plus a lighter even scatter, so the
    // forest has dense copses and open grass rather than a uniform sprinkle.
    placeDecoClusters(data, w, h, rng, Math.max(2, Math.floor(Math.min(w, h) / 8)), 4, ['tree', 'prop'], onWater, ctx);
    placeDecoStamps(data, w, h, rng, Math.floor(w * h / 28), ['tree', 'prop'], onWater, ctx);
  } else {
    // No stamp library: scatter only SMALL objects (flowers/bushes) as single
    // tiles — a single tree tile renders as a broken fragment, so we omit trees
    // rather than emit ugliness. Prefer the project's real scanned decoration
    // tiles when available, else the verified RTP ids.
    const small = (ctx.availableTiles && ctx.availableTiles.decoration && ctx.availableTiles.decoration.length)
      ? ctx.availableTiles.decoration
      : [ts.bush, ts.flower, ts.flower2].filter(Boolean);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (getTile(data, w, h, x, y, LAYER_GROUND1) === ts.grass && rng.nextBool(0.12))
          setTile(data, w, h, x, y, LAYER_UPPER1, small[rng.nextInt(0, small.length - 1)]);
      }
  }
  // An irregular, natural clearing near the centre (NOT a perfect circle —
  // that read as a bullseye). Modulate by Perlin so the clearing edge is
  // organic, and stamp a landmark (campfire/ruins) so the clearing has a focal
  // point instead of being empty dirt.
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const cr = Math.max(3, Math.floor(Math.min(w, h) / 5));
  const cs = noiseScale(0.12, w, h);
  for (let dy = -cr - 1; dy <= cr + 1; dy++)
    for (let dx = -cr - 1; dx <= cr + 1; dx++) {
      const rx = cx + dx, ry = cy + dy;
      if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Perlin warps the radius so the clearing edge is wavy, not circular.
      const warp = perlin.noise2d(rx * cs, ry * cs) * cr * 0.4;
      if (dist < cr + warp) {
        setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.dirt);
        setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
        setTile(data, w, h, rx, ry, LAYER_UPPER2, 0);
        setRegion(data, w, h, rx, ry, 1);
      }
    }
  // Landmark at the clearing centre: a campfire (well tile doubles as a hearth)
  // flanked by stumps, so the clearing reads as a rest stop / landmark.
  if (getTile(data, w, h, cx, cy, LAYER_GROUND1) === ts.dirt) {
    setTile(data, w, h, cx, cy, LAYER_UPPER2, ts.well || 107);
    if (ts.stump) { setTile(data, w, h, cx - 1, cy + 1, LAYER_UPPER2, ts.stump); setTile(data, w, h, cx + 1, cy + 1, LAYER_UPPER2, ts.stump); }
  }
}

// RTP template selection: each theme maps to one or more template categories
// whose tileset matches. The generator loads the full 106-template index and
// auto-picks the closest-sized template for the requested map dimensions. This
// gives every theme access to ALL bundled RTP reference maps, not just a
// hardcoded subset. Pass `templateId` in opts to force a specific template, or
// `useTemplate:false` to skip cloning and generate procedurally.
const THEME_CATEGORIES: Record<string, string[]> = {
  world: ['world'],
  town: ['town', 'exterior'],
  village: ['town', 'exterior'],
  castle: ['castle'],
  forest: ['exterior'],
  beach: ['exterior'],
  desert: ['exterior'],
  swamp: ['exterior'],
  snow: ['exterior'],
  ruins: ['exterior'],
  harbor: ['exterior'],
  magic_forest: ['exterior'],
  interior: ['interior', 'town'],
  magic_interior: ['interior'],
  dungeon: ['dungeon'],
  cave: ['dungeon'],
  fortress: ['dungeon', 'castle'],
  sewer: ['dungeon'],
  volcano: ['dungeon'],
  space_exterior: ['town', 'modern', 'exterior'],
  space_interior: ['interior', 'modern']
};

// B/C door tile ids in the RTP Outside sheets (B-sheet positions that render as
// wooden doors). Used to detect house entrances in a cloned town/exterior
// template so we can wire enterable-interior door events to them.
const DOOR_TILES = new Set([62, 63, 64, 68]);

// Clone a real RTP template into `data`, cropped/padded to the requested (w, h).
// `templateId` forces a specific template; otherwise the closest-sized template
// matching the theme's categories is auto-picked from the full 106-template
// index. Returns detected door positions (for town/exterior themes) or null if
// no template is available.
async function cloneTemplateForTheme(data: number[], w: number, h: number, theme: string, templateId?: number): Promise<{ x: number; y: number }[] | null> {
  const idxPath = path.join(import.meta.dirname, "..", "knowledge", "map-templates.json");
  let idx: { id: number; category: string; theme: string; width: number; height: number; tilesetId: number }[];
  try {
    await access(idxPath);
    idx = JSON.parse(await readFile(idxPath, "utf8")) as typeof idx;
  } catch {
    return null; // no knowledge dir → fall back to procedural
  }
  // Pick the template: explicit override, or auto-pick by category + closest area.
  let picked: { id: number; width: number; height: number } | null = null;
  if (templateId) {
    const found = idx.find(function (t) { return t.id === templateId; });
    if (found) picked = { id: found.id, width: found.width, height: found.height };
  }
  if (!picked) {
    const cats = THEME_CATEGORIES[theme] || [];
    const candidates = idx.filter(function (t) { return cats.indexOf(t.category) >= 0; });
    if (candidates.length === 0) return null;
    const target = w * h;
    let bestDiff = Infinity;
    for (const t of candidates) {
      const diff = Math.abs(t.width * t.height - target);
      if (diff < bestDiff) { bestDiff = diff; picked = { id: t.id, width: t.width, height: t.height }; }
    }
  }
  if (!picked) return null;
  const fn = "Map" + String(picked.id).padStart(3, "0") + ".json";
  const fp = path.join(import.meta.dirname, "..", "knowledge", "maps", fn);
  try {
    await access(fp);
  } catch {
    return null;
  }
  const map = JSON.parse(await readFile(fp, "utf8")) as { width: number; height: number; data: number[] };
  const tw = map.width, th = map.height;
  // Copy tile data, cropping/padding to (w, h).
  for (let layer = 0; layer < 6; layer++) {
    for (let y = 0; y < Math.min(h, th); y++) {
      for (let x = 0; x < Math.min(w, tw); x++) {
        const srcIdx = (layer * th + y) * tw + x;
        const dstIdx = (layer * h + y) * w + x;
        data[dstIdx] = map.data[srcIdx];
      }
    }
  }
  // Detect door positions for town/exterior themes (enterable-house wiring).
  // For interior/dungeon themes, doors are part of the template's tile layout
  // already — no detection needed.
  const cats = THEME_CATEGORIES[theme] || [];
  const isExterior = cats.indexOf('town') >= 0 || cats.indexOf('exterior') >= 0;
  const doors: { x: number; y: number }[] = [];
  if (isExterior) {
    for (let y = 0; y < Math.min(h, th); y++)
      for (let x = 0; x < Math.min(w, tw); x++) {
        const t = map.data[(3 * th + y) * tw + x];
        if (DOOR_TILES.has(t)) doors.push({ x: x, y: y });
      }
  }
  // Tag genuinely walkable tiles as region 1 (the hint event placement biases
  // toward). Engine-grounded: the GROUND1 tile must be standable, any GROUND2
  // overlay must not be an impassable wall/roof/water band, and nothing can be
  // sitting on the object layers. The old rule only excluded A4 walls + a
  // narrow water range on layer 0, so it tagged A3 roofs and every decorated
  // tile as "walkable" — that's why events landed on rooftops.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!isWalkableGround(getTile(data, w, h, x, y, LAYER_GROUND1))) continue;
      const g2 = getTile(data, w, h, x, y, LAYER_GROUND2);
      if (g2 !== 0 && !isWalkableGround(g2)) continue;
      if (getTile(data, w, h, x, y, LAYER_UPPER1) !== 0 || getTile(data, w, h, x, y, LAYER_UPPER2) !== 0) continue;
      setRegion(data, w, h, x, y, 1);
    }
  return doors;
}

function generateTownTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): { houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] } {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.grass);
  setRegion(data, w, h, 0, 0, w - 1, h - 1, 1);
  const houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] = [];
  // NOTE: this function is sync, but cloneTownTemplate is async. The async path
  // is handled by generateTileLayoutV3 (which awaits templates). This sync body
  // is the FALLBACK when no template is available: a simple organic layout with
  // autotile houses (roof + wall, properly proportioned). It is rarely hit
  // because the template clone succeeds for any project with the bundled knowledge.
  // Organic road network: a main cross offset off-centre, plus 1-2 short branches.
  const roadX = Math.floor(w / 2) + rng.nextInt(-2, 2);
  const roadY = Math.floor(h / 2) + rng.nextInt(-2, 2);
  type Rect = { x1: number; y1: number; x2: number; y2: number };
  const roads: Rect[] = [
    { x1: roadX - 1, y1: 0, x2: roadX + 1, y2: h - 1 },
    { x1: 0, y1: roadY - 1, x2: w - 1, y2: roadY + 1 }
  ];
  const numBranches = rng.nextInt(1, 2);
  for (let b = 0; b < numBranches; b++) {
    if (rng.nextBool()) {
      const bx = rng.nextInt(Math.floor(w * 0.2), Math.floor(w * 0.8));
      roads.push({ x1: bx, y1: roadY - 1, x2: bx, y2: rng.nextBool() ? h - 1 : 0 });
    } else {
      const by = rng.nextInt(Math.floor(h * 0.2), Math.floor(h * 0.8));
      roads.push({ x1: roadX - 1, y1: by, x2: rng.nextBool() ? w - 1 : 0, y2: by });
    }
  }
  const onRoad = function (x: number, y: number): boolean {
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (x >= r.x1 - 1 && x <= r.x2 + 1 && y >= r.y1 - 1 && y <= r.y2 + 1) return true;
    }
    return false;
  };
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    fillRect(data, w, h, r.x1, r.y1, r.x2, r.y2, LAYER_GROUND1, ts.dirt);
  }
  const numHouses = Math.max(3, Math.floor(w * h / 150));
  // Fallback autotile houses — fixed proportions: 2 roof rows + 3+ wall rows
  // (was 55% roof = only 1-2 wall rows, which read as "techo sin paredes").
  for (let i = 0; i < numHouses * 4 && houses.length < numHouses; i++) {
    const hw = rng.nextInt(4, 7), hh = rng.nextInt(5, 7); // taller so walls show
    const hx = rng.nextInt(2, w - hw - 2), hy = rng.nextInt(2, h - hh - 3);
    if (onRoad(hx + Math.floor(hw / 2), hy + Math.floor(hh / 2))) continue;
    let overlap = false;
    for (const oh of houses)
      if (hx < oh.x + oh.w + 2 && hx + hw + 2 > oh.x && hy < oh.y + oh.h + 2 && hy + hh + 2 > oh.y) { overlap = true; break; }
    if (overlap) continue;
    const roofKind = ROOF_KINDS[rng.nextInt(0, ROOF_KINDS.length - 1)];
    houses.push(buildAutotileHouse(data, w, h, hx, hy, hw, hh, makeAutotileId(roofKind, 0), makeAutotileId(roofKind + 8, 0), 0, undefined, 0));
  }
  for (const ho of houses) carveDoorPath(data, w, h, ho.doorX!, ho.doorY!, ts.dirt, onRoad);
  return { houses: houses };
}

// Inside-tileset A2 floor kinds the reference maps use, grouped by what reads
// right for each room type (verified in-game): 16/40/43 = wood, 18 = carpet,
// 24/42 = stone/tile. The floor is chosen by room type, not blindly random.
const FLOOR_BY_ROOM: Record<string, number[]> = {
  home: [16, 40, 43],
  shop: [24, 42, 16],
  inn: [18, 43, 16],
  library: [18, 16],
};
function generateInteriorTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
  const ts = TILESETS.inside;
  const room = ctx.interiorRoom;
  // Smart floor: chosen to fit the room type (wood for homes, carpet for inns,
  // stone/tile for shops), not a blind random pick.
  const floors = FLOOR_BY_ROOM[room] || FLOOR_BY_ROOM.home;
  fillLayer(data, w, h, LAYER_GROUND1, makeAutotileId(floors[rng.nextInt(0, floors.length - 1)], 0));
  // RTP interior walls sit on the GROUND layer (the A4 tile renders its own
  // pseudo-3D top cap + side face). The upper layers stay empty for walls so
  // objects/furniture can be placed against them. Previously walls were on the
  // upper layer with a wallTop on upper2, which floated above the floor and
  // read as "destroyed".
  const wall = ts.wallSide;
  fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_GROUND1, wall);          // top wall (2 rows)
  fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_GROUND1, wall);  // bottom wall
  fillRect(data, w, h, 0, 2, 0, h - 3, LAYER_GROUND1, wall);          // left wall
  fillRect(data, w, h, w - 1, 2, w - 1, h - 3, LAYER_GROUND1, wall);  // right wall
  const doorX = Math.floor(w / 2);
  setTile(data, w, h, doorX, h - 1, LAYER_GROUND1, makeAutotileId(floors[rng.nextInt(0, floors.length - 1)], 0)); // doorway = floor
  setTile(data, w, h, doorX - 1, h - 1, LAYER_GROUND1, makeAutotileId(floors[rng.nextInt(0, floors.length - 1)], 0));
  setRegion(data, w, h, 2, 2, w - 3, h - 3, 1);

  // A rug only really suits a home/inn; shops keep a clean floor.
  if (room !== 'shop' && rng.nextBool(0.6)) {
    const rug = makeAutotileId([18, 24][rng.nextInt(0, 1)], 0);
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2), cw = Math.max(1, Math.floor(w / 5)), ch = Math.max(1, Math.floor(h / 5));
    fillRect(data, w, h, cx - cw, cy - ch, cx + cw, cy + ch, LAYER_GROUND1, rug);
  }

  // Thematic named furniture per room type (real B/C object tiles), then a few
  // prop stamps for richness — all kept off the walls and the exit.
  const occupied = function (x: number, y: number) { return getTile(data, w, h, x, y, LAYER_UPPER1) !== 0 || getTile(data, w, h, x, y, LAYER_UPPER2) !== 0; };
  const put = function (x: number, y: number, t: number) { if (x > 1 && x < w - 2 && y > 1 && y < h - 2 && !occupied(x, y)) setTile(data, w, h, x, y, LAYER_UPPER2, t); };
  if (room === 'shop') {
    for (let x = 3; x < w - 3; x++) put(x, 2, ts.bookshelf);   // back-wall shelves/stock
    put(Math.floor(w / 2), Math.floor(h / 2), ts.table);        // counter
  } else if (room === 'inn') {
    for (let bx = 2; bx + 1 < w - 2; bx += 3) { put(bx, 2, ts.bed); put(bx, h - 4, ts.bed); }
    put(w - 3, Math.floor(h / 2), ts.table);
  } else { // home / library
    put(w - 3, 2, ts.bed);
    put(Math.floor(w / 2), Math.floor(h / 2), ts.table);
    put(2, 2, ts.bookshelf); put(3, 2, ts.bookshelf);
  }
  const nearEdgeOrExit = function (x: number, y: number) {
    return x <= 1 || y <= 1 || x >= w - 1 || y >= h - 2 || (Math.abs(x - doorX) <= 1 && y >= h - 4);
  };
  if (hasStamps(ctx.stampTileset, 'prop')) {
    placeDecoStamps(data, w, h, rng, Math.max(2, Math.floor(w * h / 22)), ['prop'], nearEdgeOrExit, ctx);
  }
}

function generateCastleTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
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

function generateBeachTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
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

function generateDesertTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.sand || ts.dirt);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.05, w, h), y * noiseScale(0.05, w, h), 3);
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

function generateSwampTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.outside;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.07, w, h), y * noiseScale(0.07, w, h), 4);
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

function generateRuinsTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.1, w, h), y * noiseScale(0.1, w, h), 3);
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

function generateVillageTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): { houses: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[] } {
  return generateTownTheme(data, w, h, rng, ctx);
}

function generateDungeonTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 15)), minRoom: 3, margin: 1 }, ctx);
}

function generateCaveTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): { grid: number[][] } {
  return generateCellularCave(data, w, h, rng, TILESETS.dungeon, { fillProb: 0.48, iterations: 5 }, ctx);
}

function generateSnowTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.06, w, h), y * noiseScale(0.06, w, h), 4);
      if (v < -0.15) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.water); setRegion(data, w, h, x, y, 3); }
      else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.stone); setRegion(data, w, h, x, y, 1); }
    }
  for (let i = 0; i < Math.floor(w * h / 20); i++) {
    const x = rng.nextInt(0, w - 1), y = rng.nextInt(0, h - 1);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
      setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : ts.rock);
  }
}

function generateHarborTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
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

function generateVolcanoTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.dungeon;
  fillLayer(data, w, h, LAYER_GROUND1, ts.darkFloor || ts.floor);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.08, w, h), y * noiseScale(0.08, w, h), 4);
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

function generateSewerTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 18)), minRoom: 3, margin: 1 }, ctx);
}

function generateFortressTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): { rooms: BSPRoom[]; corridors: BSPCorridor[]; bossRoom: BSPRoom } {
  return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(3, Math.floor(Math.min(w, h) / 12)), minRoom: 4, margin: 1 }, ctx);
}

function generateMagicForestTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
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

function generateMagicInteriorTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
  const ts = TILESETS.inside;
  generateInteriorTheme(data, w, h, rng, ctx);
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  setTile(data, w, h, cx, cy - 2, LAYER_UPPER2, ts.magicDeco || 512);
  setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.magicDeco2 || 513);
  setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.magicDeco3 || 514);
}

function generateSpaceInteriorTheme(data: number[], w: number, h: number, rng: PRNG, ctx: GeneratorContext): void {
  const ts = TILESETS.space_interior;
  fillLayer(data, w, h, LAYER_GROUND1, ts.metalFloor);
  // Walls on the ground layer (A4 renders its own 3D); upper stays empty.
  fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_GROUND1, ts.wallSide);
  fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_GROUND1, ts.wallSide);
  fillRect(data, w, h, 0, 0, 0, h - 1, LAYER_GROUND1, ts.wallSide);
  fillRect(data, w, h, w - 1, 0, w - 1, h - 1, LAYER_GROUND1, ts.wallSide);
  setRegion(data, w, h, 1, 1, w - 2, h - 2, 1);
  const doorX = Math.floor(w / 2);
  setTile(data, w, h, doorX, h - 1, LAYER_GROUND1, ts.metalFloor); // doorway
  let deco = [ts.console, ts.screen, ts.locker, ts.sifiPanel, ts.sifiMonitor, ts.sifiTank, ts.sifiCore];
  deco = deco.filter(Boolean);
  for (let i = 0; i < Math.floor(w * h / 20); i++) {
    const x = rng.nextInt(2, w - 3), y = rng.nextInt(2, h - 3);
    if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0 && deco.length > 0)
      setTile(data, w, h, x, y, LAYER_UPPER2, deco[rng.nextInt(0, deco.length - 1)]);
  }
}

function generateSpaceExteriorTheme(data: number[], w: number, h: number, rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.sf_outside;
  fillLayer(data, w, h, LAYER_GROUND1, ts.metal);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.1, w, h), y * noiseScale(0.1, w, h), 3);
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

function generateWorldTheme(data: number[], w: number, h: number, _rng: PRNG, perlin: PerlinNoise, ctx: GeneratorContext): void {
  const ts = TILESETS.overworld;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = perlin.fbm(x * noiseScale(0.03, w, h), y * noiseScale(0.03, w, h), 5, 2.0, 0.5);
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

// ════════════════════════════════════════════════════════════════
// EVENT PLACEMENT HELPERS (walkability-gated)
// ════════════════════════════════════════════════════════════════
// Events must land on a walkable floor tile, never inside a wall, water, or a
// placed object. Every theme tags its walkable floor with region id 1 (town
// grass/roads, dungeon/cave room+corridor floors, interior floors) and water
// with region 3, so "region === 1 AND both upper layers empty" is a reliable
// placeability test across all themes that generate events.

// A ground-layer tile the player can actually stand on, classified by the
// engine's own autotile predicates (no per-theme guessing):
//   • A2 ground autotiles (grass/dirt/road/interior floor) → walkable
//   • A4 wall-TOPS (the passable cap of a low wall)         → walkable
//   • A5 lower ground tiles                                 → walkable
//   • A3 roofs + A3/A4 wall-SIDES                           → NOT walkable
//   • A1 water/waterfall sheet                              → NOT walkable
// Empty (0) is "no ground here": not a floor on layer 0, but transparent (no
// obstacle) when it appears on the GROUND2 overlay.
function isWalkableGround(id: number): boolean {
  if (id === 0) return false;
  if (isTileA1(id)) return false;                         // water / waterfall
  if (isRoofTile(id) || isWallSideTile(id)) return false; // roofs, wall sides
  return true;
}

// Authoritative placeability test. Earlier this trusted region===1, but the
// region layer is tagged inconsistently across paths (template clones in
// particular used to mark roofs/walls as region 1), which dropped events onto
// roofs and walls. We now verify walkability directly from the tile data, so
// placement is correct regardless of how (or whether) regions were tagged:
//   1. both upper/object layers are empty (no decoration, furniture, tree…),
//   2. the GROUND1 tile is something the player can stand on,
//   3. any GROUND2 overlay isn't an impassable wall/roof/water band.
function isPlaceableFloor(data: number[], w: number, h: number, x: number, y: number): boolean {
  if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) return false;
  if (getTile(data, w, h, x, y, LAYER_UPPER1) !== 0 || getTile(data, w, h, x, y, LAYER_UPPER2) !== 0) return false;
  if (!isWalkableGround(getTile(data, w, h, x, y, LAYER_GROUND1))) return false;
  const g2 = getTile(data, w, h, x, y, LAYER_GROUND2);
  if (g2 !== 0 && !isWalkableGround(g2)) return false;
  return true;
}

// Find a walkable floor tile by rejection sampling. `preferX/preferY` is the
// ideal spot (used as the first candidate); falls back to random sampling and
// finally to the preferred coord even if non-ideal (so a map with no region-1
// tiles still gets an event rather than losing it). Returns null only if the
// preferred coord is out of bounds.
function findFloorTile(data: number[], w: number, h: number, rng: PRNG, preferX: number, preferY: number): { x: number; y: number } | null {
  const px = Math.max(1, Math.min(w - 2, preferX | 0));
  const py = Math.max(1, Math.min(h - 2, preferY | 0));
  // 1. The ideal spot, if it's already a real floor.
  if (isPlaceableFloor(data, w, h, px, py)) return { x: px, y: py };
  // 2. Random rejection sampling, biased toward region-1 tiles (roads, plazas,
  //    intended walkable areas) so NPCs cluster where the map "wants" them
  //    rather than on any random patch of walkable grass.
  let anyFloor: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = rng.nextInt(1, w - 2), y = rng.nextInt(1, h - 2);
    if (!isPlaceableFloor(data, w, h, x, y)) continue;
    if (data[(LAYER_REGION * h + y) * w + x] === 1) return { x: x, y: y };
    if (!anyFloor) anyFloor = { x: x, y: y };
  }
  if (anyFloor) return anyFloor;
  // 3. Deterministic full scan for the floor tile NEAREST the preferred spot.
  //    Guarantees a genuine floor whenever one exists, instead of the old
  //    behaviour of dumping the event on a wall when sampling got unlucky.
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      if (!isPlaceableFloor(data, w, h, x, y)) continue;
      const dx = x - px, dy = y - py, d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = { x: x, y: y }; }
    }
  if (best) return best;
  // 4. Truly no walkable tile on the whole map — keep the event at the clamped
  //    preferred coord rather than dropping it (the engine won't crash on an
  //    event that simply can't be stepped on).
  return { x: px, y: py };
}

// Themed NPC dialogue lines (replaces the placeholder "..."). Picked to match
// the event's context so generated maps read like a real game.
const NPC_DIALOGUES: Record<string, string[]> = {
  town: [
    'Welcome to our town, traveler. The shops are open all day.',
    'Beware the dungeons to the east — monsters grow bolder each night.',
    'The inn is warm and the beds are cheap. You look like you need rest.',
    'I hear a terrible foe lurks deep in the cave. Be careful.',
    'Our merchant has fresh potions today. Stock up before you venture out!'
  ],
  village: [
    'Peaceful here, isn\'t it? We don\'t see many adventurers.',
    'If you\'re heading to the forest, watch for wolves at dusk.',
    'The elder lives by the well. He knows the old stories.',
    'Trade with us! We have tools you won\'t find in the city.'
  ],
  dungeon: [
    'You shouldn\'t be here... but since you are, the chest is real.',
    'These halls have been abandoned for a hundred years.',
    'Turn back. The deeper rooms hold things no blade can cut.'
  ],
  cave: [
    'Damp, dark, and full of bats. Watch your step.',
    'There\'s treasure here, but the guardians never sleep.'
  ]
};

function pickDialogue(theme: string, rng: PRNG): string {
  const lines = NPC_DIALOGUES[theme] || NPC_DIALOGUES.town;
  return lines[rng.nextInt(0, lines.length - 1)];
}

function generateEvents(w: number, h: number, rng: PRNG, theme: string, opts: GeneratorOptions = {}, data?: number[]): (MapEvent | null)[] {
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
      // Place chests on a real floor tile (region 1, not inside a wall/water).
      // Was: rng.nextInt(3, w-4) with no check — chests could land in walls.
      const spot = data
        ? findFloorTile(data, w, h, rng, rng.nextInt(3, w - 4), rng.nextInt(3, h - 4))
        : { x: rng.nextInt(3, w - 4), y: rng.nextInt(3, h - 4) };
      if (spot) events.push(makeChestEvent(events.length, spot.x, spot.y));
    }
    // Boss: prefer the dungeon's boss room centre (region 2, set by the BSP
    // generator); fall back to a floor tile scan. Was fixed at (w*0.75, h*0.25)
    // which could sit inside a wall.
    const bossRoom = (opts as Record<string, unknown>).bossRoom as { cx: number; cy: number } | undefined;
    const bossPrefer = bossRoom ? { x: bossRoom.cx, y: bossRoom.cy } : { x: Math.floor(w * 0.75), y: Math.floor(h * 0.25) };
    const bossSpot = data ? findFloorTile(data, w, h, rng, bossPrefer.x, bossPrefer.y) : bossPrefer;
    if (bossSpot) events.push(makeBossEvent(events.length, bossSpot.x, bossSpot.y, 1));
  }

  if (theme === 'town' || theme === 'village') {
    const npcNames = ['Merchant', 'Guard', 'Elder', 'Child', 'Traveler', 'Scholar', 'Blacksmith', 'Healer'];
    const numNpcs = rng.nextInt(2, 5);
    for (let i = 0; i < numNpcs; i++) {
      const spot = data
        ? findFloorTile(data, w, h, rng, rng.nextInt(3, w - 4), rng.nextInt(3, h - 4))
        : { x: rng.nextInt(3, w - 4), y: rng.nextInt(3, h - 4) };
      if (spot) events.push(makeNpcEvent(events.length, spot.x, spot.y, npcNames[i % npcNames.length], pickDialogue(theme, rng)));
    }
  }

  if (theme === 'interior' || theme === 'magic_interior' || theme === 'space_interior') {
    const spot = data ? findFloorTile(data, w, h, rng, Math.floor(w / 2) + 1, Math.floor(h / 2)) : { x: Math.floor(w / 2) + 1, y: Math.floor(h / 2) };
    if (spot) events.push(makeNpcEvent(events.length, spot.x, spot.y, 'Inhabitant', pickDialogue('town', rng)));
  }

  for (let i = 0; i < teleportPositions.length; i++) {
    const tp = teleportPositions[i];
    events.push(makeTransferEvent(events.length, tp.x, tp.y, tp.destMapId, tp.destX, tp.destY, tp.trigger || 1));
  }

  return events;
}

function makeNpcEvent(id: number, x: number, y: number, name: string, dialogue?: string): MapEvent {
  const line = dialogue || '...';
  return {
    id: id, name: name || 'NPC', note: '', x: x, y: y,
    pages: [{
      conditions: defaultConditions(), directionFix: false,
      // Visible NPC sprite (People1 has 8 villagers; vary by id). Was '' = invisible.
      image: { characterIndex: id % 8, characterName: 'People1', direction: 2, pattern: 1, tileId: 0 },
      list: [
        { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
        { code: 401, indent: 0, parameters: [line] },
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

async function generateTileLayoutV3(width: number, height: number, theme: string, opts: GeneratorOptions = {}, _unused1?: unknown, _unused2?: unknown): Promise<{
  data: number[];
  events: (MapEvent | null)[];
  seed: number;
  theme: string;
  width: number;
  height: number;
  houses?: { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[];
}> {
  const seed = opts.seed || Math.floor(Math.random() * 2147483647);
  const rng = new PRNG(seed);
  const perlin = new PerlinNoise(seed);
  const data = new Array(width * height * 6).fill(0) as number[];

  // Stamps are per-tileset; use the caller's tilesetId or the theme's default.
  const ctx: GeneratorContext = {
    stampTileset: ((opts as Record<string, unknown>).tilesetId as number) || THEME_TILESET[theme] || 1,
    interiorRoom: ((opts as Record<string, unknown>).roomType as string) || 'home',
    // Real scanned tiles for the active project's tileset (optional). When stamps
    // are unavailable, themes fall back to these instead of the hardcoded RTP
    // table, so custom tilesets don't emit blank/garbage decoration.
    availableTiles: (opts as Record<string, unknown>).availableTiles as AvailableTiles | undefined,
  };

  // ── Template cloning: for themes that have matching RTP reference templates,
  // clone a hand-authored map (real 3D buildings, walls, furniture) instead of
  // generating procedurally. The procedural stamps were mined fragments that
  // looked broken; templates are the real thing. Auto-picks the closest-sized
  // template by theme category from the full 106-template index. Override with
  // opts.templateId, or opt out with opts.useTemplate === false.
  const useTpl = (opts as Record<string, unknown>).useTemplate !== false;
  const tplId = (opts as Record<string, unknown>).templateId as number | undefined;
  if (useTpl && THEME_CATEGORIES[theme]) {
    const doors = await cloneTemplateForTheme(data, width, height, theme, tplId);
    if (doors) {
      // For town/village (exterior themes), convert detected door positions
      // into house footprints so createMapV3 can wire enterable interiors.
      const isTownLike = theme === 'town' || theme === 'village';
      const houses = isTownLike
        ? doors.map(function (d) { return { x: d.x, y: Math.max(0, d.y - 4), w: 5, h: 5, doorX: d.x, doorY: d.y }; })
        : undefined;
      if ((opts as Record<string, unknown>).autotile !== false) {
        applyAutotileShapes(data, width, height);
      }
      const events = generateEvents(width, height, rng, theme, opts, data);
      return { data: data, events: events, seed: seed, theme: theme, width: width, height: height, houses: houses };
    }
    // Template clone failed (no knowledge dir / unknown id) → fall through to procedural.
  }

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
    if (genFn.length >= 6)
      genResult = genFn(data, width, height, rng, perlin, ctx);
    else
      genResult = genFn(data, width, height, rng, ctx);
  } else {
    fillLayer(data, width, height, LAYER_GROUND1, 2816);
  }
  // town/village generators return the house rectangles; surface them so the
  // caller can wire up enterable-house doors and interiors. Dungeon themes
  // return the boss room so event placement can target it instead of a fixed
  // corner that may be a wall.
  const genObj = (genResult && typeof genResult === 'object') ? genResult as Record<string, unknown> : null;
  const houses = genObj && 'houses' in genObj
    ? (genObj.houses as { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[])
    : undefined;
  if (genObj && 'bossRoom' in genObj) {
    (opts as Record<string, unknown>).bossRoom = genObj.bossRoom;
  }

  // Border every autotile against its neighbours (shorelines, ground edges,
  // roof/wall corners). Generators lay tiles down at shape 0; without this the
  // map renders as flat blocks with hard square edges. Opt out with
  // opts.autotile === false to keep raw shape-0 tiles.
  if ((opts as Record<string, unknown>).autotile !== false) {
    applyAutotileShapes(data, width, height);
  }

  const events = generateEvents(width, height, rng, theme, opts, data);

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
  let map: { width: number; height: number; data: number[]; events?: (MapEvent | null)[] };
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
  return await generateTileLayoutV3(
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
// Pretty-maps helpers (5.9.0): exported for unit/regression tests.
export { makeAutotileId, noiseScale, isPlaceableFloor, findFloorTile };
