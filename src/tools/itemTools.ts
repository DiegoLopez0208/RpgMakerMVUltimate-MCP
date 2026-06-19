import { createCrud } from "../utils/crudHelper.js";
import type { ItemParams, WeaponParams, ArmorParams, ItemType, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Item extends RpgMakerDbEntry {
  description: string;
  iconIndex: number;
  itypeId: number;
  price: number;
  consumable: boolean;
  scope: number;
  occasion: number;
  animationId: number;
  effects: unknown[];
  traits: unknown[];
}

interface Weapon extends RpgMakerDbEntry {
  description: string;
  iconIndex: number;
  wtypeId: number;
  price: number;
  atk: number;
  params: number[];
  traits: unknown[];
  etypeId: number;
  animationId: number;
}

interface Armor extends RpgMakerDbEntry {
  description: string;
  iconIndex: number;
  atypeId: number;
  price: number;
  def: number;
  params: number[];
  traits: unknown[];
  etypeId: number;
}

function itemFactory(id: number): Item {
  return {
    id,
    name: "",
    note: "",
    description: "",
    iconIndex: 0,
    itypeId: 1,
    price: 0,
    consumable: true,
    scope: 7,
    occasion: 1,
    animationId: 0,
    effects: [],
    traits: [],
  };
}

function weaponFactory(id: number): Weapon {
  return {
    id,
    name: "",
    note: "",
    description: "",
    iconIndex: 0,
    wtypeId: 1,
    price: 0,
    atk: 0,
    params: [0, 0, 0, 0, 0, 0, 0, 0],
    traits: [],
    etypeId: 1,
    animationId: 1,
  };
}

function armorFactory(id: number): Armor {
  return {
    id,
    name: "",
    note: "",
    description: "",
    iconIndex: 0,
    atypeId: 1,
    price: 0,
    def: 0,
    params: [0, 0, 0, 0, 0, 0, 0, 0],
    traits: [],
    etypeId: 2,
  };
}

const itemsCrud = createCrud<Item>("Items.json", itemFactory);
const weaponsCrud = createCrud<Weapon>("Weapons.json", weaponFactory);
const armorsCrud = createCrud<Armor>("Armors.json", armorFactory);

const fileMap: Record<ItemType, string> = { item: "Items.json", weapon: "Weapons.json", armor: "Armors.json" };

async function getItems(projectPath: string) {
  return itemsCrud.getAll(projectPath);
}

async function getWeapons(projectPath: string) {
  return weaponsCrud.getAll(projectPath);
}

async function getArmors(projectPath: string) {
  return armorsCrud.getAll(projectPath);
}

async function createItem(projectPath: string, params: ItemParams) {
  return itemsCrud.create(projectPath, (id) => ({
    ...itemFactory(id),
    ...params,
  }));
}

async function createWeapon(projectPath: string, params: WeaponParams) {
  return weaponsCrud.create(projectPath, (id) => ({
    ...weaponFactory(id),
    ...params,
  }));
}

async function createArmor(projectPath: string, params: ArmorParams) {
  return armorsCrud.create(projectPath, (id) => ({
    ...armorFactory(id),
    ...params,
  }));
}

async function updateItem(projectPath: string, id: number, type: ItemType, fields: Partial<ItemParams | WeaponParams | ArmorParams>) {
  if (!fileMap[type]) throw new Error('Unknown item type: ' + type + '. Use "item", "weapon", or "armor".');

  if (type === "weapon") {
    return weaponsCrud.update(projectPath, id, fields as Partial<Weapon>);
  }
  if (type === "armor") {
    return armorsCrud.update(projectPath, id, fields as Partial<Armor>);
  }
  return itemsCrud.update(projectPath, id, fields as Partial<Item>);
}

async function searchItems(projectPath: string, query: string, type: ItemType) {
  type = type || "item";
  if (!fileMap[type]) throw new Error('Unknown item type: ' + type + '. Use "item", "weapon", or "armor".');

  if (type === "weapon") {
    return weaponsCrud.search(projectPath, query, ["name" as keyof Weapon, "description" as keyof Weapon]);
  }
  if (type === "armor") {
    return armorsCrud.search(projectPath, query, ["name" as keyof Armor, "description" as keyof Armor]);
  }
  return itemsCrud.search(projectPath, query, ["name" as keyof Item, "description" as keyof Item]);
}

async function deleteItem(projectPath: string, id: number, type: ItemType) {
  type = type || "item";
  if (!fileMap[type]) throw new Error("Unknown item type: " + type);

  let deleted: unknown;
  if (type === "weapon") {
    deleted = await weaponsCrud.delete(projectPath, id);
  } else if (type === "armor") {
    deleted = await armorsCrud.delete(projectPath, id);
  } else {
    deleted = await itemsCrud.delete(projectPath, id);
  }
  return { deleted };
}

export { getItems, getWeapons, getArmors, createItem, createWeapon, createArmor, updateItem, searchItems, deleteItem };
