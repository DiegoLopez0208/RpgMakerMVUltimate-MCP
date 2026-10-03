import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Item, Weapon, Armor, Skill } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { definedOnly } from '../utils/records.js';
import { firstMissingEffectRef } from '../validation/createRefs.js';
import { assertMvActionScope, mvActionScopeSchema, mvActionScopeDescription } from '../../utils/actionScope.js';

/** The editor's shape for a fresh "New Item" (all zeros / sensible defaults). */
export function defaultItem(): Omit<Item, 'id'> {
  return {
    name: '',
    description: '',
    iconIndex: 0,
    itypeId: 1, // Regular Item
    scope: 0, // None
    occasion: 0, // Always
    speed: 0,
    successRate: 100,
    repeats: 1,
    tpGain: 0,
    hitType: 0,
    animationId: 0,
    price: 0,
    consumable: true,
    damage: { type: 0, elementId: 0, formula: '0', variance: 20, critical: false },
    effects: [],
    note: '',
  };
}

/** The editor's shape for a fresh "New Weapon". `etypeId` 1 = Weapon slot; flat param bonuses. */
export function defaultWeapon(): Omit<Weapon, 'id'> {
  return {
    name: '',
    description: '',
    iconIndex: 0,
    wtypeId: 1,
    price: 0,
    params: [0, 0, 0, 0, 0, 0, 0, 0],
    traits: [],
    etypeId: 1,
    animationId: 0,
    note: '',
  };
}

/** The editor's shape for a fresh "New Armor". `etypeId` 2 = Shield slot; flat param bonuses. */
export function defaultArmor(): Omit<Armor, 'id'> {
  return {
    name: '',
    description: '',
    iconIndex: 0,
    atypeId: 1,
    price: 0,
    params: [0, 0, 0, 0, 0, 0, 0, 0],
    traits: [],
    etypeId: 2,
    note: '',
  };
}

/**
 * Get all items from the project
 */
export async function getItems(projectPath: string): Promise<(Item | null)[]> {
  const itemsPath = getDataPath(projectPath, 'Items.json');
  return await readJsonFile<(Item | null)[]>(itemsPath);
}

/**
 * Get all weapons from the project
 */
export async function getWeapons(projectPath: string): Promise<(Weapon | null)[]> {
  const weaponsPath = getDataPath(projectPath, 'Weapons.json');
  return await readJsonFile<(Weapon | null)[]>(weaponsPath);
}

/**
 * Get all armors from the project
 */
export async function getArmors(projectPath: string): Promise<(Armor | null)[]> {
  const armorsPath = getDataPath(projectPath, 'Armors.json');
  return await readJsonFile<(Armor | null)[]>(armorsPath);
}

/**
 * Get all skills from the project
 */
export async function getSkills(projectPath: string): Promise<(Skill | null)[]> {
  const skillsPath = getDataPath(projectPath, 'Skills.json');
  return await readJsonFile<(Skill | null)[]>(skillsPath);
}

/**
 * Get a specific item by ID
 */
export async function getItem(projectPath: string, itemId: number): Promise<Item | null> {
  const items = await getItems(projectPath);
  return items.find((item) => item && item.id === itemId) || null;
}

/**
 * Update an item's data
 */
export async function updateItem(
  projectPath: string,
  itemId: number,
  updates: Partial<Item>,
): Promise<Item> {
  if ('scope' in updates) assertMvActionScope(updates.scope);
  const items = await getItems(projectPath);
  const itemIndex = items.findIndex((item) => item && item.id === itemId);

  if (itemIndex === -1) {
    throw new Error(`Item with ID ${itemId} not found`);
  }

  items[itemIndex] = { ...items[itemIndex]!, ...updates, id: itemId };

  const itemsPath = getDataPath(projectPath, 'Items.json');
  await commitChange(itemsPath, items);

  return items[itemIndex]!;
}

/**
 * Build one new item record against the current array — the shared per-record
 * source of truth for both `create_item` and `batch_create`. Pure record
 * construction only (`defaultItem()` template + caller overrides + id-last); the
 * effect reference check stays with the caller (it needs cross-file reads).
 */
export function buildItemRecord(existing: (Item | null)[], input: Partial<Omit<Item, 'id'>>): Item {
  if (input.scope !== undefined) assertMvActionScope(input.scope);
  const maxId = existing.reduce((max, item) => (item && item.id > max ? item.id : max), 0);
  return {
    ...defaultItem(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

/** Build one new weapon record against the current array (shared by create/batch). */
export function buildWeaponRecord(
  existing: (Weapon | null)[],
  input: Partial<Omit<Weapon, 'id'>>,
): Weapon {
  const maxId = existing.reduce((max, w) => (w && w.id > max ? w.id : max), 0);
  return {
    ...defaultWeapon(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

/** Build one new armor record against the current array (shared by create/batch). */
export function buildArmorRecord(
  existing: (Armor | null)[],
  input: Partial<Omit<Armor, 'id'>>,
): Armor {
  const maxId = existing.reduce((max, a) => (a && a.id > max ? a.id : max), 0);
  return {
    ...defaultArmor(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

/**
 * Reject an item whose effects point at a non-existent state / skill / common
 * event (P2-3: throw at author time, matching create_skill and its siblings).
 * Shared by `create_item` and `batch_create`.
 */
export async function assertItemEffectRefs(projectPath: string, item: Item): Promise<void> {
  const [states, skills, commonEvents] = await Promise.all([
    readJsonArraySoft(getDataPath(projectPath, 'States.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Skills.json')),
    readJsonArraySoft(getDataPath(projectPath, 'CommonEvents.json')),
  ]);
  const missing = firstMissingEffectRef(item.effects, { states, skills, commonEvents });
  if (missing) {
    throw new Error(`Cannot create item "${item.name}": ${missing}`);
  }
}

/**
 * Create a new item. Only the fields the caller supplies override the
 * `defaultItem()` template; the computed id always wins (spread last).
 */
export async function createItem(
  projectPath: string,
  overrides: Partial<Omit<Item, 'id'>>,
): Promise<Item> {
  const items = await getItems(projectPath);

  const newItem = buildItemRecord(items, overrides);

  await assertItemEffectRefs(projectPath, newItem);

  items[newItem.id] = newItem;

  const itemsPath = getDataPath(projectPath, 'Items.json');
  await commitChange(itemsPath, items);

  return newItem;
}

/**
 * Create a new weapon. Overrides merge over the `defaultWeapon()` template; the
 * computed id always wins.
 */
export async function createWeapon(
  projectPath: string,
  overrides: Partial<Omit<Weapon, 'id'>>,
): Promise<Weapon> {
  const weapons = await getWeapons(projectPath);
  const newWeapon = buildWeaponRecord(weapons, overrides);
  weapons[newWeapon.id] = newWeapon;

  const weaponsPath = getDataPath(projectPath, 'Weapons.json');
  await commitChange(weaponsPath, weapons);

  return newWeapon;
}

/**
 * Create a new armor. Overrides merge over the `defaultArmor()` template; the
 * computed id always wins.
 */
export async function createArmor(
  projectPath: string,
  overrides: Partial<Omit<Armor, 'id'>>,
): Promise<Armor> {
  const armors = await getArmors(projectPath);
  const newArmor = buildArmorRecord(armors, overrides);
  armors[newArmor.id] = newArmor;

  const armorsPath = getDataPath(projectPath, 'Armors.json');
  await commitChange(armorsPath, armors);

  return newArmor;
}

/**
 * Update a weapon's data
 */
export async function updateWeapon(
  projectPath: string,
  weaponId: number,
  updates: Partial<Weapon>,
): Promise<Weapon> {
  const weapons = await getWeapons(projectPath);
  const weaponIndex = weapons.findIndex((weapon) => weapon && weapon.id === weaponId);

  if (weaponIndex === -1) {
    throw new Error(`Weapon with ID ${weaponId} not found`);
  }

  weapons[weaponIndex] = { ...weapons[weaponIndex]!, ...updates, id: weaponId };

  const weaponsPath = getDataPath(projectPath, 'Weapons.json');
  await commitChange(weaponsPath, weapons);

  return weapons[weaponIndex]!;
}

/**
 * Update an armor's data
 */
export async function updateArmor(
  projectPath: string,
  armorId: number,
  updates: Partial<Armor>,
): Promise<Armor> {
  const armors = await getArmors(projectPath);
  const armorIndex = armors.findIndex((armor) => armor && armor.id === armorId);

  if (armorIndex === -1) {
    throw new Error(`Armor with ID ${armorId} not found`);
  }

  armors[armorIndex] = { ...armors[armorIndex]!, ...updates, id: armorId };

  const armorsPath = getDataPath(projectPath, 'Armors.json');
  await commitChange(armorsPath, armors);

  return armors[armorIndex]!;
}

/**
 * Update a skill's data
 */
export async function updateSkill(
  projectPath: string,
  skillId: number,
  updates: Partial<Skill>,
): Promise<Skill> {
  if ('scope' in updates) assertMvActionScope(updates.scope);
  const skills = await getSkills(projectPath);
  const skillIndex = skills.findIndex((skill) => skill && skill.id === skillId);

  if (skillIndex === -1) {
    throw new Error(`Skill with ID ${skillId} not found`);
  }

  skills[skillIndex] = { ...skills[skillIndex]!, ...updates };

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return skills[skillIndex]!;
}

/**
 * Search items by name or description
 */
export async function searchItems(projectPath: string, searchTerm: string): Promise<Item[]> {
  const items = await getItems(projectPath);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return items.filter(
    (item): item is Item =>
      !!item &&
      (item.name.toLowerCase().includes(lowerSearchTerm) ||
        item.description.toLowerCase().includes(lowerSearchTerm)),
  );
}

export const itemToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_item',
    mutates: true,
    description:
      "Create a new item in data/Items.json. Only `name` is worth passing; omitted fields use the editor's new-item defaults (Regular Item, consumable, no effects). Allocates and returns the next unused item id. An effect referencing a missing record throws: Add/Remove State (code 21/22) → state, Learn Skill (43) → skill, Common Event (44) → common event.",
    inputSchema: {
      name: z.string().describe('Item name'),
      description: z.string().optional().describe('In-game description text'),
      iconIndex: z.number().int().optional().describe('Icon index (IconSet.png)'),
      itypeId: z
        .number()
        .int()
        .optional()
        .describe('Item type: 1 Regular, 2 Key Item, 3 Hidden A, 4 Hidden B'),
      scope: mvActionScopeSchema.optional().describe(mvActionScopeDescription),
      occasion: z.number().int().optional().describe('Usable: 0 always, 1 battle, 2 menu, 3 never'),
      price: z.number().int().optional().describe('Buy price (sells for half)'),
      consumable: z.boolean().optional().describe('Consumed on use'),
      speed: z.number().int().optional().describe('Speed correction (positive acts earlier)'),
      successRate: z.number().int().optional().describe('Success rate percent'),
      repeats: z.number().int().optional().describe('Number of hits/repeats'),
      tpGain: z.number().int().optional().describe('User TP gained on use'),
      hitType: z.number().int().optional().describe('0 certain, 1 physical, 2 magical'),
      animationId: z.number().int().optional().describe('Animation id shown on use'),
      damage: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Damage object { type, elementId, formula, variance, critical }'),
      effects: z
        .array(z.unknown())
        .optional()
        .describe('Effect objects { code, dataId, value1, value2 }'),
      note: z.string().optional().describe('Note field'),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createItem(ctx.projectPath, overrides as Partial<Omit<Item, 'id'>>);
    },
  },
  {
    name: 'update_item',
    mutates: true,
    description: "Update an item's properties (shallow merge into the existing record)",
    inputSchema: {
      itemId: z.number().int().positive().describe('The ID of the item to update'),
      updates: z
        .object({ scope: mvActionScopeSchema.optional() })
        .passthrough()
        .describe('Object containing item properties to update'),
    },
    handler: (ctx, args) => updateItem(ctx.projectPath, args.itemId, args.updates),
  },
  {
    name: 'search_items',
    description: 'Search items by name or description',
    inputSchema: { searchTerm: z.string().describe('The search term to find items') },
    handler: (ctx, args) => searchItems(ctx.projectPath, args.searchTerm),
  },
  {
    name: 'create_weapon',
    mutates: true,
    description:
      "Create a new weapon in data/Weapons.json. Only `name` is required; omitted fields use the editor's new-weapon defaults (Weapon equip slot, no stat bonuses). `params` is a flat 8-length stat bonus [maxHP, maxMP, atk, def, mat, mdf, agi, luk]. Allocates and returns the next unused weapon id.",
    inputSchema: {
      name: z.string().describe('Weapon name'),
      description: z.string().optional().describe('In-game description text'),
      iconIndex: z.number().int().optional().describe('Icon index (IconSet.png)'),
      wtypeId: z.number().int().optional().describe('Weapon type id (System.json weaponTypes)'),
      price: z.number().int().optional().describe('Buy price'),
      params: z
        .array(z.number())
        .length(8)
        .optional()
        .describe('8 flat stat bonuses [maxHP, maxMP, atk, def, mat, mdf, agi, luk]'),
      animationId: z.number().int().optional().describe('Attack animation id'),
      traits: z.array(z.unknown()).optional().describe('Trait objects { code, dataId, value }'),
      note: z.string().optional().describe('Note field'),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createWeapon(ctx.projectPath, overrides as Partial<Omit<Weapon, 'id'>>);
    },
  },
  {
    name: 'update_weapon',
    mutates: true,
    description: "Update a weapon's properties (shallow merge into the existing record)",
    inputSchema: {
      weaponId: z.number().int().positive().describe('The ID of the weapon to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing weapon properties to update'),
    },
    handler: (ctx, args) => updateWeapon(ctx.projectPath, args.weaponId, args.updates),
  },
  {
    name: 'create_armor',
    mutates: true,
    description:
      "Create a new armor in data/Armors.json. Only `name` is required; omitted fields use the editor's new-armor defaults (Shield equip slot, no stat bonuses). `params` is a flat 8-length stat bonus; `etypeId` is the equip slot (System.json equipTypes: 2 Shield, 3 Head, 4 Body, 5 Accessory). Allocates and returns the next unused armor id.",
    inputSchema: {
      name: z.string().describe('Armor name'),
      description: z.string().optional().describe('In-game description text'),
      iconIndex: z.number().int().optional().describe('Icon index (IconSet.png)'),
      atypeId: z.number().int().optional().describe('Armor type id (System.json armorTypes)'),
      etypeId: z
        .number()
        .int()
        .optional()
        .describe('Equip slot (equipTypes: 2 Shield, 3 Head, 4 Body, 5 Accessory)'),
      price: z.number().int().optional().describe('Buy price'),
      params: z
        .array(z.number())
        .length(8)
        .optional()
        .describe('8 flat stat bonuses [maxHP, maxMP, atk, def, mat, mdf, agi, luk]'),
      traits: z.array(z.unknown()).optional().describe('Trait objects { code, dataId, value }'),
      note: z.string().optional().describe('Note field'),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createArmor(ctx.projectPath, overrides as Partial<Omit<Armor, 'id'>>);
    },
  },
  {
    name: 'update_armor',
    mutates: true,
    description: "Update an armor's properties (shallow merge into the existing record)",
    inputSchema: {
      armorId: z.number().int().positive().describe('The ID of the armor to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing armor properties to update'),
    },
    handler: (ctx, args) => updateArmor(ctx.projectPath, args.armorId, args.updates),
  },
];
