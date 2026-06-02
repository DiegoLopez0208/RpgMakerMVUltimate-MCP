import { createCrud } from "../utils/crudHelper.js";
import type { ActorParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface Actor extends RpgMakerDbEntry {
  nickname: string;
  profile: string;
  classId: number;
  initialLevel: number;
  maxLevel: number;
  characterName: string;
  characterIndex: number;
  faceName: string;
  faceIndex: number;
  battlerName: string;
  traits: unknown[];
  equips: number[];
}

function actorFactory(id: number): Actor {
  return {
    id,
    name: "",
    nickname: "",
    profile: "",
    classId: 1,
    initialLevel: 1,
    maxLevel: 99,
    characterName: "",
    characterIndex: 0,
    faceName: "",
    faceIndex: 0,
    battlerName: "",
    traits: [],
    equips: [0, 0, 0, 0, 0],
    note: "",
  };
}

const actorsCrud = createCrud<Actor>("Actors.json", actorFactory);

async function getActors(projectPath: string) {
  return actorsCrud.getAll(projectPath);
}

async function getActor(projectPath: string, id: number) {
  return actorsCrud.getById(projectPath, id);
}

async function createActor(projectPath: string, params: ActorParams) {
  return actorsCrud.create(projectPath, (id) => ({
    ...actorFactory(id),
    ...params,
  }));
}

async function updateActor(
  projectPath: string,
  id: number,
  fields: Partial<ActorParams>
) {
  return actorsCrud.update(projectPath, id, fields);
}

async function searchActors(projectPath: string, query: string) {
  return actorsCrud.search(projectPath, query, ["name", "nickname"]);
}

async function deleteActor(projectPath: string, id: number) {
  return actorsCrud.delete(projectPath, id);
}

export { getActors, getActor, createActor, updateActor, searchActors, deleteActor };
