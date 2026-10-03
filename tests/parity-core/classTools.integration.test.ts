import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../../src/parity/utils/commit.js';
import {
  getClasses,
  createClass,
  updateClass,
  addClassLearning,
  setClassParamCurve,
  defaultClass,
  defaultClassParams,
  skillTypeTraitWarnings,
  classToolDefinitions,
} from '../../src/parity/tools/classTools.js';
import { listNames } from '../../src/parity/tools/listTools.js';
import { GameClass, Skill } from '../../src/parity/utils/types.js';

/** Scaffold a minimal project with seeded Classes.json and Skills.json. */
async function scaffoldProject(
  classes: (GameClass | null)[],
  skills: (Skill | null)[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-class-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Classes.json'), JSON.stringify(classes));
  await writeFile(join(dir, 'data', 'Skills.json'), JSON.stringify(skills));
  return dir;
}

const warrior: GameClass = { ...defaultClass(), id: 1, name: 'Warrior' };
const fireball = { id: 1, name: 'Fireball' } as Skill;

describe('class tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // 1-indexed arrays whose slot 0 is null.
    dir = await scaffoldProject([null, warrior], [null, fireball]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createClass assigns the next id, applies defaults, and persists compactly', async () => {
    const created = await createClass(dir, { name: 'Mage' });
    expect(created.id).toBe(2);
    expect(created.expParams).toEqual([30, 20, 30, 30]);
    expect(created.params).toHaveLength(8);
    expect(created.params[0]).toHaveLength(100); // maxLevel 99 + 1
    expect(created.learnings).toEqual([]);

    const classes = await getClasses(dir);
    expect(classes.find((c) => c?.id === 2)?.name).toBe('Mage');

    const raw = await readFile(join(dir, 'data', 'Classes.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createClass honors maxLevel and never lets a caller set the id', async () => {
    const created = await createClass(dir, {
      name: 'Rogue',
      maxLevel: 50,
      id: 99,
    } as Parameters<typeof createClass>[1] & { id: number });
    expect(created.id).toBe(2);
    expect(created.params[0]).toHaveLength(51);
  });

  it('updateClass merges, re-pins the id, and refuses an unknown id', async () => {
    const updated = await updateClass(dir, 1, { name: 'Paladin', id: 99 } as Partial<GameClass>);
    expect(updated.name).toBe('Paladin');
    expect(updated.id).toBe(1);
    await expect(updateClass(dir, 99, { name: 'X' })).rejects.toThrow(/not found/);
  });

  it('addClassLearning validates the skill, inserts sorted by level', async () => {
    await addClassLearning(dir, 1, 1, 10);
    const updated = await addClassLearning(dir, 1, 1, 3, 'early');
    expect(updated.learnings.map((l) => l.level)).toEqual([3, 10]);
    expect(updated.learnings[0]).toEqual({ level: 3, note: 'early', skillId: 1 });
  });

  it('addClassLearning rejects a non-existent skill and an unknown class', async () => {
    await expect(addClassLearning(dir, 1, 99, 5)).rejects.toThrow(/skillId 99/);
    await expect(addClassLearning(dir, 99, 1, 5)).rejects.toThrow(/not found/);
  });

  it('setClassParamCurve replaces one row and enforces length + paramId range', async () => {
    const curve = defaultClassParams(99)[0].map(() => 777);
    const updated = await setClassParamCurve(dir, 1, 0, curve);
    expect(updated.params[0][5]).toBe(777);
    expect(updated.params[1][5]).toBe(warrior.params[1][5]); // other rows untouched

    await expect(setClassParamCurve(dir, 1, 0, [1, 2, 3])).rejects.toThrow(/must have 100 entries/);
    await expect(setClassParamCurve(dir, 1, 8, curve)).rejects.toThrow(/paramId must be 0-7/);
  });

  it('list_names indexes classes', async () => {
    const result = await listNames(dir, 'classes');
    expect(result.entries).toEqual([{ id: 1, name: 'Warrior' }]);
  });

  it('the create_class tool handler dispatches to createClass', async () => {
    const def = classToolDefinitions.find((t) => t.name === 'create_class')!;
    expect(def.mutates).toBe(true);
    const result = (await def.handler({ projectPath: dir }, { name: 'ViaTool' })) as GameClass;
    expect(result.id).toBe(2);
  });

  it('class-mutation handlers return a compact params summary, not the full matrix', async () => {
    const def = classToolDefinitions.find((t) => t.name === 'create_class')!;
    const result = (await def.handler({ projectPath: dir }, { name: 'Compact' })) as {
      id: number;
      params?: unknown;
      maxLevel: number;
      paramCurves: { param: string; atLevel1: number; atMaxLevel: number }[];
    };
    // The full 8×(maxLevel+1) matrix must NOT be echoed.
    expect(result.params).toBeUndefined();
    expect(result.maxLevel).toBe(99);
    expect(result.paramCurves).toHaveLength(8);
    expect(result.paramCurves[0]).toMatchObject({ param: 'maxHP' });
    // But the on-disk write still carries the full matrix.
    const onDisk = (await getClasses(dir)).find((c) => c?.id === result.id)!;
    expect(onDisk.params[0]).toHaveLength(100);
  });

  it('add_class_learning warns when the skill type has no Add Skill Type (41) trait', async () => {
    // Re-seed the lone skill with a skill type so coverage matters.
    await writeFile(
      join(dir, 'data', 'Skills.json'),
      JSON.stringify([null, { ...fireball, stypeId: 1 }]),
    );
    const def = classToolDefinitions.find((t) => t.name === 'add_class_learning')!;
    const warned = (await def.handler(
      { projectPath: dir },
      { classId: 1, skillId: 1, level: 1 },
    )) as {
      warnings?: { message: string }[];
    };
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings![0].message).toMatch(/code: 41, dataId: 1/);

    // Covering the type with a 41 trait silences the warning.
    await updateClass(dir, 1, { traits: [{ code: 41, dataId: 1, value: 1 }] });
    const clean = (await def.handler(
      { projectPath: dir },
      { classId: 1, skillId: 1, level: 3 },
    )) as {
      warnings?: unknown;
    };
    expect(clean.warnings).toBeUndefined();
  });

  it('skillTypeTraitWarnings aggregates per stypeId and skips typeless/unknown skills', () => {
    const skills = [
      null,
      { id: 1, name: 'Heal', stypeId: 1 },
      { id: 2, name: 'Cure', stypeId: 1 },
      { id: 3, name: 'Bash', stypeId: 2 },
      { id: 4, name: 'Attack', stypeId: 0 },
    ] as (Skill | null)[];
    const klass: GameClass = {
      ...defaultClass(),
      id: 9,
      name: 'Cleric',
      traits: [{ code: 41, dataId: 2, value: 1 }],
      learnings: [
        { level: 1, skillId: 1, note: '' },
        { level: 2, skillId: 2, note: '' },
        { level: 3, skillId: 3, note: '' }, // covered by the 41/2 trait
        { level: 4, skillId: 4, note: '' }, // stypeId 0 — no command needed
        { level: 5, skillId: 99, note: '' }, // unknown skill — not this check's job
      ],
    };
    const warnings = skillTypeTraitWarnings(klass, skills);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/Heal, Cure/);
    expect(warnings[0].message).toMatch(/dataId: 1/);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await createClass(dir, { name: 'Preview' });
    });
    expect(context.commits.some((c) => c.path.endsWith('Classes.json'))).toBe(true);
    const classes = await getClasses(dir);
    expect(classes.every((c) => c == null || c.name !== 'Preview')).toBe(true);
  });
});

describe('class templates', () => {
  it('defaultClass has the editor EXP curve and an 8-row param matrix', () => {
    const c = defaultClass();
    expect(c.expParams).toEqual([30, 20, 30, 30]);
    expect(c.params).toHaveLength(8);
    expect(c.traits).toEqual([]);
    expect(c.learnings).toEqual([]);
  });

  it('defaultClassParams sizes to maxLevel+1 and grows monotonically', () => {
    const params = defaultClassParams(20);
    expect(params[0]).toHaveLength(21);
    expect(params[0][1]).toBe(500);
    expect(params[0][2]).toBeGreaterThan(params[0][1]);
  });
});
