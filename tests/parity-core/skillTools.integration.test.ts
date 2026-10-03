import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSkill,
  createDamageSkill,
  createHealingSkill,
  getSkills,
  defaultSkillHitType,
  skillToolDefinitions,
} from '../../src/parity/tools/skillTools.js';
import { ToolContext } from '../../src/parity/registry.js';

const createSkillTool = skillToolDefinitions.find((t) => t.name === 'create_skill')!;

async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-skill-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  for (const file of ['Skills.json', 'States.json', 'CommonEvents.json']) {
    await writeFile(join(dir, 'data', file), JSON.stringify([null]));
  }
  return dir;
}

describe('create_skill (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips every field, including zeros', async () => {
    const input = {
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
    const created = await createSkillTool.handler({ projectPath: dir } as ToolContext, input);
    expect(created).toMatchObject(input);
    expect((await getSkills(dir))[1]).toMatchObject(input);
  });

  it('advertises every round-tripped field in its schema', () => {
    const keys = Object.keys(createSkillTool.inputSchema);
    for (const field of [
      'occasion',
      'hitType',
      'speed',
      'repeats',
      'successRate',
      'tpGain',
      'requiredWtypeId1',
      'requiredWtypeId2',
      'message2',
      'note',
    ]) {
      expect(keys).toContain(field);
    }
  });

  it('keeps the new-skill defaults when fields are omitted', async () => {
    const skill = await createSkill(dir, { name: 'Plain' });
    expect(skill).toMatchObject({
      iconIndex: 64,
      stypeId: 1,
      scope: 1,
      occasion: 1,
      speed: 0,
      successRate: 100,
      repeats: 1,
      tpGain: 0,
      message2: '',
      note: '',
      requiredWtypeId1: 0,
      requiredWtypeId2: 0,
    });
  });

  it('makes a damaging spell a magical hit, not a physical one', async () => {
    const fire = await createDamageSkill(dir, 'Fire', 'a.mat * 4', 5, 1, 2);
    expect(fire.hitType).toBe(2);
  });

  it('makes a heal a certain hit', async () => {
    const heal = await createHealingSkill(dir, 'Heal', 'a.mat * 3', 5, 7);
    expect(heal.hitType).toBe(0);
  });
});

describe('defaultSkillHitType', () => {
  it('derives from the skill type, scope and damage', () => {
    expect(defaultSkillHitType(1, 1, 1)).toBe(2); // magic damage → magical
    expect(defaultSkillHitType(2, 1, 1)).toBe(1); // special damage → physical
    expect(defaultSkillHitType(0, 1, 1)).toBe(1); // no-type damage → physical
    expect(defaultSkillHitType(1, 1, 0)).toBe(2); // magic state/debuff → magical
    expect(defaultSkillHitType(2, 1, 0)).toBe(0); // special, no damage → certain
    expect(defaultSkillHitType(1, 7, 3)).toBe(0); // heal → certain
    expect(defaultSkillHitType(1, 11, 0)).toBe(0); // self buff → certain
  });
});
