import { z } from 'zod';
import { getMapPath, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { summarizeCommandListResult } from '../utils/responseSummary.js';
import {
  validateCommandList,
  textLineWidthWarnings,
  ValidationWarning,
} from '../validation/eventCommands.js';
import { writeGate } from '../validation/gate.js';
import { eventWriteGate, getMap } from './mapTools.js';
import { getCommonEvents } from './commonEventTools.js';
import { getTroops } from './battleTools.js';
import {
  spliceIntoList,
  showText,
  showChoices,
  conditionalBranch,
  wait,
  exitEvent,
  label,
  jumpToLabel,
  controlSwitches,
  controlSelfSwitch,
  controlVariables,
  changeGold,
  changeItems,
  changeWeapons,
  changeArmors,
  changePartyMember,
  transferPlayer,
  playAudio,
  fadeScreen,
  tintScreen,
  flashScreen,
  shakeScreen,
  showPicture,
  erasePicture,
  showAnimation,
  showBalloon,
  battleProcessing,
  shopProcessing,
  nameInput,
  changeHp,
  changeMp,
  changeState,
  recoverAll,
  changeExp,
  changeLevel,
  enemyAppear,
  changeEnemyState,
  abortBattle,
  BattleTroop,
  ShopGood,
  ActorTarget,
  BranchCondition,
  ShowTextOptions,
  ShowChoicesOptions,
  ConditionalBranchOptions,
  VariableOperation,
  VariableOperand,
  GainOperation,
  GainOperand,
  TransferPlayerOptions,
  TransferDirection,
  TransferFade,
  AudioKind,
  AudioTrack,
  ColorTone,
  ShowPictureOptions,
  PictureOrigin,
  BlendMode,
} from '../events/commandBuilders.js';
import { AssetType, assetNameWarning } from './assetTools.js';
import { validateEventCommands, assertMvCompatibility } from '../../utils/eventCommandValidation.js';

/** Zod shape for a raw event command (used where callers pass builder output back). */
const eventCommandShape = z.object({
  code: z.number().int().describe('Event command code'),
  indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
  parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
});

/** Coerce a loosely-typed command array into well-formed EventCommands. */
function asCommands(raw: unknown): EventCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const cmd = c as Partial<EventCommand>;
    return {
      code: cmd.code as number,
      indent: cmd.indent ?? 0,
      parameters: Array.isArray(cmd.parameters) ? cmd.parameters : [],
    };
  });
}

/** Coerce a nested array-of-command-arrays (per-choice branches). */
function asCommandGroups(raw: unknown): EventCommand[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((group) => asCommands(group));
}

/** The three homes an EventCommand list can have in an MV project. */
export type CommandListTarget = 'map_event' | 'common_event' | 'troop_page';

export interface InsertEventCommandsOptions {
  mapId?: number;
  eventId?: number;
  commonEventId?: number;
  troopId?: number;
  pageIndex?: number;
  commands: EventCommand[];
  position?: number;
  force?: boolean;
}

export interface InsertEventCommandsResult {
  target: CommandListTarget;
  id: number;
  list: EventCommand[];
  warnings?: ValidationWarning[];
}

/**
 * One command list resolved from a target + its ids: the list to splice into,
 * the file and in-memory root to commit, and the write gate that guards it.
 *
 * `precommit` is a thunk rather than a value-taking hook because the three
 * targets gate over different values — a map event validates as a whole event
 * (its page graphics and reachability matter), while a common event or troop
 * page has nothing to validate but the list itself.
 */
interface CommandListSite {
  id: number;
  list: EventCommand[];
  file: string;
  root: unknown;
  precommit: () => Promise<void>;
  respond: <R extends object>(result: R) => R & { warnings?: ValidationWarning[] };
}

function requiredArg<T>(value: T | undefined, name: string, target: CommandListTarget): T {
  if (value === undefined) {
    throw new Error(`${name} is required for target "${target}"`);
  }
  return value;
}

/** Locate the command list a target names, without touching it yet. */
async function resolveCommandList(
  projectPath: string,
  target: CommandListTarget,
  opts: InsertEventCommandsOptions,
): Promise<CommandListSite> {
  if (target === 'map_event') {
    const mapId = requiredArg(opts.mapId, 'mapId', target);
    const eventId = requiredArg(opts.eventId, 'eventId', target);
    const pageIndex = requiredArg(opts.pageIndex, 'pageIndex', target);
    const map = await getMap(projectPath, mapId);
    const event = map.events[eventId];
    if (!event) {
      throw new Error(`Event ${eventId} not found on map ${mapId}`);
    }
    const page = event.pages[pageIndex];
    if (!page) {
      throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
    }
    const gate = eventWriteGate(projectPath, mapId, opts.force);
    return {
      id: eventId,
      list: page.list,
      file: getMapPath(projectPath, mapId),
      root: map,
      precommit: () => gate.precommit(event) as Promise<void>,
      respond: gate.respond,
    };
  }

  if (target === 'common_event') {
    const commonEventId = requiredArg(opts.commonEventId, 'commonEventId', target);
    const commonEvents = await getCommonEvents(projectPath);
    const ce = commonEvents.find((c) => c && c.id === commonEventId);
    if (!ce) {
      throw new Error(`Common event ${commonEventId} does not exist`);
    }
    const subject = `common event ${ce.id}`;
    const gate = writeGate<EventCommand[]>(opts.force, subject, (list) =>
      validateCommandList(list, subject),
    );
    return {
      id: ce.id,
      list: ce.list,
      file: getDataPath(projectPath, 'CommonEvents.json'),
      root: commonEvents,
      precommit: () => gate.precommit(ce.list) as Promise<void>,
      respond: gate.respond,
    };
  }

  const troopId = requiredArg(opts.troopId, 'troopId', target);
  const pageIndex = requiredArg(opts.pageIndex, 'pageIndex', target);
  const troops = await getTroops(projectPath);
  const troop = troops.find((t) => t && t.id === troopId);
  if (!troop) {
    throw new Error(`Troop ${troopId} does not exist`);
  }
  const page = troop.pages[pageIndex];
  if (!page) {
    throw new Error(`Page ${pageIndex} not found on troop ${troopId}`);
  }
  const subject = `troop ${troop.id} / page ${pageIndex}`;
  const gate = writeGate<EventCommand[]>(opts.force, subject, (list) =>
    validateCommandList(list, subject),
  );
  return {
    id: troop.id,
    list: page.list,
    file: getDataPath(projectPath, 'Troops.json'),
    root: troops,
    precommit: () => gate.precommit(page.list) as Promise<void>,
    respond: gate.respond,
  };
}

/**
 * Insert a pre-built command sequence into any of the three command lists an MV
 * project has — a map event page, a common event body, or a troop battle-event
 * page — the mutating companion to the read-only builders below. This is how a
 * Show Text / Show Choices / Conditional Branch block built by the builders
 * actually lands in the game.
 *
 * All three lists share the EventCommand format, so there is one splice path:
 * resolve the list, splice before its code-0 end marker (or at `position`),
 * gate, commit. The resulting list is validated **before** the commit — a
 * structurally invalid result is refused and nothing is written (unless
 * `opts.force`).
 */
export async function insertEventCommands(
  projectPath: string,
  target: CommandListTarget,
  opts: InsertEventCommandsOptions,
): Promise<InsertEventCommandsResult> {
  const site = await resolveCommandList(projectPath, target, opts);
  spliceIntoList(site.list, opts.commands, opts.position);
  assertMvCompatibility(site.list);
  await site.precommit();
  await commitChange(site.file, site.root);
  return site.respond({ target, id: site.id, list: site.list });
}

/** Zod shape for a Conditional Branch condition (validated further in the builder). */
const conditionShape = z
  .object({
    type: z
      .enum(['switch', 'self_switch', 'variable', 'actor_in_party', 'gold', 'item'])
      .describe('Condition type'),
    switchId: z.number().int().optional().describe('switch: the switch id to test'),
    name: z.enum(['A', 'B', 'C', 'D']).optional().describe('self_switch: which self switch'),
    value: z
      .enum(['on', 'off'])
      .optional()
      .describe('switch/self_switch: test for on (default) or off'),
    variableId: z.number().int().optional().describe('variable: the variable id (left side)'),
    comparison: z
      .enum(['==', '>=', '<=', '>', '<', '!='])
      .optional()
      .describe('variable: comparison operator'),
    constant: z.number().optional().describe('variable: compare against this constant (default 0)'),
    variableOperand: z
      .number()
      .int()
      .optional()
      .describe('variable: compare against this variable id (overrides constant)'),
    actorId: z.number().int().optional().describe('actor_in_party: the actor id'),
    itemId: z.number().int().optional().describe('item: the item id (tests "party has item")'),
    gold: z.number().optional().describe('gold: the amount to compare against'),
    compare: z.enum(['>=', '<=', '<']).optional().describe('gold: comparison operator'),
  })
  .describe('Conditional branch condition');

/** Map the flat condition input object to the discriminated {@link BranchCondition}. */
function toBranchCondition(c: Record<string, unknown>): BranchCondition {
  switch (c.type) {
    case 'switch':
      return { type: 'switch', switchId: c.switchId as number, value: c.value as 'on' | 'off' };
    case 'self_switch':
      return {
        type: 'self_switch',
        name: c.name as 'A' | 'B' | 'C' | 'D',
        value: c.value as 'on' | 'off',
      };
    case 'variable':
      return {
        type: 'variable',
        variableId: c.variableId as number,
        comparison: c.comparison as '==' | '>=' | '<=' | '>' | '<' | '!=',
        constant: c.constant as number | undefined,
        variableOperand: c.variableOperand as number | undefined,
      };
    case 'actor_in_party':
      return { type: 'actor_in_party', actorId: c.actorId as number };
    case 'gold':
      return { type: 'gold', value: c.gold as number, compare: c.compare as '>=' | '<=' | '<' };
    case 'item':
      return { type: 'item', itemId: c.itemId as number };
    default:
      throw new Error(`Unknown condition type: ${String(c.type)}`);
  }
}

/** Zod shape for a Change Gold/Items/Weapons/Armors operand (constant or variable amount). */
const gainOperandShape = z
  .object({
    type: z.enum(['constant', 'variable']).describe('constant amount or a variable value'),
    value: z.number().optional().describe('constant: the amount'),
    variableId: z.number().int().optional().describe('variable: the variable id to read'),
  })
  .describe('The amount to gain/lose (constant or variable)');

/** Map the flat gain-operand input to the discriminated {@link GainOperand}. */
function toGainOperand(o: Record<string, unknown>): GainOperand {
  return o.type === 'variable'
    ? { type: 'variable', variableId: o.variableId as number }
    : { type: 'constant', value: (o.value as number) ?? 0 };
}

/** Zod shape for a Control Variables operand (constant / variable / random / game_data). */
const variableOperandShape = z
  .object({
    type: z
      .enum(['constant', 'variable', 'random', 'game_data'])
      .describe('Operand source for the variable value'),
    value: z.number().optional().describe('constant: the value'),
    variableId: z.number().int().optional().describe('variable: the source variable id'),
    min: z.number().optional().describe('random: inclusive minimum'),
    max: z.number().optional().describe('random: inclusive maximum'),
    dataType: z
      .number()
      .int()
      .min(0)
      .max(7)
      .optional()
      .describe(
        'game_data: 0 item/1 weapon/2 armor count, 3 actor, 4 enemy, 5 char, 6 party, 7 other (MV only; type 8 is unsupported)',
      ),
    param1: z.number().int().optional().describe('game_data: first sub-parameter (see corescript)'),
    param2: z
      .number()
      .int()
      .optional()
      .describe('game_data: second sub-parameter (see corescript)'),
  })
  .describe('The right-hand operand of the Control Variables command');

/** Map the flat variable-operand input to the discriminated {@link VariableOperand}. */
function toVariableOperand(o: Record<string, unknown>): VariableOperand {
  switch (o.type) {
    case 'variable':
      return { type: 'variable', variableId: o.variableId as number };
    case 'random':
      return { type: 'random', min: (o.min as number) ?? 0, max: (o.max as number) ?? 0 };
    case 'game_data':
      return {
        type: 'game_data',
        dataType: (o.dataType as number) ?? 0,
        param1: o.param1 as number | undefined,
        param2: o.param2 as number | undefined,
      };
    default:
      return { type: 'constant', value: (o.value as number) ?? 0 };
  }
}

/** Coerce a loosely-typed color/tone input into the 4-number tuple (defaults to 0s). */
function toColorTone(raw: unknown): ColorTone {
  const a = Array.isArray(raw) ? raw : [];
  return [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0, Number(a[3]) || 0];
}

/**
 * Warn (never throw) when an audio `name` isn't among the project's assets for that
 * channel. Thin wrapper over the shared {@link assetNameWarning}.
 */
async function audioNameWarnings(
  projectPath: string,
  kind: AudioKind,
  name: string,
): Promise<ValidationWarning[]> {
  return assetNameWarning(projectPath, kind as AssetType, name, {
    path: `play_audio ${kind}`,
    label: 'audio',
    consequence: 'a wrong filename fails silently at runtime',
  });
}

/** Zod shape for Show Text's `wrap` option — shared by build_show_text and create_npc. */
export const showTextWrapShape = z
  .union([z.boolean(), z.enum(['soft', 'hard'])])
  .optional()
  .describe(
    'Auto word-wrap to the message-window width (the same width the line-length warning uses) and split into 4-line boxes. true/"soft" reflows all lines as one paragraph; "hard" keeps each entry (and \\n) as a forced line break. Default off (one line per entry, verbatim).',
  );

/** Zod shape for an actor target (fixed actor id / 0 = whole party, or a variable). */
const actorTargetShape = z
  .object({
    type: z.enum(['fixed', 'variable']).describe('fixed actor id (0 = whole party) or a variable'),
    actorId: z.number().int().optional().describe('fixed: the actor id (0 = entire party)'),
    variableId: z
      .number()
      .int()
      .optional()
      .describe('variable: the variable id holding the actor id'),
  })
  .describe('Which actor(s) the change applies to');

/** Map the flat actor-target input to the discriminated {@link ActorTarget}. */
function toActorTarget(t: Record<string, unknown>): ActorTarget {
  return t.type === 'variable'
    ? { type: 'variable', variableId: (t.variableId as number) ?? 0 }
    : { type: 'fixed', actorId: (t.actorId as number) ?? 0 };
}

export const eventCommandToolDefinitions: ToolDefinition[] = [
  {
    name: 'build_show_text',
    description:
      'Build a Show Text event-command sequence (101 setup + one 401 line per text line) for insertion via insert_event_commands. Supports face image (from list_assets("faces")), window background/position. MV does NOT word-wrap: keep each line under ~55 chars (~38 with a face) or it is cut off at the window edge (warned, never blocked) — or pass `wrap: true` to word-wrap automatically to that same width (escape codes like \\C[n] do not count) and split into as many 4-line message boxes as needed. Read-only: returns { commands, warnings? }, writes nothing.',
    inputSchema: {
      lines: z.array(z.string()).describe('Message lines (one entry per visual line)'),
      faceName: z.string().optional().describe('Face image basename ("" = none, default)'),
      faceIndex: z.number().int().min(0).max(7).optional().describe('Face index 0–7 in the sheet (default 0)'),
      background: z
        .enum(['window', 'dim', 'transparent'])
        .optional()
        .describe('Window background (default window)'),
      position: z
        .enum(['top', 'middle', 'bottom'])
        .optional()
        .describe('Window position (default bottom)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
      wrap: showTextWrapShape,
    },
    handler: async (_ctx, args) => {
      const options: ShowTextOptions = {
        faceName: args.faceName,
        faceIndex: args.faceIndex,
        background: args.background,
        position: args.position,
        indent: args.indent,
        wrap: args.wrap,
      };
      const commands = showText(args.lines as string[], options);
      const warnings = textLineWidthWarnings(commands, 'show_text');
      return warnings.length > 0 ? { commands, warnings } : { commands };
    },
  },
  {
    name: 'build_show_choices',
    description:
      'Build a Show Choices block (102 opener + a 402 branch per choice + optional 403 When-Cancel branch + 404 closer, each branch terminated like the editor) for insertion via insert_event_commands. Pass per-choice `branches` (each an EventCommand[] — e.g. from build_show_text) to fill the branch bodies. Read-only: returns { commands }.',
    inputSchema: {
      choices: z.array(z.string()).describe('The choice labels shown to the player'),
      branches: z
        .array(z.array(eventCommandShape))
        .optional()
        .describe('Commands per choice (same order as choices); omitted/short = empty branches'),
      cancelBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands for a "When Cancel" branch (adds a 403 block; cancel routes here)'),
      cancelType: z
        .number()
        .int()
        .optional()
        .describe(
          'Without a cancelBranch: 0-based choice index the Cancel button maps to, or -1 Disallow (default -1)',
        ),
      defaultType: z
        .number()
        .int()
        .optional()
        .describe('0-based default (highlighted) choice, or -1 none (default 0)'),
      position: z
        .enum(['left', 'middle', 'right'])
        .optional()
        .describe('Choice window position (default right)'),
      background: z
        .enum(['window', 'dim', 'transparent'])
        .optional()
        .describe('Choice window background (default window)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level of the block (default 0)'),
    },
    handler: async (_ctx, args) => {
      const options: ShowChoicesOptions = {
        branches: asCommandGroups(args.branches),
        cancelBranch: args.cancelBranch !== undefined ? asCommands(args.cancelBranch) : undefined,
        cancelType: args.cancelType,
        defaultType: args.defaultType,
        position: args.position,
        background: args.background,
        indent: args.indent,
      };
      return { commands: showChoices(args.choices as string[], options) };
    },
  },
  {
    name: 'build_conditional_branch',
    description:
      'Build a Conditional Branch block (111 condition + then-branch + optional 411 Else + 412 closer, each branch terminated like the editor) for insertion via insert_event_commands. Condition types: switch, self_switch, variable, actor_in_party, gold, item. Provide thenBranch/elseBranch as EventCommand[] (e.g. from other builders). Read-only: returns { commands }.',
    inputSchema: {
      condition: conditionShape,
      thenBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands to run when the condition is true (default empty)'),
      elseBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands for the Else branch; presence (even empty) adds the 411 Else block'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level of the block (default 0)'),
    },
    handler: async (_ctx, args) => {
      const condition = toBranchCondition(args.condition as Record<string, unknown>);
      const options: ConditionalBranchOptions = {
        thenBranch: args.thenBranch !== undefined ? asCommands(args.thenBranch) : undefined,
        elseBranch: args.elseBranch !== undefined ? asCommands(args.elseBranch) : undefined,
        indent: args.indent,
      };
      return { commands: conditionalBranch(condition, options) };
    },
  },
  {
    name: 'build_flow_command',
    description:
      'Build a single flow-control event command for insertion via insert_event_commands: wait (230, N frames), exit_event (115), label (118, a named jump target), or jump_to_label (119). Read-only: returns { command }.',
    inputSchema: {
      kind: z
        .enum(['wait', 'exit_event', 'label', 'jump_to_label'])
        .describe('Which flow command to build'),
      frames: z.number().int().optional().describe('wait: number of frames (60 = 1 second)'),
      name: z.string().optional().describe('label/jump_to_label: the label name'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      switch (args.kind) {
        case 'wait':
          if (typeof args.frames !== 'number') throw new Error('wait requires `frames`');
          return { command: wait(args.frames, indent) };
        case 'exit_event':
          return { command: exitEvent(indent) };
        case 'label':
          if (typeof args.name !== 'string') throw new Error('label requires `name`');
          return { command: label(args.name, indent) };
        case 'jump_to_label':
          if (typeof args.name !== 'string') throw new Error('jump_to_label requires `name`');
          return { command: jumpToLabel(args.name, indent) };
        default:
          throw new Error(`Unknown flow command kind: ${args.kind}`);
      }
    },
  },
  {
    name: 'build_control_switch',
    description:
      'Build a Control Switches (121) or Control Self Switch (123) event command for insertion via insert_event_commands. scope "switch": set a switch (or the inclusive switchId..endId range) on/off. scope "self_switch": set the current event\'s self switch A–D. Read-only: returns { command }.',
    inputSchema: {
      scope: z
        .enum(['switch', 'self_switch'])
        .describe('"switch" (global, by id/range) or "self_switch" (this event, A–D)'),
      switchId: z.number().int().optional().describe('switch: the switch id (range start)'),
      endId: z
        .number()
        .int()
        .optional()
        .describe('switch: inclusive range end (default = switchId, a single switch)'),
      name: z.enum(['A', 'B', 'C', 'D']).optional().describe('self_switch: which self switch'),
      value: z.enum(['on', 'off']).optional().describe('Set on (default) or off'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      const value = args.value as 'on' | 'off' | undefined;
      if (args.scope === 'self_switch') {
        if (typeof args.name !== 'string') throw new Error('self_switch requires `name` (A–D)');
        return { command: controlSelfSwitch(args.name as 'A' | 'B' | 'C' | 'D', value, indent) };
      }
      if (typeof args.switchId !== 'number') throw new Error('switch scope requires `switchId`');
      return {
        command: controlSwitches(args.switchId, args.endId ?? args.switchId, value, indent),
      };
    },
  },
  {
    name: 'build_control_variable',
    description:
      'Build a Control Variables (122) event command for insertion via insert_event_commands. Applies operation (set/add/sub/mul/div/mod) to a variable (or the inclusive variableId..endId range) using an operand: constant, another variable, a random range, or game_data (item/actor/party/… readouts). Read-only: returns { command }.',
    inputSchema: {
      variableId: z.number().int().describe('The target variable id (range start)'),
      endId: z
        .number()
        .int()
        .optional()
        .describe('Inclusive range end (default = variableId, a single variable)'),
      operation: z
        .enum(['set', 'add', 'sub', 'mul', 'div', 'mod'])
        .optional()
        .describe('Arithmetic applied to the target (default set)'),
      operand: variableOperandShape,
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const operand = toVariableOperand(args.operand as Record<string, unknown>);
      return {
        command: controlVariables(
          args.variableId as number,
          (args.operation ?? 'set') as VariableOperation,
          operand,
          { endId: args.endId, indent: args.indent },
        ),
      };
    },
  },
  {
    name: 'build_change_gold',
    description:
      'Build a Change Gold (125) event command for insertion via insert_event_commands — increase or decrease party gold by a constant or variable amount. Read-only: returns { command }.',
    inputSchema: {
      operation: z.enum(['increase', 'decrease']).describe('Gain or lose gold'),
      operand: gainOperandShape,
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const operand = toGainOperand(args.operand as Record<string, unknown>);
      return { command: changeGold(args.operation as GainOperation, operand, args.indent ?? 0) };
    },
  },
  {
    name: 'build_change_items',
    description:
      'Build a Change Items (126), Change Weapons (127), or Change Armors (128) event command for insertion via insert_event_commands — gain/lose an item/weapon/armor by a constant or variable amount. includeEquip (weapon/armor only) also counts equipped copies when removing. Read-only: returns { command }.',
    inputSchema: {
      kind: z.enum(['item', 'weapon', 'armor']).describe('Which inventory to change'),
      id: z.number().int().describe('The item/weapon/armor id'),
      operation: z.enum(['increase', 'decrease']).describe('Gain or lose'),
      operand: gainOperandShape,
      includeEquip: z
        .boolean()
        .optional()
        .describe('weapon/armor: also count equipped copies (default false)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const operand = toGainOperand(args.operand as Record<string, unknown>);
      const operation = args.operation as GainOperation;
      const id = args.id as number;
      const indent = args.indent ?? 0;
      const includeEquip = args.includeEquip ?? false;
      switch (args.kind) {
        case 'weapon':
          return { command: changeWeapons(id, operation, operand, includeEquip, indent) };
        case 'armor':
          return { command: changeArmors(id, operation, operand, includeEquip, indent) };
        default:
          return { command: changeItems(id, operation, operand, indent) };
      }
    },
  },
  {
    name: 'build_change_party_member',
    description:
      'Build a Change Party Member (129) event command for insertion via insert_event_commands — add or remove an actor from the party. initialize (add only) resets the actor to their initial state. Read-only: returns { command }.',
    inputSchema: {
      actorId: z.number().int().describe('The actor id'),
      operation: z.enum(['add', 'remove']).describe('Add to or remove from the party'),
      initialize: z
        .boolean()
        .optional()
        .describe('add only: reset the actor to their initial state (default false)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      return {
        command: changePartyMember(
          args.actorId as number,
          args.operation as 'add' | 'remove',
          args.initialize ?? false,
          args.indent ?? 0,
        ),
      };
    },
  },
  {
    name: 'build_transfer_player',
    description:
      'Build a Transfer Player (201) event command for insertion via insert_event_commands — move the party to (x, y) on a map. With designation "variable", mapId/x/y are variable ids resolved at runtime. Read-only: returns { command }.',
    inputSchema: {
      mapId: z
        .number()
        .int()
        .describe('Destination map id (or a variable id if designation=variable)'),
      x: z.number().int().describe('Destination tile x (or a variable id)'),
      y: z.number().int().describe('Destination tile y (or a variable id)'),
      direction: z
        .enum(['retain', 'down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing after transfer (default retain)'),
      fade: z.enum(['black', 'white', 'none']).optional().describe('Fade style (default black)'),
      designation: z
        .enum(['direct', 'variable'])
        .optional()
        .describe(
          'direct: mapId/x/y are literal; variable: they are variable ids (default direct)',
        ),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const options: TransferPlayerOptions = {
        direction: args.direction as TransferDirection | undefined,
        fade: args.fade as TransferFade | undefined,
        designation: args.designation as 'direct' | 'variable' | undefined,
        indent: args.indent,
      };
      return {
        command: transferPlayer(args.mapId as number, args.x as number, args.y as number, options),
      };
    },
  },
  {
    name: 'build_play_audio',
    description:
      'Build a Play BGM/BGS/ME/SE (241/245/249/250) event command for insertion via insert_event_commands. Warns (never blocks) when `name` is not a known audio asset for that channel (checked against list_assets). Returns { command, warnings? }.',
    inputSchema: {
      kind: z.enum(['bgm', 'bgs', 'me', 'se']).describe('Which audio channel to play on'),
      name: z.string().describe('Audio basename (from list_assets, extension stripped)'),
      volume: z.number().min(0).max(100).optional().describe('Volume 0–100 (default 90)'),
      pitch: z.number().min(50).max(150).optional().describe('Pitch 50–150 (default 100)'),
      pan: z.number().min(-100).max(100).optional().describe('Pan -100–100 (default 0)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (ctx, args) => {
      const kind = args.kind as AudioKind;
      const track: AudioTrack = {
        name: args.name as string,
        volume: args.volume,
        pitch: args.pitch,
        pan: args.pan,
      };
      const command = playAudio(kind, track, args.indent ?? 0);
      const warnings = await audioNameWarnings(ctx.projectPath, kind, track.name);
      return warnings.length > 0 ? { command, warnings } : { command };
    },
  },
  {
    name: 'build_screen_effect',
    description:
      'Build a screen transition/effect event command for insertion via insert_event_commands: fadeout (221) / fadein (222) — no params; tint (223) & flash (224) — an [r,g,b,a] color over `duration` frames; shake (225) — power/speed over `duration`. `wait` holds the event until it finishes. Read-only: returns { command }.',
    inputSchema: {
      kind: z
        .enum(['fadeout', 'fadein', 'tint', 'flash', 'shake'])
        .describe('Which screen effect to build'),
      color: z
        .array(z.number())
        .length(4)
        .optional()
        .describe(
          'tint: [red,green,blue,gray] (−255…255); flash: [red,green,blue,intensity] (0…255)',
        ),
      power: z.number().min(1).max(9).optional().describe('shake: strength 1–9 (default 5)'),
      speed: z.number().min(1).max(9).optional().describe('shake: speed 1–9 (default 5)'),
      duration: z.number().int().nonnegative().optional().describe('tint/flash/shake: frames (default 60)'),
      wait: z
        .boolean()
        .optional()
        .describe('tint/flash/shake: hold the event until it finishes (default true)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      const duration = (args.duration as number | undefined) ?? 60;
      const wait = (args.wait as boolean | undefined) ?? true;
      switch (args.kind) {
        case 'fadeout':
          return { command: fadeScreen('out', indent) };
        case 'fadein':
          return { command: fadeScreen('in', indent) };
        case 'tint':
          return { command: tintScreen(toColorTone(args.color), duration, wait, indent) };
        case 'flash':
          return { command: flashScreen(toColorTone(args.color), duration, wait, indent) };
        case 'shake':
          return {
            command: shakeScreen(
              (args.power as number | undefined) ?? 5,
              (args.speed as number | undefined) ?? 5,
              duration,
              wait,
              indent,
            ),
          };
        default:
          throw new Error(`Unknown screen effect kind: ${args.kind}`);
      }
    },
  },
  {
    name: 'build_picture',
    description:
      'Build a Show Picture (231) or Erase Picture (235) event command for insertion via insert_event_commands. show: display `name` in slot `pictureId` with origin/position/scale/opacity/blend; erase: clear the slot. Read-only: returns { command }.',
    inputSchema: {
      kind: z.enum(['show', 'erase']).describe('Show a picture or erase a slot'),
      pictureId: z.number().int().describe('Picture slot 1–100'),
      name: z.string().optional().describe('show: picture basename (from list_assets("pictures"))'),
      origin: z
        .enum(['upper_left', 'center'])
        .optional()
        .describe('show: anchor point (default upper_left)'),
      x: z.number().optional().describe('show: screen x in pixels (default 0)'),
      y: z.number().optional().describe('show: screen y in pixels (default 0)'),
      scaleX: z.number().optional().describe('show: horizontal scale % (default 100)'),
      scaleY: z.number().optional().describe('show: vertical scale % (default 100)'),
      opacity: z.number().min(0).max(255).optional().describe('show: opacity 0–255 (default 255)'),
      blend: z
        .enum(['normal', 'additive', 'multiply', 'screen'])
        .optional()
        .describe('show: blend mode (default normal)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      const pictureId = args.pictureId as number;
      if (args.kind === 'erase') {
        return { command: erasePicture(pictureId, indent) };
      }
      if (typeof args.name !== 'string') throw new Error('show requires `name`');
      const options: ShowPictureOptions = {
        origin: args.origin as PictureOrigin | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        scaleX: args.scaleX as number | undefined,
        scaleY: args.scaleY as number | undefined,
        opacity: args.opacity as number | undefined,
        blend: args.blend as BlendMode | undefined,
        indent,
      };
      return { command: showPicture(pictureId, args.name, options) };
    },
  },
  {
    name: 'build_character_effect',
    description:
      'Build a Show Animation (212) or Show Balloon Icon (213) event command for insertion via insert_event_commands, played over a character (characterId: -1 player, 0 this event, N event id). Read-only: returns { command }.',
    inputSchema: {
      kind: z.enum(['animation', 'balloon']).describe('Play an animation or a balloon icon'),
      characterId: z
        .number()
        .int()
        .describe('Target character: -1 player, 0 this event, N event id on the current map'),
      id: z
        .number()
        .int()
        .describe(
          'animation: the animation id; balloon: the balloon id (1 exclamation, 2 question, …)',
        ),
      wait: z.boolean().optional().describe('Hold the event until it finishes (default false)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const characterId = args.characterId as number;
      const id = args.id as number;
      const wait = (args.wait as boolean | undefined) ?? false;
      const indent = args.indent ?? 0;
      return {
        command:
          args.kind === 'balloon'
            ? showBalloon(characterId, id, wait, indent)
            : showAnimation(characterId, id, wait, indent),
      };
    },
  },
  {
    name: 'build_battle_processing',
    description:
      'Build a Battle Processing (301) event command for insertion via insert_event_commands — start a battle against a troop (direct id, a variable holding the id, or "random" like the map encounters). canEscape/canLose gate the battle result branches. Read-only: returns { command }.',
    inputSchema: {
      troop: z
        .enum(['direct', 'variable', 'random'])
        .describe('How the troop is chosen (default direct)')
        .optional(),
      troopId: z
        .number()
        .int()
        .optional()
        .describe('direct: the troop id; variable: the variable id holding it'),
      canEscape: z.boolean().optional().describe('Allow the party to escape (default false)'),
      canLose: z
        .boolean()
        .optional()
        .describe('Continue the event if the party loses (default false)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const mode = (args.troop as 'direct' | 'variable' | 'random' | undefined) ?? 'direct';
      let troop: BattleTroop;
      if (mode === 'random') {
        troop = { type: 'random' };
      } else if (mode === 'variable') {
        if (typeof args.troopId !== 'number')
          throw new Error('variable troop requires `troopId` (a variable id)');
        troop = { type: 'variable', variableId: args.troopId };
      } else {
        if (typeof args.troopId !== 'number') throw new Error('direct troop requires `troopId`');
        troop = { type: 'direct', troopId: args.troopId };
      }
      return {
        command: battleProcessing(
          troop,
          args.canEscape ?? false,
          args.canLose ?? false,
          args.indent ?? 0,
        ),
      };
    },
  },
  {
    name: 'build_shop_processing',
    description:
      'Build a Shop Processing (302 + one 605 row per extra good) event-command sequence for insertion via insert_event_commands. Each good sells an item/weapon/armor at its database price, or a specified `price`. purchaseOnly hides the sell tab. Read-only: returns { commands }.',
    inputSchema: {
      goods: z
        .array(
          z.object({
            kind: z.enum(['item', 'weapon', 'armor']).describe('What is for sale'),
            id: z.number().int().describe('The item/weapon/armor id'),
            price: z
              .number()
              .int()
              .optional()
              .describe('Override price (omitted = the database standard price)'),
          }),
        )
        .describe('The goods offered (at least one)'),
      purchaseOnly: z.boolean().optional().describe('Hide the sell tab (default false)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const goods = (args.goods as Record<string, unknown>[]).map((g) => ({
        kind: g.kind as ShopGood['kind'],
        id: g.id as number,
        price: g.price as number | undefined,
      }));
      return {
        commands: shopProcessing(goods, args.purchaseOnly ?? false, args.indent ?? 0),
      };
    },
  },
  {
    name: 'build_name_input',
    description:
      'Build a Name Input Processing (303) event command for insertion via insert_event_commands — open the name-entry screen for an actor. Read-only: returns { command }.',
    inputSchema: {
      actorId: z.number().int().describe('The actor whose name is entered'),
      maxLength: z.number().int().min(1).max(16).optional().describe('Max name length (default 8)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      return {
        command: nameInput(args.actorId as number, args.maxLength ?? 8, args.indent ?? 0),
      };
    },
  },
  {
    name: 'build_change_actor',
    description:
      'Build an actor stat-change scene command for insertion via insert_event_commands: hp (311), mp (312), state (313), recover_all (314), exp (315), or level (316). Targets a fixed actor (0 = whole party) or a variable. hp/mp/exp/level take an increase/decrease `operand` (constant or variable); state takes add/remove + `stateId`; recover_all takes nothing extra. Read-only: returns { command }.',
    inputSchema: {
      kind: z
        .enum(['hp', 'mp', 'state', 'recover_all', 'exp', 'level'])
        .describe('Which actor change to build'),
      target: actorTargetShape,
      operation: z
        .enum(['increase', 'decrease'])
        .optional()
        .describe('hp/mp/exp/level: gain or lose (default increase)'),
      operand: gainOperandShape
        .optional()
        .describe('hp/mp/exp/level: the amount (constant/variable)'),
      allowKnockout: z
        .boolean()
        .optional()
        .describe('hp: allow the change to reduce HP to 0/death (default false)'),
      showLevelUp: z
        .boolean()
        .optional()
        .describe('exp/level: show the level-up message (default false)'),
      stateOperation: z
        .enum(['add', 'remove'])
        .optional()
        .describe('state: add or remove the state'),
      stateId: z.number().int().optional().describe('state: the state id'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const target = toActorTarget(args.target as Record<string, unknown>);
      const indent = args.indent ?? 0;
      if (args.kind === 'recover_all') {
        return { command: recoverAll(target, indent) };
      }
      if (args.kind === 'state') {
        if (typeof args.stateId !== 'number') throw new Error('state change requires `stateId`');
        return {
          command: changeState(
            target,
            (args.stateOperation as 'add' | 'remove' | undefined) ?? 'add',
            args.stateId,
            indent,
          ),
        };
      }
      const operation = (args.operation as GainOperation | undefined) ?? 'increase';
      const operand = toGainOperand((args.operand as Record<string, unknown>) ?? {});
      switch (args.kind) {
        case 'mp':
          return { command: changeMp(target, operation, operand, indent) };
        case 'exp':
          return {
            command: changeExp(target, operation, operand, args.showLevelUp ?? false, indent),
          };
        case 'level':
          return {
            command: changeLevel(target, operation, operand, args.showLevelUp ?? false, indent),
          };
        default:
          return {
            command: changeHp(target, operation, operand, args.allowKnockout ?? false, indent),
          };
      }
    },
  },
  {
    name: 'build_battle_command',
    description:
      'Build an in-battle event command for a troop battle-event page (see build_troop_page / add_troop_page / insert_event_commands target "troop_page"): enemy_appear (335 — reveal a troop member added with hidden: true, i.e. a summon/reinforcement), enemy_state (333 — add/remove a state on one troop member or the whole troop, e.g. a telegraph "Gathering power" state), or abort_battle (340 — end the battle with no victory/defeat; the calling Battle Processing takes its Escape branch). `enemyIndex` is the 0-based troop slot (members[] order), NOT an enemy id; enemy_state also accepts -1 = entire troop. Read-only: returns { command }.',
    inputSchema: {
      kind: z
        .enum(['enemy_appear', 'enemy_state', 'abort_battle'])
        .describe('Which battle command to build'),
      enemyIndex: z
        .number()
        .int()
        .min(-1)
        .optional()
        .describe(
          'enemy_appear/enemy_state: 0-based troop slot (members[] order); enemy_state also allows -1 = entire troop',
        ),
      stateOperation: z
        .enum(['add', 'remove'])
        .optional()
        .describe('enemy_state: add or remove the state (default add)'),
      stateId: z.number().int().positive().optional().describe('enemy_state: the state id'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      switch (args.kind) {
        case 'enemy_appear':
          if (typeof args.enemyIndex !== 'number')
            throw new Error('enemy_appear requires `enemyIndex`');
          return { command: enemyAppear(args.enemyIndex, indent) };
        case 'enemy_state':
          if (typeof args.enemyIndex !== 'number')
            throw new Error('enemy_state requires `enemyIndex` (-1 = entire troop)');
          if (typeof args.stateId !== 'number') throw new Error('enemy_state requires `stateId`');
          return {
            command: changeEnemyState(
              args.enemyIndex,
              (args.stateOperation as 'add' | 'remove' | undefined) ?? 'add',
              args.stateId,
              indent,
            ),
          };
        case 'abort_battle':
          return { command: abortBattle(indent) };
        default:
          throw new Error(`Unknown battle command kind: ${args.kind}`);
      }
    },
  },
  {
    name: 'insert_event_commands',
    mutates: true,
    forceable: true,
    summarize: summarizeCommandListResult,
    description:
      'Insert a pre-built sequence of event commands (from the build_* builders) into any of the three command lists an MV project has — the mutating companion to the read-only builders. Splices before the list’s end marker (or at `position`). target "map_event" (the default) needs mapId + eventId + pageIndex; "common_event" needs commonEventId; "troop_page" needs troopId + pageIndex. The resulting list is validated before writing: a structural problem (wrong parameter count for a command code, a list left unterminated) refuses the write and saves nothing — pass force: true to override. Advisory findings (unrecognized code, over-long text line) are returned as `warnings` and never block. Returns { target, id, listLength, listCodes, warnings? } — the resulting list as its length and its command CODES, which is what you verify a splice against; pass verbose: true for the full list with parameters, or read it back with get_map_event.',
    inputSchema: {
      target: z
        .enum(['map_event', 'common_event', 'troop_page'])
        .optional()
        .describe('Which command list to insert into (default map_event)'),
      mapId: z.number().int().positive().optional().describe('target "map_event": the map id'),
      eventId: z.number().int().positive().optional().describe('target "map_event": the event id'),
      commonEventId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('target "common_event": the common event id'),
      troopId: z.number().int().positive().optional().describe('target "troop_page": the troop id'),
      pageIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('target "map_event"/"troop_page": zero-based page index'),
      commands: z
        .array(eventCommandShape)
        .describe('The event commands to insert (e.g. the `commands` from a build_* tool)'),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Insertion index; defaults to the end of the list'),
    },
    handler: (ctx, args) =>
      insertEventCommands(ctx.projectPath, (args.target ?? 'map_event') as CommandListTarget, {
        mapId: args.mapId,
        eventId: args.eventId,
        commonEventId: args.commonEventId,
        troopId: args.troopId,
        pageIndex: args.pageIndex,
        commands: asCommands(args.commands),
        position: args.position,
        force: args.force,
      }),
  },
];

// Builders are available before selecting a project. Asset checks remain advisory.
// Validate the complete emitted fragment as well as each command's parameters.
for (const definition of eventCommandToolDefinitions) {
  if (!definition.name.startsWith('build_')) continue;
  definition.requiresProject = false;
  definition.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const build = definition.handler;
  definition.handler = async (ctx, args) => {
    const parsed = z.object(definition.inputSchema).strict().parse(args);
    const result = await build(ctx, parsed) as { command?: EventCommand; commands?: EventCommand[]; warnings?: ValidationWarning[] };
    const commands = result.commands ?? (result.command ? [result.command] : []);
    const base = commands[0]?.indent ?? 0;
    validateEventCommands(commands.map(command => ({ ...command, indent: command.indent - base })), { fragment: true });
    return result;
  };
}
