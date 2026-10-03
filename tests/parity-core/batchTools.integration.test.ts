import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { batchToolDefinitions } from '../../src/parity/tools/batchTools.js';
import { getActors } from '../../src/parity/tools/actorTools.js';
import { getItems } from '../../src/parity/tools/itemTools.js';
import { getEnemies } from '../../src/parity/tools/battleTools.js';
import { getClasses, defaultClass } from '../../src/parity/tools/classTools.js';
import { getSkills } from '../../src/parity/tools/skillTools.js';
import { CommitContext, commitStore } from '../../src/parity/utils/commit.js';
import { ToolContext } from '../../src/parity/registry.js';

const batchCreate = batchToolDefinitions.find((t) => t.name === 'batch_create')!;

interface BatchResponse {
  type: string;
  count: number;
  created: Record<string, unknown>[];
  warnings?: { path: string; message: string }[];
}

/** Run the batch_create tool the way the server would. */
async function run(dir: string, args: Record<string, unknown>): Promise<BatchResponse> {
  return (await batchCreate.handler({ projectPath: dir } as ToolContext, args)) as BatchResponse;
}

/** Scaffold a minimal project with the 1-indexed (slot-0-null) db arrays. */
async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-batch-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  for (const file of [
    'Actors.json',
    'Items.json',
    'Weapons.json',
    'Armors.json',
    'Skills.json',
    'Enemies.json',
    'States.json',
    'Classes.json',
    'CommonEvents.json',
  ]) {
    await writeFile(join(dir, 'data', file), JSON.stringify([null]));
  }
  await writeFile(join(dir, 'data', 'Classes.json'), JSON.stringify([null, {id:1, ...defaultClass(), name:'Default'}]));
  return dir;
}

describe('batch_create (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a cast of actors with sequential ids', async () => {
    const result = await run(dir, {
      type: 'actor',
      records: [{ name: 'Reid' }, { name: 'Marle' }, { name: 'Lucca' }],
    });

    expect(result.type).toBe('actor');
    expect(result.count).toBe(3);
    expect(result.created.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(result.created.map((a) => a.name)).toEqual(['Reid', 'Marle', 'Lucca']);

    const actors = await getActors(dir);
    expect(actors.filter(Boolean)).toHaveLength(3);
    // Every record still gets the full new-actor template (the engine crashes on
    // a partial actor), not just the fields passed.
    expect(actors[1]!.equips).toEqual([0, 0, 0, 0, 0]);
    expect(actors[1]!.traits).toEqual([]);
  });

  it('continues id allocation from the existing max', async () => {
    await run(dir, { type: 'actor', records: [{ name: 'First' }] });
    const result = await run(dir, { type: 'actor', records: [{ name: 'Second' }] });
    expect(result.created[0].id).toBe(2);
  });

  it('writes the whole batch in a single file write', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await run(dir, {
        type: 'actor',
        records: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      });
    });

    // The point of the batch tool: N records, one write (not one per record).
    const writes = context.commits.filter((c) => c.path.endsWith('Actors.json'));
    expect(writes).toHaveLength(1);
    // ...and dry-run touched nothing on disk.
    expect(await getActors(dir)).toEqual([null]);
  });

  it('rejects the whole batch when a record has a dangling reference', async () => {
    await expect(
      run(dir, {
        type: 'item',
        records: [
          { name: 'Potion' },
          // Effect code 21 = Add State, pointing at a state that doesn't exist.
          { name: 'Cursed Brew', effects: [{ code: 21, dataId: 99, value1: 1, value2: 0 }] },
        ],
      }),
    ).rejects.toThrow(/records\[1\]/);

    // Nothing was written — not even the valid record that preceded it.
    expect(await getItems(dir)).toEqual([null]);
  });

  it('resolves a reference to a sibling created earlier in the same batch', async () => {
    const result = await run(dir, {
      type: 'skill',
      records: [
        { name: 'Fire' },
        // Effect code 43 = Learn Skill, pointing at the skill built just above.
        { name: 'Tome of Fire', effects: [{ code: 43, dataId: 1, value1: 0, value2: 0 }] },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.created[1]).toMatchObject({ effects: [{ code: 43, dataId: 1 }] });
  });

  it('round-trips every skill field (no silent drops, 0 is a real value)', async () => {
    const record = {
      name: 'Tail Swipe',
      occasion: 0,
      hitType: 2,
      repeats: 2,
      speed: 100,
      stypeId: 0,
      iconIndex: 0,
      successRate: 90,
      tpGain: 5,
      requiredWtypeId1: 2,
      requiredWtypeId2: 3,
      message2: 'It lashes out!',
      note: '<Tag>',
    };
    const result = await run(dir, { type: 'skill', records: [record] });
    expect(result.warnings).toBeUndefined();
    expect(result.created[0]).toMatchObject(record);
    expect((await getSkills(dir))[1]).toMatchObject(record);
  });

  it('warns (never blocks) on record fields the create_* tool does not accept', async () => {
    const result = await run(dir, {
      type: 'skill',
      records: [{ name: 'Ok' }, { name: 'Typo', hitTyp: 2, bogus: 1 }],
    });
    expect(result.count).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]!.path).toBe('records[1]');
    expect(result.warnings![0]!.message).toMatch(/"hitTyp", "bogus".*create_skill/);
  });

  it('surfaces enemy battler warnings tagged by record index', async () => {
    // An enemies asset dir with a file in it, so the check has something to
    // validate against (an empty dir is skipped to avoid false positives).
    await mkdir(join(dir, 'img', 'enemies'), { recursive: true });
    await writeFile(join(dir, 'img', 'enemies', 'Slime.png'), '');
    // defaultEnemy() ships one action using skill 1, so the reference check
    // needs that skill to exist.
    await writeFile(
      join(dir, 'data', 'Skills.json'),
      JSON.stringify([null, { id: 1, name: 'Attack', effects: [] }]),
    );

    const result = await run(dir, {
      type: 'enemy',
      records: [
        { name: 'Slime', battlerName: 'Slime' },
        { name: 'Ghost', battlerName: 'Nope' },
      ],
    });

    expect(result.count).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('records[1].battlerName');
    // Warn-by-default: the enemy is still created.
    expect((await getEnemies(dir)).filter(Boolean)).toHaveLength(2);
  });

  it('summarizes classes instead of echoing the param matrix', async () => {
    const result = await run(dir, {
      type: 'class',
      records: [{ name: 'Warrior', maxLevel: 50 }],
    });

    expect(result.created[0].params).toBeUndefined();
    expect(result.created[0].maxLevel).toBe(50);
    // The on-disk record still carries the full 8×(maxLevel+1) matrix.
    const classes = await getClasses(dir);
    expect(classes[Number(result.created[0].id)]!.params).toHaveLength(8);
    expect(classes[Number(result.created[0].id)]!.params[0]).toHaveLength(51);
  });
});
