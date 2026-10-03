// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { blankMapData, getMap, tileIndex } from '../src/parity/tools/mapTools.js';
import { objectToolDefinitions, flatObjectGrid } from '../src/parity/tools/objectTools.js';
import { makeAutotileId } from '../src/parity/tiles/tileCodec.js';

/**
 * Fixture tile ids and their flags:
 *  - 0   empty → 0x10 star (the engine's empty-tile flag; makes a groundless cell impassable)
 *  - 100 passable flat ground (flag 0 = all four directions walkable)
 *  - 200 solid object tile (0x0f = all four passage bits set = blocked every way)
 */
const GROUND = 100;
const SOLID = 200;

function tilesetFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[0] = 0x10; // empty tile is a [*] star, per the engine
  flags[GROUND] = 0x00; // fully passable
  flags[SOLID] = 0x0f; // impassable all directions
  return flags;
}

/** Scaffold a project + one map. `ground` fills layer 0 with the passable ground tile. */
async function scaffold(width: number, height: number, ground: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-object-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');

  const map = blankMapData(width, height, 1);
  if (ground) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        map.data[tileIndex(width, height, x, y, 0)] = GROUND;
      }
  }
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));

  const tileset = {
    id: 1,
    name: 'Fixture',
    mode: 1,
    note: '',
    tilesetNames: ['', '', '', '', '', 'Fixture_B', '', '', ''],
    flags: tilesetFlags(),
  };
  await writeFile(join(dir, 'data', 'Tilesets.json'), JSON.stringify([null, tileset]));
  return dir;
}

const placeObject = objectToolDefinitions.find((t) => t.name === 'place_object')!;

type Passable = { down: boolean; left: boolean; right: boolean; up: boolean };
interface PlaceResult {
  placed: number;
  layer: number;
  footprint: { x: number; y: number; tileId: number; passable: Passable }[];
  collision: { x: number; y: number }[];
  warnings?: string[];
}

describe('place_object (integration)', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('on walkable ground', () => {
    beforeEach(async () => {
      dir = await scaffold(6, 6, true);
    });

    it('stamps a solid 2x2 object on layer 2 and reports its collision footprint', async () => {
      const res = (await placeObject.handler(
        { projectPath: dir },
        {
          mapId: 1,
          x: 1,
          y: 1,
          tiles: [
            [SOLID, SOLID],
            [SOLID, SOLID],
          ],
        },
      )) as PlaceResult;

      expect(res.placed).toBe(4);
      expect(res.layer).toBe(2); // default upper tile layer
      expect(res.warnings).toBeUndefined(); // walkable ground, empty layer, flat tiles
      // Every footprint cell is now impassable → all four report as collision.
      expect(res.collision).toHaveLength(4);
      expect(res.footprint.every((c) => !c.passable.down && !c.passable.up)).toBe(true);

      const map = await getMap(dir, 1);
      expect(map.data[tileIndex(map.width, map.height, 1, 1, 2)]).toBe(SOLID);
      expect(map.data[tileIndex(map.width, map.height, 0, 0, 2)]).toBe(0); // outside footprint untouched
      expect(map.data[tileIndex(map.width, map.height, 1, 1, 0)]).toBe(GROUND); // ground preserved under it
    });

    it('leaves 0-hole cells untouched (irregular objects)', async () => {
      const res = (await placeObject.handler(
        { projectPath: dir },
        {
          mapId: 1,
          x: 0,
          y: 0,
          tiles: [
            [SOLID, 0],
            [SOLID, SOLID],
          ],
        },
      )) as PlaceResult;
      expect(res.placed).toBe(3); // the 0 is skipped
      const map = await getMap(dir, 1);
      expect(map.data[tileIndex(map.width, map.height, 1, 0, 2)]).toBe(0); // the hole
    });

    it('warns when overwriting an existing tile on the target layer', async () => {
      await placeObject.handler({ projectPath: dir }, { mapId: 1, x: 2, y: 2, tiles: [[SOLID]] });
      const res = (await placeObject.handler(
        { projectPath: dir },
        { mapId: 1, x: 2, y: 2, tiles: [[SOLID]] },
      )) as PlaceResult;
      expect(res.warnings?.some((w) => w.includes('overwrote existing tile'))).toBe(true);
    });

    it('warns and skips out-of-bounds footprint cells', async () => {
      const res = (await placeObject.handler(
        { projectPath: dir },
        { mapId: 1, x: 5, y: 5, tiles: [[SOLID, SOLID]] },
      )) as PlaceResult;
      expect(res.placed).toBe(1); // (5,5) in, (6,5) out
      expect(res.warnings?.some((w) => w.includes('out of bounds'))).toBe(true);
    });

    it('warns that an autotile id should go through paint_tiles', async () => {
      const res = (await placeObject.handler(
        { projectPath: dir },
        { mapId: 1, x: 1, y: 1, tiles: [[makeAutotileId(16, 0)]] },
      )) as PlaceResult;
      expect(res.warnings?.some((w) => w.includes('autotile'))).toBe(true);
    });

    it('rejects a non-rectangular grid', async () => {
      await expect(
        placeObject.handler(
          { projectPath: dir },
          { mapId: 1, x: 0, y: 0, tiles: [[SOLID, SOLID], [SOLID]] },
        ),
      ).rejects.toThrow(/rectangular/);
    });
  });

  describe('on impassable ground', () => {
    beforeEach(async () => {
      dir = await scaffold(6, 6, false); // no ground tiles → groundless cells are impassable
    });

    it('warns that the object sits on impassable terrain', async () => {
      const res = (await placeObject.handler(
        { projectPath: dir },
        { mapId: 1, x: 1, y: 1, tiles: [[GROUND]] },
      )) as PlaceResult;
      expect(res.warnings?.some((w) => w.includes('impassable terrain'))).toBe(true);
      // A passable object tile over nothing is now walkable → not a collision cell.
      expect(res.collision).toHaveLength(0);
    });
  });

  it('registers place_object (mutating) and object_tiles (read-only)', () => {
    expect(objectToolDefinitions.map((t) => t.name).sort()).toEqual([
      'object_tiles',
      'place_object',
    ]);
    expect(placeObject.mutates).toBe(true);
    expect(objectTiles.mutates).toBeUndefined();
  });
});

const objectTiles = objectToolDefinitions.find((t) => t.name === 'object_tiles')!;

describe('flatObjectGrid (pure)', () => {
  it('walks down a half-column with an 8-tile stride, not 16', () => {
    // B sheet (base 0), top-left local index 1 → visual (col 1, row 0).
    expect(flatObjectGrid(1, 2, 2)).toEqual([
      [1, 2],
      [9, 10],
    ]);
  });

  it('wraps across the half-column boundary (col 8 jumps to index 128)', () => {
    // top-left at col 6, row 0; a 4-wide row crosses into the right half-column.
    expect(flatObjectGrid(6, 4, 1)).toEqual([[6, 7, 128, 129]]);
  });

  it('offsets by the sheet base (C sheet base 256)', () => {
    expect(flatObjectGrid(257, 2, 1)).toEqual([[257, 258]]);
  });

  it('throws on an autotile top-left id', () => {
    expect(() => flatObjectGrid(makeAutotileId(16, 0), 2, 2)).toThrow(/autotile/);
  });

  it('throws when the rectangle runs off the 16x16 sheet', () => {
    // local index 135 → right half, col 15, row 0; width 2 would need col 16.
    expect(() => flatObjectGrid(135, 2, 1)).toThrow(/runs off/);
  });
});

describe('object_tiles (integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold(6, 6, true); // fixture tileset 1 has a B sheet ("Fixture_B")
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the id grid and the resolved sheet name, no warning', async () => {
    const res = (await objectTiles.handler(
      { projectPath: dir },
      { tilesetId: 1, topLeftId: 1, width: 2, height: 2 },
    )) as { sheet: string; sheetName: string; tiles: number[][]; warnings?: string[] };
    expect(res.sheet).toBe('B');
    expect(res.sheetName).toBe('Fixture_B');
    expect(res.tiles).toEqual([
      [1, 2],
      [9, 10],
    ]);
    expect(res.warnings).toBeUndefined();
  });

  it('warns when the tileset lacks the referenced sheet (C is empty in the fixture)', async () => {
    const res = (await objectTiles.handler(
      { projectPath: dir },
      { tilesetId: 1, topLeftId: 257, width: 1, height: 1 },
    )) as { sheet: string; warnings?: string[] };
    expect(res.sheet).toBe('C');
    expect(res.warnings?.some((w) => /no C sheet/.test(w))).toBe(true);
  });

  it('throws on an unknown tileset id', async () => {
    await expect(
      objectTiles.handler(
        { projectPath: dir },
        { tilesetId: 99, topLeftId: 1, width: 1, height: 1 },
      ),
    ).rejects.toThrow(/Tileset 99/);
  });
});
