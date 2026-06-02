import { createCrud } from "../utils/crudHelper.js";
import type { TilesetParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Tileset extends RpgMakerDbEntry {
  mode: number;
  tilesetNames: string[];
  flags: number[];
}

function tilesetFactory(id: number): Tileset {
  return {
    id,
    name: "",
    note: "",
    mode: 0,
    tilesetNames: [],
    flags: [],
  };
}

const tilesetsCrud = createCrud<Tileset>("Tilesets.json", tilesetFactory);

async function getTilesets(projectPath: string) {
  return tilesetsCrud.getAll(projectPath);
}

async function getTileset(projectPath: string, id: number) {
  return tilesetsCrud.getById(projectPath, id);
}

async function updateTileset(projectPath: string, id: number, fields: Partial<TilesetParams>) {
  return tilesetsCrud.update(projectPath, id, fields);
}

export { getTilesets, getTileset, updateTileset };
