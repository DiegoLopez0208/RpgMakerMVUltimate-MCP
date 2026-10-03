import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createItem,
  defaultItem,
  createWeapon,
  defaultWeapon,
  updateWeapon,
  createArmor,
  defaultArmor,
  updateArmor,
  getItems,
  getWeapons,
} from '../../src/parity/tools/itemTools.js';
import { Item, Weapon, Armor } from '../../src/parity/utils/types.js';

/** Scaffold a minimal project with seeded Items/Weapons/Armors.json. */
async function scaffoldProject(
  items: (Item | null)[],
  weapons: (Weapon | null)[],
  armors: (Armor | null)[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-item-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Items.json'), JSON.stringify(items));
  await writeFile(join(dir, 'data', 'Weapons.json'), JSON.stringify(weapons));
  await writeFile(join(dir, 'data', 'Armors.json'), JSON.stringify(armors));
  return dir;
}

const potion: Item = { ...defaultItem(), id: 1, name: 'Potion' };
const sword: Weapon = { ...defaultWeapon(), id: 1, name: 'Short Sword' };
const shield: Armor = { ...defaultArmor(), id: 1, name: 'Small Shield' };

describe('item/equipment tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject([null, potion], [null, sword], [null, shield]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createItem assigns the next id, applies the full default shape, and persists compactly', async () => {
    const created = await createItem(dir, { name: 'Ether', price: 50 });
    expect(created.id).toBe(2);
    expect(created.price).toBe(50);
    // Fields that were missing from the old Item type must now be present.
    expect(created.itypeId).toBe(1);
    expect(created.consumable).toBe(true);
    expect(created.damage).toEqual({
      type: 0,
      elementId: 0,
      formula: '0',
      variance: 20,
      critical: false,
    });
    expect(created.effects).toEqual([]);

    const items = await getItems(dir);
    expect(items.find((i) => i?.id === 2)?.name).toBe('Ether');

    const raw = await readFile(join(dir, 'data', 'Items.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createItem never lets a caller set the id', async () => {
    const created = await createItem(dir, { name: 'Elixir', id: 99 } as Partial<
      Omit<Item, 'id'>
    > & { id: number });
    expect(created.id).toBe(2);
  });

  it('createWeapon applies defaults, honors params, and computes the id', async () => {
    const created = await createWeapon(dir, {
      name: 'Long Sword',
      params: [0, 0, 12, 0, 0, 0, 0, 0],
      wtypeId: 2,
    });
    expect(created.id).toBe(2);
    expect(created.etypeId).toBe(1); // weapon slot
    expect(created.params).toEqual([0, 0, 12, 0, 0, 0, 0, 0]);
    expect(created.traits).toEqual([]);

    const weapons = await getWeapons(dir);
    expect(weapons.find((w) => w?.id === 2)?.name).toBe('Long Sword');
  });

  it('updateWeapon shallow-merges into the existing record', async () => {
    const updated = await updateWeapon(dir, 1, { price: 999 });
    expect(updated.price).toBe(999);
    expect(updated.name).toBe('Short Sword'); // untouched
  });

  it('createArmor defaults to the Shield equip slot and computes the id', async () => {
    const created = await createArmor(dir, {
      name: 'Iron Shield',
      params: [0, 0, 0, 5, 0, 0, 0, 0],
    });
    expect(created.id).toBe(2);
    expect(created.etypeId).toBe(2); // shield slot
    expect(created.atypeId).toBe(1);
    expect(created.params[3]).toBe(5);
  });

  it('updateArmor shallow-merges into the existing record', async () => {
    const updated = await updateArmor(dir, 1, { etypeId: 3 });
    expect(updated.etypeId).toBe(3);
    expect(updated.name).toBe('Small Shield');
  });

  it('updateWeapon throws on an unknown id', async () => {
    await expect(updateWeapon(dir, 999, { price: 1 })).rejects.toThrow(/not found/);
  });
});
