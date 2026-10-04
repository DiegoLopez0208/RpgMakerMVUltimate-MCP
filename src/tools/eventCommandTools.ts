import type { EventCommand } from '../types/rpgmaker.js';
import { readJson, writeJson } from '../utils/fileHandler.js';
import { validateEventCommands } from '../utils/eventCommandValidation.js';

type Target = 'map_event' | 'common_event' | 'troop_page';
type JsonObject = Record<string, unknown>;
export interface InsertEventCommandsResult {
  target: Target;
  filename: string;
  dryRun: boolean;
  mapId?: number;
  eventId?: number;
  commonEventId?: number;
  troopId?: number;
  pageIndex?: number;
  position: number;
  insertedCount: number;
  /** Length of the resulting list, including the root terminator. */
  listLength: number;
  /** Command codes of the resulting list: enough to verify a splice without echoing every parameter. */
  listCodes: number[];
  /** Full lists, only with verbose: true (they can cost thousands of tokens on long events). */
  before?: EventCommand[];
  after?: EventCommand[];
  warnings: string[];
}

function object(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} does not exist or is not an object`);
  return value as JsonObject;
}
function numberArg(args: JsonObject, key: string, min: number, fallback?: number): number {
  const raw = args[key] === undefined ? fallback : args[key];
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
  return value;
}
function entry(value: unknown, id: number, description: string): JsonObject {
  if (!Array.isArray(value)) throw new Error(`${description} database must be an array`);
  const found = object(value[id], `${description} ${id}`);
  if (found.id !== undefined && found.id !== id) throw new Error(`${description} ${id} has a mismatched ID`);
  return found;
}

function relativeFragment(input: unknown): unknown {
  if (!Array.isArray(input) || input.length === 0) return input;
  const entries = input.map((value, index) => object(value, `commands[${index}]`));
  const indents = entries.map((value, index) => {
    const indent = value.indent === undefined ? 0 : value.indent;
    if (typeof indent !== 'number' || !Number.isSafeInteger(indent) || indent < 0 || indent > 100) {
      throw new Error(`commands[${index}]: indent must be an integer from 0 to 100`);
    }
    return indent;
  });
  const base = indents.reduce((min, indent) => Math.min(min, indent), Infinity);
  return entries.map((value, index) => ({ ...value, indent: indents[index] - base }));
}

/** Throw on statically resolvable references that do not exist; return advisories for runtime-only ones. */
export async function checkReferences(projectPath: string, commands: EventCommand[]): Promise<string[]> {
  const warnings: string[] = [];
  const cache = new Map<string, unknown>();
  const read = async (name: string) => {
    if (!cache.has(name)) cache.set(name, await readJson(projectPath, name));
    return cache.get(name);
  };
  const system = object(await read('System.json'), 'System.json');
  const checkSystemId = (kind: 'switches' | 'variables', id: unknown) => {
    const values = system[kind];
    if (Array.isArray(values) && values.length > 1 && typeof id === 'number' && id >= values.length) {
      throw new Error(`${kind} ID ${id} exceeds System.json maximum ${values.length - 1}`);
    }
  };
  for (const command of commands) {
    const p = command.parameters;
    if (command.code === 121 || command.code === 122) {
      const kind = command.code === 121 ? 'switches' : 'variables';
      checkSystemId(kind, p[0]); checkSystemId(kind, p[1]);
      if (command.code === 122 && p[3] === 1) checkSystemId('variables', p[4]);
      if (command.code === 122 && p[3] === 3) {
        const database = ['Items.json', 'Weapons.json', 'Armors.json', 'Actors.json'][p[4] as number];
        if (database) entry(await read(database), p[5] as number, database.replace('.json', ''));
        else if (p[4] === 4 || p[4] === 5 || p[4] === 6) warnings.push('Game-data enemy, character, or party index depends on the runtime event context');
      }
    } else if (command.code === 111) {
      if (p[0] === 0) checkSystemId('switches', p[1]);
      if (p[0] === 1) { checkSystemId('variables', p[1]); if (p[2] === 1) checkSystemId('variables', p[3]); }
      if (p[0] === 4 && p[2] === 0) entry(await read('Actors.json'), p[1] as number, 'Actor');
      if (p[0] === 8) entry(await read('Items.json'), p[1] as number, 'Item');
      if (p[0] === 9) entry(await read('Weapons.json'), p[1] as number, 'Weapon');
      if (p[0] === 10) entry(await read('Armors.json'), p[1] as number, 'Armor');
    } else if (command.code === 103 || command.code === 104) checkSystemId('variables', p[0]);
    else if (command.code === 117) entry(await read('CommonEvents.json'), p[0] as number, 'Common event');
    else if (command.code === 201) {
      if (p[0] === 1) {
        for (const value of p.slice(1, 4)) checkSystemId('variables', value);
        warnings.push('Variable-based transfer destination cannot be resolved until runtime');
      } else {
        const map = object(await read(`Map${String(p[1]).padStart(3, '0')}.json`), `Transfer map ${p[1]}`);
        if ((typeof map.width === 'number' && (p[2] as number) >= map.width) || (typeof map.height === 'number' && (p[3] as number) >= map.height)) {
          throw new Error(`Transfer coordinates (${p[2]}, ${p[3]}) are outside map ${p[1]}`);
        }
      }
    } else if (command.code === 301) {
      if (p[0] === 0) entry(await read('Troops.json'), p[1] as number, 'Troop');
      if (p[0] === 1) checkSystemId('variables', p[1]);
    } else if (command.code === 125) {
      if (p[1] === 1) checkSystemId('variables', p[2]);
    } else if (command.code >= 126 && command.code <= 128) {
      const database = { 126: 'Items', 127: 'Weapons', 128: 'Armors' }[command.code]!;
      entry(await read(`${database}.json`), p[0] as number, database.slice(0, -1));
      if (p[2] === 1) checkSystemId('variables', p[3]);
    } else if (command.code === 129 || command.code === 303) {
      entry(await read('Actors.json'), p[0] as number, 'Actor');
    } else if (command.code === 212) {
      entry(await read('Animations.json'), p[1] as number, 'Animation');
    } else if (command.code === 231 && p[3] === 1) {
      checkSystemId('variables', p[4]); checkSystemId('variables', p[5]);
    } else if (command.code === 302 || command.code === 605) {
      // The 302 row is the first good; each 605 row is another: [type, id, priceType, price].
      const database = ['Items', 'Weapons', 'Armors'][p[0] as number];
      if (database) entry(await read(`${database}.json`), p[1] as number, database.slice(0, -1));
    } else if (command.code >= 311 && command.code <= 316) {
      // [0, actorId (0 = entire party)] or [1, variableId], then the code's own operands.
      if (p[0] === 0 && p[1] !== 0) entry(await read('Actors.json'), p[1] as number, 'Actor');
      if (p[0] === 1) checkSystemId('variables', p[1]);
      if (command.code === 313) entry(await read('States.json'), p[3] as number, 'State');
      else if (command.code !== 314 && p[3] === 1) checkSystemId('variables', p[4]);
    } else if (command.code === 333) {
      entry(await read('States.json'), p[2] as number, 'State');
    } else if (command.code === 205) {
      // Route steps 27/28 (switch on/off) carry a switch ID.
      const route = p[1] as { list?: { code?: number; parameters?: unknown[] }[] } | undefined;
      for (const step of route?.list ?? []) {
        if (step.code === 27 || step.code === 28) checkSystemId('switches', step.parameters?.[0]);
      }
    }
  }
  return warnings;
}

/** Insert a validated complete fragment, preserving the target and backups on all validation errors. */
export async function insertEventCommands(projectPath: string, args: JsonObject): Promise<InsertEventCommandsResult> {
  object(args, 'arguments');
  const target = args.target ?? 'map_event';
  if (!['map_event', 'common_event', 'troop_page'].includes(target as string)) throw new Error('target must be map_event, common_event, or troop_page');
  const keys = ['target', 'commands', 'position', 'dryRun', 'verbose', ...(target === 'map_event' ? ['mapId', 'eventId', 'pageIndex'] : target === 'common_event' ? ['commonEventId'] : ['troopId', 'pageIndex'])];
  for (const key of Object.keys(args)) if (!keys.includes(key)) throw new Error(`Unexpected argument ${key} for ${target}`);
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
  if (args.verbose !== undefined && typeof args.verbose !== 'boolean') throw new Error('verbose must be a boolean');
  const fragment = validateEventCommands(relativeFragment(args.commands), { fragment: true });
  if (!fragment.commands.length) throw new Error('commands must contain at least one executable command');
  let filename: string;
  let data: unknown;
  let holder: JsonObject;
  const ids: Pick<InsertEventCommandsResult, 'mapId' | 'eventId' | 'commonEventId' | 'troopId' | 'pageIndex'> = {};
  if (target === 'common_event') {
    ids.commonEventId = numberArg(args, 'commonEventId', 1);
    filename = 'CommonEvents.json'; data = await readJson(projectPath, filename);
    holder = entry(data, ids.commonEventId, 'Common event');
  } else {
    ids.pageIndex = numberArg(args, 'pageIndex', 0, 0);
    let owner: JsonObject;
    if (target === 'map_event') {
      ids.mapId = numberArg(args, 'mapId', 1); ids.eventId = numberArg(args, 'eventId', 1);
      filename = `Map${String(ids.mapId).padStart(3, '0')}.json`; data = await readJson(projectPath, filename);
      owner = entry(object(data, 'Map').events, ids.eventId, 'Map event');
    } else {
      ids.troopId = numberArg(args, 'troopId', 1);
      filename = 'Troops.json'; data = await readJson(projectPath, filename);
      owner = entry(data, ids.troopId, 'Troop');
    }
    if (!Array.isArray(owner.pages)) throw new Error('Target pages must be an array');
    holder = object(owner.pages[ids.pageIndex], `Page ${ids.pageIndex}`);
  }
  const beforeValidation = validateEventCommands(holder.list);
  const before = beforeValidation.commands;
  const position = numberArg(args, 'position', 0, before.length - 1);
  const indent = beforeValidation.insertionPoints.get(position);
  if (indent === undefined) throw new Error(`position ${position} is not a safe command boundary (cannot split continuations or block delimiters)`);
  const shifted = fragment.commands.map(command => ({ ...command, indent: (command.indent ?? 0) + indent }));
  const after = [...before.slice(0, position), ...shifted, ...before.slice(position)];
  const afterValidation = validateEventCommands(after);
  // Existing unrelated stale references should not prevent a scoped insertion.
  const referenceWarnings = await checkReferences(projectPath, shifted);
  const warnings = [...new Set([...beforeValidation.warnings, ...fragment.warnings, ...afterValidation.warnings, ...referenceWarnings])];
  const result: InsertEventCommandsResult = {
    target: target as Target, filename, dryRun: args.dryRun === true, ...ids, position, insertedCount: shifted.length,
    listLength: after.length, listCodes: after.map(command => command.code),
    ...(args.verbose === true ? { before, after } : {}), warnings,
  };
  if (args.dryRun !== true) {
    holder.list = after;
    await writeJson(projectPath, filename, data);
  }
  return result;
}
