import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { insertEventCommands } from '../src/tools/eventCommandTools.js';
import { validateEventCommands } from '../src/utils/eventCommandValidation.js';
import { buildEventCommands } from '../src/utils/eventCommandBuilders.js';

const c = (code: number, parameters: unknown[] = [], indent = 0) => ({ code, indent, parameters });
const original = [c(108, ['Original']), c(0)];
let project: string;
async function save(name: string, value: unknown) {
  await writeFile(join(project, 'data', name), JSON.stringify(value));
}
async function bytes(name = 'Map001.json') { return readFile(join(project, 'data', name), 'utf8'); }
async function snapshot() {
  const data = await readdir(join(project, 'data'));
  return { data, contents: await Promise.all(data.map(bytes)), root: await readdir(project) };
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'mv-command-insert-'));
  await mkdir(join(project, 'data'));
  await save('System.json', { switches: ['', 'Quest'], variables: ['', 'Progress'] });
  await save('Map001.json', { width: 20, height: 15, events: [null, { id: 1, pages: [{ list: original }] }] });
  await save('CommonEvents.json', [null, { id: 1, list: original }]);
  await save('Troops.json', [null, { id: 1, pages: [{ list: original }] }]);
  for (const name of ['Actors', 'Items', 'Weapons', 'Armors', 'States', 'Animations']) await save(`${name}.json`, [null, { id: 1, name: 'Fixture' }]);
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

describe('guarded event command insertion', () => {
  it.each([
    [{ mapId: 1, eventId: 1 }, 'Map001.json'],
    [{ target: 'common_event', commonEventId: 1 }, 'CommonEvents.json'],
    [{ target: 'troop_page', troopId: 1 }, 'Troops.json'],
  ])('inserts into %j with a final root terminator and backups', async (target, filename) => {
    const before = await bytes(filename);
    const result = await insertEventCommands(project, { ...target, commands: [c(230, [30]), c(0)], verbose: true });
    expect(result.after).toEqual([c(108, ['Original']), c(230, [30]), c(0)]);
    expect(result.insertedCount).toBe(1);
    expect(await bytes(filename)).not.toBe(before);
    expect(await readFile(join(project, 'data', filename + '.bak'), 'utf8')).toBe(before);
    expect((await readdir(join(project, '.mcp-backups'))).length).toBe(1);
  });

  it('direct dryRun validates and previews without changing files or creating backups', async () => {
    const before = await snapshot();
    const result = await insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(121, [1, 1, 0])], dryRun: true, verbose: true });
    expect(result.before).toEqual(original);
    expect(result.dryRun).toBe(true);
    expect(result.after).toHaveLength(3);
    expect(await snapshot()).toEqual(before);
  });

  it('rebases fragments into nested branch bodies and preserves child terminators', async () => {
    const list = [c(111, [0, 1, 0]), c(0, [], 1), c(411), c(0, [], 1), c(412), c(0)];
    await save('Map001.json', { events: [null, { id: 1, pages: [{ list }] }] });
    const result = await insertEventCommands(project, { mapId: 1, eventId: 1, position: 1, commands: [c(108, ['Inside'])], verbose: true });
    expect(result.after).toEqual([list[0], c(108, ['Inside'], 1), ...list.slice(1)]);
  });

  it('rebases nonzero-indent builder output without mutating its input', async () => {
    const list = [c(111, [0, 1, 0]), c(0, [], 1), c(412), c(0)];
    await save('Map001.json', { events: [null, { id: 1, pages: [{ list }] }] });
    const commands = buildEventCommands({ kind: 'conditional_branch', indent: 2,
      condition: { type: 'switch', switchId: 1 },
      thenBranch: buildEventCommands({ kind: 'show_text', lines: ['Nested'], indent: 4 }).commands,
    }).commands;
    const unchanged = structuredClone(commands);
    const result = await insertEventCommands(project, { mapId: 1, eventId: 1, position: 1, commands, dryRun: true, verbose: true });
    expect(result.after).toEqual([list[0], ...commands.map(command => ({ ...command, indent: command.indent! - 1 })), ...list.slice(1)]);
    expect(commands).toEqual(unchanged);
  });

  it.each([
    [c(108, ['negative'], -1)],
    [c(108, ['first'], 3), c(108, ['later'], 2)],
    [c(111, [0, 1, 0], 2), c(108, ['skipped'], 4), c(412, [], 2)],
  ])('does not normalize malformed relative indents into valid fragments %j', async (...commands) => {
    const before = await snapshot();
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    [c(101, ['', 0, 0, 2, 'MZ name']), c(401, ['Text'])],
    [c(357, ['Plugin', 'Command', '', {}])],
    [c(111, [0, 1, 0]), c(230, [1], 1)],
    [c(0), c(230, [1])],
    [c(401, ['orphan'])],
    [c(122, [1, 1, 0, 0])],
    [c(122, [1, 1, 0, 3, 8, 0, 0])],
    [c(122, [1, 1, 0, 3, 3, 1, 12])],
    [c(121, [1, 2, 0])],
    [c(117, [2])],
    [c(201, [0, 9, 1, 1, 2, 0])],
  ])('rejects invalid commands without any writes: %j', async (...commands) => {
    const before = await snapshot();
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { mapId: '1e0' }, { mapId: '' }, { mapId: ' ' }, { mapId: null }, { mapId: true },
    { eventId: '1.0' }, { eventId: 1.5 }, { pageIndex: -1 }, { position: '0.5' },
    { position: 2 }, { dryRun: 'true' }, { target: 'something_else' }, { extra: true },
  ])('rejects malformed arguments %j', async (bad) => {
    const before = await snapshot();
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(230, [1])], ...bad })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('accepts whole decimal numeric strings for IDs, pageIndex, and position', async () => {
    const result = await insertEventCommands(project, { mapId: '1', eventId: '01', pageIndex: '0', position: '0', commands: [c(230, [1])], dryRun: true });
    expect(result.mapId).toBe(1);
    expect(result.eventId).toBe(1);
    expect(result.position).toBe(0);
    expect(result.pageIndex).toBe(0);
    await expect(insertEventCommands(project, { target: 'common_event', commonEventId: '1', commands: [c(230, [1])], dryRun: true })).resolves.toBeDefined();
    await expect(insertEventCommands(project, { target: 'troop_page', troopId: '1', commands: [c(230, [1])], dryRun: true })).resolves.toBeDefined();
  });

  it('rejects missing targets and unsafe continuation or branch-marker boundaries', async () => {
    await save('Map001.json', { events: [null, { id: 1, pages: [{ list: [c(101, ['', 0, 0, 2]), c(401, ['text']), c(0)] }] }] });
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, position: 1, commands: [c(230, [1])] })).rejects.toThrow(/position/i);
    await expect(insertEventCommands(project, { mapId: 1, eventId: 2, commands: [c(230, [1])] })).rejects.toThrow(/event/i);
    await expect(insertEventCommands(project, { target: 'common_event', commonEventId: 2, commands: [c(230, [1])] })).rejects.toThrow();
    await expect(insertEventCommands(project, { target: 'troop_page', troopId: 1, pageIndex: 1, commands: [c(230, [1])] })).rejects.toThrow();
  });

  it('advises about unknown plugin commands without prohibiting them', async () => {
    const result = await insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(900, ['extension'])] });
    expect(result.warnings.join(' ')).toMatch(/900/);
  });

  it('does not assume an empty System metadata fixture imposes zero available switches', async () => {
    await save('System.json', { switches: [], variables: [] });
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(121, [1, 5, 0])] })).resolves.toBeDefined();
  });

  it('checks variable operands and direct transfer coordinates', async () => {
    for (const command of [c(122, [1, 1, 0, 1, 2]), c(201, [0, 1, 20, 0, 2, 0])]) {
      await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands: [command] })).rejects.toThrow();
    }
  });

  it('refuses to write into an already malformed event list', async () => {
    await save('CommonEvents.json', [null, { id: 1, list: [c(111, [0, 1, 0]), c(0)] }]);
    const before = await snapshot();
    await expect(insertEventCommands(project, { target: 'common_event', commonEventId: 1, commands: [c(230, [1])] })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    [c(111, [4, 2, 0]), c(0, [], 1), c(412)],
    [c(111, [8, 2]), c(0, [], 1), c(412)],
    ...[0, 1, 2, 3].map(type => [c(122, [1, 1, 0, 3, type, 2, 0])]),
  ])('checks statically resolvable actor/item/game-data references %j', async (...commands) => {
    const before = await snapshot();
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('returns a compact result by default and the full lists only with verbose', async () => {
    const compact = await insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(230, [30])], dryRun: true });
    expect(compact).not.toHaveProperty('before');
    expect(compact).not.toHaveProperty('after');
    expect(compact.listLength).toBe(3);
    expect(compact.listCodes).toEqual([108, 230, 0]);
    const full = await insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(230, [30])], dryRun: true, verbose: true });
    expect(full.before).toEqual(original);
    expect(full.after).toHaveLength(3);
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands: [c(230, [1])], verbose: 'yes' })).rejects.toThrow(/verbose/);
  });

  it('inserts into a page whose When Cancel row has the editor shape [6, null]', async () => {
    const list = [c(102, [['Yes', 'No'], -2, 0, 2, 0]), c(402, [0, 'Yes']), c(0, [], 1),
      c(402, [1, 'No']), c(0, [], 1), c(403, [6, null]), c(0, [], 1), c(404), c(0)];
    await save('Map001.json', { events: [null, { id: 1, pages: [{ list }] }] });
    const result = await insertEventCommands(project, { mapId: 1, eventId: 1, position: 6, commands: [c(108, ['Cancelled'])], verbose: true });
    expect(result.after![6]).toEqual(c(108, ['Cancelled'], 1));
    expect(result.after![5]).toEqual(c(403, [6, null]));
  });

  it.each([
    [c(111, [9, 2, false]), c(0, [], 1), c(412)],
    [c(111, [10, 2, false]), c(0, [], 1), c(412)],
  ])('checks weapon and armor condition references %j', async (...commands) => {
    const before = await snapshot();
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands })).rejects.toThrow(/Weapon|Armor/);
    expect(await snapshot()).toEqual(before);
    commands[0].parameters[1] = 1;
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands, dryRun: true })).resolves.toBeDefined();
  });

  it.each([
    ['change_items', { itemType: 'weapon', itemId: 2, amount: 1 }],
    ['change_items', { itemId: 1, amountVariableId: 9 }],
    ['change_gold', { amountVariableId: 9 }],
    ['change_party_member', { actorId: 2 }],
    ['name_input', { actorId: 2 }],
    ['show_animation', { animationId: 2 }],
    ['shop_processing', { goods: [{ id: 1 }, { type: 'armor', id: 2 }] }],
    ['change_actor', { stat: 'state', actorId: 1, stateId: 2 }],
    ['change_actor', { stat: 'hp', actorId: 2, amount: 1 }],
    ['change_actor', { stat: 'mp', actorVariableId: 9, amount: 1 }],
    ['change_enemy_state', { enemyIndex: 0, stateId: 2 }],
    ['show_picture', { pictureId: 1, name: 'x', designation: 'variable', x: 1, y: 9 }],
  ])('refuses a %s fragment with a missing reference %j', async (kind, args) => {
    const before = await snapshot();
    const commands = buildEventCommands({ kind, ...args }).commands;
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('accepts the new kinds when every reference exists', async () => {
    const commands = [
      ...buildEventCommands({ kind: 'change_items', itemType: 'armor', itemId: 1, amountVariableId: 1 }).commands,
      ...buildEventCommands({ kind: 'shop_processing', goods: [{ id: 1 }, { type: 'weapon', id: 1 }] }).commands,
      ...buildEventCommands({ kind: 'change_actor', stat: 'state', actorId: 0, stateId: 1 }).commands,
      ...buildEventCommands({ kind: 'change_party_member', actorId: 1 }).commands,
      ...buildEventCommands({ kind: 'show_animation', animationId: 1 }).commands,
    ];
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands, dryRun: true })).resolves.toBeDefined();
  });

  it('accepts existing actor/item/game-data references', async () => {
    const commands = [c(111, [4, 1, 0]), c(0, [], 1), c(412), c(111, [8, 1]), c(0, [], 1), c(412),
      ...[0, 1, 2, 3].map(type => c(122, [1, 1, 0, 3, type, 1, 0]))];
    await expect(insertEventCommands(project, { mapId: 1, eventId: 1, commands, dryRun: true })).resolves.toBeDefined();
  });
});

describe('MV event-list structure', () => {
  it('accepts complete nested choices, conditional branches, and loops', () => {
    const list = [c(102, [['Yes', 'No'], -2, 0, 2, 0]), c(402, [0, 'Yes']),
      c(112, [], 1), c(113, [], 2), c(0, [], 2), c(413, [], 1), c(0, [], 1),
      c(402, [1, 'No']), c(111, [0, 1, 0], 1), c(0, [], 2), c(412, [], 1), c(0, [], 1),
      c(403), c(0, [], 1), c(404), c(0)];
    expect(validateEventCommands(list).commands).toEqual(list);
  });

  it('accepts When Cancel both as the builder writes it and as the editor saves it', () => {
    const list = (cancel: unknown[]) => [c(102, [['Yes'], 1, 0, 2, 0]), c(402, [0, 'Yes']), c(0, [], 1),
      c(403, cancel), c(0, [], 1), c(404), c(0)];
    expect(() => validateEventCommands(list([]))).not.toThrow();
    expect(() => validateEventCommands(list([6, null]))).not.toThrow();
    expect(() => validateEventCommands(list([6]))).toThrow(/403 expects 0 or 2/);
  });

  it.each([
    [c(411), c(0)],
    [c(111, [0, 1, 0]), c(0, [], 1), c(411), c(0, [], 1), c(411), c(412), c(0)],
    [c(112), c(230, [1], 2), c(413), c(0)],
    [c(102, [['Yes'], -1, 0, 2, 0]), c(404), c(0)],
    [c(102, [['Yes'], -1, 0, 2, 0]), c(402, [0, 'Yes']), c(0, [], 1), c(402, [0, 'Yes']), c(404), c(0)],
    [c(111, [0, 1, 0]), c(0, [], 1), c(230, [1], 1), c(412), c(0)],
    [c(108, ['missing final marker'])],
  ])('rejects malformed block structure %j', (...commands) => {
    expect(() => validateEventCommands(commands)).toThrow();
  });

  it('validates continuations as one unit and marks only safe insertion positions', () => {
    const list = [c(355, ['const answer = 42;']), c(655, ['console.log(answer);']), c(0)];
    expect([...validateEventCommands(list).insertionPoints.keys()]).toEqual([0, 2]);
    expect(() => validateEventCommands([c(108, [undefined]), c(0)])).toThrow(/JSON/);
    expect(() => validateEventCommands([c(230, [NaN]), c(0)])).toThrow(/JSON/);
  });
});
