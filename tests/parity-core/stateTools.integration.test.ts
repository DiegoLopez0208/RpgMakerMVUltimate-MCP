import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../../src/parity/utils/commit.js';
import {
  createState,
  updateState,
  getStates,
  defaultState,
  stateToolDefinitions,
} from '../../src/parity/tools/stateTools.js';
import { listNames } from '../../src/parity/tools/listTools.js';
import { State } from '../../src/parity/utils/types.js';

/** Scaffold a minimal project with a seeded States.json. */
async function scaffoldProject(states: (State | null)[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-state-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'States.json'), JSON.stringify(states));
  return dir;
}

const poison: State = { ...defaultState(), id: 1, name: 'Poison' };

describe('state tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // 1-indexed array whose slot 0 is null.
    dir = await scaffoldProject([null, poison]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createState assigns the next id, applies defaults, and persists compactly', async () => {
    const created = await createState(dir, { name: 'Sleep' });
    expect(created.id).toBe(2);
    expect(created.priority).toBe(50);
    expect(created.minTurns).toBe(1);
    expect(created.maxTurns).toBe(1);
    expect(created.traits).toEqual([]);

    const states = await getStates(dir);
    expect(states.find((s) => s?.id === 2)?.name).toBe('Sleep');

    const raw = await readFile(join(dir, 'data', 'States.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createState honors overrides but never lets a caller set the id', async () => {
    const created = await createState(dir, {
      name: 'Stun',
      restriction: 4,
      maxTurns: 3,
      id: 99,
    } as Partial<Omit<State, 'id'>> & { id: number });
    expect(created.id).toBe(2);
    expect(created.restriction).toBe(4);
    expect(created.maxTurns).toBe(3);
  });

  it('createState ignores undefined optional fields, keeping template defaults', async () => {
    const created = await createState(dir, { name: 'Blind', priority: undefined });
    expect(created.priority).toBe(50);
    expect(created.chanceByDamage).toBe(100);
  });

  it('updateState merges and refuses an unknown id', async () => {
    const updated = await updateState(dir, 1, { maxTurns: 5, removeByDamage: true });
    expect(updated.maxTurns).toBe(5);
    expect(updated.removeByDamage).toBe(true);
    expect(updated.name).toBe('Poison');
    await expect(updateState(dir, 99, { maxTurns: 1 })).rejects.toThrow(/not found/);
  });

  it('list_names indexes states', async () => {
    const result = await listNames(dir, 'states');
    expect(result.entries).toEqual([{ id: 1, name: 'Poison' }]);
  });

  it('the create_state tool handler dispatches to createState', async () => {
    const def = stateToolDefinitions.find((t) => t.name === 'create_state')!;
    expect(def.mutates).toBe(true);
    const result = (await def.handler({ projectPath: dir }, { name: 'ViaTool' })) as State;
    expect(result.id).toBe(2);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await createState(dir, { name: 'Preview' });
    });
    expect(context.commits.some((c) => c.path.endsWith('States.json'))).toBe(true);
    const states = await getStates(dir);
    expect(states.every((s) => s == null || s.name !== 'Preview')).toBe(true);
  });
});

describe('state templates', () => {
  it('defaultState has editor new-state defaults', () => {
    const s = defaultState();
    expect(s.priority).toBe(50);
    expect(s.restriction).toBe(0);
    expect(s.minTurns).toBe(1);
    expect(s.maxTurns).toBe(1);
    expect(s.chanceByDamage).toBe(100);
    expect(s.stepsToRemove).toBe(100);
    expect(s.traits).toEqual([]);
  });
});
