import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { firstMissingEffectRef, firstMissingEnemyRef } from '../../src/parity/validation/createRefs.js';
import { createStateSkill, createSkill } from '../../src/parity/tools/skillTools.js';
import { createItem } from '../../src/parity/tools/itemTools.js';
import { createEnemy } from '../../src/parity/tools/battleTools.js';
import { Effect } from '../../src/parity/utils/types.js';

const eff = (code: number, dataId: number): Effect => ({ code, dataId, value1: 0, value2: 0 });

describe('firstMissingEffectRef (pure)', () => {
  // 1-indexed arrays: slot 0 null, ids 1..n live.
  const targets = { states: [null, {}], skills: [null, {}, {}], commonEvents: [null, {}] };

  it('returns null for undefined / empty effects', () => {
    expect(firstMissingEffectRef(undefined, targets)).toBeNull();
    expect(firstMissingEffectRef([], targets)).toBeNull();
  });

  it('flags an Add State (21) effect referencing a missing state', () => {
    expect(firstMissingEffectRef([eff(21, 999)], targets)).toMatch(/adds state 999/);
  });

  it('flags a Remove State (22) effect referencing a missing state', () => {
    expect(firstMissingEffectRef([eff(22, 5)], targets)).toMatch(/removes state 5/);
  });

  it('accepts an Add State effect referencing an existing state', () => {
    expect(firstMissingEffectRef([eff(21, 1)], targets)).toBeNull();
  });

  it('skips dataId 0 (the normal-attack-states sentinel)', () => {
    expect(firstMissingEffectRef([eff(21, 0)], targets)).toBeNull();
  });

  it('flags Learn Skill (43) and Common Event (44) refs', () => {
    expect(firstMissingEffectRef([eff(43, 99)], targets)).toMatch(/Learn Skill.*skill 99/);
    expect(firstMissingEffectRef([eff(44, 99)], targets)).toMatch(/Common Event.*common event 99/);
  });

  it('ignores buff/debuff codes (31/32) — dataId is a param index, not a db id', () => {
    expect(firstMissingEffectRef([eff(31, 999)], targets)).toBeNull();
    expect(firstMissingEffectRef([eff(32, 999)], targets)).toBeNull();
  });

  it('skips a check when the target array is empty (can not verify)', () => {
    expect(firstMissingEffectRef([eff(21, 999)], { ...targets, states: [] })).toBeNull();
  });
});

describe('firstMissingEnemyRef (pure)', () => {
  const targets = {
    skills: [null, {}],
    items: [null, {}],
    weapons: [null, {}],
    armors: [null, {}],
  };

  it('flags an action referencing a missing skill', () => {
    expect(firstMissingEnemyRef({ actions: [{ skillId: 99 }] }, targets)).toMatch(
      /action 0 uses skill 99/,
    );
  });

  it('flags a drop referencing a missing item/weapon/armor by kind', () => {
    expect(firstMissingEnemyRef({ dropItems: [{ kind: 1, dataId: 9 }] }, targets)).toMatch(
      /item 9/,
    );
    expect(firstMissingEnemyRef({ dropItems: [{ kind: 2, dataId: 9 }] }, targets)).toMatch(
      /weapon 9/,
    );
    expect(firstMissingEnemyRef({ dropItems: [{ kind: 3, dataId: 9 }] }, targets)).toMatch(
      /armor 9/,
    );
  });

  it('ignores kind-0 drop slots (no drop)', () => {
    expect(firstMissingEnemyRef({ dropItems: [{ kind: 0, dataId: 9 }] }, targets)).toBeNull();
  });

  it('accepts actions/drops that all resolve', () => {
    expect(
      firstMissingEnemyRef(
        { actions: [{ skillId: 1 }], dropItems: [{ kind: 1, dataId: 1 }] },
        targets,
      ),
    ).toBeNull();
  });

  it('skips the skill check when Skills.json is empty', () => {
    expect(
      firstMissingEnemyRef({ actions: [{ skillId: 99 }] }, { ...targets, skills: [] }),
    ).toBeNull();
  });
});

/** Minimal project seeded with the db files the create-time checks consult. */
async function scaffold(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-createrefs-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, 'data', name), JSON.stringify(data));
  }
  return dir;
}

describe('create-time reference throws (integration)', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('create_state_skill throws on a non-existent stateId, and accepts a real one', async () => {
    dir = await scaffold({
      'Skills.json': [null],
      'States.json': [null, { id: 1, name: 'Poison' }],
      'CommonEvents.json': [null],
    });
    await expect(createStateSkill(dir, 'Venom', 999, 0.5, 5, 1)).rejects.toThrow(/state 999/);
    const ok = await createStateSkill(dir, 'Venom', 1, 0.5, 5, 1);
    expect(ok.effects[0]).toMatchObject({ code: 21, dataId: 1 });
  });

  it('create_skill throws on a Learn Skill effect pointing at a missing skill', async () => {
    dir = await scaffold({
      'Skills.json': [null, { id: 1, name: 'Attack' }],
      'States.json': [null],
      'CommonEvents.json': [null],
    });
    await expect(createSkill(dir, { name: 'Teach', effects: [eff(43, 42)] })).rejects.toThrow(
      /skill 42/,
    );
  });

  it('create_item throws on an Add State effect pointing at a missing state', async () => {
    dir = await scaffold({
      'Items.json': [null],
      'Skills.json': [null],
      'States.json': [null, { id: 1, name: 'Poison' }],
      'CommonEvents.json': [null],
    });
    await expect(createItem(dir, { name: 'Bad Potion', effects: [eff(21, 7)] })).rejects.toThrow(
      /state 7/,
    );
  });

  it('create_enemy throws on an action skillId / drop dataId that does not exist', async () => {
    dir = await scaffold({
      'Enemies.json': [null],
      'Skills.json': [null, { id: 1, name: 'Attack' }],
      'Items.json': [null],
      'Weapons.json': [null],
      'Armors.json': [null],
    });
    await expect(
      createEnemy(dir, {
        name: 'Wisp',
        actions: [
          { conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 99 },
        ],
      }),
    ).rejects.toThrow(/skill 99/);
    await expect(
      createEnemy(dir, { name: 'Chest', dropItems: [{ kind: 1, dataId: 5, denominator: 1 }] }),
    ).rejects.toThrow(/item 5/);
    // A clean enemy (default action skillId 1 exists, default drops kind 0) is fine.
    const ok = await createEnemy(dir, { name: 'Slime' });
    expect(ok.id).toBe(1);
  });
});
