import { EventCommand, MapEvent } from '../utils/types.js';
import { blockStructureWarnings } from './eventBlocks.js';
import { validateEventCommands, assertMvCommandShape } from '../../utils/eventCommandValidation.js';
import { validateMoveRoute } from './moveCommands.js';
import {
  TextMetrics,
  formatWidth,
  getActiveTextMetrics,
  lineBudget,
  measureLine,
} from './textMetrics.js';

/**
 * How seriously a finding should be taken.
 *
 * - `'error'` — **structural**: the data is malformed in a way that is almost
 *   always a bug (wrong parameter arity, an unterminated command list, a
 *   non-array `parameters`). Mutating tools refuse to write these by default;
 *   see `assertWritable` in `./gate.js`.
 * - `'warning'` — **advisory**: something looks off but is legitimately possible
 *   (an unrecognized command code may be a plugin command; an over-long text
 *   line is ugly, not broken). Never blocks a write.
 *
 * An absent `severity` means advisory — so a finding from a validator that
 * doesn't classify (asset names, references, transparency) can never block.
 */
export type Severity = 'error' | 'warning';

/**
 * A single validation finding. `severity` decides whether it blocks a write:
 * structural findings ('error') refuse the write unless the caller passes
 * `force: true`; everything else is advisory and merely reported.
 */
export interface ValidationWarning {
  path: string;
  code?: number;
  message: string;
  severity?: Severity;
}

export interface ValidationReport {
  ok: boolean;
  warnings: ValidationWarning[];
}

/**
 * Specification for a known RPG Maker MV event command. `check` returns a warning
 * message when the parameters look wrong, or `null` when they're fine. Commands
 * with no `check` are recognized (so they don't trip the unknown-code warning)
 * but their parameters aren't inspected.
 */
interface CommandSpec {
  name: string;
  check?: (params: unknown[]) => string | null;
}

const expectLength =
  (n: number) =>
  (params: unknown[]): string | null =>
    params.length === n ? null : `expected ${n} parameter(s), got ${params.length}`;

const expectAtLeast =
  (n: number) =>
  (params: unknown[]): string | null =>
    params.length >= n ? null : `expected at least ${n} parameter(s), got ${params.length}`;

const expectBetween =
  (min: number, max: number) =>
  (params: unknown[]): string | null =>
    params.length >= min && params.length <= max
      ? null
      : `expected ${min}–${max} parameters, got ${params.length}`;

/**
 * Show Choices (102). The engine's `setupChoices` reads `params[0]` as the choice
 * array and defaults every later slot it doesn't find (`params.length > 2 ? … `),
 * so a short list is legal — but a missing/non-array choice list is not: it
 * throws on `params[0].clone()`.
 */
function checkShowChoices(params: unknown[]): string | null {
  if (!Array.isArray(params[0])) {
    return 'parameters[0] must be the array of choice texts';
  }
  if (params[0].length === 0) {
    return 'the choice array is empty — a Show Choices needs at least one choice';
  }
  return expectBetween(2, 5)(params);
}

/**
 * Minimum parameter count per Conditional Branch (111) condition type, keyed by
 * `params[0]` (the type selector the engine's `command111` switches on). These are
 * minimums, not exact counts — a few types carry an extra parameter for a sub-kind
 * (e.g. actor "has state"), so an
 * over-long list is not a defect while a short one always is.
 */
const BRANCH_CONDITION_ARITY: Record<number, number> = {
  0: 3, // switch: [0, switchId, on/off]
  1: 5, // variable: [1, variableId, operandType, operand, comparison]
  2: 3, // self switch: [2, 'A'..'D', on/off]
  3: 3, // timer: [3, seconds, comparison]
  4: 3, // actor: [4, actorId, subKind, …]
  5: 3, // enemy: [5, enemyIndex, subKind, …]
  6: 3, // character: [6, characterId, direction]
  7: 3, // gold: [7, value, comparison]
  8: 2, // item: [8, itemId]
  9: 3, // weapon: [9, weaponId, includeEquip]
  10: 3, // armor: [10, armorId, includeEquip]
  11: 2, // button: [11, buttonName, …]
  12: 2, // script: [12, script]
  13: 2, // vehicle: [13, vehicleType]
};

/** Conditional Branch (111): the parameter count depends on the condition type. */
function checkConditionalBranch(params: unknown[]): string | null {
  const short = expectAtLeast(1)(params);
  if (short) return short;
  const type = params[0];
  if (typeof type !== 'number') return 'parameters[0] must be the numeric condition type';
  const min = BRANCH_CONDITION_ARITY[type];
  if (min === undefined) return null; // unknown/plugin condition type — don't guess
  return params.length >= min
    ? null
    : `condition type ${type} expects at least ${min} parameters, got ${params.length}`;
}

/**
 * Minimum parameter count per Control Variables (122) operand type, keyed by
 * `params[3]`. From `command122`: constant/variable/script read `params[4]`,
 * random reads `params[4..5]`, game data reads `params[4..6]`.
 */
const VARIABLE_OPERAND_ARITY: Record<number, number> = {
  0: 5, // constant
  1: 5, // variable
  2: 6, // random: min, max
  3: 7, // game data: dataType, param1, param2
  4: 5, // script
};

/** Control Variables (122): the parameter count depends on the operand type. */
function checkControlVariables(params: unknown[]): string | null {
  const short = expectAtLeast(4)(params);
  if (short) return short;
  const operandType = params[3];
  if (typeof operandType !== 'number') return 'parameters[3] must be the numeric operand type';
  const min = VARIABLE_OPERAND_ARITY[operandType];
  if (min === undefined) return null;
  return params.length >= min
    ? null
    : `operand type ${operandType} expects at least ${min} parameters, got ${params.length}`;
}

/**
 * Curated table of core RPG Maker MV event command codes. Not exhaustive — it
 * covers the commands this server is most likely to read or write, plus enough
 * of the common set that an unrecognized code is a meaningful signal. Codes not
 * listed here produce a soft "unrecognized" warning rather than an error, since
 * plugins are free to introduce their own.
 */
export const KNOWN_COMMANDS: Record<number, CommandSpec> = {
  0: { name: 'End of list' },
  // Messages
  101: {
    name: 'Show Text (setup)',
    check: (p) =>
      p.length === 4
        ? null
        : `MV Show Text expects 4 parameters, got ${p.length}`,
  },
  102: { name: 'Show Choices', check: checkShowChoices },
  103: { name: 'Input Number', check: expectLength(2) },
  104: { name: 'Select Item', check: expectLength(2) },
  105: { name: 'Show Scrolling Text', check: expectAtLeast(1) },
  108: { name: 'Comment', check: expectAtLeast(1) },
  // Flow control
  111: { name: 'Conditional Branch', check: checkConditionalBranch },
  112: { name: 'Loop' },
  113: { name: 'Break Loop' },
  115: { name: 'Exit Event Processing', check: expectLength(0) },
  117: { name: 'Common Event', check: expectLength(1) },
  118: { name: 'Label', check: expectLength(1) },
  119: { name: 'Jump to Label', check: expectLength(1) },
  // Game progression
  121: { name: 'Control Switches', check: expectLength(3) },
  122: { name: 'Control Variables', check: checkControlVariables },
  123: { name: 'Control Self Switch', check: expectLength(2) },
  124: { name: 'Control Timer', check: expectAtLeast(1) },
  125: { name: 'Change Gold', check: expectLength(3) },
  126: { name: 'Change Items', check: expectLength(4) },
  127: { name: 'Change Weapons', check: expectLength(5) },
  128: { name: 'Change Armors', check: expectLength(5) },
  129: { name: 'Change Party Member', check: expectLength(3) },
  // System settings (name-only; params not inspected)
  132: { name: 'Change Battle BGM' },
  133: { name: 'Change Victory ME' },
  134: { name: 'Change Save Access' },
  135: { name: 'Change Menu Access' },
  136: { name: 'Change Encounter Disable' },
  137: { name: 'Change Formation Access' },
  138: { name: 'Change Window Color' },
  139: { name: 'Change Defeat ME' },
  140: { name: 'Change Vehicle BGM' },
  // Movement / character
  201: { name: 'Transfer Player', check: expectLength(6) },
  202: { name: 'Set Vehicle Location' },
  203: { name: 'Set Event Location' },
  204: { name: 'Scroll Map' },
  205: { name: 'Set Movement Route', check: expectAtLeast(2) },
  206: { name: 'Get on/off Vehicle' },
  211: { name: 'Change Transparency' },
  212: { name: 'Show Animation', check: expectLength(3) },
  213: { name: 'Show Balloon Icon', check: expectLength(3) },
  214: { name: 'Erase Event' },
  216: { name: 'Change Player Followers' },
  217: { name: 'Gather Followers' },
  // Screen / audio / timing
  221: { name: 'Fadeout Screen', check: expectLength(0) },
  222: { name: 'Fadein Screen', check: expectLength(0) },
  223: { name: 'Tint Screen', check: expectLength(3) },
  224: { name: 'Flash Screen', check: expectLength(3) },
  225: { name: 'Shake Screen', check: expectLength(4) },
  230: { name: 'Wait', check: expectLength(1) },
  231: { name: 'Show Picture', check: expectLength(10) },
  232: { name: 'Move Picture' },
  233: { name: 'Rotate Picture' },
  234: { name: 'Tint Picture' },
  235: { name: 'Erase Picture', check: expectLength(1) },
  236: { name: 'Set Weather Effect' },
  241: { name: 'Play BGM', check: expectLength(1) },
  242: { name: 'Fadeout BGM' },
  243: { name: 'Save BGM' },
  244: { name: 'Replay BGM' },
  245: { name: 'Play BGS', check: expectLength(1) },
  246: { name: 'Fadeout BGS' },
  249: { name: 'Play ME', check: expectLength(1) },
  250: { name: 'Play SE', check: expectLength(1) },
  251: { name: 'Stop SE' },
  261: { name: 'Play Movie' },
  // Map / scene settings
  281: { name: 'Change Map Name Display' },
  282: { name: 'Change Tileset' },
  283: { name: 'Change Battle Background' },
  284: { name: 'Change Parallax' },
  285: { name: 'Get Location Info' },
  // Actor / party
  301: { name: 'Battle Processing', check: expectLength(4) },
  302: { name: 'Shop Processing', check: expectLength(5) },
  303: { name: 'Name Input Processing', check: expectLength(2) },
  311: { name: 'Change HP', check: expectLength(6) },
  312: { name: 'Change MP', check: expectLength(5) },
  313: { name: 'Change State', check: expectLength(4) },
  314: { name: 'Recover All', check: expectLength(2) },
  315: { name: 'Change EXP', check: expectLength(6) },
  316: { name: 'Change Level', check: expectLength(6) },
  // Actor attributes (name-only; params not inspected)
  317: { name: 'Change Parameter' },
  318: { name: 'Change Skill' },
  319: { name: 'Change Equipment' },
  320: { name: 'Change Name' },
  321: { name: 'Change Class' },
  322: { name: 'Change Actor Images' },
  323: { name: 'Change Vehicle Image' },
  324: { name: 'Change Nickname' },
  325: { name: 'Change Profile' },
  326: { name: 'Change TP' },
  // Enemy (in-battle). Codes per rpg_objects.js Game_Interpreter.command3xx —
  // note Change Enemy TP is 342 in the installed MV 1.6.1 core, not 333.
  331: { name: 'Change Enemy HP' },
  332: { name: 'Change Enemy MP' },
  333: { name: 'Change Enemy State', check: expectLength(3) },
  334: { name: 'Enemy Recover All' },
  335: { name: 'Enemy Appear', check: expectLength(1) },
  336: { name: 'Enemy Transform' },
  337: { name: 'Show Battle Animation' },
  339: { name: 'Force Action' },
  340: { name: 'Abort Battle', check: expectLength(0) },
  342: { name: 'Change Enemy TP' },
  // Scene control (all parameterless)
  351: { name: 'Open Menu Screen', check: expectLength(0) },
  352: { name: 'Open Save Screen', check: expectLength(0) },
  353: { name: 'Game Over', check: expectLength(0) },
  354: { name: 'Return to Title Screen', check: expectLength(0) },
  // Advanced
  355: { name: 'Script', check: expectAtLeast(1) },
  356: { name: 'Plugin Command (MV)', check: expectAtLeast(1) },
  357: { name: 'Plugin Command (MZ)', check: () => 'MZ code 357 is unsupported in MV; use 356' },
  657: { name: 'Plugin command annotation (MZ)', check: () => 'MZ code 657 is unsupported in MV' },
  // Continuation codes (data rows for the setup command above them)
  401: { name: 'Show Text line', check: expectLength(1) },
  402: { name: 'When [choice]', check: expectLength(2) },
  403: { name: 'When Cancel', check: expectLength(0) },
  404: { name: 'End Choices', check: expectLength(0) },
  405: { name: 'Scrolling Text line', check: expectLength(1) },
  408: { name: 'Comment line', check: expectAtLeast(1) },
  505: { name: 'Move Route step', check: expectLength(1) },
  601: { name: 'If Win', check: expectLength(0) },
  602: { name: 'If Escape', check: expectLength(0) },
  603: { name: 'If Lose', check: expectLength(0) },
  604: { name: 'End Battle Processing', check: expectLength(0) },
  605: { name: 'Shop goods', check: expectLength(4) },
  411: { name: 'Else', check: expectLength(0) },
  412: { name: 'End Conditional Branch', check: expectLength(0) },
  413: { name: 'Repeat Above', check: expectLength(0) },
  655: { name: 'Script line', check: expectAtLeast(1) },
};

/** Validate a single event command. */
export function validateCommand(command: EventCommand, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (typeof command?.code !== 'number') {
    warnings.push({ path, message: 'command is missing a numeric `code`', severity: 'error' });
    return warnings;
  }

  if (!Array.isArray(command.parameters)) {
    warnings.push({
      path,
      code: command.code,
      message: '`parameters` is not an array',
      severity: 'error',
    });
    return warnings;
  }

  const spec = KNOWN_COMMANDS[command.code];
  if (!spec) {
    // Advisory: KNOWN_COMMANDS is curated, not exhaustive, and plugins are free
    // to introduce their own codes — blocking here would fail valid writes.
    warnings.push({
      path,
      code: command.code,
      message: `unrecognized command code ${command.code} (may be a plugin command)`,
      severity: 'warning',
    });
    return warnings;
  }

  const problem = spec.check?.(command.parameters);
  if (problem) {
    warnings.push({
      path,
      code: command.code,
      message: `${spec.name}: ${problem}`,
      severity: 'error',
    });
  }

  try {
    assertMvCommandShape(command);
  } catch (error) {
    warnings.push({ path, code: command.code, severity: 'error', message: String((error as Error).message) });
  }
  if (command.code === 205) warnings.push(...validateMoveRoute(command.parameters[1], `${path} / forced route`));

  return warnings;
}

/**
 * Warn (never block) on Show Text lines (401) too wide for the message window —
 * RPG Maker MV does **not** word-wrap, an over-long line is silently cut off at
 * the window edge. Face-aware: a 101 setup with a face image shrinks the budget
 * for the 401 lines that follow it. Exported so the read-only text builders can
 * surface the same warning at build time (on fragments without a terminator).
 *
 * `metrics` defaults to whatever the dispatcher installed for the active project
 * (see {@link getActiveTextMetrics}) — a character-count estimate unless the project
 * supplies a pixel width table. Tests pass it explicitly.
 */
export function textLineWidthWarnings(
  list: EventCommand[],
  path: string,
  metrics: TextMetrics = getActiveTextMetrics(),
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  let faceShown = false;
  const approx = metrics.unit === 'chars' ? '~' : '';

  list.forEach((command, i) => {
    if (!command || !Array.isArray(command.parameters)) return;
    if (command.code === 101) {
      faceShown = typeof command.parameters[0] === 'string' && command.parameters[0] !== '';
    } else if (command.code === 401 && typeof command.parameters[0] === 'string') {
      const limit = lineBudget(metrics, faceShown);
      const width = measureLine(command.parameters[0], metrics);
      if (width > limit) {
        warnings.push({
          path: `${path} / command ${i}`,
          code: 401,
          // Advisory even when measured in pixels: the project's own table could be
          // stale, and an over-long line still runs.
          severity: 'warning',
          message: `Show Text line is ${formatWidth(width, metrics)} but the message window fits ${approx}${formatWidth(limit, metrics)}${faceShown ? ' with a face shown' : ''} — MV does not word-wrap, the end will be cut off; split it into shorter 401 lines`,
        });
      }
    }
  });

  return warnings;
}

/**
 * Validate an event command list (an event page's `list`). Checks that it is a
 * proper array terminated by the code-0 end marker, then validates each command.
 */
export function validateCommandList(list: unknown, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!Array.isArray(list)) {
    warnings.push({ path, message: 'command list is not an array', severity: 'error' });
    return warnings;
  }

  if (list.length === 0 || list[list.length - 1]?.code !== 0) {
    warnings.push({
      path,
      message: 'command list should end with an end-of-list command (code 0)',
      severity: 'error',
    });
  }

  list.forEach((command, i) => {
    warnings.push(...validateCommand(command as EventCommand, `${path} / command ${i}`));
  });

  warnings.push(...blockStructureWarnings(list as EventCommand[], path));
  try {
    validateEventCommands(list);
  } catch (error) {
    warnings.push({ path, severity: 'error', message: String((error as Error).message) });
  }
  warnings.push(...textLineWidthWarnings(list as EventCommand[], path));

  return warnings;
}

/** Validate every page of an event. */
export function validateEvent(event: MapEvent, path = `event ${event?.id}`): ValidationReport {
  const warnings: ValidationWarning[] = [];

  if (!event || !Array.isArray(event.pages)) {
    warnings.push({ path, message: 'event has no `pages` array', severity: 'error' });
    return { ok: warnings.length === 0, warnings };
  }

  event.pages.forEach((page, i) => {
    warnings.push(...validateCommandList(page?.list, `${path} / page ${i}`));
    if (page?.moveType === 3) warnings.push(...validateMoveRoute(page.moveRoute, `${path} / page ${i} / autonomous route`));
    const domains: [string, unknown, number, number][] = [
      ['trigger', page?.trigger, 0, 4], ['priorityType', page?.priorityType, 0, 2],
      ['moveType', page?.moveType, 0, 3], ['moveSpeed', page?.moveSpeed, 1, 6],
      ['moveFrequency', page?.moveFrequency, 1, 5], ['characterIndex', page?.image?.characterIndex, 0, 7],
      ['pattern', page?.image?.pattern, 0, 2],
    ];
    for (const [name, value, min, max] of domains) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) {
        warnings.push({ path: `${path} / page ${i}`, severity: 'error', message: `${name} must be an integer ${min}–${max}` });
      }
    }
  });

  return { ok: warnings.length === 0, warnings };
}

/** Validate every (non-null) event in a map's `events` array. */
export function validateEvents(events: (MapEvent | null)[]): ValidationReport {
  const warnings: ValidationWarning[] = [];

  events.forEach((event) => {
    if (event) {
      warnings.push(...validateEvent(event).warnings);
    }
  });

  return { ok: warnings.length === 0, warnings };
}
