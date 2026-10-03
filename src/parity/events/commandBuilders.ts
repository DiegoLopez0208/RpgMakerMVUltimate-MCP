import { EventCommand } from '../utils/types.js';
import { assertMvCommandShape, validateEventCommands } from '../../utils/eventCommandValidation.js';
import {
  MESSAGE_BOX_LINES,
  TextMetrics,
  WrapMode,
  getActiveTextMetrics,
  wrapLines,
} from '../validation/textMetrics.js';

/**
 * Splice built commands into a command list before its code-0 end marker (or at
 * `position` when it's a valid in-range index). Shared by every insert path
 * (map event page, common event, troop page, single-command add) so the "insert
 * before the terminator" rule lives in one place. Mutates `list` in place.
 */
export function spliceIntoList(
  list: EventCommand[],
  commands: EventCommand[],
  position?: number,
): void {
  const insertAt =
    position !== undefined && position >= 0 && position < list.length - 1
      ? position
      : list.length - 1; // before the end-of-list command (code 0)
  list.splice(insertAt, 0, ...commands);
}

/**
 * Pure builders for common vanilla RPG Maker MV event commands. Each returns the
 * exact `EventCommand[]` sequence the editor writes on disk (validated against
 * real editor output), ready to splice into an event page's `list` via
 * `insert_event_commands`. No I/O — every function is a pure transform so the
 * byte-for-byte shape can be unit-tested.
 *
 * Block commands (Show Choices, Conditional Branch) follow the editor's recursive
 * layout: the block-opener sits at `indent`, each branch body sits at `indent + 1`
 * and is closed by its own `{ code: 0 }` end-of-branch marker at that child indent
 * — exactly as the editor serializes them (an empty branch still gets the marker).
 */

/** Event command codes emitted by these builders. */
const CODE = {
  SHOW_TEXT: 101,
  SHOW_TEXT_LINE: 401,
  SHOW_CHOICES: 102,
  WHEN_CHOICE: 402,
  WHEN_CANCEL: 403,
  END_CHOICES: 404,
  CONDITIONAL_BRANCH: 111,
  ELSE: 411,
  END_BRANCH: 412,
  EXIT_EVENT: 115,
  LABEL: 118,
  JUMP_TO_LABEL: 119,
  CONTROL_SWITCHES: 121,
  CONTROL_VARIABLES: 122,
  CONTROL_SELF_SWITCH: 123,
  CHANGE_GOLD: 125,
  CHANGE_ITEMS: 126,
  CHANGE_WEAPONS: 127,
  CHANGE_ARMORS: 128,
  CHANGE_PARTY_MEMBER: 129,
  TRANSFER_PLAYER: 201,
  SHOW_ANIMATION: 212,
  SHOW_BALLOON: 213,
  FADEOUT_SCREEN: 221,
  FADEIN_SCREEN: 222,
  TINT_SCREEN: 223,
  FLASH_SCREEN: 224,
  SHAKE_SCREEN: 225,
  WAIT: 230,
  SHOW_PICTURE: 231,
  ERASE_PICTURE: 235,
  PLAY_BGM: 241,
  PLAY_BGS: 245,
  PLAY_ME: 249,
  PLAY_SE: 250,
  BATTLE_PROCESSING: 301,
  SHOP_PROCESSING: 302,
  SHOP_GOODS: 605,
  NAME_INPUT: 303,
  CHANGE_HP: 311,
  CHANGE_MP: 312,
  CHANGE_STATE: 313,
  RECOVER_ALL: 314,
  CHANGE_EXP: 315,
  CHANGE_LEVEL: 316,
  CHANGE_ENEMY_STATE: 333,
  ENEMY_APPEAR: 335,
  ABORT_BATTLE: 340,
  END_OF_LIST: 0,
} as const;

/** Encode a switch/self-switch on/off value as the engine's code (0 on, 1 off). */
const onOff = (value?: 'on' | 'off'): number => (value === 'off' ? 1 : 0);

/** Build one event command with an always-present parameters array. */
function cmd(code: number, indent: number, parameters: unknown[] = []): EventCommand {
  const command = { code, indent, parameters };
  assertMvCommandShape(command);
  return command;
}

/**
 * Place a caller-supplied branch body at `childIndent`. The body is normalized so
 * its shallowest command sits at `childIndent` (regardless of the indent it was
 * authored at), preserving any internal nesting — so builders compose cleanly.
 * Always followed by the `{ code: 0 }` end-of-branch marker the editor writes.
 */
function branchBody(body: EventCommand[] | undefined, childIndent: number): EventCommand[] {
  const commands = body ?? [];
  const minIndent = commands.reduce(
    (min, c) => Math.min(min, c.indent ?? 0),
    commands.length > 0 ? Infinity : 0,
  );
  const normalized = validateEventCommands(commands.map(c => ({
    ...c, indent: (c.indent ?? 0) - minIndent,
  })), { fragment: true }).commands;
  const shifted = normalized.map(c => cmd(c.code, (c.indent ?? 0) + childIndent, c.parameters));
  shifted.push(cmd(CODE.END_OF_LIST, childIndent));
  return shifted;
}

/** Message window position (top/middle/bottom) as the engine's positionType code. */
export type TextPosition = 'top' | 'middle' | 'bottom';
/** Message window background (window/dim/transparent) as the engine's code. */
export type TextBackground = 'window' | 'dim' | 'transparent';

const POSITION_CODE: Record<TextPosition, number> = { top: 0, middle: 1, bottom: 2 };
const BACKGROUND_CODE: Record<TextBackground, number> = { window: 0, dim: 1, transparent: 2 };

export interface ShowTextOptions {
  /** Face image basename (from list_assets('faces')); '' = no face. Default ''. */
  faceName?: string;
  /** Face index 0–7 within the face sheet. Default 0. */
  faceIndex?: number;
  /** Window background. Default 'window'. */
  background?: TextBackground;
  /** Window position on screen. Default 'bottom'. */
  position?: TextPosition;
  /** Indentation level in the target list. Default 0. */
  indent?: number;
  /**
   * Auto word-wrap to the message window and split into 4-line boxes (one 101 setup
   * per box). `true` = `'soft'` (reflow everything as one paragraph); `'hard'` keeps
   * each entry / `\n` as a forced break. Default off: one 401 per entry, verbatim.
   */
  wrap?: boolean | WrapMode;
  /** Metrics to wrap with. Default: the active project's (same as the width check). */
  metrics?: TextMetrics;
}

/**
 * Show Text (command 101 setup + one 401 line per text line). `lines` are the
 * message lines; MV does not word-wrap, so by default pass one entry per visual
 * line you intend. With `wrap`, the lines are word-wrapped to the width the
 * line-width check uses and split into as many 4-line boxes as needed, each with
 * its own identical 101 setup. Face/background/position/speaker match the
 * editor's Show Text dialog.
 */
export function showText(lines: string[], options: ShowTextOptions = {}): EventCommand[] {
  const indent = options.indent ?? 0;
  const faceName = options.faceName ?? '';
  const setup = (): EventCommand =>
    cmd(CODE.SHOW_TEXT, indent, [
      faceName,
      options.faceIndex ?? 0,
      BACKGROUND_CODE[options.background ?? 'window'],
      POSITION_CODE[options.position ?? 'bottom'],
    ]);
  const toLine = (line: string): EventCommand => cmd(CODE.SHOW_TEXT_LINE, indent, [String(line)]);

  if (!options.wrap) return [setup(), ...lines.map(toLine)];

  const mode: WrapMode = options.wrap === 'hard' ? 'hard' : 'soft';
  const wrapped = wrapLines(
    lines,
    faceName !== '',
    mode,
    options.metrics ?? getActiveTextMetrics(),
  );
  if (wrapped.length === 0) return [setup()];
  const out: EventCommand[] = [];
  for (let i = 0; i < wrapped.length; i += MESSAGE_BOX_LINES) {
    out.push(setup(), ...wrapped.slice(i, i + MESSAGE_BOX_LINES).map(toLine));
  }
  return out;
}

/** Choice list window position (left/middle/right). */
export type ChoicePosition = 'left' | 'middle' | 'right';
const CHOICE_POSITION_CODE: Record<ChoicePosition, number> = { left: 0, middle: 1, right: 2 };

export interface ShowChoicesOptions {
  /** Command body per choice (same order as `choices`); omitted/short = empty branches. */
  branches?: EventCommand[][];
  /** When present, adds a "When Cancel" (403) branch and marks cancel = branch. */
  cancelBranch?: EventCommand[];
  /**
   * Which choice the Cancel button maps to when there's no cancelBranch: a 0-based
   * choice index, or -1 for "Disallow" (cancel does nothing). Default -1. Ignored
   * when `cancelBranch` is given (cancel then routes to that branch).
   */
  cancelType?: number;
  /** 0-based default (highlighted) choice, or -1 for none. Default 0. */
  defaultType?: number;
  /** Choice window position. Default 'right'. */
  position?: ChoicePosition;
  /** Choice window background. Default 'window'. */
  background?: TextBackground;
  /** Indentation level of the block opener. Default 0. */
  indent?: number;
}

/**
 * Show Choices — the 102 opener + a 402 "When [choice]" branch per choice
 * (optionally a 403 "When Cancel" branch) + the 404 "End Choices" closer. Each
 * branch body is placed at indent+1 and terminated with a code-0 marker, matching
 * the editor. The engine reads cancelType via `params[1] < choices.length ? … : -2`,
 * so a cancel branch is encoded as cancelType = choices.length.
 */
export function showChoices(choices: string[], options: ShowChoicesOptions = {}): EventCommand[] {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('showChoices requires a non-empty `choices` array');
  }
  const indent = options.indent ?? 0;
  const child = indent + 1;
  const hasCancelBranch = options.cancelBranch !== undefined;
  const cancelType = hasCancelBranch ? choices.length : (options.cancelType ?? -1);

  const out: EventCommand[] = [
    cmd(CODE.SHOW_CHOICES, indent, [
      choices.map((c) => String(c)),
      cancelType,
      options.defaultType ?? 0,
      CHOICE_POSITION_CODE[options.position ?? 'right'],
      BACKGROUND_CODE[options.background ?? 'window'],
    ]),
  ];

  choices.forEach((choice, i) => {
    out.push(cmd(CODE.WHEN_CHOICE, indent, [i, String(choice)]));
    out.push(...branchBody(options.branches?.[i], child));
  });

  if (hasCancelBranch) {
    out.push(cmd(CODE.WHEN_CANCEL, indent));
    out.push(...branchBody(options.cancelBranch, child));
  }

  out.push(cmd(CODE.END_CHOICES, indent));
  return out;
}

/** A comparison operator for the Variable conditional-branch condition. */
export type Comparison = '==' | '>=' | '<=' | '>' | '<' | '!=';
const COMPARISON_CODE: Record<Comparison, number> = {
  '==': 0,
  '>=': 1,
  '<=': 2,
  '>': 3,
  '<': 4,
  '!=': 5,
};
/** A comparison operator for the Gold conditional-branch condition. */
export type GoldCompare = '>=' | '<=' | '<';
const GOLD_COMPARE_CODE: Record<GoldCompare, number> = { '>=': 0, '<=': 1, '<': 2 };

/**
 * A Conditional Branch condition. Covers the common vanilla condition types
 * (switch, variable, self switch, actor-in-party, gold, item). Each maps to the
 * engine's `command111` parameter layout.
 */
export type BranchCondition =
  | { type: 'switch'; switchId: number; value?: 'on' | 'off' }
  | { type: 'self_switch'; name: 'A' | 'B' | 'C' | 'D'; value?: 'on' | 'off' }
  | {
      type: 'variable';
      variableId: number;
      comparison: Comparison;
      /** Compare against this constant (default 0) unless `variableOperand` is set. */
      constant?: number;
      /** Compare against the value of this variable id (takes precedence over constant). */
      variableOperand?: number;
    }
  | { type: 'actor_in_party'; actorId: number }
  | { type: 'gold'; value: number; compare?: GoldCompare }
  | { type: 'item'; itemId: number };

/** Turn a {@link BranchCondition} into the code-111 parameters array. */
export function conditionParameters(condition: BranchCondition): unknown[] {
  switch (condition.type) {
    case 'switch':
      return [0, condition.switchId, condition.value === 'off' ? 1 : 0];
    case 'self_switch':
      return [2, condition.name, condition.value === 'off' ? 1 : 0];
    case 'variable': {
      const useVar = condition.variableOperand !== undefined;
      return [
        1,
        condition.variableId,
        useVar ? 1 : 0,
        useVar ? condition.variableOperand : (condition.constant ?? 0),
        COMPARISON_CODE[condition.comparison],
      ];
    }
    case 'actor_in_party':
      return [4, condition.actorId, 0];
    case 'gold':
      return [7, condition.value, GOLD_COMPARE_CODE[condition.compare ?? '>=']];
    case 'item':
      return [8, condition.itemId];
  }
}

export interface ConditionalBranchOptions {
  /** Commands to run when the condition is true. Default empty. */
  thenBranch?: EventCommand[];
  /** Commands for the Else branch. Presence (even if empty) adds the 411 Else block. */
  elseBranch?: EventCommand[];
  /** Indentation level of the block opener. Default 0. */
  indent?: number;
}

/**
 * Conditional Branch — the 111 opener (condition), the then-branch body, an
 * optional 411 "Else" branch, and the 412 "End" closer. Each branch body is
 * placed at indent+1 and terminated with a code-0 marker, matching the editor.
 * The Else block is emitted only when `elseBranch` is provided.
 */
export function conditionalBranch(
  condition: BranchCondition,
  options: ConditionalBranchOptions = {},
): EventCommand[] {
  const indent = options.indent ?? 0;
  const child = indent + 1;

  const out: EventCommand[] = [
    cmd(CODE.CONDITIONAL_BRANCH, indent, conditionParameters(condition)),
    ...branchBody(options.thenBranch, child),
  ];

  if (options.elseBranch !== undefined) {
    out.push(cmd(CODE.ELSE, indent));
    out.push(...branchBody(options.elseBranch, child));
  }

  out.push(cmd(CODE.END_BRANCH, indent));
  return out;
}

/** Wait a number of frames (command 230; 60 frames = 1 second). */
export function wait(frames: number, indent = 0): EventCommand {
  return cmd(CODE.WAIT, indent, [frames]);
}

/** Exit Event Processing (command 115) — stops the current event's list early. */
export function exitEvent(indent = 0): EventCommand {
  return cmd(CODE.EXIT_EVENT, indent, []);
}

/** Label (command 118) — a named jump target within the same command list. */
export function label(name: string, indent = 0): EventCommand {
  return cmd(CODE.LABEL, indent, [String(name)]);
}

/** Jump to Label (command 119) — jumps to the matching {@link label} by name. */
export function jumpToLabel(name: string, indent = 0): EventCommand {
  return cmd(CODE.JUMP_TO_LABEL, indent, [String(name)]);
}

// --- 5e-2 game state ---

/**
 * Control Switches (command 121) — turn a switch (or an inclusive range of
 * switches `startId..endId`) on or off. Pass the same id for `endId` to set a
 * single switch. On disk: `[startId, endId, value]` where value 0 = ON, 1 = OFF.
 */
export function controlSwitches(
  startId: number,
  endId: number,
  value: 'on' | 'off' = 'on',
  indent = 0,
): EventCommand {
  return cmd(CODE.CONTROL_SWITCHES, indent, [startId, endId, onOff(value)]);
}

/**
 * Control Self Switch (command 123) — turn one of the current event's self
 * switches (A–D) on or off. On disk: `[name, value]` (value 0 = ON, 1 = OFF).
 */
export function controlSelfSwitch(
  name: 'A' | 'B' | 'C' | 'D',
  value: 'on' | 'off' = 'on',
  indent = 0,
): EventCommand {
  return cmd(CODE.CONTROL_SELF_SWITCH, indent, [name, onOff(value)]);
}

/** The arithmetic applied to the target variable(s) by Control Variables. */
export type VariableOperation = 'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod';
const VARIABLE_OPERATION_CODE: Record<VariableOperation, number> = {
  set: 0,
  add: 1,
  sub: 2,
  mul: 3,
  div: 4,
  mod: 5,
};

/**
 * The right-hand operand of a Control Variables command. `game_data` reaches the
 * engine's `gameDataOperand(dataType, param1, param2)` table (dataType 0 item /
 * 1 weapon / 2 armor count, 3 actor, 4 enemy, 5 character, 6 party, 7 other,
 * see the MV corescript for each type's param1/param2 meanings; MZ type 8 is unsupported).
 */
export type VariableOperand =
  | { type: 'constant'; value: number }
  | { type: 'variable'; variableId: number }
  | { type: 'random'; min: number; max: number }
  | { type: 'game_data'; dataType: number; param1?: number; param2?: number };

/** Turn a {@link VariableOperand} into the trailing code-122 parameters (from params[3]). */
function variableOperandParams(operand: VariableOperand): unknown[] {
  switch (operand.type) {
    case 'constant':
      return [0, operand.value];
    case 'variable':
      return [1, operand.variableId];
    case 'random':
      return [2, operand.min, operand.max];
    case 'game_data':
      return [3, operand.dataType, operand.param1 ?? 0, operand.param2 ?? 0];
  }
}

export interface ControlVariablesOptions {
  /** Range end id (inclusive); defaults to `variableId` (a single variable). */
  endId?: number;
  /** Indentation level. Default 0. */
  indent?: number;
}

/**
 * Control Variables (command 122) — apply `operation` to a variable (or an
 * inclusive `variableId..endId` range) using `operand`. On disk:
 * `[startId, endId, operationType, operandType, ...operandParams]`.
 */
export function controlVariables(
  variableId: number,
  operation: VariableOperation,
  operand: VariableOperand,
  options: ControlVariablesOptions = {},
): EventCommand {
  return cmd(CODE.CONTROL_VARIABLES, options.indent ?? 0, [
    variableId,
    options.endId ?? variableId,
    VARIABLE_OPERATION_CODE[operation],
    ...variableOperandParams(operand),
  ]);
}

/** Increase or decrease, shared by Change Gold/Items/Weapons/Armors. */
export type GainOperation = 'increase' | 'decrease';
/** A constant or variable amount, shared by the Change Gold/Items/Weapons/Armors commands. */
export type GainOperand =
  { type: 'constant'; value: number } | { type: 'variable'; variableId: number };

/**
 * The engine's `operateValue(operation, operandType, operand)` triple:
 * `[operation(0 increase/1 decrease), operandType(0 constant/1 variable), operand]`.
 */
function operateValueParams(operation: GainOperation, operand: GainOperand): unknown[] {
  const opCode = operation === 'decrease' ? 1 : 0;
  return operand.type === 'variable' ? [opCode, 1, operand.variableId] : [opCode, 0, operand.value];
}

/** Change Gold (command 125) — gain or lose gold by a constant or variable amount. */
export function changeGold(
  operation: GainOperation,
  operand: GainOperand,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_GOLD, indent, operateValueParams(operation, operand));
}

/**
 * Change Items (command 126) — gain or lose `itemId` from the party inventory by
 * a constant or variable amount. On disk: `[itemId, operation, operandType, operand]`.
 */
export function changeItems(
  itemId: number,
  operation: GainOperation,
  operand: GainOperand,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_ITEMS, indent, [itemId, ...operateValueParams(operation, operand)]);
}

/**
 * Change Weapons (command 127) — gain or lose `weaponId`. `includeEquip` (default
 * false) also counts weapons currently equipped by party members when removing.
 * On disk: `[weaponId, operation, operandType, operand, includeEquip]`.
 */
export function changeWeapons(
  weaponId: number,
  operation: GainOperation,
  operand: GainOperand,
  includeEquip = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_WEAPONS, indent, [
    weaponId,
    ...operateValueParams(operation, operand),
    includeEquip,
  ]);
}

/**
 * Change Armors (command 128) — gain or lose `armorId`. `includeEquip` (default
 * false) also counts armors currently equipped when removing.
 * On disk: `[armorId, operation, operandType, operand, includeEquip]`.
 */
export function changeArmors(
  armorId: number,
  operation: GainOperation,
  operand: GainOperand,
  includeEquip = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_ARMORS, indent, [
    armorId,
    ...operateValueParams(operation, operand),
    includeEquip,
  ]);
}

/** Add an actor to, or remove one from, the party (Change Party Member). */
export type PartyMemberOperation = 'add' | 'remove';

/**
 * Change Party Member (command 129) — add or remove `actorId`. `initialize`
 * (default false, add only) resets the actor to their initial state on add.
 * On disk: `[actorId, operation(0 add/1 remove), initialize]`.
 */
export function changePartyMember(
  actorId: number,
  operation: PartyMemberOperation,
  initialize = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_PARTY_MEMBER, indent, [
    actorId,
    operation === 'remove' ? 1 : 0,
    initialize,
  ]);
}

// --- 5e-3 presentation & transitions ---

/** The direction the player faces after a Transfer Player (retain = keep current). */
export type TransferDirection = 'retain' | 'down' | 'left' | 'right' | 'up';
const TRANSFER_DIRECTION_CODE: Record<TransferDirection, number> = {
  retain: 0,
  down: 2,
  left: 4,
  right: 6,
  up: 8,
};
/** The screen fade used by Transfer Player. */
export type TransferFade = 'black' | 'white' | 'none';
const TRANSFER_FADE_CODE: Record<TransferFade, number> = { black: 0, white: 1, none: 2 };

export interface TransferPlayerOptions {
  /** Facing after transfer. Default 'retain'. */
  direction?: TransferDirection;
  /** Fade style. Default 'black'. */
  fade?: TransferFade;
  /**
   * When 'variable', `mapId`/`x`/`y` are read as *variable ids* holding the real
   * destination at runtime (Designation with variables). Default 'direct'.
   */
  designation?: 'direct' | 'variable';
  /** Indentation level. Default 0. */
  indent?: number;
}

/**
 * Transfer Player (command 201) — move the party to `(x, y)` on map `mapId`. On
 * disk: `[designation(0 direct/1 variable), mapId, x, y, direction, fade]`. With
 * `designation: 'variable'`, `mapId`/`x`/`y` are variable ids resolved at runtime.
 */
export function transferPlayer(
  mapId: number,
  x: number,
  y: number,
  options: TransferPlayerOptions = {},
): EventCommand {
  return cmd(CODE.TRANSFER_PLAYER, options.indent ?? 0, [
    options.designation === 'variable' ? 1 : 0,
    mapId,
    x,
    y,
    TRANSFER_DIRECTION_CODE[options.direction ?? 'retain'],
    TRANSFER_FADE_CODE[options.fade ?? 'black'],
  ]);
}

/** An audio track reference — the `{ name, volume, pitch, pan }` object the editor writes. */
export interface AudioTrack {
  /** Audio basename (from list_assets, extension stripped). */
  name: string;
  /** Volume 0–100. Default 90. */
  volume?: number;
  /** Pitch 50–150. Default 100. */
  pitch?: number;
  /** Pan -100–100. Default 0. */
  pan?: number;
}

/** Which audio channel to play on — maps to the play command code. */
export type AudioKind = 'bgm' | 'bgs' | 'me' | 'se';
const AUDIO_CODE: Record<AudioKind, number> = {
  bgm: CODE.PLAY_BGM,
  bgs: CODE.PLAY_BGS,
  me: CODE.PLAY_ME,
  se: CODE.PLAY_SE,
};

/** Normalize an {@link AudioTrack} into the on-disk audio object with defaults filled. */
function audioParam(track: AudioTrack): Record<string, unknown> {
  return {
    name: track.name,
    volume: track.volume ?? 90,
    pitch: track.pitch ?? 100,
    pan: track.pan ?? 0,
  };
}

/**
 * Play BGM/BGS/ME/SE (commands 241/245/249/250) — start a track on the given audio
 * channel. On disk: `[{ name, volume, pitch, pan }]` (a single audio object).
 */
export function playAudio(kind: AudioKind, track: AudioTrack, indent = 0): EventCommand {
  return cmd(AUDIO_CODE[kind], indent, [audioParam(track)]);
}

/** Fade the screen out (to a colour) or back in. */
export type ScreenFade = 'out' | 'in';

/**
 * Fadeout/Fadein Screen (commands 221/222) — no parameters; MV changes the
 * screen brightness to fade to black or restore visibility.
 */
export function fadeScreen(direction: ScreenFade, indent = 0): EventCommand {
  return cmd(direction === 'in' ? CODE.FADEIN_SCREEN : CODE.FADEOUT_SCREEN, indent, []);
}

/** An `[r, g, b, a]` tuple — RGB plus a fourth channel (gray for tint, intensity for flash). */
export type ColorTone = [number, number, number, number];

/**
 * Tint Screen (command 223) — shift the screen tone over `duration` frames. `tone`
 * is `[red, green, blue, gray]`, each −255…255 (0,0,0,0 = normal). On disk:
 * `[tone, duration, wait]`.
 */
export function tintScreen(tone: ColorTone, duration = 60, wait = true, indent = 0): EventCommand {
  return cmd(CODE.TINT_SCREEN, indent, [tone, duration, wait]);
}

/**
 * Flash Screen (command 224) — flash a colour over `duration` frames. `color` is
 * `[red, green, blue, intensity]`, each 0…255. On disk: `[color, duration, wait]`.
 */
export function flashScreen(
  color: ColorTone,
  duration = 60,
  wait = true,
  indent = 0,
): EventCommand {
  return cmd(CODE.FLASH_SCREEN, indent, [color, duration, wait]);
}

/**
 * Shake Screen (command 225) — shake for `duration` frames. On disk:
 * `[power(1–9), speed(1–9), duration, wait]`.
 */
export function shakeScreen(
  power = 5,
  speed = 5,
  duration = 60,
  wait = true,
  indent = 0,
): EventCommand {
  return cmd(CODE.SHAKE_SCREEN, indent, [power, speed, duration, wait]);
}

/** Where a picture is anchored: its upper-left corner or its center. */
export type PictureOrigin = 'upper_left' | 'center';
const PICTURE_ORIGIN_CODE: Record<PictureOrigin, number> = { upper_left: 0, center: 1 };
/** How a picture blends with what's behind it. */
export type BlendMode = 'normal' | 'additive' | 'multiply' | 'screen';
const BLEND_MODE_CODE: Record<BlendMode, number> = {
  normal: 0,
  additive: 1,
  multiply: 2,
  screen: 3,
};

export interface ShowPictureOptions {
  /** Anchor point. Default 'upper_left'. */
  origin?: PictureOrigin;
  /** Screen x (pixels). Default 0. */
  x?: number;
  /** Screen y (pixels). Default 0. */
  y?: number;
  /** Horizontal scale (%). Default 100. */
  scaleX?: number;
  /** Vertical scale (%). Default 100. */
  scaleY?: number;
  /** Opacity 0–255. Default 255. */
  opacity?: number;
  /** Blend mode. Default 'normal'. */
  blend?: BlendMode;
  /** Indentation level. Default 0. */
  indent?: number;
}

/**
 * Show Picture (command 231) — display picture `name` in slot `pictureId` (1–100).
 * On disk: `[pictureId, name, origin, 0 (direct position), x, y, scaleX, scaleY,
 * opacity, blend]` — the position is always a direct designation here (variable
 * positioning isn't exposed).
 */
export function showPicture(
  pictureId: number,
  name: string,
  options: ShowPictureOptions = {},
): EventCommand {
  return cmd(CODE.SHOW_PICTURE, options.indent ?? 0, [
    pictureId,
    name,
    PICTURE_ORIGIN_CODE[options.origin ?? 'upper_left'],
    0,
    options.x ?? 0,
    options.y ?? 0,
    options.scaleX ?? 100,
    options.scaleY ?? 100,
    options.opacity ?? 255,
    BLEND_MODE_CODE[options.blend ?? 'normal'],
  ]);
}

/** Erase Picture (command 235) — remove the picture in slot `pictureId`. */
export function erasePicture(pictureId: number, indent = 0): EventCommand {
  return cmd(CODE.ERASE_PICTURE, indent, [pictureId]);
}

/**
 * A character reference for Show Animation / Show Balloon: -1 = player, 0 = this
 * event, N = event id N on the current map (same convention as move routes).
 */
export type CharacterTarget = number;

/**
 * Show Animation (command 212) — play animation `animationId` on `characterId`.
 * `wait` holds event execution until it finishes. On disk: `[characterId,
 * animationId, wait]`.
 */
export function showAnimation(
  characterId: CharacterTarget,
  animationId: number,
  wait = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.SHOW_ANIMATION, indent, [characterId, animationId, wait]);
}

/**
 * Show Balloon Icon (command 213) — show balloon `balloonId` (1 exclamation, 2
 * question, …) over `characterId`. On disk: `[characterId, balloonId, wait]`.
 */
export function showBalloon(
  characterId: CharacterTarget,
  balloonId: number,
  wait = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.SHOW_BALLOON, indent, [characterId, balloonId, wait]);
}

// --- 5e-4 scenes ---

/**
 * Which troop a Battle Processing command fights: a `direct` troop id, a `variable`
 * holding the troop id at runtime, or `random` (same as the map's random encounters).
 */
export type BattleTroop =
  | { type: 'direct'; troopId: number }
  | { type: 'variable'; variableId: number }
  | { type: 'random' };

/**
 * Battle Processing (command 301) — start a battle against a troop. On disk:
 * `[designation(0 direct/1 variable/2 random), troopId, canEscape, canLose]`. With
 * `variable`, param[1] is a variable id; with `random` it is ignored. `canEscape`
 * / `canLose` are engine-truthy JS booleans on disk.
 */
export function battleProcessing(
  troop: BattleTroop,
  canEscape = false,
  canLose = false,
  indent = 0,
): EventCommand {
  const designation: [number, number] =
    troop.type === 'variable'
      ? [1, troop.variableId]
      : troop.type === 'random'
        ? [2, 0]
        : [0, troop.troopId];
  return cmd(CODE.BATTLE_PROCESSING, indent, [...designation, canEscape, canLose]);
}

/** A single item offered in a shop. `price` set = Specify price; omitted = the database's standard price. */
export interface ShopGood {
  /** What kind of thing is for sale. */
  kind: 'item' | 'weapon' | 'armor';
  /** The item/weapon/armor id. */
  id: number;
  /** Override price. When set, priceType = Specify; when omitted, the database price is used. */
  price?: number;
}
const SHOP_GOOD_KIND_CODE: Record<ShopGood['kind'], number> = { item: 0, weapon: 1, armor: 2 };

/** Encode one shop good as `[kind, id, priceType(0 standard/1 specify), price]`. */
function shopGoodParams(good: ShopGood): unknown[] {
  const specify = good.price !== undefined;
  return [SHOP_GOOD_KIND_CODE[good.kind], good.id, specify ? 1 : 0, specify ? good.price : 0];
}

/**
 * Shop Processing (command 302 + one 605 continuation row per extra good) — open a
 * shop selling `goods`. The 302 carries the first good plus `purchaseOnly` as a 5th
 * param `[kind, id, priceType, price, purchaseOnly]`; each additional good is a 605
 * row `[kind, id, priceType, price]` — exactly as the editor serializes them.
 */
export function shopProcessing(
  goods: ShopGood[],
  purchaseOnly = false,
  indent = 0,
): EventCommand[] {
  if (!Array.isArray(goods) || goods.length === 0) {
    throw new Error('shopProcessing requires a non-empty `goods` array');
  }
  const [first, ...rest] = goods;
  const out: EventCommand[] = [
    cmd(CODE.SHOP_PROCESSING, indent, [...shopGoodParams(first), purchaseOnly]),
  ];
  rest.forEach((good) => out.push(cmd(CODE.SHOP_GOODS, indent, shopGoodParams(good))));
  return out;
}

/**
 * Name Input Processing (command 303) — open the name-entry screen for `actorId`.
 * `maxLength` (default 8) caps the entered name. On disk: `[actorId, maxLength]`.
 */
export function nameInput(actorId: number, maxLength = 8, indent = 0): EventCommand {
  return cmd(CODE.NAME_INPUT, indent, [actorId, maxLength]);
}

/**
 * Which actor(s) a Change HP/MP/State/EXP/Level/Recover-All command targets:
 * a `fixed` actor id (0 = the entire party), or a `variable` holding the actor id.
 * On disk this is the leading `[designation(0 fixed/1 variable), actorId]` pair.
 */
export type ActorTarget =
  { type: 'fixed'; actorId: number } | { type: 'variable'; variableId: number };

/** Encode an {@link ActorTarget} as the leading `[designation, actorId]` pair. */
function actorTargetParams(target: ActorTarget): [number, number] {
  return target.type === 'variable' ? [1, target.variableId] : [0, target.actorId];
}

/**
 * Change HP (command 311) — gain or lose HP on the target actor(s) by a constant or
 * variable amount. `allowKnockout` (default false) permits the change to reduce HP to
 * 0 (death). On disk: `[designation, actorId, operation, operandType, operand, allowKnockout]`.
 */
export function changeHp(
  target: ActorTarget,
  operation: GainOperation,
  operand: GainOperand,
  allowKnockout = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_HP, indent, [
    ...actorTargetParams(target),
    ...operateValueParams(operation, operand),
    allowKnockout,
  ]);
}

/**
 * Change MP (command 312) — gain or lose MP on the target actor(s). On disk:
 * `[designation, actorId, operation, operandType, operand]`.
 */
export function changeMp(
  target: ActorTarget,
  operation: GainOperation,
  operand: GainOperand,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_MP, indent, [
    ...actorTargetParams(target),
    ...operateValueParams(operation, operand),
  ]);
}

/**
 * Change State (command 313) — add or remove a state on the target actor(s). On disk:
 * `[designation, actorId, operation(0 add/1 remove), stateId]`.
 */
export function changeState(
  target: ActorTarget,
  operation: 'add' | 'remove',
  stateId: number,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_STATE, indent, [
    ...actorTargetParams(target),
    operation === 'remove' ? 1 : 0,
    stateId,
  ]);
}

/** Recover All (command 314) — fully restore HP/MP and clear states on the target actor(s). */
export function recoverAll(target: ActorTarget, indent = 0): EventCommand {
  return cmd(CODE.RECOVER_ALL, indent, [...actorTargetParams(target)]);
}

/**
 * Change EXP (command 315) — gain or lose experience on the target actor(s).
 * `showLevelUp` (default false) shows the level-up message. On disk:
 * `[designation, actorId, operation, operandType, operand, showLevelUp]`.
 */
export function changeExp(
  target: ActorTarget,
  operation: GainOperation,
  operand: GainOperand,
  showLevelUp = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_EXP, indent, [
    ...actorTargetParams(target),
    ...operateValueParams(operation, operand),
    showLevelUp,
  ]);
}

/**
 * Change Level (command 316) — raise or lower level on the target actor(s).
 * `showLevelUp` (default false) shows the level-up message. On disk:
 * `[designation, actorId, operation, operandType, operand, showLevelUp]`.
 */
export function changeLevel(
  target: ActorTarget,
  operation: GainOperation,
  operand: GainOperand,
  showLevelUp = false,
  indent = 0,
): EventCommand {
  return cmd(CODE.CHANGE_LEVEL, indent, [
    ...actorTargetParams(target),
    ...operateValueParams(operation, operand),
    showLevelUp,
  ]);
}

// --- Battle (troop battle-event) commands ---

/**
 * Enemy Appear (command 335) — reveal a troop member that started `hidden` (a
 * mid-battle summon / reinforcement). `enemyIndex` is the 0-based troop slot
 * (`members[]` order), NOT an enemy id. On disk: `[enemyIndex]`.
 */
export function enemyAppear(enemyIndex: number, indent = 0): EventCommand {
  if (!Number.isInteger(enemyIndex) || enemyIndex < 0) {
    throw new Error(`enemyAppear needs a 0-based troop slot index, got ${enemyIndex}`);
  }
  return cmd(CODE.ENEMY_APPEAR, indent, [enemyIndex]);
}

/**
 * Change Enemy State (command 333) — add or remove a state on one troop member
 * (0-based slot) or the entire troop (`enemyIndex` -1). On disk:
 * `[enemyIndex, operation(0 add/1 remove), stateId]`.
 */
export function changeEnemyState(
  enemyIndex: number,
  operation: 'add' | 'remove',
  stateId: number,
  indent = 0,
): EventCommand {
  if (!Number.isInteger(enemyIndex) || enemyIndex < -1) {
    throw new Error(
      `changeEnemyState needs a troop slot index (or -1 = entire troop), got ${enemyIndex}`,
    );
  }
  return cmd(CODE.CHANGE_ENEMY_STATE, indent, [
    enemyIndex,
    operation === 'remove' ? 1 : 0,
    stateId,
  ]);
}

/**
 * Abort Battle (command 340) — end the battle immediately with no victory or
 * defeat (the "yield" fight); a Battle Processing with canEscape takes its
 * Escape branch. Parameterless on disk.
 */
export function abortBattle(indent = 0): EventCommand {
  return cmd(CODE.ABORT_BATTLE, indent);
}
