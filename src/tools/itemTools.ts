// @ts-nocheck
import { readJson, writeJson, nextId } from '../utils/fileHandler.js';

/**
 * Get all items from the RPG Maker MV project.
 * Reads Items.json and returns all non-null entries.
 */
async function getItems(projectPath) {
  const items = await readJson(projectPath, 'Items.json');
  return items.filter(function(i) { return i !== null; });
}

/**
 * Get all weapons from the RPG Maker MV project.
 * Reads Weapons.json and returns all non-null entries.
 */
async function getWeapons(projectPath) {
  const weapons = await readJson(projectPath, 'Weapons.json');
  return weapons.filter(function(w) { return w !== null; });
}

/**
 * Get all armors from the RPG Maker MV project.
 * Reads Armors.json and returns all non-null entries.
 */
async function getArmors(projectPath) {
  const armors = await readJson(projectPath, 'Armors.json');
  return armors.filter(function(a) { return a !== null; });
}

/**
 * Get all skills from the RPG Maker MV project.
 * Reads Skills.json and returns all non-null entries.
 */
async function getSkillsList(projectPath) {
  const skills = await readJson(projectPath, 'Skills.json');
  return skills.filter(function(s) { return s !== null; });
}

/**
 * Create a new item (consumable: potions, scrolls, etc.).
 * Generates a complete RPG Maker MV item object.
 * @param {string} projectPath - The project root path
 * @param {object} params - Item properties
 */
async function createItem(projectPath, params) {
  const items = await readJson(projectPath, 'Items.json');
  const newId = nextId(items);

  const newItem = {
    id: newId,
    name: params.name || '',
    description: params.description || '',
    iconIndex: params.iconIndex || 0,
    itypeId: params.itypeId || 1,         // 1=normal item, 2=key item
    price: params.price || 0,
    consumable: params.consumable !== undefined ? params.consumable : true,
    scope: params.scope || 7,             // 7=all allies, 11=user, 1=single enemy
    occasion: params.occasion || 1,       // 0=always, 1=battle, 2=menu, 3=never
    animationId: params.animationId || 0,
    effects: params.effects || [],
    traits: params.traits || [],
    note: params.note || ''
  };

  while (items.length <= newId) items.push(null);
  items[newId] = newItem;

  await writeJson(projectPath, 'Items.json', items);
  return newItem;
}

/**
 * Create a new weapon.
 * Generates a complete RPG Maker MV weapon object.
 * params array order: [mhp, mmp, matk, mdef, mat, mdf, agi, luk]
 * @param {string} projectPath - The project root path
 * @param {object} params - Weapon properties
 */
async function createWeapon(projectPath, params) {
  const weapons = await readJson(projectPath, 'Weapons.json');
  const newId = nextId(weapons);

  const newWeapon = {
    id: newId,
    name: params.name || '',
    description: params.description || '',
    iconIndex: params.iconIndex || 0,
    wtypeId: params.wtypeId || 1,         // Weapon type ID
    price: params.price || 0,
    params: params.params || [0, 0, 0, 0, 0, 0, 0, 0],
    traits: params.traits || [],
    etypeId: params.etypeId || 1,         // Equip type: 1=weapon
    animationId: params.animationId || 1,
    note: params.note || ''
  };

  while (weapons.length <= newId) weapons.push(null);
  weapons[newId] = newWeapon;

  await writeJson(projectPath, 'Weapons.json', weapons);
  return newWeapon;
}

/**
 * Create a new armor.
 * Generates a complete RPG Maker MV armor object.
 * @param {string} projectPath - The project root path
 * @param {object} params - Armor properties
 */
async function createArmor(projectPath, params) {
  const armors = await readJson(projectPath, 'Armors.json');
  const newId = nextId(armors);

  const newArmor = {
    id: newId,
    name: params.name || '',
    description: params.description || '',
    iconIndex: params.iconIndex || 0,
    atypeId: params.atypeId || 1,         // Armor type ID
    price: params.price || 0,
    params: params.params || [0, 0, 0, 0, 0, 0, 0, 0],
    traits: params.traits || [],
    etypeId: params.etypeId || 2,         // Equip type: 2=shield, 3=head, 4=body, 5=accessory
    note: params.note || ''
  };

  while (armors.length <= newId) armors.push(null);
  armors[newId] = newArmor;

  await writeJson(projectPath, 'Armors.json', armors);
  return newArmor;
}

/**
 * Update an existing item, weapon, or armor by ID (partial update).
 * @param {string} projectPath - The project root path
 * @param {number} id - The item/weapon/armor ID
 * @param {string} type - "item", "weapon", or "armor"
 * @param {object} fields - Fields to update
 */
async function updateItem(projectPath, id, type, fields) {
  var fileMap = { item: 'Items.json', weapon: 'Weapons.json', armor: 'Armors.json' };
  var filename = fileMap[type];
  if (!filename) throw new Error('Unknown item type: ' + type + '. Use "item", "weapon", or "armor".');

  var items = await readJson(projectPath, filename);

  if (id < 0 || id >= items.length || items[id] === null) {
    throw new Error(type + ' with ID ' + id + ' not found');
  }

  items[id] = Object.assign({}, items[id], fields);
  await writeJson(projectPath, filename, items);
  return items[id];
}

/**
 * Search items, weapons, or armors by name or description (case-insensitive).
 * @param {string} projectPath - The project root path
 * @param {string} query - Search term
 * @param {string} type - "item", "weapon", or "armor"
 */
async function searchItems(projectPath, query, type) {
  type = type || 'item';
  var fileMap = { item: 'Items.json', weapon: 'Weapons.json', armor: 'Armors.json' };
  var filename = fileMap[type];
  if (!filename) throw new Error('Unknown item type: ' + type + '. Use "item", "weapon", or "armor".');

  var items = await readJson(projectPath, filename);
  var lowerQuery = query.toLowerCase();
  return items.filter(function(i) {
    return i !== null &&
      (i.name.toLowerCase().includes(lowerQuery) ||
       i.description.toLowerCase().includes(lowerQuery));
  });
}

async function deleteItem(projectPath, id, type) {
  type = type || 'item';
  var fileMap = { item: 'Items.json', weapon: 'Weapons.json', armor: 'Armors.json' };
  var filename = fileMap[type];
  if (!filename) throw new Error('Unknown item type: ' + type);
  var items = await readJson(projectPath, filename);
  if (id < 0 || id >= items.length || items[id] === null) {
    throw new Error(type + ' with ID ' + id + ' not found');
  }
  var deleted = items[id];
  items[id] = null;
  await writeJson(projectPath, filename, items);
  return { deleted: deleted };
}

export { getItems };
export { getWeapons };
export { getArmors };
export { getSkillsList };
export { createItem };
export { createWeapon };
export { createArmor };
export { updateItem };
export { searchItems };
export { deleteItem };
