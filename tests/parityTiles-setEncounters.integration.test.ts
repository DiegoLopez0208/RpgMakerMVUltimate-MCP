// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import { setEncounters, getMap, blankMapData, mapToolDefinitions } from '../src/parity/tools/mapTools.js';

/** Scaffold a minimal project with Map001.json + a seeded Troops.json. */
async function scaffold(troopCount: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-encounters-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(blankMapData(17, 13, 1)));
  // 1-indexed Troops.json: slot 0 null, ids 1..troopCount live.
  const troops = [
    null,
    ...Array.from({ length: troopCount }, (_, i) => ({ id: i + 1, name: `T${i + 1}` })),
  ];
  await writeFile(join(dir, 'data', 'Troops.json'), JSON.stringify(troops));
  return dir;
}

describe('setEncounters (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffold(2);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the encounter list with defaults and updates encounterStep', async () => {
    const result = await setEncounters(dir, 1, [{ troopId: 1 }, { troopId: 2, weight: 10 }], 25);
    expect(result.encounterList).toEqual([
      { troopId: 1, weight: 5, regionSet: [] },
      { troopId: 2, weight: 10, regionSet: [] },
    ]);
    expect(result.encounterStep).toBe(25);

    const map = await getMap(dir, 1);
    expect(map.encounterList).toHaveLength(2);
    expect(map.encounterStep).toBe(25);
  });

  it('preserves the existing encounterStep when omitted', async () => {
    const before = (await getMap(dir, 1)).encounterStep;
    const result = await setEncounters(dir, 1, [{ troopId: 1, regionSet: [3, 4] }]);
    expect(result.encounterStep).toBe(before);
    expect(result.encounterList[0].regionSet).toEqual([3, 4]);
  });

  it('replaces the list wholesale on a second call', async () => {
    await setEncounters(dir, 1, [{ troopId: 1 }, { troopId: 2 }]);
    const result = await setEncounters(dir, 1, [{ troopId: 2 }]);
    expect(result.encounterList).toEqual([{ troopId: 2, weight: 5, regionSet: [] }]);
  });

  it('throws when a troopId does not exist', async () => {
    await expect(setEncounters(dir, 1, [{ troopId: 99 }])).rejects.toThrow(/troopId 99/);
    // The failed troop is reported by its index in the list.
    await expect(setEncounters(dir, 1, [{ troopId: 1 }, { troopId: 99 }])).rejects.toThrow(
      /Encounter 1/,
    );
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await setEncounters(dir, 1, [{ troopId: 1 }]);
    });
    expect(context.commits.some((c) => c.path.endsWith('Map001.json'))).toBe(true);
    expect((await getMap(dir, 1)).encounterList).toHaveLength(0);
  });

  it('the set_encounters tool is registered and mutating', () => {
    const def = mapToolDefinitions.find((t) => t.name === 'set_encounters')!;
    expect(def).toBeDefined();
    expect(def.mutates).toBe(true);
  });
});
