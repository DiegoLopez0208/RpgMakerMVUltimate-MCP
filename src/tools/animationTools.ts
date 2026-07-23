import { createCrud } from "../utils/crudHelper.js";
import type { RpgMakerDbEntry } from "../types/rpgmaker.js";

type Animation = RpgMakerDbEntry;

const animationsCrud = createCrud<Animation>("Animations.json", (id) => ({
  id,
  name: "",
}));

async function getAnimations(projectPath: string) {
  return animationsCrud.getAll(projectPath);
}

async function getAnimation(projectPath: string, id: number) {
  return animationsCrud.getById(projectPath, id);
}

async function updateAnimation(projectPath: string, id: number, fields: Partial<Animation>) {
  return animationsCrud.update(projectPath, id, fields);
}

async function deleteAnimation(projectPath: string, id: number) {
  return animationsCrud.delete(projectPath, id);
}

export { getAnimations, getAnimation, updateAnimation, deleteAnimation };
