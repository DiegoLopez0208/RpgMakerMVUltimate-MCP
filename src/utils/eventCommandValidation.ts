import type { EventCommand } from '../types/rpgmaker.js';
import { validateMoveRoute, validateMoveCommand } from '../parity/validation/moveCommands.js';

export interface EventCommandValidation {
  commands: EventCommand[];
  warnings: string[];
  /** Safe array positions and the indent at which a complete fragment belongs. */
  insertionPoints: Map<number, number>;
}

const arities: Record<number, number> = {
  0: 0, 101: 4, 103: 2, 104: 2, 105: 2, 108: 1, 112: 0, 113: 0,
  115: 0, 117: 1, 118: 1, 119: 1, 121: 3, 123: 2, 124: 2,
  125: 3, 126: 4, 127: 5, 128: 5, 129: 3, 201: 6, 205: 2,
  212: 3, 213: 3, 221: 0, 222: 0, 223: 3, 224: 3, 225: 4,
  230: 1, 231: 10, 235: 1, 241: 1, 245: 1, 249: 1, 250: 1,
  301: 4, 302: 5, 303: 2, 351: 0, 352: 0, 353: 0, 354: 0,
  311: 6, 312: 5, 313: 4, 314: 2, 315: 6, 316: 6,
  333: 3, 335: 1, 340: 0,
  355: 1, 356: 1, 401: 1, 402: 2, 403: 0, 404: 0, 405: 1,
  408: 1, 411: 0, 412: 0, 413: 0, 505: 1, 601: 0, 602: 0,
  603: 0, 604: 0, 605: 4, 655: 1,
};
const otherKnownCodes = new Set([
  111, 122, 102, 132, 133, 134, 135, 136, 137, 138, 139, 140,
  202, 203, 204, 206, 211, 214, 216, 217, 232, 233, 234, 236,
  242, 243, 244, 246, 251, 261, 281, 282, 283, 284, 285,
  311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322,
  323, 324, 325, 326, 331, 332, 333, 334, 335, 336, 337, 339, 340, 342,
]);
const delimiters = new Set([402, 403, 404, 411, 412, 413, 601, 602, 603, 604]);
const continuationFor: Record<number, number> = { 101: 401, 105: 405, 108: 408, 205: 505, 302: 605, 355: 655 };
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
  if (arities[code] !== undefined) {
    require(p.length === arities[code], `MV code ${code} expects ${arities[code]} parameters, got ${p.length}`);
  } else if (!otherKnownCodes.has(code)) {
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
  } else if ([125, 126, 127, 128].includes(code)) {
    const offset = code === 125 ? 0 : 1;
    if (offset) id(0);
    range(offset, 0, 1); range(offset + 1, 0, 1);
    if (p[offset + 1] === 1) id(offset + 2);
    else require(typeof p[offset + 2] === 'number' && Number.isFinite(p[offset + 2]), 'amount must be finite');
    if (code === 127 || code === 128) require(typeof p[4] === 'boolean', 'include equipment must be boolean');
  } else if (code === 129) {
    id(0); range(1, 0, 1); require(typeof p[2] === 'boolean', 'initialize must be boolean');
  } else if (code === 212 || code === 213) {
    range(0, -1, Number.MAX_SAFE_INTEGER); id(1);
    require(typeof p[2] === 'boolean', 'wait must be boolean');
  } else if (code === 223 || code === 224) {
    require(Array.isArray(p[0]) && p[0].length === 4 && p[0].every((v, i) => integer(v, code === 223 && i < 3 ? -255 : 0, 255)), 'color must contain four valid integer channels');
    range(1, 0, Number.MAX_SAFE_INTEGER); require(typeof p[2] === 'boolean', 'wait must be boolean');
  } else if (code === 225) {
    range(0, 1, 9); range(1, 1, 9); range(2, 0, Number.MAX_SAFE_INTEGER);
    require(typeof p[3] === 'boolean', 'wait must be boolean');
  } else if (code === 231) {
    range(0, 1, 100); require(typeof p[1] === 'string', 'picture name must be a string');
    range(2, 0, 1); range(3, 0, 1);
    for (const slot of [4, 5, 6, 7]) require(typeof p[slot] === 'number' && Number.isFinite(p[slot]), 'picture coordinates/scales must be finite');
    if (p[3] === 1) { id(4); id(5); }
    range(8, 0, 255); range(9, 0, 3);
  } else if (code === 235) range(0, 1, 100);
  else if ([241, 245, 249, 250].includes(code)) {
    const audio = p[0] as Record<string, unknown>;
    require(!!audio && typeof audio === 'object' && !Array.isArray(audio), 'audio must be an object');
    require(typeof audio.name === 'string', 'audio name must be a string');
    for (const [key, min, max] of [['volume', 0, 100], ['pitch', 50, 150], ['pan', -100, 100]] as const) {
      require(typeof audio[key] === 'number' && Number.isFinite(audio[key]) && (audio[key] as number) >= min && (audio[key] as number) <= max, `invalid audio ${key}`);
    }
  } else if (code === 302 || code === 605) {
    range(0, 0, 2); id(1); range(2, 0, 1); range(3, 0, Number.MAX_SAFE_INTEGER);
    if (code === 302) require(typeof p[4] === 'boolean', 'purchaseOnly must be boolean');
  } else if (code === 303) { id(0); range(1, 1, 16); }
  else if ([311, 312, 313, 314, 315, 316].includes(code)) {
    range(0, 0, 1); range(1, p[0] === 1 ? 1 : 0, Number.MAX_SAFE_INTEGER);
    if (code === 313) { range(2, 0, 1); id(3); }
    else if (code !== 314) {
      range(2, 0, 1); range(3, 0, 1);
      if (p[3] === 1) id(4);
      else require(typeof p[4] === 'number' && Number.isFinite(p[4]), 'amount must be finite');
      if (code !== 312) require(typeof p[5] === 'boolean', 'actor change flag must be boolean');
    }
  } else if (code === 333) { range(0, -1, 7); range(1, 0, 1); id(2); }
  else if (code === 335) range(0, 0, 7);
  else if (code === 205) {
    range(0, -1, Number.MAX_SAFE_INTEGER);
    for (const finding of validateMoveRoute(p[1])) {
      if (finding.severity === 'error') fail(index, finding.message);
      warnings.push(finding.message);
    }
  } else if (code === 505) {
    for (const finding of validateMoveCommand(p[0] as never, 'move step')) {
      if (finding.severity === 'error') fail(index, finding.message);
      warnings.push(finding.message);
    }
  }
}

/** Shared parameter checks for pure builders before a complete list exists. */
export function assertMvCommandShape(command: EventCommand): void {
  if (!integer(command.code, 0) || !integer(command.indent ?? 0, 0, 100)) throw new Error('command code/indent must be valid integers');
  if (!Array.isArray(command.parameters)) throw new Error('command parameters must be an array');
  checkShape(command, 0, []);
}

/** Engine incompatibilities cannot be overridden by a structural-warning force flag. */
export function assertMvCompatibility(input: unknown): void {
  if (!Array.isArray(input)) return;
  input.forEach((command, index) => {
    const code = command?.code;
    const p = command?.parameters;
    if (code === 357 || code === 657) fail(index, `MZ code ${code} cannot be written to MV; use plugin command 356`);
    if (code === 101 && Array.isArray(p) && p.length > 4) fail(index, 'MV Show Text has four parameters; MZ speakerName is unsupported');
    if (code === 122 && Array.isArray(p) && p[3] === 3 && p[4] === 8) fail(index, 'MZ last-game-data operand 8 is unsupported in MV');
  });
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
