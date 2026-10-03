import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildEventCommands } from '../src/utils/eventCommandBuilders.js';
import { blockStructureWarnings } from '../src/parity/validation/eventBlocks.js';
import { validateCommandList } from '../src/parity/validation/eventCommands.js';
import { checkReferences, ProjectData } from '../src/parity/validation/references.js';
import { checkAssets, AssetProjectData } from '../src/parity/validation/assets.js';
import { listAssets } from '../src/parity/tools/assetTools.js';
import { validateAssetsTool } from '../src/parity/tools/validationTools.js';
import { EventCommand } from '../src/parity/utils/types.js';
import { eventCommandToolDefinitions } from '../src/parity/tools/eventCommandTools.js';

const command = (code: number, parameters: unknown[] = [], indent = 0): EventCommand => ({ code, parameters, indent });
const emptyRefs = (): ProjectData => ({
  mapInfos: [], maps: [], actors: [], classes: [], skills: [], items: [], weapons: [], armors: [],
  enemies: [], troops: [], states: [], commonEvents: [], animations: null, system: null,
});
const emptyAssets = (): AssetProjectData => ({
  actors: [], enemies: [], tilesets: [], maps: [], troops: [], commonEvents: [], system: null,
});
const route = {
  repeat: false, skippable: false, wait: false,
  list: [
    { code: 41, parameters: ['MissingSprite', 0] },
    { code: 44, parameters: [{ name: 'MissingSound', volume: 90, pitch: 100, pan: 0 }] },
    { code: 0, parameters: [] },
  ],
};

describe('MV static validation regressions', () => {
  it('recognizes all valid battle branches while retaining structural and zero-parameter checks', async () => {
    const tool = eventCommandToolDefinitions.find(definition => definition.name === 'build_battle_processing')!;
    const built = await tool.handler({ projectPath: '' }, {
      troopId: 1, canEscape: true, canLose: true,
    }) as { command: EventCommand };
    const list = [built.command, command(601), command(0, [], 1),
      command(602), command(0, [], 1), command(603), command(0, [], 1), command(604), command(0)];
    expect(validateCommandList(list, 'battle')).toEqual([]);
    for (const code of [601, 602, 603, 604]) {
      const invalid = list.map(row => row.code === code ? { ...row, parameters: [1] } : row);
      expect(validateCommandList(invalid, 'battle')).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
    }
    expect(validateCommandList(list.filter(row => row.code !== 604), 'battle'))
      .toContainEqual(expect.objectContaining({ severity: 'error' }));
  });

  it.each([-2, 1])('accepts a valid cancellation branch with cancelType %s', (cancelType) => {
    const built = buildEventCommands({ kind: 'show_choices', choices: ['Go'], cancelType, cancelBranch: [] });
    const list = [...built.commands, command(0)] as EventCommand[];
    expect(validateCommandList(list, 'choice')).toEqual([]);
  });

  it('still flags a missing cancellation branch for the native MV -2 value', () => {
    const list = [command(102, [['Go'], -2, 0, 2, 0]), command(402, [0, 'Go']),
      command(0, [], 1), command(404), command(0)];
    expect(blockStructureWarnings(list, 'choice')).toContainEqual(expect.objectContaining({
      code: 102, message: expect.stringContaining('no When Cancel'),
    }));
  });

  it('checks map, common-event, and troop animation calls, including invalid zero IDs', () => {
    const data = emptyRefs();
    data.animations = [null, { id: 1 }];
    data.maps = [{ id: 1, events: [null, { id: 1, pages: [{ list: [command(212, [-1, 99, false])] }] } as never] }];
    data.commonEvents = [null, { id: 1, list: [command(212, [-1, 0, false])] } as never];
    data.troops = [null, { id: 1, pages: [{ list: [command(337, [-1, 88, false]), command(337, [-1, 1, false])] }] } as never];
    const warnings = checkReferences(data);
    expect(warnings).toHaveLength(3);
    expect(warnings.every(warning => warning.category === 'animation')).toBe(true);
    expect(warnings.map(warning => warning.path)).toEqual([
      'map 1 / event 1 / page 0 / command 0',
      'common event 1 / command 0',
      'troop 1 / page 0 / command 0',
    ]);
    data.animations = null;
    expect(checkReferences(data)).toEqual([]);
  });

  it('audits MV animation sheets/timing SE and forced/autonomous movement assets once each', () => {
    const data = emptyAssets();
    data.animations = [null, { id: 1, animation1Name: 'MissingSheet', animation2Name: 'Present',
      timings: [{ se: { name: 'MissingTiming', volume: 90, pitch: 100, pan: 0 } }] }];
    data.maps = [{ id: 1, map: { events: [null, { id: 1, pages: [{ moveType: 3, moveRoute: route,
      list: [command(205, [0, route]), ...route.list.slice(0, -1).map(step => command(505, [step])), command(0)],
    }] }] } as never }];
    data.commonEvents = [null, { id: 1, list: [command(205, [-1, route]), command(0)] } as never];
    data.troops = [null, { id: 1, pages: [{ list: [command(205, [-1, route]), command(0)] }] } as never];
    const available = { animations: new Set(['Present']), characters: new Set(['Present']), se: new Set(['Present']) };
    const warnings = checkAssets(data, available);
    expect(warnings).toHaveLength(10); // two animation fields + four routes, two fields each
    expect(warnings.filter(warning => warning.category === 'animation')).toHaveLength(2);
    expect(warnings.filter(warning => warning.category === 'move-route')).toHaveLength(8);
    expect(warnings.some(warning => warning.path.includes('command 1'))).toBe(false); // 505 mirrors not double-counted
    available.animations.add('MissingSheet');
    available.characters.add('MissingSprite');
    available.se.add('MissingSound');
    available.se.add('MissingTiming');
    expect(checkAssets(data, available)).toEqual([]);
  });
});

let project: string | undefined;
afterEach(async () => { if (project) await rm(project, { recursive: true, force: true }); project = undefined; });

it('loads Animations.json and resolves encrypted MV images/audio with basename deduplication', async () => {
  project = await mkdtemp(join(tmpdir(), 'mv-static-assets-'));
  const write = async (relative: string, value: string) => {
    const file = join(project!, relative);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, value);
  };
  await write('data/MapInfos.json', '[null]');
  await write('data/Animations.json', JSON.stringify([null, { id: 1,
    animation1Name: 'Fire', animation2Name: 'Ice',
    timings: [{ se: { name: 'Blast', volume: 90, pitch: 100, pan: 0 } }],
  }]));
  await write('img/animations/Fire.png', '');
  await write('img/animations/Fire.rpgmvp', '');
  await write('img/animations/Ice.rpgmvp', '');
  for (const extension of ['ogg', 'm4a', 'rpgmvo', 'rpgmvm']) await write(`audio/se/Blast.${extension}`, '');
  await write('audio/se/OnlyEncrypted.rpgmvm', '');
  expect(await listAssets(project, 'animations')).toEqual({ type: 'animations', count: 2, names: ['Fire', 'Ice'] });
  expect(await listAssets(project, 'se')).toEqual({ type: 'se', count: 2, names: ['Blast', 'OnlyEncrypted'] });
  expect(await validateAssetsTool(project)).toEqual({ ok: true, warnings: [] });
  await write('data/Animations.json', JSON.stringify([null, { id: 1, animation1Name: 'Absent' }]));
  const report = await validateAssetsTool(project);
  expect(report.ok).toBe(false);
  expect(report.warnings).toEqual([expect.objectContaining({ category: 'animation', path: 'animation 1 / animation1Name' })]);
});
