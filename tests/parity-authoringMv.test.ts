import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { eventCommandToolDefinitions } from '../src/parity/tools/eventCommandTools.js';
import { eventPageToolDefinitions, blankEventPage } from '../src/parity/tools/eventPageTools.js';
import { moveToolDefinitions, createMoveRoute } from '../src/parity/tools/moveTools.js';
import { battleToolDefinitions, blankTroopPage, buildTroopPage } from '../src/parity/tools/battleTools.js';
import { blankMapData } from '../src/parity/tools/mapTools.js';
import { commitStore } from '../src/parity/utils/commit.js';
import { validateEventCommands } from '../src/utils/eventCommandValidation.js';
import { buildEventCommands } from '../src/utils/eventCommandBuilders.js';
import { insertEventCommands } from '../src/tools/eventCommandTools.js';
import { showText, controlVariables } from '../src/parity/events/commandBuilders.js';
import type { EventCommand, MapData } from '../src/parity/utils/types.js';

const definitions = [...eventCommandToolDefinitions, ...eventPageToolDefinitions, ...moveToolDefinitions, ...battleToolDefinitions];
const tool = (name: string) => definitions.find(def => def.name === name)!;
const end = { code: 0, indent: 0, parameters: [] };
const constant = { type: 'constant', value: 5 };

const newFamilies: [string, Record<string, unknown>, number[]][] = [
  ['build_change_gold', { operation: 'increase', operand: constant }, [125]],
  ['build_change_items', { kind: 'weapon', id: 1, operation: 'decrease', operand: constant, includeEquip: true }, [127]],
  ['build_change_party_member', { actorId: 1, operation: 'add', initialize: true }, [129]],
  ['build_play_audio', { kind: 'se', name: 'Bell' }, [250]],
  ['build_screen_effect', { kind: 'tint', color: [-30, 0, 30, 0], duration: 30 }, [223]],
  ['build_picture', { kind: 'show', pictureId: 1, name: 'Portrait' }, [231]],
  ['build_character_effect', { kind: 'balloon', characterId: -1, id: 1 }, [213]],
  ['build_battle_processing', { troopId: 1, canEscape: true }, [301]],
  ['build_shop_processing', { goods: [{ kind: 'item', id: 1 }, { kind: 'armor', id: 1, price: 10 }] }, [302, 605]],
  ['build_name_input', { actorId: 1, maxLength: 8 }, [303]],
  ['build_change_actor', { kind: 'hp', target: { type: 'fixed', actorId: 0 }, operand: constant }, [311]],
  ['build_battle_command', { kind: 'enemy_state', enemyIndex: -1, stateId: 1 }, [333]],
];

describe('MV reusable event authoring', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rpgmv-parity-authoring-'));
    await mkdir(join(dir, 'data'));
    const map = blankMapData(10, 10, 1);
    map.events = [null, { id: 1, name: 'Test', x: 2, y: 2, note: '', pages: [blankEventPage()] }];
    await Promise.all(Object.entries({
      'Map001.json': map,
      'System.json': { switches: ['', 'Gate'], variables: ['', 'Count'] },
      'Troops.json': [null, { id: 1, name: 'Test', members: [], pages: [blankTroopPage()] }],
      'CommonEvents.json': [null, { id: 1, name: 'Test', list: [end] }],
    }).map(([name, value]) => writeFile(join(dir, 'data', name), JSON.stringify(value))));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(newFamilies)('%s builds MV commands accepted by established insertion', async (name, args, codes) => {
    const before = await readFile(join(dir, 'data', 'Map001.json'), 'utf8');
    const result = await tool(name).handler({ projectPath: dir }, args) as { command?: EventCommand; commands?: EventCommand[] };
    const commands = result.commands ?? [result.command!];
    expect(commands.map(command => command.code)).toEqual(codes);
    expect(tool(name).requiresProject).toBe(false);
    expect(validateEventCommands(commands, { fragment: true }).commands).toHaveLength(codes.length);
    await insertEventCommands(dir, { mapId: 1, eventId: 1, commands, dryRun: true });
    expect(await readFile(join(dir, 'data', 'Map001.json'), 'utf8')).toBe(before);
    expect((await readdir(join(dir, 'data'))).some(name => /backup|\.bak/.test(name))).toBe(false);
  });

  it('existing consolidated Show Text wraps to MV boxes and warns when wrapping is disabled', () => {
    const text = 'The watchman waits beside the gate. '.repeat(12);
    const wrapped = buildEventCommands({ kind: 'show_text', lines: [text], faceName: 'Actor1', wrap: true });
    expect(wrapped.commands.filter(command => command.code === 101).length).toBeGreaterThan(1);
    expect(wrapped.commands.filter(command => command.code === 101).every(command => command.parameters.length === 4)).toBe(true);
    expect(wrapped.warnings).toBeUndefined();
    expect(buildEventCommands({ kind: 'show_text', lines: [text] }).warnings?.join(' ')).toMatch(/width|fits/);
  });

  it('rejects MZ builder fields and data operands', async () => {
    await expect(tool('build_show_text').handler({ projectPath: dir }, { lines: ['Hello'], speakerName: 'MZ only' })).rejects.toThrow();
    await expect(tool('build_control_variable').handler({ projectPath: dir }, { variableId: 1, operation: 'set', operand: { type: 'game_data', dataType: 8 } })).rejects.toThrow();
    expect(() => controlVariables(1, 'set', { type: 'game_data', dataType: 8 })).toThrow();
  });

  it.each([
    ['build_change_gold', { operation: 'increase', operand: { type: 'variable' } }],
    ['build_change_items', { kind: 'item', id: 0, operation: 'increase', operand: constant }],
    ['build_picture', { kind: 'erase', pictureId: 101 }],
    ['build_character_effect', { kind: 'balloon', characterId: -2, id: 1 }],
    ['build_play_audio', { kind: 'se', name: 'Bell', volume: 101 }],
    ['build_change_actor', { kind: 'recover_all', target: { type: 'variable', variableId: 0 } }],
  ])('rejects invalid %s parameters', async (name, args) => {
    await expect(tool(name as string).handler({ projectPath: dir }, args as Record<string, unknown>)).rejects.toThrow();
  });

  it('builds a rebased troop page without changing nested caller commands', () => {
    const commands = showText(['Prepare!'], { indent: 3 });
    const before = structuredClone(commands);
    const page = buildTroopPage({ turn: [1, 2], enemyHpBelow: [0, 50] }, 'turn', commands);
    expect(page.span).toBe(1);
    expect(page.conditions).toMatchObject({ turnValid: true, turnA: 1, turnB: 2, enemyValid: true });
    expect(page.list.map(command => command.indent)).toEqual([0, 0, 0]);
    expect(commands).toEqual(before);
    expect(() => buildTroopPage({ turnEnd: true }, 'battle', [{ code: 335, indent: 0, parameters: [] }])).toThrow();
  });

  it.each([
    { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'MZ'] },
    { code: 357, indent: 0, parameters: ['Plugin', 'command', '', {}] },
    { code: 657, indent: 0, parameters: ['MZ annotation'] },
    { code: 122, indent: 0, parameters: [1, 1, 0, 3, 8, 0, 0] },
  ])('force cannot write MZ command $code to troop pages', async command => {
    const path = join(dir, 'data', 'Troops.json');
    const before = await readFile(path, 'utf8');
    await expect(tool('add_troop_page').handler({ projectPath: dir }, {
      troopId: 1, page: { ...blankTroopPage(), list: [command, end] }, force: true,
    })).rejects.toThrow(/MV|MZ/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('previews partial page edits, forced routes, and troop insertion without writes', async () => {
    const mapPath = join(dir, 'data', 'Map001.json');
    const troopPath = join(dir, 'data', 'Troops.json');
    const before = await Promise.all([readFile(mapPath, 'utf8'), readFile(troopPath, 'utf8')]);
    const context = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await tool('set_event_page').handler({ projectPath: dir }, { mapId: 1, eventId: 1, pageIndex: 0, direction: 'up', moveSpeed: 5 });
      await tool('set_movement_route').handler({ projectPath: dir }, { mapId: 1, eventId: 1, pageIndex: 0, characterId: -1, moveRoute: createMoveRoute('patrol') });
      await tool('add_troop_page').handler({ projectPath: dir }, { troopId: 1, page: buildTroopPage({ turnEnd: true }) });
    });
    expect(context.commits).toHaveLength(3);
    expect(await Promise.all([readFile(mapPath, 'utf8'), readFile(troopPath, 'utf8')])).toEqual(before);
  });

  it('rejects invalid autonomous routes and unsafe forced-route insertion without writes', async () => {
    const path = join(dir, 'data', 'Map001.json');
    const map = JSON.parse(await readFile(path, 'utf8')) as MapData;
    map.events[1]!.pages[0].list = [...showText(['Do not split me']), end];
    await writeFile(path, JSON.stringify(map));
    const before = await readFile(path, 'utf8');
    await expect(tool('set_event_page').handler({ projectPath: dir }, {
      mapId: 1, eventId: 1, pageIndex: 0, moveType: 'custom', moveRoute: { list: [{ code: 29, parameters: [99] }, { code: 0, parameters: [] }] },
    })).rejects.toThrow();
    await expect(tool('set_movement_route').handler({ projectPath: dir }, {
      mapId: 1, eventId: 1, pageIndex: 0, characterId: -1, position: 1, moveRoute: createMoveRoute('wander'),
    })).rejects.toThrow(/boundary/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('public schemas omit MZ speakerName and cap game-data types at 7', () => {
    expect(tool('build_show_text').inputSchema).not.toHaveProperty('speakerName');
    expect(tool('create_npc').inputSchema).not.toHaveProperty('speakerName');
    expect(z.object(tool('build_control_variable').inputSchema).safeParse({
      variableId: 1, operation: 'set', operand: { type: 'game_data', dataType: 8 },
    }).success).toBe(false);
  });
});
