import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSkillRecord, createSkill, updateSkill, skillToolDefinitions } from '../src/parity/tools/skillTools.js';
import { buildItemRecord, createItem, updateItem, updateSkill as updateSkillViaItems, itemToolDefinitions } from '../src/parity/tools/itemTools.js';
import { createSkill as createLegacySkill, updateSkill as updateLegacySkill } from '../src/tools/skillTools.js';
import { createItem as createLegacyItem, updateItem as updateLegacyItem } from '../src/tools/itemTools.js';
import { batchToolDefinitions } from '../src/parity/tools/batchTools.js';
import { commitStore } from '../src/parity/utils/commit.js';

let project: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'mv-action-scope-'));
  await mkdir(join(project, 'data'));
  await writeFile(join(project, 'data/Skills.json'), JSON.stringify([null, buildSkillRecord([], { name: 'Skill', scope: 7 })]));
  await writeFile(join(project, 'data/Items.json'), JSON.stringify([null, buildItemRecord([], { name: 'Item', scope: 7 })]));
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

describe('MV skill/item scopes', () => {
  it.each([12, 13, 14, -1, 1.5])('rejects unsupported scope %s in pure builders', scope => {
    expect(() => buildSkillRecord([], { name: 'Bad', scope })).toThrow(/scope/i);
    expect(() => buildItemRecord([], { name: 'Bad', scope })).toThrow(/scope/i);
  });

  it.each([12, 13, 14])('rejects scope %s in direct creates, passthrough updates and batches with no writes', async scope => {
    const skillsBefore = await readFile(join(project, 'data/Skills.json'), 'utf8');
    const itemsBefore = await readFile(join(project, 'data/Items.json'), 'utf8');
    const attempts = [
      () => createSkill(project, { name: 'Bad', scope }),
      () => createItem(project, { name: 'Bad', scope }),
      () => updateSkill(project, 1, { scope }),
      () => updateSkillViaItems(project, 1, { scope }),
      () => updateItem(project, 1, { scope }),
      () => createLegacySkill(project, { name: 'Bad', scope }),
      () => createLegacyItem(project, { name: 'Bad', scope }),
      () => updateLegacySkill(project, 1, { scope }),
      () => updateLegacyItem(project, 1, 'item', { scope }),
      ...['skill', 'item'].map(type => () => batchToolDefinitions[0].handler({ projectPath: project }, { type, records: [{ name: 'Valid', scope: 11 }, { name: 'Bad', scope }] })),
    ];
    const context = { dryRun: false, commits: [] };
    await commitStore.run(context, async () => {
      for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/scope/i);
    });
    expect(context.commits).toEqual([]);
    expect(await readFile(join(project, 'data/Skills.json'), 'utf8')).toBe(skillsBefore);
    expect(await readFile(join(project, 'data/Items.json'), 'utf8')).toBe(itemsBefore);
  });

  it.each([0, 7, 8, 11])('preserves valid MV scope %s through builders, updates and batch writes', async scope => {
    expect(buildSkillRecord([], { name: 'Valid', scope }).scope).toBe(scope);
    expect(buildItemRecord([], { name: 'Valid', scope }).scope).toBe(scope);
    expect((await updateSkill(project, 1, { scope })).scope).toBe(scope);
    expect((await updateItem(project, 1, { scope })).scope).toBe(scope);
    expect((await updateLegacySkill(project, 1, { scope })).scope).toBe(scope);
    expect((await updateLegacyItem(project, 1, 'item', { scope })).scope).toBe(scope);
    for (const type of ['skill', 'item']) {
      await batchToolDefinitions[0].handler({ projectPath: project }, { type, records: [{ name: 'Valid', scope }] });
      const table = JSON.parse(await readFile(join(project, 'data', type === 'skill' ? 'Skills.json' : 'Items.json'), 'utf8'));
      expect(table[2].scope).toBe(scope);
    }
  });

  it('advertises the MV scope limits and correct ally labels, retaining update extension fields', () => {
    const definitions = [...skillToolDefinitions, ...itemToolDefinitions];
    for (const definition of definitions.filter(tool => tool.inputSchema.scope)) {
      const schema = definition.inputSchema.scope;
      for (const scope of [12, 13, 14]) expect(schema.safeParse(scope).success, definition.name).toBe(false);
      for (const scope of [0, 7, 8, 11]) expect(schema.safeParse(scope).success, definition.name).toBe(true);
      expect(schema.description, definition.name).toContain('7=one ally');
      expect(schema.description, definition.name).toContain('8=all allies');
    }
    for (const name of ['update_skill', 'update_item']) {
      const schema = definitions.find(tool => tool.name === name)!.inputSchema.updates;
      expect(schema.parse({ scope: 11, customMetadata: 'retained' })).toEqual({ scope: 11, customMetadata: 'retained' });
      for (const scope of [12, 13, 14]) expect(schema.safeParse({ scope }).success, name).toBe(false);
    }
  });
});
