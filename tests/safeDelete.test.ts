import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';
import { referencesTo } from '../src/intel/deleteGuard.js';

const dirs: string[] = [];
let project: string;
const write = (name: string, value: unknown) => writeFileSync(path.join(project, 'data', name), JSON.stringify(value));
const read = (name: string) => JSON.parse(readFileSync(path.join(project, 'data', name), 'utf8'));
const c = (code: number, parameters: unknown[] = [], indent = 0) => ({ code, indent, parameters });

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-safe-delete-'));
  dirs.push(project);
  mkdirSync(path.join(project, 'data'));
  write('System.json', { partyMembers: [1], switches: ['', ''], variables: ['', ''], startMapId: 1, startX: 0, startY: 0 });
  write('Actors.json', [null, { id: 1, name: 'Hero', classId: 1, equips: [1, 0, 1] }, { id: 2, name: 'Spare', classId: 1, equips: [0, 0, 0] }]);
  write('Classes.json', [null, { id: 1, name: 'Fighter', learnings: [{ level: 1, skillId: 3 }], traits: [] }, { id: 2, name: 'Unused', learnings: [], traits: [] }]);
  write('Skills.json', [null, { id: 1, name: 'Attack', effects: [] }, { id: 2, name: 'Guard', effects: [] }, { id: 3, name: 'Slash', animationId: 1, effects: [{ code: 21, dataId: 4 }] }, { id: 4, name: 'Unused', animationId: 0, effects: [] }]);
  write('Items.json', [null, { id: 1, name: 'Potion', effects: [] }, { id: 2, name: 'Ether', effects: [] }, { id: 3, name: 'Unused', effects: [] }]);
  write('Weapons.json', [null, { id: 1, name: 'Sword', traits: [] }, { id: 2, name: 'Unused', traits: [] }]);
  write('Armors.json', [null, { id: 1, name: 'Shield', traits: [] }]);
  write('Enemies.json', [null, { id: 1, name: 'Slime', actions: [{ skillId: 1 }], dropItems: [{ kind: 1, dataId: 2, denominator: 1 }], traits: [] }, { id: 2, name: 'Unused', actions: [], dropItems: [], traits: [] }]);
  write('States.json', [null, { id: 1, name: 'Knockout', traits: [] }, { id: 2, name: 'Unused', traits: [] }, { id: 3, name: 'Poison', traits: [] }, { id: 4, name: 'Stun', traits: [] }]);
  write('Troops.json', [null, { id: 1, name: 'Slimes', members: [{ enemyId: 1, x: 0, y: 0, hidden: false }], pages: [] }]);
  write('Animations.json', [null, { id: 1, name: 'Hit' }, { id: 2, name: 'Unused' }]);
  write('CommonEvents.json', [null]);
  write('MapInfos.json', [null, { id: 1, name: 'Town', parentId: 0, order: 1 }]);
  // A chest that gives a Potion, on map 1.
  write('Map001.json', { width: 5, height: 5, data: new Array(150).fill(0), encounterList: [], events: [null, {
    id: 1, name: 'Chest', x: 1, y: 1, pages: [{ conditions: {}, list: [c(126, [1, 0, 0, 1]), c(0)] }],
  }] });
  initProjectPath(project);
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('reference-aware delete_database_entry', () => {
  it.each([
    ['items', 1, /Chest/],
    ['items', 2, /Enemy 1 "Slime" drops/],
    ['actors', 1, /System starting party/],
    ['classes', 1, /Actor 1 "Hero" class/],
    ['skills', 3, /Class 1 "Fighter" learnings/],
    ['states', 4, /Skill 3 "Slash" effect/],
    ['enemies', 1, /Troop 1 "Slimes" members/],
    ['animations', 1, /Skill 3 "Slash" animation/],
    ['weapons', 1, /Actor 1 "Hero" starting equipment/],
    ['armors', 1, /Actor 1 "Hero" starting equipment/],
  ])('refuses to delete %s %i while it is referenced, and leaves the file untouched', async (entity, id, where) => {
    const file = { items: 'Items.json', actors: 'Actors.json', classes: 'Classes.json', skills: 'Skills.json', states: 'States.json', enemies: 'Enemies.json', animations: 'Animations.json', weapons: 'Weapons.json', armors: 'Armors.json' }[entity]!;
    const before = readFileSync(path.join(project, 'data', file), 'utf8');
    await expect(dispatchTool('delete_database_entry', { entity, id })).rejects.toThrow(where);
    expect(readFileSync(path.join(project, 'data', file), 'utf8')).toBe(before);
  });

  it('deletes an unreferenced entry exactly as before', async () => {
    const result = await dispatchTool('delete_database_entry', { entity: 'items', id: 3 }) as Record<string, unknown>;
    expect(result).not.toHaveProperty('brokenReferences');
    expect(read('Items.json')[3]).toBeNull();
  });

  it('previews the references with dryRun and writes nothing', async () => {
    const result = await dispatchTool('delete_database_entry', { entity: 'enemies', id: 1, dryRun: true }) as { dryRun: boolean; result: { brokenReferences: string[] } };
    expect(result.dryRun).toBe(true);
    expect(result.result.brokenReferences).toEqual(['Troop 1 "Slimes" members']);
    expect(read('Enemies.json')[1]).not.toBeNull();
  });

  it('deletes anyway with force and reports what is now broken', async () => {
    const result = await dispatchTool('delete_database_entry', { entity: 'enemies', id: 1, force: true }) as { brokenReferences: string[] };
    expect(result.brokenReferences).toEqual(['Troop 1 "Slimes" members']);
    expect(read('Enemies.json')[1]).toBeNull();
  });

  it('finds nothing for entries no one uses', async () => {
    for (const [entity, id] of [['classes', 2], ['skills', 4], ['states', 2], ['enemies', 2], ['animations', 2], ['weapons', 2], ['actors', 2]] as const) {
      expect(await referencesTo(project, entity, id), entity + ' ' + id).toEqual([]);
    }
  });
});
