import { EventCommand, MapEvent, EventPage, CommonEvent, Effect } from '../utils/types.js';
import { ProjectData } from './references.js';

/**
 * The id namespaces an author picks a number in by hand. Deliberately narrow:
 * these are the three where nothing assigns the id for you, so two sessions
 * editing the same project can silently claim the same one. Database rows
 * (actors, items, …) are not here — `create_*`/`batch_create` assign those ids,
 * and `list_names` already shows what exists.
 *
 * Self switches (command 123, A–D) are also absent on purpose: they're scoped to
 * one event, so they can't collide across sessions.
 */
export type IdNamespace = 'switch' | 'variable' | 'common_event';

/** A single place an id is referenced. */
export interface IdReference {
  id: number;
  /** Where the reference sits, e.g. `map 3 / event 7 / page 0 / command 4`. */
  path: string;
  /** What carries it, e.g. `Control Switches` or `page condition (switch1Id)`. */
  via: string;
}

/**
 * Where a command's parameters carry an id of one namespace.
 *
 * `always` indices hold an id unconditionally. `conditional` entries hold one
 * only when every `[index, value]` pair in `when` matches — that's how the
 * "designation by variable" commands work (Transfer Player's map/x/y are
 * variable ids only when `parameters[0] === 1`). `range` names two indices
 * holding the inclusive start/end of an id range, which is how Control
 * Switches/Variables address a block in one command.
 */
interface RefSpec {
  /** Command name, surfaced as the reference's `via`. */
  name: string;
  always?: number[];
  conditional?: Array<{ when: Array<[number, number]>; indices: number[] }>;
  range?: [number, number];
}

/**
 * A Control Switches/Variables range is normally a handful of ids; this only
 * stops a corrupt or hand-written `[1, 999999]` from expanding into a
 * million-entry result.
 */
const MAX_RANGE = 1000;

/**
 * Curated (not exhaustive) — the same stance as `KNOWN_COMMANDS`. It covers
 * every command this server's own builders emit plus the hand-authored ones an
 * agent is likely to meet; an unlisted command contributes no references, so a
 * switch used only from a `Script` (355) or a plugin command (356) reads as
 * free. Callers surface that caveat.
 */
const SWITCH_REFS: Record<number, RefSpec> = {
  111: { name: 'Conditional Branch', conditional: [{ when: [[0, 0]], indices: [1] }] },
  121: { name: 'Control Switches', range: [0, 1] },
};

const VARIABLE_REFS: Record<number, RefSpec> = {
  103: { name: 'Input Number', always: [0] },
  104: { name: 'Select Item', always: [0] },
  111: {
    name: 'Conditional Branch',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      // Comparing a variable against another variable: params[2] === 1.
      {
        when: [
          [0, 1],
          [2, 1],
        ],
        indices: [3],
      },
    ],
  },
  // operateValue(operation, operandType, operand): operandType 1 = variable.
  122: {
    name: 'Control Variables',
    range: [0, 1],
    conditional: [{ when: [[3, 1]], indices: [4] }],
  },
  125: { name: 'Change Gold', conditional: [{ when: [[1, 1]], indices: [2] }] },
  126: { name: 'Change Items', conditional: [{ when: [[2, 1]], indices: [3] }] },
  127: { name: 'Change Weapons', conditional: [{ when: [[2, 1]], indices: [3] }] },
  128: { name: 'Change Armors', conditional: [{ when: [[2, 1]], indices: [3] }] },
  201: { name: 'Transfer Player', conditional: [{ when: [[0, 1]], indices: [1, 2, 3] }] },
  202: { name: 'Set Vehicle Location', conditional: [{ when: [[1, 1]], indices: [2, 3, 4] }] },
  203: { name: 'Set Event Location', conditional: [{ when: [[1, 1]], indices: [2, 3] }] },
  285: {
    name: 'Get Location Info',
    always: [0],
    conditional: [{ when: [[2, 1]], indices: [3, 4] }],
  },
  // iterateActorEx(params[0], params[1]): actor designated by variable when params[0] === 1.
  311: {
    name: 'Change HP',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[3, 1]], indices: [4] },
    ],
  },
  312: {
    name: 'Change MP',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[3, 1]], indices: [4] },
    ],
  },
  313: { name: 'Change State', conditional: [{ when: [[0, 1]], indices: [1] }] },
  314: { name: 'Recover All', conditional: [{ when: [[0, 1]], indices: [1] }] },
  315: {
    name: 'Change EXP',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[3, 1]], indices: [4] },
    ],
  },
  316: {
    name: 'Change Level',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[3, 1]], indices: [4] },
    ],
  },
  317: {
    name: 'Change Parameter',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[4, 1]], indices: [5] },
    ],
  },
  318: { name: 'Change Skill', conditional: [{ when: [[0, 1]], indices: [1] }] },
  326: {
    name: 'Change TP',
    conditional: [
      { when: [[0, 1]], indices: [1] },
      { when: [[3, 1]], indices: [4] },
    ],
  },
};

const COMMON_EVENT_REFS: Record<number, RefSpec> = {
  117: { name: 'Common Event', always: [0] },
};

const REF_TABLES: Record<IdNamespace, Record<number, RefSpec>> = {
  switch: SWITCH_REFS,
  variable: VARIABLE_REFS,
  common_event: COMMON_EVENT_REFS,
};

/** The command codes scanned for a namespace — surfaced so callers can state their coverage. */
export function scannedCommandCodes(ns: IdNamespace): number[] {
  return Object.keys(REF_TABLES[ns])
    .map(Number)
    .sort((a, b) => a - b);
}

/** A positive integer id, or `undefined` for anything else (missing, 0, a string, …). */
function idAt(parameters: unknown[], index: number): number | undefined {
  const value = parameters[index];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Every id of one namespace referenced by a single event command. Unlisted
 * codes and parameters that aren't positive integers yield nothing, so a
 * malformed command degrades to "no references" rather than throwing.
 */
export function commandIdRefs(
  command: EventCommand,
  ns: IdNamespace,
): Array<{ id: number; via: string }> {
  const spec = REF_TABLES[ns][command?.code];
  if (!spec || !Array.isArray(command.parameters)) return [];
  const parameters = command.parameters as unknown[];

  const ids: number[] = [];

  for (const index of spec.always ?? []) {
    const id = idAt(parameters, index);
    if (id !== undefined) ids.push(id);
  }

  for (const group of spec.conditional ?? []) {
    if (!group.when.every(([index, value]) => parameters[index] === value)) continue;
    for (const index of group.indices) {
      const id = idAt(parameters, index);
      if (id !== undefined) ids.push(id);
    }
  }

  if (spec.range) {
    const start = idAt(parameters, spec.range[0]);
    const end = idAt(parameters, spec.range[1]);
    if (start !== undefined) {
      const last = Math.min(end !== undefined && end >= start ? end : start, start + MAX_RANGE - 1);
      for (let id = start; id <= last; id++) ids.push(id);
    }
  }

  return ids.map((id) => ({ id, via: spec.name }));
}

/** Scan one command list, tagging each reference with the list's path. */
function scanList(list: unknown, path: string, ns: IdNamespace): IdReference[] {
  if (!Array.isArray(list)) return [];
  const refs: IdReference[] = [];
  list.forEach((command, i) => {
    for (const { id, via } of commandIdRefs(command as EventCommand, ns)) {
      refs.push({ id, path: `${path} / command ${i}`, via });
    }
  });
  return refs;
}

/**
 * Switch/variable references that live in an event page's *conditions* rather
 * than its command list — the gate that decides which page runs. A page
 * condition only reads its id when the matching `*Valid` flag is set, so an
 * unused slot (which still holds a stale id) isn't counted.
 */
function pageConditionRefs(page: EventPage | undefined, path: string, ns: IdNamespace) {
  const conditions = page?.conditions;
  if (!conditions) return [];
  const refs: IdReference[] = [];

  if (ns === 'switch') {
    if (conditions.switch1Valid && conditions.switch1Id > 0) {
      refs.push({ id: conditions.switch1Id, path, via: 'page condition (switch1Id)' });
    }
    if (conditions.switch2Valid && conditions.switch2Id > 0) {
      refs.push({ id: conditions.switch2Id, path, via: 'page condition (switch2Id)' });
    }
  }

  if (ns === 'variable' && conditions.variableValid && conditions.variableId > 0) {
    refs.push({ id: conditions.variableId, path, via: 'page condition (variableId)' });
  }

  return refs;
}

/** Every reference carried by one map event's pages (conditions + command lists). */
function mapEventRefs(event: MapEvent, mapId: number, ns: IdNamespace): IdReference[] {
  if (!Array.isArray(event.pages)) return [];
  const refs: IdReference[] = [];
  event.pages.forEach((page, pi) => {
    const path = `map ${mapId} / event ${event.id} / page ${pi}`;
    refs.push(...pageConditionRefs(page, path, ns));
    refs.push(...scanList(page?.list, path, ns));
  });
  return refs;
}

/** Common-event references: the autorun/parallel gate switch, plus the command list. */
function commonEventRefs(commonEvent: CommonEvent, ns: IdNamespace): IdReference[] {
  const path = `common event ${commonEvent.id}`;
  const refs: IdReference[] = [];

  // trigger 0 = call-only, in which case switchId is ignored by the engine.
  if (ns === 'switch' && commonEvent.trigger !== 0 && commonEvent.switchId > 0) {
    refs.push({ id: commonEvent.switchId, path, via: 'common event trigger switch' });
  }

  refs.push(...scanList(commonEvent.list, path, ns));
  return refs;
}

/** Skill/item effects that run a common event (Game_Action effect code 44). */
const EFFECT_COMMON_EVENT = 44;

function effectRefs(effects: Effect[] | undefined, path: string): IdReference[] {
  if (!Array.isArray(effects)) return [];
  const refs: IdReference[] = [];
  effects.forEach((effect, i) => {
    if (effect?.code === EFFECT_COMMON_EVENT && effect.dataId > 0) {
      refs.push({ id: effect.dataId, path: `${path} / effect ${i}`, via: 'Common Event effect' });
    }
  });
  return refs;
}

/**
 * Every reference to one id namespace across the whole project: map event pages
 * (conditions and commands), common events (trigger switch and commands), troop
 * pages (battle conditions and commands), and — for common events — skill/item
 * effects that call one.
 *
 * Pure, so it's unit-testable without file I/O. Derived entirely from the
 * project's own JSON, which is the point: a hand-maintained ledger of claimed
 * ids drifts the moment someone edits in the RPG Maker editor.
 */
export function scanIdUsage(data: ProjectData, ns: IdNamespace): IdReference[] {
  const refs: IdReference[] = [];

  for (const map of data.maps) {
    for (const event of map.events) {
      if (event) refs.push(...mapEventRefs(event, map.id, ns));
    }
  }

  for (const commonEvent of data.commonEvents) {
    if (commonEvent) refs.push(...commonEventRefs(commonEvent, ns));
  }

  for (const troop of data.troops) {
    if (!troop || !Array.isArray(troop.pages)) continue;
    troop.pages.forEach((page, pi) => {
      const path = `troop ${troop.id} / page ${pi}`;
      const conditions = page?.conditions;
      if (ns === 'switch' && conditions?.switchValid && conditions.switchId > 0) {
        refs.push({ id: conditions.switchId, path, via: 'troop page condition (switchId)' });
      }
      refs.push(...scanList(page?.list, path, ns));
    });
  }

  if (ns === 'common_event') {
    for (const skill of data.skills) {
      if (skill) refs.push(...effectRefs(skill.effects, `skill ${skill.id}`));
    }
    for (const item of data.items) {
      if (item) refs.push(...effectRefs(item.effects, `item ${item.id}`));
    }
  }

  return refs;
}
