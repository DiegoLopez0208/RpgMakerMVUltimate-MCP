// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import {
  deleteMap,
  updateMapTree,
  getMapInfos,
  blankMapData,
  mapToolDefinitions,
} from '../src/parity/tools/mapTools.js';
import { MapInfo } from '../src/parity/utils/types.js';

function mapInfo(id: number, parentId: number, order = id): MapInfo {
  return {
    id,
    name: `MAP${String(id).padStart(3, '0')}`,
    parentId,
    order,
    expanded: false,
    scrollX: 0,
    scrollY: 0,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Scaffold a project with a seeded MapInfos.json plus a MapNNN.json per entry. */
async function scaffoldProject(infos: (MapInfo | null)[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-deletemap-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify(infos));
  for (const info of infos) {
    if (!info) continue;
    const name = `Map${String(info.id).padStart(3, '0')}.json`;
    await writeFile(join(dir, 'data', name), JSON.stringify(blankMapData(17, 13, 1)));
  }
  return dir;
}

describe('deleteMap (integration)', () => {
  let dir: string;

  // Tree: 1 (root) -> 2 (child) -> 3 (grandchild); 4 is a sibling of 2 under 1.
  beforeEach(async () => {
    dir = await scaffoldProject([null, mapInfo(1, 0), mapInfo(2, 1), mapInfo(3, 2), mapInfo(4, 1)]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the tree entry and deletes the map file', async () => {
    const result = await deleteMap(dir, 4);
    expect(result).toMatchObject({ mapId: 4, reparentedTo: 1, reparentedChildren: [] });

    const infos = await getMapInfos(dir);
    expect(infos[4]).toBeNull();
    expect(await exists(join(dir, 'data', 'Map004.json'))).toBe(false);
    // Untouched siblings survive.
    expect(infos[2]).not.toBeNull();
    expect(await exists(join(dir, 'data', 'Map002.json'))).toBe(true);
  });

  it('reparents children onto the deleted map’s parent instead of deleting them', async () => {
    // Delete map 2 (parent 1, child 3). Child 3 should move up to parent 1.
    const result = await deleteMap(dir, 2);
    expect(result.reparentedTo).toBe(1);
    expect(result.reparentedChildren).toEqual([3]);

    const infos = await getMapInfos(dir);
    expect(infos[2]).toBeNull();
    expect(infos[3]?.parentId).toBe(1);
    // The grandchild's own map file is left intact — only map 2 was deleted.
    expect(await exists(join(dir, 'data', 'Map003.json'))).toBe(true);
    expect(await exists(join(dir, 'data', 'Map002.json'))).toBe(false);
  });

  it('reparents a top-level map’s children to the top level', async () => {
    // Delete root map 1: its children (2, 4) become top-level (parentId 0).
    const result = await deleteMap(dir, 1);
    expect(result.reparentedTo).toBe(0);
    expect(result.reparentedChildren.sort()).toEqual([2, 4]);

    const infos = await getMapInfos(dir);
    expect(infos[2]?.parentId).toBe(0);
    expect(infos[4]?.parentId).toBe(0);
  });

  it('rejects deleting a non-existent map', async () => {
    await expect(deleteMap(dir, 99)).rejects.toThrow(/does not exist/);
  });

  it('dry-run previews the tree rewrite and the file deletion without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await deleteMap(dir, 2);
    });

    const byFile = new Map(context.commits.map((c) => [basename(c.path), c]));
    expect(byFile.get('MapInfos.json')?.changed).toBe(true);
    const del = byFile.get('Map002.json');
    expect(del?.deleted).toBe(true);
    expect(del?.changed).toBe(true);

    // Nothing was actually mutated.
    expect(await exists(join(dir, 'data', 'Map002.json'))).toBe(true);
    const infos = await getMapInfos(dir);
    expect(infos[2]).not.toBeNull();
  });

  it('the delete_map tool handler dispatches to deleteMap', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'delete_map')!;
    expect(def.mutates).toBe(true);
    const result = (await def.handler({ projectPath: dir }, { mapId: 4 })) as { mapId: number };
    expect(result.mapId).toBe(4);
  });
});

describe('updateMapTree (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject([null, mapInfo(1, 0), mapInfo(2, 1), mapInfo(3, 1)]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reparents, reorders, and renames in one batch', async () => {
    await updateMapTree(dir, [
      { mapId: 3, parentId: 2, order: 5 },
      { mapId: 2, name: 'Town' },
    ]);

    const infos = await getMapInfos(dir);
    expect(infos[3]?.parentId).toBe(2);
    expect(infos[3]?.order).toBe(5);
    expect(infos[2]?.name).toBe('Town');
    // Tiles/events aren't the tree's concern — no map file was rewritten.
  });

  it('can move a map to the top level (parentId 0)', async () => {
    await updateMapTree(dir, [{ mapId: 2, parentId: 0 }]);
    const infos = await getMapInfos(dir);
    expect(infos[2]?.parentId).toBe(0);
  });

  it('rejects a self-parenting update', async () => {
    await expect(updateMapTree(dir, [{ mapId: 2, parentId: 2 }])).rejects.toThrow(/its own parent/);
  });

  it('rejects a cycle (A under B, B under A)', async () => {
    // 2 is currently under 1; move 1 under 2 -> 1<->2 cycle.
    await expect(updateMapTree(dir, [{ mapId: 1, parentId: 2 }])).rejects.toThrow(/cycle/);
  });

  it('rejects a non-existent parent', async () => {
    await expect(updateMapTree(dir, [{ mapId: 2, parentId: 99 }])).rejects.toThrow(/parentId 99/);
  });

  it('rejects a non-existent target map', async () => {
    await expect(updateMapTree(dir, [{ mapId: 99, name: 'Ghost' }])).rejects.toThrow(
      /does not exist/,
    );
  });

  it('applies nothing when a later update in the batch is invalid', async () => {
    // First update is valid, second targets a missing map: the whole batch is
    // rejected up front, so the valid one must not land either.
    await expect(
      updateMapTree(dir, [
        { mapId: 2, name: 'Renamed' },
        { mapId: 99, name: 'Ghost' },
      ]),
    ).rejects.toThrow(/does not exist/);

    const infos = await getMapInfos(dir);
    expect(infos[2]?.name).toBe('MAP002');
  });
});
