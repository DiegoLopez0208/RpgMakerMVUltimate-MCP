// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LayerAccess, applyAutotiling } from '../src/parity/tiles/paint.js';
import {
  TILE_ID,
  makeAutotileId,
  getAutotileShape,
  getAutotileKind,
} from '../src/parity/tiles/tileCodec.js';
import { blankMapData, getMap, setMapTile, tileIndex, mapToolDefinitions } from '../src/parity/tools/mapTools.js';
import { paintToolDefinitions } from '../src/parity/tools/paintTools.js';

/** A LayerAccess backed by a flat array, for the pure tests. */
function grid(width: number, height: number): LayerAccess & { data: number[] } {
  const data = new Array(width * height).fill(0);
  return {
    width,
    height,
    data,
    get: (x, y) => data[y * width + x],
    set: (x, y, v) => {
      data[y * width + x] = v;
    },
  };
}

const A2 = TILE_ID.A2; // A2 ground autotile, kind 16, shape 0

describe('applyAutotiling', () => {
  it('shapes an isolated autotile as the island tile (47)', () => {
    const g = grid(5, 5);
    g.set(2, 2, A2);
    applyAutotiling(g, [{ x: 2, y: 2 }]);
    expect(getAutotileShape(g.get(2, 2))).toBe(47);
    expect(getAutotileKind(g.get(2, 2))).toBe(16); // kind preserved
  });

  it('makes the interior of a filled block solid and the corners outer', () => {
    const g = grid(5, 5);
    const cells: { x: number; y: number }[] = [];
    for (let y = 1; y <= 3; y++)
      for (let x = 1; x <= 3; x++) {
        g.set(x, y, A2);
        cells.push({ x, y });
      }
    applyAutotiling(g, cells);
    // Center is surrounded on all 8 sides → interior (shape 0).
    expect(g.get(2, 2)).toBe(makeAutotileId(16, 0));
    // Top-left corner of the block: only E/S/SE are same-kind → outer|hedge|vedge|solid = 34.
    expect(getAutotileShape(g.get(1, 1))).toBe(34);
  });

  it('leaves flat (non-autotile) tiles untouched', () => {
    const g = grid(3, 3);
    g.set(1, 1, 5); // a B-sheet tile
    applyAutotiling(g, [{ x: 1, y: 1 }]);
    expect(g.get(1, 1)).toBe(5);
  });
});

/** Scaffold a project with one blank map to paint on. */
async function scaffold(width: number, height: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-paint-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(blankMapData(width, height, 1)));
  return dir;
}

const fillArea = paintToolDefinitions.find((t) => t.name === 'fill_area')!;
const paintTiles = paintToolDefinitions.find((t) => t.name === 'paint_tiles')!;

describe('paint tools (integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold(6, 6);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fill_area autotiles a rectangle on layer 0', async () => {
    const res = (await fillArea.handler(
      { projectPath: dir },
      {
        mapId: 1,
        x: 1,
        y: 1,
        width: 3,
        height: 3,
        tileId: A2,
      },
    )) as { painted: number; warnings?: string[] };
    expect(res.painted).toBe(9);
    expect(res.warnings).toBeUndefined();

    const map = await getMap(dir, 1);
    const at = (x: number, y: number) => map.data[tileIndex(map.width, map.height, x, y, 0)];
    expect(at(2, 2)).toBe(makeAutotileId(16, 0)); // interior solid
    expect(getAutotileShape(at(1, 1))).toBe(34); // corner
    expect(at(0, 0)).toBe(0); // outside the rect, untouched
  });

  it('paint_tiles warns on out-of-bounds cells but paints the rest', async () => {
    const res = (await paintTiles.handler(
      { projectPath: dir },
      {
        mapId: 1,
        tiles: [
          { x: 0, y: 0, tileId: A2 },
          { x: 99, y: 0, tileId: A2 },
        ],
      },
    )) as { painted: number; warnings?: string[] };
    expect(res.painted).toBe(1);
    expect(res.warnings?.some((w) => w.includes('out of bounds'))).toBe(true);
  });

  it.each([[4, 16], [5, 256], [0, 8192], [-1, 1], [6, 1]])('rejects invalid layer %s value %s before writing', async (layer, tileId) => {
    const path = join(dir, 'data', 'Map001.json');
    const before = await readFile(path, 'utf8');
    await expect(fillArea.handler({ projectPath: dir }, { mapId: 1, x: 0, y: 0, width: 2, height: 2, tileId, layer })).rejects.toThrow(/layer|value/i);
    await expect(setMapTile(dir, 1, 0, 0, layer, tileId)).rejects.toThrow(/layer|value/i);
    await expect(paintToolDefinitions.find(t => t.name === 'paint_blueprint')!.handler({ projectPath: dir }, {mapId: 1, rows: ['x'], legend: {x: [[layer, tileId]]}})).rejects.toThrow(/layer|value/i);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('preserves MV region IDs and shadow bits without autotiling', async () => {
    await fillArea.handler({projectPath: dir}, {mapId: 1, x: 0, y: 0, width: 2, height: 2, tileId: 255, layer: 5});
    await setMapTile(dir, 1, 0, 0, 4, 15);
    const map = await getMap(dir, 1);
    expect(map.data[tileIndex(6,6,1,1,5)]).toBe(255);
    expect(map.data[tileIndex(6,6,0,0,4)]).toBe(15);
  });

  it('rejects fractional coordinates before editing a map', async () => {
    await expect(setMapTile(dir, 1, 0.5, 0, 0, 1)).rejects.toThrow(/integer/);
    await expect(paintTiles.handler({projectPath: dir}, {mapId: 1, tiles: [{x: 0.5, y: 0, tileId: 1}]})).rejects.toThrow(/integer/);
  });

  it('is available as three registered mutating tools', () => {
    expect(paintToolDefinitions.map((t) => t.name).sort()).toEqual([
      'fill_area',
      'paint_blueprint',
      'paint_tiles',
    ]);
    expect(paintToolDefinitions.every((t) => t.mutates)).toBe(true);
    // sanity: the map module it builds on is present too
    expect(mapToolDefinitions.some((t) => t.name === 'set_map_tile')).toBe(true);
  });
});
