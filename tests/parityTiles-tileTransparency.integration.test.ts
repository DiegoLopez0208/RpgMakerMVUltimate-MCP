// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { encodePng } from '../src/parity/tiles/png.js';
import { autotileSample } from '../src/parity/tiles/tilegeom.js';
import {
  isTileTransparent,
  tileTransparencyDetail,
  baseAwareTransparencyWarning,
} from '../src/parity/tools/tileTransparency.js';
import { catalogToolDefinitions } from '../src/parity/tools/catalogTools.js';
import { tileToolDefinitions } from '../src/parity/tools/tileTools.js';
import { paintToolDefinitions } from '../src/parity/tools/paintTools.js';
import { getMap } from '../src/parity/tools/mapTools.js';
import { makeAutotileId, TILE_ID } from '../src/parity/tiles/tileCodec.js';
import { Tileset } from '../src/parity/utils/types.js';

/**
 * End-to-end for the transparency stack: a synthetic project whose World_A2 sheet
 * is opaque except kind 16's interior (a transparent ground tile) and whose
 * World_B sheet has one transparent object tile. Proves the tools-layer classifier
 * reads real PNGs, the catalog annotates a `transparent` flag, and the paint tools
 * warn (base-aware) when a see-through tile lands with no opaque base beneath.
 */

const GRASS_A2 = makeAutotileId(16, 0); // 2816 — first A2 kind, shape-0 base (made transparent)
const DIRT_A2 = makeAutotileId(17, 0); // 2864 — a second A2 kind (left opaque)
const TREE_B = TILE_ID.B + 1; // 1 — a flat B object tile (made transparent)

const TILESET: Tileset = {
  id: 1,
  name: 'Test World',
  mode: 0,
  note: '',
  tilesetNames: ['', 'World_A2', '', '', '', 'World_B', '', '', ''],
  flags: [],
};

const W = 4;
const H = 4;
const MAP = {
  id: 1,
  width: W,
  height: H,
  tilesetId: 1,
  data: new Array(W * H * 6).fill(0),
  events: [],
};

function opaqueRGBA(w: number, h: number): Buffer {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) b[i * 4 + 3] = 255;
  return b;
}
function punch(b: Buffer, w: number, sx: number, sy: number, rw: number, rh: number, a: number) {
  for (let y = sy; y < sy + rh; y++) for (let x = sx; x < sx + rw; x++) b[(y * w + x) * 4 + 3] = a;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rpgmv-alpha-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Tilesets.json'), JSON.stringify([null, TILESET]));
  await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'M' }]));
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(MAP));

  await mkdir(join(dir, 'img', 'tilesets'), { recursive: true });
  await writeFile(join(dir, 'img', 'tilesets', 'World_A2.txt'), 'Grass\nDirt\n');
  // World_A2 (768×576): opaque ground, except kind 16's shape-0 quarters made transparent.
  const a2 = opaqueRGBA(768, 576);
  for (const [sx, sy] of autotileSample(16)) punch(a2, 768, sx, sy, 24, 24, 0);
  await writeFile(join(dir, 'img', 'tilesets', 'World_A2.png'), encodePng(768, 576, a2));
  // World_B (768×768): opaque, except the local-index-1 cell (a transparent "tree").
  const b = opaqueRGBA(768, 768);
  punch(b, 768, 48, 0, 48, 48, 0); // flatSample(1) → (48,0)
  await writeFile(join(dir, 'img', 'tilesets', 'World_B.png'), encodePng(768, 768, b));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('tile transparency (integration)', () => {
  it('classifies transparent vs opaque tiles from the real PNG', async () => {
    expect(await isTileTransparent(dir, TILESET, TREE_B)).toBe(true);
    expect(await isTileTransparent(dir, TILESET, GRASS_A2)).toBe(true);
    expect(await isTileTransparent(dir, TILESET, DIRT_A2)).toBe(false);
    expect(await isTileTransparent(dir, TILESET, 0)).toBeUndefined(); // empty tile
  });

  it('reports a percentage detail for describe_tile', async () => {
    expect(await tileTransparencyDetail(dir, TILESET, TREE_B)).toEqual({
      transparent: true,
      transparentPercent: 100,
    });
    expect(await tileTransparencyDetail(dir, TILESET, DIRT_A2)).toEqual({
      transparent: false,
      transparentPercent: 0,
    });
  });

  it('fails soft when the sheet PNG is missing', async () => {
    const noPng: Tileset = {
      ...TILESET,
      tilesetNames: ['', 'Nonexistent_A2', '', '', '', '', '', '', ''],
    };
    expect(await isTileTransparent(dir, noPng, GRASS_A2)).toBeUndefined();
  });

  it('describe_tile surfaces transparency when given a tilesetId', async () => {
    const describe = tileToolDefinitions.find((t) => t.name === 'describe_tile')!;
    const withId = (await describe.handler(
      { projectPath: dir },
      { tileId: TREE_B, tilesetId: 1 },
    )) as {
      transparent?: boolean;
      sheet: string;
    };
    expect(withId).toMatchObject({ sheet: 'B', transparent: true });
    // Without a tilesetId it stays a pure decode (no transparency field).
    const bare = (await describe.handler({ projectPath: dir }, { tileId: TREE_B })) as {
      transparent?: boolean;
    };
    expect(bare.transparent).toBeUndefined();
  });

  it('get_tile_catalog annotates each entry with the transparent flag', async () => {
    const getCatalog = catalogToolDefinitions.find((t) => t.name === 'get_tile_catalog')!;
    const res = (await getCatalog.handler(
      { projectPath: dir },
      { tilesetId: 1, sheet: 'World_A2' },
    )) as { entries: { tileId: number; transparent?: boolean }[] };
    const grass = res.entries.find((e) => e.tileId === GRASS_A2)!;
    const dirt = res.entries.find((e) => e.tileId === DIRT_A2)!;
    expect(grass.transparent).toBe(true);
    expect(dirt.transparent).toBe(false);
  });

  it('warns painting a transparent tile on layer 0, but not an opaque one', async () => {
    const paint = paintToolDefinitions.find((t) => t.name === 'paint_tiles')!;
    const clear = (await paint.handler(
      { projectPath: dir },
      { mapId: 1, tiles: [{ x: 0, y: 0, tileId: DIRT_A2 }], layer: 0 },
    )) as { warnings?: string[] };
    expect(clear.warnings ?? []).not.toContainEqual(expect.stringMatching(/no opaque base/));

    const voided = (await paint.handler(
      { projectPath: dir },
      { mapId: 1, tiles: [{ x: 1, y: 1, tileId: TREE_B }], layer: 0 },
    )) as { warnings?: string[] };
    expect(voided.warnings ?? []).toContainEqual(expect.stringMatching(/no opaque base/));
  });

  it('does NOT warn when an opaque base already sits beneath (base-aware)', async () => {
    // Cell (2,2): opaque ground on layer 0 already exists → a transparent tile on
    // an upper layer is covered.
    const map = await getMap(dir, 1);
    map.data[/* layer 0, (2,2) */ (0 * H + 2) * W + 2] = DIRT_A2;
    const warn = await baseAwareTransparencyWarning(dir, map, TILESET, [
      { x: 2, y: 2, tileId: TREE_B, layer: 2 },
    ]);
    expect(warn).toBeUndefined();

    // Same tile on an upper layer over an EMPTY column → still warns.
    const warn2 = await baseAwareTransparencyWarning(dir, map, TILESET, [
      { x: 3, y: 3, tileId: TREE_B, layer: 2 },
    ]);
    expect(warn2).toMatch(/no opaque base/);
  });
});
