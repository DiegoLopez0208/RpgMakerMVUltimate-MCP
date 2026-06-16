import { readJson, writeJson, nextId } from "./fileHandler.js";
import { NotFoundError } from "./errors.js";
import { DB_TEMPLATES } from "../data/engineDefaults.js";
import type { RpgMakerDbEntry } from "../types/rpgmaker.js";

// Map data filename -> the engine template key (from the real default project).
const FILE_TO_ENTITY: Record<string, string> = {
  "Actors.json": "actors", "Classes.json": "classes", "Skills.json": "skills",
  "Items.json": "items", "Weapons.json": "weapons", "Armors.json": "armors",
  "Enemies.json": "enemies", "States.json": "states", "Troops.json": "troops",
  "Animations.json": "animations", "Tilesets.json": "tilesets", "CommonEvents.json": "common_events",
};

// Fill any top-level field the factory omitted with the engine's canonical
// default, so every created entry is structurally complete (e.g. an enemy
// always has params/exp/gold/dropItems/actions/traits) and never breaks a
// battle or menu. Non-destructive: only absent keys are added.
function fillEngineDefaults<T extends RpgMakerDbEntry>(filename: string, entry: T): T {
  const tmpl = DB_TEMPLATES[FILE_TO_ENTITY[filename]];
  if (tmpl) {
    for (const k of Object.keys(tmpl)) {
      if (!(k in (entry as Record<string, unknown>))) {
        (entry as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(tmpl[k]));
      }
    }
  }
  return entry;
}

export interface CrudOperations<T extends RpgMakerDbEntry> {
  getAll: (projectPath: string) => Promise<T[]>;
  getById: (projectPath: string, id: number) => Promise<T | null>;
  create: (projectPath: string, factory: (id: number) => T) => Promise<T>;
  update: (projectPath: string, id: number, fields: Partial<T>) => Promise<T>;
  delete: (projectPath: string, id: number) => Promise<T>;
  search: (projectPath: string, query: string, searchFields?: (keyof T)[]) => Promise<T[]>;
}

export function createCrud<T extends RpgMakerDbEntry>(
  filename: string,
  defaultFactory: (id: number) => T
): CrudOperations<T> {
  return {
    async getAll(projectPath: string): Promise<T[]> {
      const data = await readJson(projectPath, filename);
      const arr = ensureArray<T>(data);
      return arr.filter((e): e is T => e !== null && e !== undefined);
    },

    async getById(projectPath: string, id: number): Promise<T | null> {
      const data = await readJson(projectPath, filename);
      const arr = ensureArray<T>(data);
      if (id < 0 || id >= arr.length || !arr[id]) return null;
      return arr[id];
    },

    async create(projectPath: string, factory?: (id: number) => T): Promise<T> {
      const data = await readJson(projectPath, filename);
      const arr = ensureArray<T>(data);
      const id = nextId(arr);
      const entry = fillEngineDefaults(filename, (factory || defaultFactory)(id));
      arr[id] = entry;
      await writeJson(projectPath, filename, arr);
      return entry;
    },

    async update(
      projectPath: string,
      id: number,
      fields: Partial<T>
    ): Promise<T> {
      const data = await readJson(projectPath, filename);
      const arr = ensureArray<T>(data);
      if (id < 0 || id >= arr.length || !arr[id]) {
        throw new NotFoundError(filename.replace(".json", ""), id);
      }
      const updated = { ...arr[id], ...fields, id };
      arr[id] = updated;
      await writeJson(projectPath, filename, arr);
      return updated;
    },

    async delete(projectPath: string, id: number): Promise<T> {
      const data = await readJson(projectPath, filename);
      const arr = ensureArray<T>(data);
      if (id < 0 || id >= arr.length || !arr[id]) {
        throw new NotFoundError(filename.replace(".json", ""), id);
      }
      const deleted = arr[id];
      arr[id] = null as unknown as T;
      await writeJson(projectPath, filename, arr);
      return deleted;
    },

    async search(
      projectPath: string,
      query: string,
      searchFields: (keyof T)[] = ["name" as keyof T]
    ): Promise<T[]> {
      const all = await this.getAll(projectPath);
      const q = query.toLowerCase();
      return all.filter((e) =>
        searchFields.some((field) => {
          const val = e[field];
          return typeof val === "string" && val.toLowerCase().includes(q);
        })
      );
    },
  };
}

function ensureArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data;
  if (data === null || data === undefined) return [];
  return [];
}
