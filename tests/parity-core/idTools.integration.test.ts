import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listAllocatedIds,
  nextFreeId,
  idToolDefinitions,
  AllocationReport,
  AllocatedId,
} from '../../src/parity/tools/idTools.js';
import { setSwitchName, setVariableName } from '../../src/parity/tools/systemTools.js';

const END = { code: 0, indent: 0, parameters: [] };
const controlSwitch = (id: number) => ({ code: 121, indent: 0, parameters: [id, id, 0] });

function page(list: unknown[]) {
  return {
    conditions: {
      switch1Valid: false,
      switch1Id: 0,
      switch2Valid: false,
      switch2Id: 0,
      variableValid: false,
      variableId: 0,
      variableValue: 0,
      selfSwitchValid: false,
      selfSwitchCh: 'A',
      actorValid: false,
      actorId: 0,
      itemValid: false,
      itemId: 0,
    },
    list,
  };
}

/** A minimal but real on-disk project: MapInfos + one map + System + CommonEvents. */
async function scaffold(files: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-ids-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));

  const defaults: Record<string, unknown> = {
    'MapInfos.json': [null, { id: 1, name: 'Town', parentId: 0 }],
    'Map001.json': {
      width: 10,
      height: 10,
      data: [],
      events: [
        null,
        {
          id: 1,
          name: 'Door',
          note: '',
          x: 1,
          y: 1,
          pages: [page([controlSwitch(3), END])],
        },
      ],
    },
    'System.json': {
      switches: ['', 'Intro done', '', '', '', '', '', '', '', ''],
      variables: ['', '', 'Gold spent', '', '', '', '', '', '', ''],
    },
    'CommonEvents.json': [null, { id: 1, name: 'Heal all', trigger: 0, switchId: 0, list: [] }],
  };

  for (const [name, data] of Object.entries({ ...defaults, ...files })) {
    await writeFile(join(dir, 'data', name), JSON.stringify(data));
  }
  return dir;
}

describe('listAllocatedIds', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts both named-but-unused and used-but-unnamed switches', async () => {
    const report = (await listAllocatedIds(dir, 'switch')) as AllocationReport;

    expect(report.allocated).toEqual([
      { id: 1, name: 'Intro done', declared: true, referenceCount: 0, referencedBy: [] },
      {
        id: 3,
        name: '',
        declared: false,
        referenceCount: 1,
        referencedBy: [{ path: 'map 1 / event 1 / page 0 / command 0', via: 'Control Switches' }],
      },
    ]);
    expect(report.count).toBe(2);
    expect(report.highest).toBe(3);
  });

  it('reports the holes below the highest allocated id', async () => {
    const report = (await listAllocatedIds(dir, 'switch')) as AllocationReport;
    expect(report.gaps).toEqual([2]);
  });

  it('reports the declared System.json capacity for switches and variables', async () => {
    const switches = (await listAllocatedIds(dir, 'switch')) as AllocationReport;
    const variables = (await listAllocatedIds(dir, 'variable')) as AllocationReport;
    expect(switches.declaredCapacity).toBe(9);
    expect(variables.declaredCapacity).toBe(9);
  });

  it('has no declared capacity for common events (no fixed-size name array)', async () => {
    const report = (await listAllocatedIds(dir, 'common_event')) as AllocationReport;
    expect(report.declaredCapacity).toBeUndefined();
    expect(report.allocated).toEqual([
      { id: 1, name: 'Heal all', declared: true, referenceCount: 0, referencedBy: [] },
    ]);
  });

  it('states its coverage, naming the command codes it scanned', async () => {
    const report = (await listAllocatedIds(dir, 'switch')) as AllocationReport;
    expect(report.coverage).toContain('111, 121');
    expect(report.coverage).toContain('curated, not exhaustive');
  });

  it('answers "where is this id used?" for a single id', async () => {
    const single = (await listAllocatedIds(dir, 'switch', 3)) as AllocatedId & {
      allocated: boolean;
    };
    expect(single.allocated).toBe(true);
    expect(single.referencedBy).toEqual([
      { path: 'map 1 / event 1 / page 0 / command 0', via: 'Control Switches' },
    ]);
  });

  it('reports a free id as unallocated rather than omitting it', async () => {
    const single = (await listAllocatedIds(dir, 'switch', 42)) as AllocatedId & {
      allocated: boolean;
    };
    expect(single).toMatchObject({ id: 42, allocated: false, declared: false, referenceCount: 0 });
  });

  it('degrades to an empty report on a project with no data files', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'rpgmv-ids-bare-'));
    await writeFile(join(bare, 'Game.rpgproject'), 'RPGMV 1.6.1');
    await mkdir(join(bare, 'data'));
    try {
      const report = (await listAllocatedIds(bare, 'switch')) as AllocationReport;
      expect(report).toMatchObject({ count: 0, highest: 0, gaps: [], allocated: [] });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('nextFreeId', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends above every allocated id, skipping holes by default', async () => {
    const result = await nextFreeId(dir, 'switch');
    expect(result).toMatchObject({ ids: [4], strategy: 'append', highest: 3 });
  });

  it('hands back a consecutive block when asked for several', async () => {
    expect((await nextFreeId(dir, 'switch', 3)).ids).toEqual([4, 5, 6]);
  });

  it('fills holes first only when explicitly asked', async () => {
    const result = await nextFreeId(dir, 'switch', 2, true);
    expect(result).toMatchObject({ ids: [2, 4], strategy: 'gap-fill' });
  });

  it('warns when the id runs past the declared System.json capacity', async () => {
    const result = await nextFreeId(dir, 'switch', 8);
    expect(result.ids).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.warnings.join(' ')).toMatch(/declares 9 switches/);
    expect(result.warnings.join(' ')).toMatch(/set_switch_name to grow the array before using/);
  });

  it('stays quiet while the ids fit inside the declared capacity', async () => {
    expect((await nextFreeId(dir, 'switch')).warnings).toEqual([]);
  });

  it('starts at 1 on an empty project', async () => {
    const empty = await scaffold({
      'System.json': { switches: [''], variables: [''] },
      'CommonEvents.json': [null],
      'Map001.json': { width: 10, height: 10, data: [], events: [null] },
    });
    try {
      expect((await nextFreeId(empty, 'switch')).ids).toEqual([1]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('is honoured end to end: a claimed id shows up as allocated next time', async () => {
    const { ids } = await nextFreeId(dir, 'switch');
    await setSwitchName(dir, ids[0], 'Met the librarian');

    const after = (await listAllocatedIds(dir, 'switch', ids[0])) as AllocatedId & {
      allocated: boolean;
    };
    expect(after).toMatchObject({ allocated: true, declared: true, name: 'Met the librarian' });
    expect((await nextFreeId(dir, 'switch')).ids).toEqual([ids[0] + 1]);
  });
});

describe('set_switch_name / set_variable_name capacity growth', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readSystem = async (): Promise<{ switches: string[]; variables: string[] }> =>
    JSON.parse(await readFile(join(dir, 'data', 'System.json'), 'utf8'));

  it('grows the switch list to the next 20-slot block for an id past the end', async () => {
    await setSwitchName(dir, 25, 'Act II unlocked');
    const system = await readSystem();
    expect(system.switches.length).toBe(40);
    expect(system.switches[25]).toBe('Act II unlocked');
    expect(system.switches[26]).toBe('');
    // Existing names survive the growth.
    expect(system.switches[1]).toBe('Intro done');
  });

  it('grows the variable list the same way', async () => {
    await setVariableName(dir, 12, 'Quest stage');
    const system = await readSystem();
    expect(system.variables.length).toBe(20);
    expect(system.variables[12]).toBe('Quest stage');
  });

  it('leaves the array alone when the slot already exists', async () => {
    await setSwitchName(dir, 5, 'Chest opened');
    expect((await readSystem()).switches.length).toBe(10);
  });

  it('refuses an id past the safety ceiling rather than allocating thousands of slots', async () => {
    await expect(setSwitchName(dir, 99999, 'typo')).rejects.toThrow(/ceiling/);
  });

  it('still rejects a non-positive id', async () => {
    await expect(setSwitchName(dir, 0, 'nope')).rejects.toThrow(/1-based/);
  });
});

describe('id tool definitions', () => {
  it('registers two read-only tools', () => {
    expect(idToolDefinitions.map((def) => def.name)).toEqual([
      'list_allocated_ids',
      'next_free_id',
    ]);
    for (const def of idToolDefinitions) {
      expect(def.mutates).toBeUndefined();
      expect(def.forceable).toBeUndefined();
    }
  });
});
