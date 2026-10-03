import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommonEvent, updateCommonEvent, addCommonEventCommand } from '../src/tools/commonEventTools.js';
import { createTroop, updateTroop } from '../src/tools/troopTools.js';
import { createMapEvent, updateMapEvent, addEventCommand, setMapEncounters } from '../src/tools/mapTools.js';
import { blankMapData, blankEventPage } from '../src/parity/tools/mapTools.js';
import { blankTroopPage } from '../src/parity/tools/battleTools.js';

const end = { code: 0, indent: 0, parameters: [] };
const mzCommands = [
  { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'MZ speaker'] },
  { code: 357, indent: 0, parameters: ['MZ', 'command', '', {}] },
  { code: 657, indent: 0, parameters: ['MZ annotation'] },
  { code: 122, indent: 0, parameters: [1, 1, 0, 3, 8, 0, 0] },
];

describe('legacy MV authored-list compatibility guard', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rpgmv-legacy-compat-'));
    await mkdir(join(dir, 'data'));
    const map = blankMapData(10, 10, 1);
    map.events = [null, { id: 1, name: 'Event', note: '', x: 2, y: 2, pages: [blankEventPage()] }];
    await Promise.all(Object.entries({
      'Map001.json': map,
      'System.json': {},
      'CommonEvents.json': [null, { id: 1, name: 'Common', trigger: 0, switchId: 1, list: [end] }],
      'Troops.json': [null, { id: 1, name: 'Troop', members: [], pages: [blankTroopPage()] }],
    }).map(([name, data]) => writeFile(join(dir, 'data', name), JSON.stringify(data))));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const bytes = (name: string) => readFile(join(dir, 'data', name), 'utf8');

  it.each(mzCommands)('rejects code $code on all legacy command-list writes before files/backups change', async command => {
    const originals = await Promise.all(['Map001.json', 'CommonEvents.json', 'Troops.json'].map(bytes));
    const page = { ...blankEventPage(), list: [command, end] };
    const troopPage = { ...blankTroopPage(), list: [command, end] };
    const writes = [
      () => createCommonEvent(dir, { name: 'New', list: [command, end], force: true } as never),
      () => updateCommonEvent(dir, 1, { list: [command, end], force: true } as never),
      () => addCommonEventCommand(dir, 1, command),
      () => createTroop(dir, { name: 'New', pages: [troopPage], force: true } as never),
      () => updateTroop(dir, 1, { pages: [troopPage], force: true } as never),
      () => createMapEvent(dir, 1, 2, 2, 'New', 0, [page]),
      () => updateMapEvent(dir, 1, 1, { pages: [page], force: true } as never),
      () => addEventCommand(dir, 1, 1, 0, command),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow(/MV|MZ/);
    expect(await Promise.all(['Map001.json', 'CommonEvents.json', 'Troops.json'].map(bytes))).toEqual(originals);
    expect((await readdir(join(dir, 'data'))).some(name => name.endsWith('.bak'))).toBe(false);
    expect(await readdir(dir)).not.toContain('.mcp-backups');
  });

  it('keeps incremental legacy block construction available', async () => {
    const opener = { code: 102, indent: 0, parameters: [['Yes', 'No'], -1, 0, 2, 0] };
    await addCommonEventCommand(dir, 1, opener);
    await addEventCommand(dir, 1, 1, 0, opener);
    const common = JSON.parse(await bytes('CommonEvents.json'));
    const map = JSON.parse(await bytes('Map001.json'));
    expect(common[1].list).toEqual([opener, end]);
    expect(map.events[1].pages[0].list).toEqual([opener, end]);
    const mvPlugin = { code: 356, indent: 0, parameters: ['DoorCtl open'] };
    await createCommonEvent(dir, { name: 'Plugin', list: [mvPlugin, end] });
    expect(JSON.parse(await bytes('CommonEvents.json'))[2].list).toEqual([mvPlugin, end]);
  });

  it('also guards map paths that write directly without writeMapJson', async () => {
    const map = JSON.parse(await bytes('Map001.json'));
    map.events[1].pages[0].list = [mzCommands[1], end];
    await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));
    const before = await bytes('Map001.json');
    await expect(setMapEncounters(dir, 1, [], 30)).rejects.toThrow(/MZ/);
    expect(await bytes('Map001.json')).toBe(before);
    expect((await readdir(join(dir, 'data'))).some(name => name.endsWith('.bak'))).toBe(false);
  });
});
