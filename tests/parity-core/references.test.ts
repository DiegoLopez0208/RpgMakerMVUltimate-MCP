import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkReferences, ProjectData } from '../../src/parity/validation/references.js';
import { validationToolDefinitions } from '../../src/parity/tools/validationTools.js';
import { MapInfo } from '../../src/parity/utils/types.js';

/** An all-empty ProjectData; override just the slices a case exercises. */
function emptyData(over: Partial<ProjectData> = {}): ProjectData {
  return {
    mapInfos: [],
    maps: [],
    actors: [],
    classes: [],
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
    ...over,
  };
}

function mapInfo(id: number, parentId: number): MapInfo {
  return { id, name: `MAP${id}`, parentId, order: id, expanded: false, scrollX: 0, scrollY: 0 };
}

describe('checkReferences — map tree', () => {
  it('flags a dangling parentId', () => {
    const warnings = checkReferences(
      emptyData({ mapInfos: [null, mapInfo(1, 0), mapInfo(2, 99)] }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'map-tree', path: 'MapInfos[2]' }),
    );
  });

  it('flags a cycle (A under B, B under A)', () => {
    const warnings = checkReferences(emptyData({ mapInfos: [null, mapInfo(1, 2), mapInfo(2, 1)] }));
    expect(warnings.filter((w) => /cycle/.test(w.message)).length).toBeGreaterThan(0);
  });

  it('is silent on a well-formed tree', () => {
    const warnings = checkReferences(
      emptyData({ mapInfos: [null, mapInfo(1, 0), mapInfo(2, 1), mapInfo(3, 2)] }),
    );
    expect(warnings).toEqual([]);
  });
});

describe('checkReferences — startup', () => {
  const system = (over: object) =>
    ({ partyMembers: [], startMapId: 0, ...over }) as unknown as ProjectData['system'];

  it('flags a party member with no actor', () => {
    const warnings = checkReferences(
      emptyData({
        actors: [null, { id: 1 } as never],
        system: system({ partyMembers: [1, 5] }),
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'startup', path: 'System.partyMembers[1]' }),
    );
  });

  it('flags a start map that does not exist', () => {
    const warnings = checkReferences(
      emptyData({ mapInfos: [null, mapInfo(1, 0)], system: system({ startMapId: 9 }) }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'startup', path: 'System.startMapId' }),
    );
  });
});

describe('checkReferences — effects', () => {
  it('flags an Add State effect targeting a missing state', () => {
    const warnings = checkReferences(
      emptyData({
        states: [null, { id: 1 } as never],
        skills: [
          null,
          { id: 1, effects: [{ code: 21, dataId: 7, value1: 0, value2: 0 }] } as never,
        ],
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'effect', message: expect.stringMatching(/state 7/) }),
    );
  });

  it('does not flag Add State with dataId 0 (normal-attack sentinel)', () => {
    const warnings = checkReferences(
      emptyData({
        states: [null, { id: 1 } as never],
        items: [null, { id: 1, effects: [{ code: 21, dataId: 0, value1: 0, value2: 0 }] } as never],
      }),
    );
    expect(warnings).toEqual([]);
  });

  it('flags a bad animationId only when Animations.json is loaded', () => {
    const skill = { id: 1, effects: [], animationId: 50 } as never;
    expect(checkReferences(emptyData({ skills: [null, skill], animations: null }))).toEqual([]);
    const warnings = checkReferences(emptyData({ skills: [null, skill], animations: [null, {}] }));
    expect(warnings).toContainEqual(expect.objectContaining({ category: 'animation' }));
  });
});

describe('checkReferences — database refs', () => {
  it('flags a class learning a missing skill', () => {
    const warnings = checkReferences(
      emptyData({
        skills: [null, { id: 1 } as never],
        classes: [null, { id: 1, learnings: [{ level: 1, skillId: 9, note: '' }] } as never],
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'skill', path: 'class 1 / learnings[0]' }),
    );
  });

  it('flags a troop member referencing a missing enemy', () => {
    const warnings = checkReferences(
      emptyData({
        enemies: [null, { id: 1 } as never],
        troops: [
          null,
          { id: 1, members: [{ enemyId: 3, x: 0, y: 0, hidden: false }], pages: [] } as never,
        ],
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'troop-member', path: 'troop 1 / members[0]' }),
    );
  });
});

describe('checkReferences — command refs', () => {
  it('flags a Transfer Player (direct) to a missing map', () => {
    const warnings = checkReferences(
      emptyData({
        mapInfos: [null, mapInfo(1, 0)],
        maps: [
          {
            id: 1,
            events: [
              null,
              {
                id: 1,
                name: 'e',
                note: '',
                x: 0,
                y: 0,
                pages: [
                  {
                    list: [
                      { code: 201, indent: 0, parameters: [0, 99, 5, 5, 0, 0] },
                      { code: 0, indent: 0, parameters: [] },
                    ],
                  },
                ],
              } as never,
            ],
          },
        ],
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'transfer', message: expect.stringMatching(/map 99/) }),
    );
  });

  it('does not flag a variable-designated Transfer Player', () => {
    const warnings = checkReferences(
      emptyData({
        mapInfos: [null, mapInfo(1, 0)],
        maps: [
          {
            id: 1,
            events: [
              null,
              {
                id: 1,
                name: 'e',
                note: '',
                x: 0,
                y: 0,
                pages: [
                  {
                    list: [
                      { code: 201, indent: 0, parameters: [1, 99, 5, 5, 0, 0] },
                      { code: 0, indent: 0, parameters: [] },
                    ],
                  },
                ],
              } as never,
            ],
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });

  it('flags a Common Event call to a missing common event', () => {
    const warnings = checkReferences(
      emptyData({
        commonEvents: [
          null,
          {
            id: 1,
            name: 'c',
            list: [
              { code: 117, indent: 0, parameters: [9] },
              { code: 0, indent: 0, parameters: [] },
            ],
            switchId: 1,
            trigger: 0,
          } as never,
        ],
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'common-event', path: 'common event 1 / command 0' }),
    );
  });
});

describe('checkReferences — record-naming commands and encounters', () => {
  /** A common event carrying `commands`, so its list is scanned. */
  const withCommands = (commands: unknown[], over: Partial<ProjectData>) =>
    emptyData({
      commonEvents: [
        null,
        {
          id: 1,
          name: 'c',
          list: [...commands, { code: 0, indent: 0, parameters: [] }],
          switchId: 1,
          trigger: 0,
        } as never,
      ],
      ...over,
    });

  it('flags Change Items/Weapons/Armors, Party Member, Battle, Shop, State and Skill targets', () => {
    const one = [null, { id: 1 }] as never[];
    const warnings = checkReferences(
      withCommands(
        [
          { code: 126, indent: 0, parameters: [9, 0, 0, 1] },
          { code: 127, indent: 0, parameters: [9, 0, 0, 1, false] },
          { code: 128, indent: 0, parameters: [9, 0, 0, 1, false] },
          { code: 129, indent: 0, parameters: [9, 0, false] },
          { code: 301, indent: 0, parameters: [0, 9, false, false] },
          { code: 302, indent: 0, parameters: [0, 9, 0, 0, false] },
          { code: 605, indent: 0, parameters: [2, 9, 0, 0] },
          { code: 313, indent: 0, parameters: [0, 9, 0, 9] },
          { code: 318, indent: 0, parameters: [0, 1, 0, 9] },
        ],
        {
          items: one,
          weapons: one,
          armors: one,
          actors: one,
          troops: one,
          states: one,
          skills: one,
        },
      ),
    );
    expect(warnings.map((w) => `${w.category}@${w.path}`)).toEqual([
      'item@common event 1 / command 0',
      'weapon@common event 1 / command 1',
      'armor@common event 1 / command 2',
      'actor@common event 1 / command 3',
      'troop@common event 1 / command 4',
      'item@common event 1 / command 5',
      'armor@common event 1 / command 6',
      'actor@common event 1 / command 7',
      'state@common event 1 / command 7',
      'skill@common event 1 / command 8',
    ]);
  });

  it('skips variable designations, party-wide targets, and unloaded tables', () => {
    const warnings = checkReferences(
      withCommands(
        [
          { code: 301, indent: 0, parameters: [1, 9, false, false] },
          { code: 313, indent: 0, parameters: [0, 0, 0, 1] },
          { code: 126, indent: 0, parameters: [9, 0, 0, 1] },
        ],
        { troops: [null, { id: 1 }] as never[], states: [null, { id: 1 }] as never[] },
      ),
    );
    expect(warnings).toEqual([]);
  });

  it('flags a map random encounter with a missing troop', () => {
    const warnings = checkReferences(
      emptyData({
        troops: [null, { id: 1 }] as never[],
        maps: [{ id: 2, events: [], encounterList: [{ troopId: 1 }, { troopId: 5 }] }],
      }),
    );
    expect(warnings).toEqual([expect.objectContaining({ path: 'map 2 / encounterList[1]' })]);
  });
});

describe('validate_references (integration)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads the project and reports a cross-file dangling reference', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rpgmv-refs-'));
    await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
    await mkdir(join(dir, 'data'));
    await writeFile(
      join(dir, 'data', 'System.json'),
      JSON.stringify({ partyMembers: [1, 4], startMapId: 1 }),
    );
    await writeFile(
      join(dir, 'data', 'Actors.json'),
      JSON.stringify([null, { id: 1, name: 'Hero', classId: 1 }]),
    );
    await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify([null, mapInfo(1, 0)]));

    const def = validationToolDefinitions.find((t) => t.name === 'validate_references')!;
    expect(def.mutates).toBeFalsy();
    const result = (await def.handler({ projectPath: dir }, {})) as {
      ok: boolean;
      warnings: Array<{ category: string }>;
    };

    expect(result.ok).toBe(false);
    // Party member 4 has no actor; missing DB files fail soft (no false positives).
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ category: 'startup', path: 'System.partyMembers[1]' }),
    );
  });
});
