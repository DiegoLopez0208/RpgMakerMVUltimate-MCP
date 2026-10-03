import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getPartyMembers,
  updatePartyMembers,
  getTerms,
  setTerm,
  getTypes,
  setTypeName,
  setCurrencyUnit,
  getTitleScreen,
  updateTitleScreen,
  systemToolDefinitions,
} from '../../src/parity/tools/systemTools.js';

/** A minimal System.json with the fields these tools touch. */
function seedSystem() {
  return {
    partyMembers: [1],
    currencyUnit: 'G',
    elements: ['', 'Physical', 'Fire'],
    skillTypes: ['', 'Magic'],
    weaponTypes: ['', 'Dagger', 'Sword'],
    armorTypes: ['', 'General Armor'],
    equipTypes: ['', 'Weapon', 'Shield'],
    terms: {
      basic: ['Level', 'Lv', 'HP', 'HP'],
      commands: ['Fight', 'Escape'],
      params: ['Max HP', 'Max MP'],
      messages: { actorDamage: '%1 took %2 damage!' },
    },
    title1Name: 'Castle',
    title2Name: '',
    titleBgm: { name: 'Theme1', volume: 90, pitch: 100, pan: 0 },
    optDrawTitle: true,
  };
}

/** Scaffold a project with System.json and a 2-actor Actors.json (ids 1 and 2). */
async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-system-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), JSON.stringify(seedSystem()));
  await writeFile(
    join(dir, 'data', 'Actors.json'),
    JSON.stringify([null, { id: 1, name: 'Harold' }, { id: 2, name: 'Therese' }]),
  );
  return dir;
}

describe('system tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get_party / set_party round-trip and persist compactly', async () => {
    expect(await getPartyMembers(dir)).toEqual([1]);

    await updatePartyMembers(dir, [2, 1]);
    expect(await getPartyMembers(dir)).toEqual([2, 1]);

    const raw = await readFile(join(dir, 'data', 'System.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('set_party rejects a non-existent actor id', async () => {
    await expect(updatePartyMembers(dir, [1, 99])).rejects.toThrow(/actor id 99 does not exist/);
  });

  it('the get_party handler returns { partyMembers }, rhyming with set_party (P2-8)', async () => {
    const def = systemToolDefinitions.find((t) => t.name === 'get_party')!;
    const result = (await def.handler({ projectPath: dir }, {})) as { partyMembers: number[] };
    expect(result).toEqual({ partyMembers: [1] });
  });

  it('setTerm edits an indexed array category', async () => {
    const terms = await setTerm(dir, 'commands', '0', 'Attack');
    expect(terms.commands[0]).toBe('Attack');
    expect((await getTerms(dir)).commands[0]).toBe('Attack');
  });

  it('setTerm edits a message-key category', async () => {
    await setTerm(dir, 'messages', 'actorRecovery', '%1 recovered %2 HP!');
    expect((await getTerms(dir)).messages.actorRecovery).toBe('%1 recovered %2 HP!');
  });

  it('setTerm throws on an out-of-range index', async () => {
    await expect(setTerm(dir, 'basic', '99', 'x')).rejects.toThrow(/out of range/);
  });

  it('getTypes / setTypeName round-trip', async () => {
    expect(await getTypes(dir, 'weaponTypes')).toEqual(['', 'Dagger', 'Sword']);
    const updated = await setTypeName(dir, 'weaponTypes', 2, 'Broadsword');
    expect(updated[2]).toBe('Broadsword');
    expect(await getTypes(dir, 'weaponTypes')).toEqual(['', 'Dagger', 'Broadsword']);
  });

  it('setTypeName throws on an out-of-range index', async () => {
    await expect(setTypeName(dir, 'elements', 99, 'Plasma')).rejects.toThrow(/out of range/);
  });

  it('setCurrencyUnit updates the unit', async () => {
    await setCurrencyUnit(dir, 'Gold');
    const raw = JSON.parse(await readFile(join(dir, 'data', 'System.json'), 'utf-8'));
    expect(raw.currencyUnit).toBe('Gold');
  });

  it('getTitleScreen reads title1Name/title2Name/titleBgm/drawTitle off System.json', async () => {
    expect(await getTitleScreen(dir)).toEqual({
      title1Name: 'Castle',
      title2Name: '',
      titleBgm: { name: 'Theme1', volume: 90, pitch: 100, pan: 0 },
      drawTitle: true,
    });
  });

  it('updateTitleScreen only changes the provided fields', async () => {
    await updateTitleScreen(dir, { title2Name: 'Overlay', drawTitle: false });
    expect(await getTitleScreen(dir)).toEqual({
      title1Name: 'Castle', // unchanged
      title2Name: 'Overlay',
      titleBgm: { name: 'Theme1', volume: 90, pitch: 100, pan: 0 }, // unchanged
      drawTitle: false,
    });
  });

  describe('update_title_screen tool (asset warnings)', () => {
    beforeEach(async () => {
      await mkdir(join(dir, 'img', 'titles1'), { recursive: true });
      await writeFile(join(dir, 'img', 'titles1', 'Castle.png'), '');
      await mkdir(join(dir, 'audio', 'bgm'), { recursive: true });
      await writeFile(join(dir, 'audio', 'bgm', 'Theme1.ogg'), '');
    });

    it('returns no warnings for known asset names', async () => {
      const def = systemToolDefinitions.find((t) => t.name === 'update_title_screen')!;
      const result = (await def.handler({ projectPath: dir }, { title1Name: 'Castle' })) as {
        warnings?: unknown[];
      };
      expect(result.warnings).toBeUndefined();
    });

    it('warns (but still writes) on an unknown image/audio name', async () => {
      const def = systemToolDefinitions.find((t) => t.name === 'update_title_screen')!;
      const result = (await def.handler(
        { projectPath: dir },
        { title1Name: 'NoSuchImage', titleBgm: { name: 'NoSuchTrack' } },
      )) as { title1Name: string; warnings?: { path: string }[] };

      expect(result.title1Name).toBe('NoSuchImage');
      expect(result.warnings?.map((w) => w.path).sort()).toEqual(['title1Name', 'titleBgm.name']);

      // Update still persisted despite the warning.
      expect((await getTitleScreen(dir)).title1Name).toBe('NoSuchImage');
    });

    it('defaults titleBgm volume/pitch/pan when omitted', async () => {
      const def = systemToolDefinitions.find((t) => t.name === 'update_title_screen')!;
      await def.handler({ projectPath: dir }, { titleBgm: { name: 'Theme1' } });
      expect((await getTitleScreen(dir)).titleBgm).toEqual({
        name: 'Theme1',
        volume: 90,
        pitch: 100,
        pan: 0,
      });
    });
  });
});
