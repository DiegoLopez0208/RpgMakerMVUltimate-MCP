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

export { getAnimations, getAnimation };
