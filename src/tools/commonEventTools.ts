import { createCrud } from "../utils/crudHelper.js";
import type { CommonEventParams, EventCommand, RpgMakerDbEntry } from "../types/rpgmaker.js";

interface CommonEvent extends RpgMakerDbEntry {
  trigger: number;
  switchId: number;
  list: EventCommand[];
}

function commonEventFactory(id: number): CommonEvent {
  return {
    id,
    name: "",
    note: "",
    trigger: 0,
    switchId: 0,
    list: [{ code: 0, indent: 0, parameters: [] }],
  };
}

const commonEventsCrud = createCrud<CommonEvent>("CommonEvents.json", commonEventFactory);

async function getCommonEvents(projectPath: string) {
  return commonEventsCrud.getAll(projectPath);
}

async function createCommonEvent(projectPath: string, params: CommonEventParams) {
  return commonEventsCrud.create(projectPath, (id) => ({
    ...commonEventFactory(id),
    ...params,
  }));
}

async function updateCommonEvent(projectPath: string, id: number, fields: Partial<CommonEventParams>) {
  return commonEventsCrud.update(projectPath, id, fields);
}

async function addCommonEventCommand(projectPath: string, id: number, command: EventCommand) {
  const ev = await commonEventsCrud.getById(projectPath, id);
  if (!ev) throw new Error("Common Event " + id + " not found");
  const list = [...ev.list];
  list.splice(list.length - 1, 0, command);
  return commonEventsCrud.update(projectPath, id, { list });
}

export { getCommonEvents, createCommonEvent, updateCommonEvent, addCommonEventCommand };
