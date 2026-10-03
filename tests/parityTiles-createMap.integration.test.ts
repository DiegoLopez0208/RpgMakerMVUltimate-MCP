// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import { createMap, getMapInfos, blankMapData, mapToolDefinitions } from '../src/parity/tools/mapTools.js';
import { MapData, MapInfo } from '../src/parity/utils/types.js';

/** Scaffold a minimal RPG Maker MZ project with a seeded MapInfos.json. */
async function scaffoldProject(infos: (MapInfo | null)[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-createmap-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify(infos));
  return dir;
}

const map1: MapInfo = {
  id: 1,
  name: 'MAP001',
  parentId: 0,
  order: 1,
  expanded: false,
  scrollX: 0,
  scrollY: 0,
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('createMap (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // MapInfos is a 1-indexed array whose slot 0 is null.
    dir = await scaffoldProject([null, map1]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('allocates the next id, writes the map file, and registers it in the tree', async () => {
    const { mapId, mapInfo } = await createMap(dir, { name: 'Town' });
    expect(mapId).toBe(2);
    expect(mapInfo).toMatchObject({ id: 2, name: 'Town', parentId: 0, order: 2 });

    // Map file landed on disk, zero-padded, and compact.
    const raw = await readFile(join(dir, 'data', 'Map002.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    const map = JSON.parse(raw) as MapData;
    expect(map.width).toBe(17);
    expect(map.height).toBe(13);
    expect(map.data).toHaveLength(17 * 13 * 6);
    expect(map.data.every((t) => t === 0)).toBe(true);
    expect(map.events).toEqual([]);

    // Tree updated.
    const infos = await getMapInfos(dir);
    expect(infos[2]?.name).toBe('Town');
  });

  it('honors custom dimensions and tileset', async () => {
    const { map } = await createMap(dir, { name: 'Cave', width: 30, height: 20, tilesetId: 4 });
    expect(map.width).toBe(30);
    expect(map.height).toBe(20);
    expect(map.tilesetId).toBe(4);
    expect(map.data).toHaveLength(30 * 20 * 6);
  });

  it('nests under a valid parent', async () => {
    const { mapInfo } = await createMap(dir, { name: 'Inn', parentId: 1 });
    expect(mapInfo.parentId).toBe(1);
  });

  it('rejects a non-existent parent', async () => {
    await expect(createMap(dir, { name: 'Orphan', parentId: 99 })).rejects.toThrow(/parentId 99/);
  });

  it('rejects non-positive dimensions', async () => {
    await expect(createMap(dir, { name: 'Bad', width: 0 })).rejects.toThrow(/dimensions/);
  });

  it('refuses to overwrite an existing map file for the allocated id', async () => {
    // Pre-create Map002.json so the freshly-allocated id collides with a file.
    await writeFile(join(dir, 'data', 'Map002.json'), '{}');
    await expect(createMap(dir, { name: 'Collision' })).rejects.toThrow(/refusing to overwrite/);
  });

  it('dry-run previews both writes without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await createMap(dir, { name: 'Preview' });
    });

    const files = context.commits.map((c) => c.path);
    expect(files.some((f) => f.endsWith('Map002.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('MapInfos.json'))).toBe(true);
    expect(context.commits.every((c) => c.changed)).toBe(true);

    // Nothing was written.
    expect(await exists(join(dir, 'data', 'Map002.json'))).toBe(false);
    const infos = await getMapInfos(dir);
    expect(infos[2]).toBeUndefined();
  });

  it('the create_map tool handler dispatches to createMap and trims the blank data array', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'create_map')!;
    expect(def.mutates).toBe(true);
    const result = (await def.handler({ projectPath: dir }, { name: 'ViaTool' })) as {
      mapId: number;
      mapInfo: MapInfo;
      map: MapData & { dataTileCount: number; data?: unknown };
    };
    expect(result.mapId).toBe(2);
    // P2-6: the response omits the ~w*h*6 all-zero tile array, reporting its size.
    expect(result.map.data).toBeUndefined();
    expect(result.map.dataTileCount).toBe(17 * 13 * 6);
    expect(result.mapInfo.name).toBe('ViaTool');
  });
});

describe('blankMapData', () => {
  it('produces a fully-zeroed tile array of width*height*6', () => {
    const map = blankMapData(5, 4, 2);
    expect(map.data).toHaveLength(5 * 4 * 6);
    expect(map.data.every((t) => t === 0)).toBe(true);
    expect(map.tilesetId).toBe(2);
    expect(map.events).toEqual([]);
  });
});
