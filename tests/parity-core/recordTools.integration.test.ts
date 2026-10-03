import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deleteRecord,
  resetTable,
  danglingAfterRemoval,
  recordToolDefinitions,
} from '../../src/parity/tools/recordTools.js';
import { CommitContext, commitStore } from '../../src/parity/utils/commit.js';
import { ProjectData } from '../../src/parity/validation/references.js';

const END = { code: 0, indent: 0, parameters: [] };

/**
 * A small project where things point at each other: actor 1 → class 1, troop 1
 * → enemy 2, a map event giving item 2 and fighting troop 1, a map encounter
 * with troop 1, and skill 3 learned by class 1.
 */
async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-records-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  const files: Record<string, unknown> = {
    'System.json': { partyMembers: [1] },
    'MapInfos.json': [null, { id: 1, name: 'Town', parentId: 0 }],
    'Map001.json': {
      width: 5,
      height: 5,
      data: [],
      encounterList: [{ troopId: 1, weight: 5, regionSet: [] }],
      events: [
        null,
        {
          id: 1,
          name: 'Giver',
          pages: [
            {
              list: [
                { code: 126, indent: 0, parameters: [2, 0, 0, 1] },
                { code: 301, indent: 0, parameters: [0, 1, false, false] },
                END,
              ],
            },
          ],
        },
      ],
    },
    'Actors.json': [null, { id: 1, name: 'Hero', classId: 1 }],
    'Classes.json': [null, { id: 1, name: 'Warrior', learnings: [{ level: 1, skillId: 3 }] }],
    'Skills.json': [
      null,
      { id: 1, name: 'Attack', effects: [] },
      { id: 2, name: 'Guard', effects: [] },
      { id: 3, name: 'Slash', effects: [] },
      { id: 4, name: 'Spare', effects: [] },
    ],
    'Items.json': [
      null,
      { id: 1, name: 'Potion', effects: [] },
      { id: 2, name: 'Key', effects: [] },
      { id: 3, name: 'Junk', effects: [] },
    ],
    'Enemies.json': [
      null,
      { id: 1, name: 'Slime', actions: [], dropItems: [] },
      { id: 2, name: 'Bat', actions: [], dropItems: [] },
    ],
    'Troops.json': [null, { id: 1, name: 'Bat*1', members: [{ enemyId: 2 }], pages: [] }],
    'States.json': [null, { id: 1, name: 'Knockout' }],
    'CommonEvents.json': [null],
  };
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, 'data', name), JSON.stringify(data));
  }
  return dir;
}

async function readData(dir: string, file: string): Promise<unknown[]> {
  return JSON.parse(await readFile(join(dir, 'data', file), 'utf-8'));
}

describe('delete_record', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('nulls an unreferenced slot without shifting later ids', async () => {
    const result = await deleteRecord(dir, 'item', 1);
    expect(result.deleted).toEqual({ id: 1, name: 'Potion' });
    expect(result.referenceCount).toBe(0);
    const items = await readData(dir, 'Items.json');
    expect(items).toHaveLength(4);
    expect(items[1]).toBeNull();
    expect(items[2]).toMatchObject({ id: 2, name: 'Key' });
  });

  it('refuses a referenced record, naming the references, and writes nothing', async () => {
    await expect(deleteRecord(dir, 'item', 2)).rejects.toThrow(
      /Refusing to delete item 2 \(Key\).*map 1 \/ event 1 \/ page 0 \/ command 0.*force: true/s,
    );
    expect((await readData(dir, 'Items.json'))[2]).not.toBeNull();
  });

  it('deletes a referenced record with force and reports what dangles', async () => {
    const result = await deleteRecord(dir, 'troop', 1, true);
    const paths = result.references.map((r) => r.path);
    expect(paths).toContain('map 1 / event 1 / page 0 / command 1'); // Battle Processing
    expect(paths).toContain('map 1 / encounterList[0]');
    expect(result.requiresForce).toBeUndefined();
    expect((await readData(dir, 'Troops.json'))[1]).toBeNull();
  });

  it('reports actor/class/skill/enemy references from the database itself', async () => {
    const enemy = await deleteRecord(dir, 'enemy', 2, true);
    expect(enemy.references).toContainEqual(
      expect.objectContaining({ category: 'troop-member', path: 'troop 1 / members[0]' }),
    );
    const cls = await deleteRecord(dir, 'class', 1, true);
    expect(cls.references).toContainEqual(expect.objectContaining({ path: 'actor 1 / classId' }));
    const actor = await deleteRecord(dir, 'actor', 1, true);
    expect(actor.references).toContainEqual(
      expect.objectContaining({ path: 'System.partyMembers[0]' }),
    );
  });

  it('flags the engine-reserved Attack skill', async () => {
    await expect(deleteRecord(dir, 'skill', 1)).rejects.toThrow(/attackSkillId/);
  });

  it('throws for a missing record', async () => {
    await expect(deleteRecord(dir, 'item', 9)).rejects.toThrow(/item 9 does not exist/);
  });

  it('does not throw in a dry-run; reports requiresForce and writes nothing', async () => {
    const ctx: CommitContext = { dryRun: true, commits: [] };
    const result = await commitStore.run(ctx, () => deleteRecord(dir, 'item', 2));
    expect(result.requiresForce).toBe(true);
    expect(result.referenceCount).toBe(1);
    expect(ctx.commits).toHaveLength(1);
    expect((await readData(dir, 'Items.json'))[2]).not.toBeNull();
  });
});

describe('reset_table', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the listed ids in place and trims trailing nulls', async () => {
    const result = await resetTable(dir, 'skill', [1, 2], true);
    expect(result.kept.map((k) => k.id)).toEqual([1, 2]);
    expect(result.removed.map((r) => r.id)).toEqual([3, 4]);
    // Slash is learned by class 1; Spare is referenced by nothing.
    expect(result.references.map((r) => r.path)).toEqual(['class 1 / learnings[0]']);
    const skills = await readData(dir, 'Skills.json');
    expect(skills).toHaveLength(3);
    expect(skills[2]).toMatchObject({ id: 2, name: 'Guard' });
  });

  it('keeps a non-leading id at its own index', async () => {
    await resetTable(dir, 'item', [3], true);
    expect(await readData(dir, 'Items.json')).toEqual([
      null,
      null,
      null,
      { id: 3, name: 'Junk', effects: [] },
    ]);
  });

  it('empties the table to [null] with no keep', async () => {
    await resetTable(dir, 'common_event');
    await resetTable(dir, 'state', [], true);
    expect(await readData(dir, 'States.json')).toEqual([null]);
  });

  it('refuses when references would dangle, and previews in a dry-run', async () => {
    await expect(resetTable(dir, 'item')).rejects.toThrow(/Refusing to reset Items\.json/);
    const ctx: CommitContext = { dryRun: true, commits: [] };
    const preview = await commitStore.run(ctx, () => resetTable(dir, 'item'));
    expect(preview.removedCount).toBe(3);
    expect(preview.requiresForce).toBe(true);
    expect((await readData(dir, 'Items.json')).length).toBe(4);
  });

  it('rejects a keep id that does not exist', async () => {
    await expect(resetTable(dir, 'skill', [1, 42])).rejects.toThrow(/42/);
  });
});

describe('danglingAfterRemoval', () => {
  it('ignores references that were already broken', () => {
    const data = {
      mapInfos: [],
      maps: [],
      actors: [null, { id: 1, name: 'A', classId: 7 }],
      classes: [null, { id: 1, name: 'C', learnings: [] }],
      skills: [],
      items: [],
      weapons: [],
      armors: [],
      enemies: [],
      troops: [],
      states: [],
      commonEvents: [],
      animations: null,
      system: null,
    } as unknown as ProjectData;
    // actor 1 → class 7 is already dangling; removing class 1 breaks nothing new.
    expect(danglingAfterRemoval(data, 'class', [1])).toEqual([]);
  });
});

describe('record tool definitions', () => {
  it('are mutating and forceable', () => {
    for (const name of ['delete_record', 'reset_table']) {
      const def = recordToolDefinitions.find((d) => d.name === name)!;
      expect(def.mutates).toBe(true);
      expect(def.forceable).toBe(true);
    }
  });
});
