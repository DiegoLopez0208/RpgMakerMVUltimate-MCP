import { createCrud } from "../utils/crudHelper.js";
import type { StateParams, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface State extends RpgMakerDbEntry {
  iconIndex: number;
  restriction: number;
  priority: number;
  removeAtBattleEnd: boolean;
  removeByDamage: boolean;
  removeByRestriction: boolean;
  autoRemovalTiming: number;
  minTurns: number;
  maxTurns: number;
  stepsToRemove: number;
  message1: string;
  message2: string;
  message3: string;
  message4: string;
  motion: number;
  overlay: number;
  traits: unknown[];
}

function stateFactory(id: number): State {
  return {
    id,
    name: "",
    note: "",
    iconIndex: 0,
    restriction: 0,
    priority: 50,
    removeAtBattleEnd: false,
    removeByDamage: false,
    removeByRestriction: false,
    autoRemovalTiming: 0,
    minTurns: 1,
    maxTurns: 5,
    stepsToRemove: 100,
    message1: "",
    message2: "",
    message3: "",
    message4: "",
    motion: 0,
    overlay: 0,
    traits: [],
  };
}

const statesCrud = createCrud<State>("States.json", stateFactory);

async function getStates(projectPath: string) {
  return statesCrud.getAll(projectPath);
}

async function getState(projectPath: string, id: number) {
  return statesCrud.getById(projectPath, id);
}

async function createState(projectPath: string, params: StateParams) {
  return statesCrud.create(projectPath, (id) => ({
    ...stateFactory(id),
    ...params,
  }));
}

async function updateState(projectPath: string, id: number, fields: Partial<StateParams>) {
  return statesCrud.update(projectPath, id, fields);
}

async function searchStates(projectPath: string, query: string) {
  return statesCrud.search(projectPath, query, ["name"]);
}

async function deleteState(projectPath: string, id: number) {
  const deleted = await statesCrud.delete(projectPath, id);
  return { deleted };
}

export { getStates, getState, createState, updateState, searchStates, deleteState };
