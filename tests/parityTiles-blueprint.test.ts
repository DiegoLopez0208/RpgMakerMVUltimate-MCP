// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LayerAccess } from '../src/parity/tiles/paint.js';
import {
  applyBlueprint,
  parseBlueprint,
  wallSideFor,
  ResolvedEntry,
  ResolvedWall,
} from '../src/parity/tiles/blueprint.js';
import {
  TILE_ID,
  getAutotileKind,
  getAutotileShape,
  isWallSideTile,
  isWallTopTile,
} from '../src/parity/tiles/tileCodec.js';
import { resolveTileName } from '../src/parity/tiles/catalog/index.js';
import { blankMapData, getMap, tileIndex } from '../src/parity/tools/mapTools.js';
import { paintToolDefinitions } from '../src/parity/tools/paintTools.js';

const GRASS = TILE_ID.A2; // A2 kind 16 ('Grassland A' on World_A2)
const WALL_TOP = 6656; // A4 kind 96 — a wall-top kind (96 % 16 = 0)
const WALL_SIDE = 7040; // kind 104 — its side (top + 8 kinds)
const FLOOR = 1557; // a flat A5 tile
const SOLID = 100; // flat B tile flagged impassable in the fixture tileset

/** Six in-memory layers over a width×height map. */
function layers(width: number, height: number) {
  const data = Array.from({ length: 6 }, () => new Array(width * height).fill(0));
  const layerOf = (layer: number): LayerAccess => ({
    width,
    height,
    get: (x, y) => data[layer][y * width + x],
    set: (x, y, v) => {
      data[layer][y * width + x] = v;
    },
  });
  return { data, layerOf, at: (layer: number, x: number, y: number) => data[layer][y * width + x] };
}

const wall = (faceHeight = 1): ResolvedWall => ({
  top: WALL_TOP,
  side: WALL_SIDE,
  faceHeight,
  layer: 0,
});
const wallEntry = (w: ResolvedWall): ResolvedEntry => ({ tiles: new Map([[0, w.top]]), wall: w });

describe('wallSideFor', () => {
  it('derives the side as top + 8 kinds (+384 ids), matching the tileCodec A4 bands', () => {
    expect(wallSideFor(WALL_TOP)).toBe(WALL_SIDE);
    expect(isWallTopTile(WALL_TOP)).toBe(true);
    expect(isWallSideTile(WALL_SIDE)).toBe(true);
    expect(getAutotileKind(WALL_SIDE) - getAutotileKind(WALL_TOP)).toBe(8);
  });

  it('refuses a tile that is not a wall top / roof', () => {
    expect(() => wallSideFor(GRASS)).toThrow(/not an A4 wall-top/);
    expect(() => wallSideFor(WALL_SIDE)).toThrow(/not an A4 wall-top/);
  });
});

describe('parseBlueprint', () => {
  it('splits rows into glyph cells', () => {
    expect(parseBlueprint(['ab', 'ba'], ['a', 'b'])).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });

  it('reports ragged rows, unknown glyphs and multi-char keys together', () => {
    let message = '';
    try {
      parseBlueprint(['ab', 'a', 'xz'], ['a', 'b', 'bb']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/row 1 has 1 cells, expected 2/);
    expect(message).toMatch(/glyph "x" \(first at column 0, row 2\)/);
    expect(message).toMatch(/glyph "z"/);
    expect(message).toMatch(/legend key "bb"/);
  });
});

describe('applyBlueprint', () => {
  it('converts the bottom of each vertical wall run to the side kind', () => {
    const m = layers(5, 4);
    const w = wall();
    const grid = parseBlueprint(['WWWWW', 'W...W', 'W...W', 'WWWWW'], ['W', '.']);
    const stats = applyBlueprint(
      m.layerOf,
      grid,
      { W: wallEntry(w), '.': { tiles: new Map([[0, FLOOR]]) } },
      0,
      0,
      true,
    );
    // Top row interior (above floor) → faces; corners continue down → tops.
    for (let x = 1; x <= 3; x++) expect(getAutotileKind(m.at(0, x, 0))).toBe(104);
    expect(getAutotileKind(m.at(0, 0, 0))).toBe(96);
    // Side columns run off the bottom edge → no face anywhere down them.
    for (let y = 0; y < 4; y++) expect(getAutotileKind(m.at(0, 0, y))).toBe(96);
    // Bottom row continues off-map → tops.
    expect(getAutotileKind(m.at(0, 2, 3))).toBe(96);
    expect(stats.wallFaces).toBe(3);
    expect(stats.painted[0]).toBe(20);
    expect(m.at(0, 2, 1)).toBe(FLOOR);
  });

  it('honours faceHeight and stops at the run top', () => {
    const m = layers(3, 5);
    const w = wall(2);
    const grid = parseBlueprint(['.W.', '.W.', '.W.', '...', '.W.'], ['W', '.']);
    applyBlueprint(
      m.layerOf,
      grid,
      { W: wallEntry(w), '.': { tiles: new Map([[0, FLOOR]]) } },
      0,
      0,
      true,
    );
    expect(getAutotileKind(m.at(0, 1, 0))).toBe(96); // top
    expect(getAutotileKind(m.at(0, 1, 1))).toBe(104); // face
    expect(getAutotileKind(m.at(0, 1, 2))).toBe(104); // face (run bottom)
    // A 1-cell run on the map's bottom edge continues off-map: stays a top.
    expect(getAutotileKind(m.at(0, 1, 4))).toBe(96);
  });

  it('autotiles once per layer and clears unspecified upper layers', () => {
    const m = layers(4, 3);
    // Stale object on layer 2 and an upper tile on layer 3 everywhere.
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) {
        m.layerOf(2).set(x, y, 55);
        m.layerOf(3).set(x, y, 66);
      }
    const grid = parseBlueprint(['gggg', 'gffg', 'g--g'], ['g', 'f', '-']);
    const stats = applyBlueprint(
      m.layerOf,
      grid,
      {
        g: { tiles: new Map([[0, GRASS]]) },
        f: {
          tiles: new Map([
            [0, GRASS],
            [1, GRASS],
          ]),
        },
        '-': null,
      },
      0,
      0,
      true,
    );
    // Interior-ish grass cell (1,1) on layer 0 has grass all around except below-row
    // '-' cells, which were left untouched (0) — so not solid, but same kind.
    expect(getAutotileKind(m.at(0, 1, 1))).toBe(16);
    // Two-cell layer-1 strip: each end is a border shape, not the island slot.
    expect(getAutotileShape(m.at(1, 1, 1))).not.toBe(47);
    expect(getAutotileKind(m.at(1, 2, 1))).toBe(16);
    // Layers 2-3 cleared on painted cells, kept on the null '-' cells.
    expect(m.at(2, 0, 0)).toBe(0);
    expect(m.at(3, 2, 1)).toBe(0);
    expect(m.at(2, 1, 2)).toBe(55);
    expect(m.at(3, 1, 2)).toBe(66);
    expect(stats.cleared).toBe(20); // 10 painted cells × layers 2 and 3
    expect(stats.painted).toEqual({ 0: 10, 1: 2 });
  });

  it('leaves upper layers alone when clearUpperLayers is false', () => {
    const m = layers(2, 1);
    m.layerOf(2).set(0, 0, 55);
    applyBlueprint(m.layerOf, [['g', 'g']], { g: { tiles: new Map([[0, GRASS]]) } }, 0, 0, false);
    expect(m.at(2, 0, 0)).toBe(55);
  });
});

describe('resolveTileName', () => {
  const sheets = ['', 'World_A2', '', '', '', '', '', '', ''];

  it('prefers an exact name over substring hits', () => {
    expect(resolveTileName(sheets, 'forest')).toBe(TILE_ID.A2 + 4 * 48);
    expect(resolveTileName(sheets, 'Grassland A')).toBe(GRASS);
  });

  it('accepts a unique substring', () => {
    expect(resolveTileName(sheets, 'conifer')).toBe(TILE_ID.A2 + 5 * 48);
  });

  it('errors on ambiguity and on no match', () => {
    expect(() => resolveTileName(sheets, 'grassland')).toThrow(/ambiguous/);
    expect(() => resolveTileName(sheets, 'no such tile')).toThrow(/no catalog tile/);
  });
});

/**
 * Passage bits (low nibble) of A4 wall-top shapes 0-47 exactly as the RMMZ
 * editor sets them in a stock Tilesets.json: only outer edges block, never the
 * bottom edge (the face below does that), and an interior top (shape 0) is open.
 */
const REAL_WALL_TOP_BITS = '0000000000000000222288884444000068aacc4422ea6cef';

/**
 * Scaffold a project whose tileset uses World_A2 (named) with SOLID impassable.
 * Wall tops are fully blocked unless `realWallTops` gives them the editor's edge flags.
 */
async function scaffold(width: number, height: number, realWallTops = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-blueprint-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'img', 'tilesets'), { recursive: true });
  await writeFile(join(dir, 'img', 'tilesets', 'World_A2.txt'), 'Grassland A\nGrassland B\n');
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(blankMapData(width, height, 1)));
  const flags = new Array(8192).fill(0);
  flags[0] = 0x10;
  flags[SOLID] = 0x0f;
  for (let s = 0; s < 48; s++) {
    flags[WALL_TOP + s] = realWallTops ? parseInt(REAL_WALL_TOP_BITS[s], 16) : 0x0f;
    flags[WALL_SIDE + s] = 0x0f;
  }
  const tileset = {
    id: 1,
    name: 'Fixture',
    mode: 1,
    note: '',
    tilesetNames: ['', 'World_A2', '', '', '', '', '', '', ''],
    flags,
  };
  await writeFile(join(dir, 'data', 'Tilesets.json'), JSON.stringify([null, tileset]));
  return dir;
}

const paintBlueprint = paintToolDefinitions.find((t) => t.name === 'paint_blueprint')!;

interface BlueprintResult {
  layers: Record<string, number>;
  cleared: number;
  wallFaces: number;
  passability?: { impassableCount: number; rows: string[]; impassable: [number, number][] };
  warnings?: string[];
}

describe('paint_blueprint (integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold(7, 5);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('paints walls, names and multi-layer cells in one write with a passability overview', async () => {
    const res = (await paintBlueprint.handler(
      { projectPath: dir },
      {
        mapId: 1,
        origin: [1, 1],
        rows: ['WWWWW', 'W.o.W', 'WWWWW'],
        legend: {
          W: { wall: { top: WALL_TOP } },
          '.': 'Grassland A',
          o: [
            [0, 'Grassland A'],
            [2, SOLID],
          ],
        },
      },
    )) as BlueprintResult;
    expect(res.layers).toEqual({ 0: 15, 2: 1 });
    expect(res.wallFaces).toBe(8); // 3 above the grass + the 5-cell bottom row above an empty map row
    expect(res.passability?.rows).toEqual(['#####', '#.#.#', '#####']);
    expect(res.passability?.impassableCount).toBe(13);
    expect(res.passability?.impassable).toContainEqual([3, 2]);

    const map = await getMap(dir, 1);
    const at = (layer: number, x: number, y: number) =>
      map.data[tileIndex(map.width, map.height, x, y, layer)];
    expect(getAutotileKind(at(0, 2, 1))).toBe(104); // top row above grass → face
    expect(getAutotileKind(at(0, 2, 3))).toBe(104); // bottom row above empty map row → face
    expect(getAutotileKind(at(0, 1, 1))).toBe(96); // corner continues down
    expect(getAutotileKind(at(0, 2, 2))).toBe(16); // grass
    expect(at(2, 3, 2)).toBe(SOLID);
    expect(at(0, 0, 0)).toBe(0); // outside the blueprint
  });

  it('marks a whole A4 wall mass impassable with real edge-only wall-top flags', async () => {
    const real = await scaffold(9, 7, true);
    try {
      const res = (await paintBlueprint.handler(
        { projectPath: real },
        {
          mapId: 1,
          rows: [
            'WWWWWWWWW',
            'WWWWWWWWW',
            'WW.....WW',
            'WW.....WW',
            'WW.....WW',
            'WWWWWWWWW',
            'WWWWWWWWW',
          ],
          legend: { W: { wall: { top: WALL_TOP } }, '.': 'Grassland A' },
        },
      )) as BlueprintResult;
      expect(res.passability?.rows).toEqual([
        '#########',
        '#########',
        '##.....##',
        '##.....##',
        '##.....##',
        '#########',
        '#########',
      ]);
      expect(res.passability?.impassableCount).toBe(63 - 15);

      // The fixture really exercises edge flags: the corner top is open inward,
      // and the top beside the floor only blocks its floor-facing edge.
      const map = await getMap(real, 1);
      const shapeAt = (x: number, y: number) =>
        getAutotileShape(map.data[tileIndex(map.width, map.height, x, y, 0)]);
      expect(REAL_WALL_TOP_BITS[shapeAt(0, 3)]).not.toBe('f');
      expect(parseInt(REAL_WALL_TOP_BITS[shapeAt(1, 3)], 16) & 0x04).toBe(0x04); // right blocked
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  it('validates everything before writing', async () => {
    const before = await readFile(join(dir, 'data', 'Map001.json'), 'utf8');
    await expect(
      paintBlueprint.handler(
        { projectPath: dir },
        { mapId: 1, rows: ['ab'], legend: { a: 'grassland', b: 'nope' } },
      ),
    ).rejects.toThrow(/ambiguous[\s\S]*no catalog tile/);
    await expect(
      paintBlueprint.handler(
        { projectPath: dir },
        { mapId: 1, rows: ['aaaaaaaa'], legend: { a: [[0, GRASS]] } },
      ),
    ).rejects.toThrow(/does not fit/);
    await expect(
      paintBlueprint.handler(
        { projectPath: dir },
        { mapId: 1, rows: ['a'], legend: { a: { wall: { top: GRASS } } } },
      ),
    ).rejects.toThrow(/not an A4 wall-top/);
    expect(await readFile(join(dir, 'data', 'Map001.json'), 'utf8')).toBe(before);
  });

  it('is registered as a mutating paint tool', () => {
    expect(paintBlueprint.mutates).toBe(true);
  });
});
