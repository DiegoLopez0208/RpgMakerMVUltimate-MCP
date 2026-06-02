import { createCrud } from "../utils/crudHelper.js";
import type { ClassParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Class extends RpgMakerDbEntry {
  params: number[][];
  expParams: number[];
  learnings: { level: number; skillId: number; note: string }[];
  traits: unknown[];
}

function classFactory(id: number): Class {
  return {
    id,
    name: "",
    params: [[500, 30, 30, 30, 30, 30, 30, 30]],
    expParams: [30, 20, 10, 90],
    learnings: [],
    traits: [],
    note: "",
  };
}

const classesCrud = createCrud<Class>("Classes.json", classFactory);

async function getClasses(projectPath: string) {
  return classesCrud.getAll(projectPath);
}

async function getClass(projectPath: string, id: number) {
  return classesCrud.getById(projectPath, id);
}

async function createClass(projectPath: string, params: ClassParams) {
  return classesCrud.create(projectPath, (id) => ({
    ...classFactory(id),
    ...params,
  }));
}

async function updateClass(projectPath: string, id: number, fields: Partial<ClassParams>) {
  return classesCrud.update(projectPath, id, fields);
}

async function searchClasses(projectPath: string, query: string) {
  return classesCrud.search(projectPath, query, ["name"]);
}

async function deleteClass(projectPath: string, id: number) {
  const deleted = await classesCrud.delete(projectPath, id);
  return { deleted };
}

export { getClasses, getClass, createClass, updateClass, searchClasses, deleteClass };
