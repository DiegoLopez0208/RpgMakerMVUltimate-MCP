import type { EventCommand } from '../types/rpgmaker.js';
import { BLOCK_ENDS, BLOCK_SECTIONS, CONTINUATION_FOR, EVENT_COMMANDS } from './eventCommandTable.js';

export interface EventCommandValidation {
  commands: EventCommand[];
  warnings: string[];
  /** Safe array positions and the indent at which a complete fragment belongs. */
  insertionPoints: Map<number, number>;
}

const delimiters = new Set([...BLOCK_SECTIONS, ...BLOCK_ENDS]);
const continuationFor = CONTINUATION_FOR;
const continuations = new Set(Object.values(continuationFor));

function fail(index: number, message: string): never {
  throw new Error(`commands[${index}]: ${message}`);
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkShape(command: EventCommand, index: number, warnings: string[]): void {
  const { code, parameters: p } = command;
  const require = (condition: boolean, message: string) => { if (!condition) fail(index, message); };
  const id = (slot: number) => require(integer(p[slot], 1), `parameter ${slot} must be a positive integer ID`);
  const range = (slot: number, min: number, max: number) => require(integer(p[slot], min, max), `parameter ${slot} must be an integer from ${min} to ${max}`);
  if (code === 357 || code === 657) fail(index, `code ${code} is an MZ plugin command; MV uses code 356`);
  const arity = EVENT_COMMANDS[code]?.arity;
  if (arity !== undefined) {
    const allowed = typeof arity === 'number' ? [arity] : arity;
    require(allowed.includes(p.length), `MV code ${code} expects ${allowed.join(' or ')} parameters, got ${p.length}`);
  } else if (!EVENT_COMMANDS[code]) {
    warnings.push(`commands[${index}]: unrecognized code ${code}; verify its plugin implements MV event-command behavior`);
  }
  if ([108, 118, 119, 355, 356, 401, 405, 408, 655].includes(code)) {
    require(typeof p[0] === 'string', 'parameter 0 must be a string');
  }
  if (code === 101) {
    require(typeof p[0] === 'string', 'face name must be a string');
    range(1, 0, 7); range(2, 0, 2); range(3, 0, 2);
  } else if (code === 102) {
    require(p.length >= 2 && p.length <= 5, 'Show Choices expects 2 through 5 parameters');
    require(Array.isArray(p[0]) && p[0].length > 0 && p[0].every(v => typeof v === 'string'), 'choices must be a nonempty string array');
    const count = (p[0] as string[]).length;
    range(1, -2, count);
    if (p.length > 2) range(2, -1, count - 1);
    if (p.length > 3) range(3, 0, 2);
    if (p.length > 4) range(4, 0, 2);
  } else if (code === 111) {
    range(0, 0, 13);
    const type = p[0] as number;
    const counts = [3, 5, 3, 3, p[2] === 0 ? 3 : 4, p[2] === 0 ? 3 : 4, 3, 3, 2, 3, 3, 2, 2, 2];
    // Editor versions sometimes retain the unused actor/enemy fourth slot.
    require(p.length === counts[type] || ((type === 4 || type === 5) && p[2] === 0 && p.length === 4), `invalid MV conditional type ${type} parameter count`);
    if (type === 0) { id(1); range(2, 0, 1); }
    if (type === 1) { id(1); range(2, 0, 1); range(4, 0, 5); if (p[2] === 1) id(3); else require(typeof p[3] === 'number' && Number.isFinite(p[3]), 'constant must be finite'); }
    if (type === 2) { require(['A', 'B', 'C', 'D'].includes(p[1] as string), 'invalid self-switch'); range(2, 0, 1); }
    if (type === 4 || type === 8 || type === 9 || type === 10) id(1);
    if (type === 4) range(2, 0, 6);
    if (type === 12) require(typeof p[1] === 'string', 'script condition must be a string');
  } else if (code === 121 || code === 122) {
    id(0); id(1); require((p[1] as number) >= (p[0] as number), 'ID range must be ordered');
    range(2, 0, code === 121 ? 1 : 5);
    if (code === 122) {
      range(3, 0, 4);
      const count = [5, 5, 6, 7, 5][p[3] as number];
      require(p.length === count, `Control Variables operand type ${p[3]} expects ${count} parameters`);
      if (p[3] === 1) id(4);
      else if (p[3] === 4) require(typeof p[4] === 'string', 'script operand must be a string');
      else if (p[3] === 3) {
        range(4, 0, 7);
        const dataType = p[4] as number;
        require(integer(p[5], dataType <= 3 ? 1 : dataType === 5 ? -1 : 0), 'invalid game-data subject ID/index');
        require(integer(p[6], 0), 'game-data parameter index must be a nonnegative integer');
        if (dataType === 3) range(6, 0, 11);
        if (dataType === 4) range(6, 0, 9);
        if (dataType === 5) range(6, 0, 4);
        if (dataType === 7) range(5, 0, 9);
      }
      else if (p[3] === 0 || p[3] === 2) {
        require(typeof p[4] === 'number' && Number.isFinite(p[4]), 'operand must be finite');
        if (p[3] === 2) require(typeof p[5] === 'number' && Number.isFinite(p[5]) && p[5] >= (p[4] as number), 'random operand bounds must be finite and ordered');
      }
    }
  } else if (code === 123) {
    require(['A', 'B', 'C', 'D'].includes(p[0] as string), 'invalid self-switch'); range(1, 0, 1);
  } else if (code === 117) id(0);
  else if (code === 201) {
    range(0, 0, 1); id(1);
    require(integer(p[2], p[0] === 0 ? 0 : 1) && integer(p[3], p[0] === 0 ? 0 : 1), 'coordinates/variable IDs must be valid integers');
    require([0, 2, 4, 6, 8].includes(p[4] as number), 'invalid transfer direction'); range(5, 0, 2);
  } else if (code === 103) { id(0); range(1, 1, 8); }
  else if (code === 104) { id(0); range(1, 1, 4); }
  else if (code === 230) range(0, 1, 999999);
  else if (code === 301) {
    range(0, 0, 2); if (p[0] !== 2) id(1);
    require(typeof p[2] === 'boolean' && typeof p[3] === 'boolean', 'battle escape/lose flags must be booleans');
  }
}

/** Validate an MV list or complete fragment without executing scripts or touching disk. */
export function validateEventCommands(input: unknown, options: { fragment?: boolean } = {}): EventCommandValidation {
  if (!Array.isArray(input)) throw new Error('commands must be an array');
  const warnings: string[] = [];
  const commands = input.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(index, 'must be an event-command object');
    const value = entry as Record<string, unknown>;
    if (Object.keys(value).some(key => !['code', 'indent', 'parameters'].includes(key))) fail(index, 'unknown event-command property');
    if (!integer(value.code, 0)) fail(index, 'code must be a nonnegative integer');
    if (value.indent !== undefined && !integer(value.indent, 0, 100)) fail(index, 'indent must be an integer from 0 to 100');
    if (!Array.isArray(value.parameters)) fail(index, 'parameters must be an array');
    let parameters: unknown[];
    try {
      // Reject values JSON would silently change (NaN, undefined, functions, cycles).
      const json = JSON.stringify(value.parameters, (_key, item: unknown) => {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('not JSON');
        return item;
      });
      parameters = JSON.parse(json) as unknown[];
    } catch { fail(index, 'parameters must contain only finite JSON values'); }
    const command = { code: value.code, indent: value.indent ?? 0, parameters } as EventCommand;
    checkShape(command, index, warnings);
    return command;
  });
  const final = commands.at(-1);
  const hasTerminal = final?.code === 0 && final.indent === 0;
  if (!options.fragment && !hasTerminal) throw new Error('event list requires a final code 0 at indent 0');
  const limit = hasTerminal ? commands.length - 1 : commands.length;
  const insertionPoints = new Map<number, number>();
  let cursor = 0;
  const matches = (code: number, indent: number) => commands[cursor]?.code === code && commands[cursor]?.indent === indent;
  const close = (code: number, indent: number) => {
    if (!matches(code, indent)) fail(cursor, `expected code ${code} at indent ${indent}`);
    cursor++;
  };
  const sequence = (indent: number, loopDepth: number): void => {
    while (cursor < limit) {
      const command = commands[cursor];
      if ((command.indent ?? 0) < indent) return;
      if (command.indent !== indent) fail(cursor, `expected indent ${indent}, got ${command.indent}`);
      if (delimiters.has(command.code)) fail(cursor, `orphan or duplicate block delimiter ${command.code}`);
      if (continuations.has(command.code)) fail(cursor, `orphan continuation ${command.code}`);
      insertionPoints.set(cursor, indent);
      const index = cursor++;
      if (command.code === 0) {
        if (indent === 0) fail(index, 'root terminator must be the final command');
        if (cursor < limit && (commands[cursor].indent ?? 0) >= indent) fail(cursor, 'commands cannot follow the branch terminator');
        return;
      }
      if (command.code === 111) {
        sequence(indent + 1, loopDepth);
        if (matches(411, indent)) { cursor++; sequence(indent + 1, loopDepth); }
        close(412, indent);
      } else if (command.code === 102) {
        const choices = command.parameters[0] as string[];
        for (let choice = 0; choice < choices.length; choice++) {
          if (!matches(402, indent)) fail(cursor, `expected choice branch ${choice}`);
          const branch = commands[cursor];
          if (branch.parameters[0] !== choice || branch.parameters[1] !== choices[choice]) fail(cursor, 'choice index/text does not match Show Choices');
          cursor++;
          sequence(indent + 1, loopDepth);
        }
        if (command.parameters[1] === -2 || (command.parameters[1] as number) >= choices.length) {
          close(403, indent); sequence(indent + 1, loopDepth);
        }
        close(404, indent);
      } else if (command.code === 112) {
        sequence(indent + 1, loopDepth + 1); close(413, indent);
      } else if (command.code === 113 && loopDepth === 0) {
        fail(index, 'Break Loop must be inside a loop');
      } else if (command.code === 301 && matches(601, indent)) {
        cursor++; sequence(indent + 1, loopDepth);
        if (command.parameters[2]) { close(602, indent); sequence(indent + 1, loopDepth); }
        if (command.parameters[3]) { close(603, indent); sequence(indent + 1, loopDepth); }
        close(604, indent);
      }
      const continuation = continuationFor[command.code];
      if (continuation !== undefined) {
        while (matches(continuation, indent)) cursor++;
      }
    }
  };
  sequence(0, 0);
  insertionPoints.set(limit, 0);
  if (options.fragment && hasTerminal) commands.pop();
  return { commands, warnings, insertionPoints };
}
