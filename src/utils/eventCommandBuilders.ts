import { z } from "zod";
import type { EventCommand } from "../types/rpgmaker.js";
import { validateEventCommands } from "./eventCommandValidation.js";

// Numeric strings follow the server's convention without coercing null, blanks or booleans.
function numberField(integer = false, min?: number, max?: number) {
  let schema = z.number().finite();
  if (integer) schema = schema.int().safe();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess(value => {
    if (typeof value !== "string" || value.trim() === "") return value;
    const text = value.trim();
    if (integer && !/^[+-]?\d+$/.test(text)) return value;
    return Number.isFinite(Number(text)) ? Number(text) : value;
  }, schema);
}

const id = () => numberField(true, 1);
const integer = (min?: number, max?: number) => numberField(true, min, max);
const indentField = integer(0, 100).default(0);
const onOff = z.enum(["on", "off"]).default("on");
const background = z.enum(["window", "dim", "transparent"]).default("window");
const backgroundCodes = { window: 0, dim: 1, transparent: 2 };
const nameField = z.string().refine(value => value.trim().length > 0, "must not be blank");
const rawCommand = z.object({
  code: integer(0), indent: indentField, parameters: z.array(z.unknown()),
}).strict();
const body = z.array(rawCommand);

const textSchema = z.object({
  kind: z.literal("show_text"), indent: indentField,
  lines: z.array(z.string()).min(1), faceName: z.string().default(""),
  faceIndex: integer(0, 7).default(0), background,
  position: z.enum(["top", "middle", "bottom"]).default("bottom"),
  wrap: z.union([z.boolean(), z.literal("hard")]).default(false), wrapWidth: integer(10, 200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.wrapWidth !== undefined && value.wrap === false) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["wrapWidth"], message: "wrapWidth needs wrap: true or \"hard\"" });
  }
});

const choicesSchema = z.object({
  kind: z.literal("show_choices"), indent: indentField,
  choices: z.array(z.string()).min(1).max(6), branches: z.array(body).optional(),
  cancelBranch: body.optional(), cancelType: integer(-2).optional(),
  defaultType: integer(-1).default(0),
  position: z.enum(["left", "middle", "right"]).default("right"), background,
}).strict().superRefine((value, ctx) => {
  if ((value.branches?.length ?? 0) > value.choices.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "more branches than choices" });
  }
  if (value.defaultType >= value.choices.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultType"], message: "default choice is out of range" });
  }
  const cancel = value.cancelType ?? (value.cancelBranch === undefined ? -1 : -2);
  const branchCancel = cancel === -2 || cancel === value.choices.length;
  if (cancel > value.choices.length || branchCancel !== (value.cancelBranch !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cancelType"], message: "cancelType must agree with the choice count and presence of cancelBranch" });
  }
});

const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("switch"), switchId: id(), value: onOff }).strict(),
  z.object({ type: z.literal("self_switch"), name: z.enum(["A", "B", "C", "D"]), value: onOff }).strict(),
  z.object({
    type: z.literal("variable"), variableId: id(), comparison: z.enum(["==", ">=", "<=", ">", "<", "!="]),
    constant: numberField().optional(), variableOperand: id().optional(),
  }).strict(),
  z.object({ type: z.literal("actor_in_party"), actorId: id() }).strict(),
  z.object({ type: z.literal("gold"), gold: numberField(false, 0), compare: z.enum([">=", "<=", "<"]).default(">=") }).strict(),
  z.object({ type: z.literal("item"), itemId: id() }).strict(),
]).superRefine((value, ctx) => {
  if (value.type === "variable" && value.constant !== undefined && value.variableOperand !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "use constant or variableOperand, not both" });
  }
});

const conditionalSchema = z.object({
  kind: z.literal("conditional_branch"), indent: indentField,
  condition: conditionSchema, thenBranch: body.optional(), elseBranch: body.optional(),
}).strict();

const switchSchema = z.discriminatedUnion("scope", [
  z.object({
    kind: z.literal("control_switch"), indent: indentField, scope: z.literal("switch"),
    switchId: id(), endId: id().optional(), value: onOff,
  }).strict(),
  z.object({
    kind: z.literal("control_switch"), indent: indentField, scope: z.literal("self_switch"),
    name: z.enum(["A", "B", "C", "D"]), value: onOff,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.scope === "switch" && value.endId !== undefined && value.endId < value.switchId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endId"], message: "endId must be at least switchId" });
  }
});

const operandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("constant"), value: numberField() }).strict(),
  z.object({ type: z.literal("variable"), variableId: id() }).strict(),
  z.object({ type: z.literal("random"), min: integer(), max: integer() }).strict(),
  z.object({
    type: z.literal("game_data"), dataType: integer(0, 7),
    param1: integer().default(0), param2: integer(0).default(0),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.type === "random" && value.min > value.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "random max must be at least min" });
  }
  if (value.type === "game_data") {
    const minParam1 = value.dataType <= 3 ? 1 : value.dataType === 5 ? -1 : 0;
    const maxParam2 = value.dataType === 3 ? 11 : value.dataType === 4 ? 9 : value.dataType === 5 ? 4 : undefined;
    if (value.param1 < minParam1 || (value.dataType === 7 && value.param1 > 9)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["param1"], message: "invalid MV game-data item/actor ID, index or field selector" });
    }
    if (maxParam2 !== undefined && value.param2 > maxParam2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["param2"], message: "invalid MV game-data field selector" });
    }
  }
});

const variableSchema = z.object({
  kind: z.literal("control_variable"), indent: indentField,
  variableId: id(), endId: id().optional(),
  operation: z.enum(["set", "add", "sub", "mul", "div", "mod"]).default("set"),
  operand: operandSchema,
}).strict().superRefine((value, ctx) => {
  if (value.endId !== undefined && value.endId < value.variableId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endId"], message: "endId must be at least variableId" });
  }
});

const transferSchema = z.object({
  kind: z.literal("transfer_player"), indent: indentField,
  mapId: id(), x: integer(0), y: integer(0),
  designation: z.enum(["direct", "variable"]).default("direct"),
  direction: z.enum(["retain", "down", "left", "right", "up"]).default("retain"),
  fade: z.enum(["black", "white", "none"]).default("black"),
}).strict().superRefine((value, ctx) => {
  if (value.designation === "variable" && (value.x < 1 || value.y < 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "variable designation requires positive variable IDs for x and y" });
  }
});

const commonEventSchema = z.object({
  kind: z.literal("common_event"), indent: indentField, commonEventId: id(),
}).strict();

const flowSchema = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("flow"), indent: indentField, action: z.literal("wait"), frames: integer(1, 999999) }).strict(),
  z.object({ kind: z.literal("flow"), indent: indentField, action: z.literal("exit_event") }).strict(),
  z.object({ kind: z.literal("flow"), indent: indentField, action: z.literal("label"), name: nameField }).strict(),
  z.object({ kind: z.literal("flow"), indent: indentField, action: z.literal("jump_to_label"), name: nameField }).strict(),
]);

const pluginSchema = z.object({
  kind: z.literal("plugin_command"), indent: indentField,
  text: nameField.refine(value => !/[\r\n]/.test(value), "MV plugin commands must be one line"),
}).strict();

// Amount operand shared by gold, items and actor stats: MV's operateValue(operation, operandType, operand).
const amountFields = { amount: integer(0).optional(), amountVariableId: id().optional(), decrease: z.boolean().default(false) };
function requireOneAmount(value: { amount?: number; amountVariableId?: number }, ctx: z.RefinementCtx) {
  if ((value.amount === undefined) === (value.amountVariableId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "give exactly one of amount or amountVariableId" });
  }
}
function amountParameters(value: { amount?: number; amountVariableId?: number; decrease: boolean }): unknown[] {
  return [value.decrease ? 1 : 0, value.amountVariableId === undefined ? 0 : 1, value.amountVariableId ?? value.amount];
}

const goldSchema = z.object({ kind: z.literal("change_gold"), indent: indentField, ...amountFields }).strict().superRefine(requireOneAmount);

const itemsSchema = z.object({
  kind: z.literal("change_items"), indent: indentField, itemType: z.enum(["item", "weapon", "armor"]).default("item"),
  itemId: id(), ...amountFields, includeEquip: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  requireOneAmount(value, ctx);
  if (value.itemType === "item" && value.includeEquip) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["includeEquip"], message: "includeEquip applies to weapons and armors only" });
  }
});

const partySchema = z.object({
  kind: z.literal("change_party_member"), indent: indentField, actorId: id(),
  remove: z.boolean().default(false), initialize: z.boolean().default(false),
}).strict();

const audioSchema = z.object({
  kind: z.literal("play_audio"), indent: indentField, channel: z.enum(["bgm", "bgs", "me", "se"]),
  name: z.string(), volume: integer(0, 100).default(90), pitch: integer(50, 150).default(100), pan: integer(-100, 100).default(0),
}).strict();

const tone = z.tuple([integer(-255, 255), integer(-255, 255), integer(-255, 255), integer(0, 255)]);
const flashColor = z.tuple([integer(0, 255), integer(0, 255), integer(0, 255), integer(0, 255)]);
const duration = integer(1, 999).default(60);
const screenSchema = z.discriminatedUnion("effect", [
  z.object({ kind: z.literal("screen_effect"), indent: indentField, effect: z.literal("fadeout") }).strict(),
  z.object({ kind: z.literal("screen_effect"), indent: indentField, effect: z.literal("fadein") }).strict(),
  z.object({ kind: z.literal("screen_effect"), indent: indentField, effect: z.literal("tint"), color: tone, duration, wait: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("screen_effect"), indent: indentField, effect: z.literal("flash"), color: flashColor, duration, wait: z.boolean().default(true) }).strict(),
  z.object({
    kind: z.literal("screen_effect"), indent: indentField, effect: z.literal("shake"),
    power: integer(1, 9).default(5), speed: integer(1, 9).default(5), duration, wait: z.boolean().default(true),
  }).strict(),
]);

const pictureSchema = z.object({
  kind: z.literal("show_picture"), indent: indentField, pictureId: integer(1, 100), name: nameField,
  origin: z.enum(["upper_left", "center"]).default("upper_left"), designation: z.enum(["direct", "variable"]).default("direct"),
  x: integer().default(0), y: integer().default(0), scaleX: integer(0, 2000).default(100), scaleY: integer(0, 2000).default(100),
  opacity: integer(0, 255).default(255), blend: z.enum(["normal", "additive", "multiply", "screen"]).default("normal"),
}).strict().superRefine((value, ctx) => {
  if (value.designation === "variable" && (value.x < 1 || value.y < 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "variable designation requires positive variable IDs for x and y" });
  }
});
const erasePictureSchema = z.object({ kind: z.literal("erase_picture"), indent: indentField, pictureId: integer(1, 100) }).strict();

// MV character IDs: -1 is the player, 0 is the running event, n is map event n.
const characterId = integer(-1).default(0);
const animationSchema = z.object({
  kind: z.literal("show_animation"), indent: indentField, characterId, animationId: id(), wait: z.boolean().default(false),
}).strict();
const balloonSchema = z.object({
  kind: z.literal("show_balloon"), indent: indentField, characterId, balloonId: integer(1, 15), wait: z.boolean().default(false),
}).strict();

const battleSchema = z.object({
  kind: z.literal("battle_processing"), indent: indentField,
  troopId: id().optional(), troopVariableId: id().optional(), randomEncounter: z.boolean().default(false),
  canEscape: z.boolean().default(false), canLose: z.boolean().default(false),
  winBranch: body.optional(), escapeBranch: body.optional(), loseBranch: body.optional(),
}).strict().superRefine((value, ctx) => {
  const sources = [value.troopId !== undefined, value.troopVariableId !== undefined, value.randomEncounter].filter(Boolean).length;
  if (sources !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["troopId"], message: "give exactly one of troopId, troopVariableId or randomEncounter: true" });
  if (value.escapeBranch && !value.canEscape) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["escapeBranch"], message: "escapeBranch needs canEscape: true" });
  if (value.loseBranch && !value.canLose) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["loseBranch"], message: "loseBranch needs canLose: true" });
  if (value.winBranch && !value.canEscape && !value.canLose) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["winBranch"], message: "the editor only has result branches when canEscape or canLose is true" });
  }
});

const shopSchema = z.object({
  kind: z.literal("shop_processing"), indent: indentField, purchaseOnly: z.boolean().default(false),
  goods: z.array(z.object({ type: z.enum(["item", "weapon", "armor"]).default("item"), id: id(), price: integer(0).optional() }).strict()).min(1),
}).strict();

const nameInputSchema = z.object({
  kind: z.literal("name_input"), indent: indentField, actorId: id(), maxLength: integer(1, 16).default(8),
}).strict();

// actorId 0 is the whole party, as in the editor's "Entire Party".
const actorBase = { kind: z.literal("change_actor"), indent: indentField, actorId: integer(0).optional(), actorVariableId: id().optional() };
const actorSchema = z.discriminatedUnion("stat", [
  z.object({ ...actorBase, stat: z.literal("hp"), ...amountFields, allowDeath: z.boolean().default(false) }).strict(),
  z.object({ ...actorBase, stat: z.literal("mp"), ...amountFields }).strict(),
  z.object({ ...actorBase, stat: z.literal("exp"), ...amountFields, showLevelUp: z.boolean().default(false) }).strict(),
  z.object({ ...actorBase, stat: z.literal("level"), ...amountFields, showLevelUp: z.boolean().default(false) }).strict(),
  z.object({ ...actorBase, stat: z.literal("state"), stateId: id(), remove: z.boolean().default(false) }).strict(),
  z.object({ ...actorBase, stat: z.literal("recover_all") }).strict(),
]).superRefine((value, ctx) => {
  if ((value.actorId === undefined) === (value.actorVariableId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actorId"], message: "give exactly one of actorId (0 = entire party) or actorVariableId" });
  }
  if ("decrease" in value) requireOneAmount(value, ctx);
});

// Troop battle events. Enemy indexes are troop slots from 0; -1 is the entire troop.
const enemyAppearSchema = z.object({ kind: z.literal("enemy_appear"), indent: indentField, enemyIndex: integer(0, 7) }).strict();
const enemyStateSchema = z.object({
  kind: z.literal("change_enemy_state"), indent: indentField, enemyIndex: integer(-1, 7), stateId: id(), remove: z.boolean().default(false),
}).strict();
const abortBattleSchema = z.object({ kind: z.literal("abort_battle"), indent: indentField }).strict();

// Set Movement Route. Step names are Game_Character's ROUTE_* constants in lower case
// (ROUTE_MOVE_DOWN is "move_down"), so each can be checked against the engine.
const ROUTE_STEP_CODES = {
  move_down: 1, move_left: 2, move_right: 3, move_up: 4, move_lower_l: 5, move_lower_r: 6, move_upper_l: 7, move_upper_r: 8,
  move_random: 9, move_toward: 10, move_away: 11, move_forward: 12, move_backward: 13, jump: 14, wait: 15,
  turn_down: 16, turn_left: 17, turn_right: 18, turn_up: 19, turn_90d_r: 20, turn_90d_l: 21, turn_180d: 22, turn_90d_r_l: 23,
  turn_random: 24, turn_toward: 25, turn_away: 26, switch_on: 27, switch_off: 28, change_speed: 29, change_freq: 30,
  walk_anime_on: 31, walk_anime_off: 32, step_anime_on: 33, step_anime_off: 34, dir_fix_on: 35, dir_fix_off: 36,
  through_on: 37, through_off: 38, transparent_on: 39, transparent_off: 40, change_image: 41, change_opacity: 42,
  change_blend_mode: 43, play_se: 44, script: 45,
} as const;
type RouteStepName = keyof typeof ROUTE_STEP_CODES;
/** Fields each step with parameters accepts; a step not listed takes none. */
const ROUTE_STEP_FIELDS: Partial<Record<RouteStepName, string[]>> = {
  jump: ["x", "y"], wait: ["frames"], switch_on: ["switchId"], switch_off: ["switchId"], change_speed: ["value"],
  change_freq: ["value"], change_image: ["name", "index"], change_opacity: ["value"], change_blend_mode: ["value"],
  play_se: ["name", "volume", "pitch", "pan"], script: ["text"],
};
const VALUE_RANGE: Partial<Record<RouteStepName, [number, number]>> = {
  change_speed: [1, 6], change_freq: [1, 5], change_opacity: [0, 255], change_blend_mode: [0, 3],
};
const routeStepSchema = z.object({
  step: z.enum(Object.keys(ROUTE_STEP_CODES) as [RouteStepName, ...RouteStepName[]]),
  times: integer(1, 99).default(1),
  x: integer().optional(), y: integer().optional(), frames: integer(1, 999).optional(), switchId: id().optional(),
  value: integer().optional(), name: z.string().optional(), index: integer(0, 7).optional(),
  volume: integer(0, 100).optional(), pitch: integer(50, 150).optional(), pan: integer(-100, 100).optional(),
  text: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  const allowed = ROUTE_STEP_FIELDS[value.step] ?? [];
  for (const key of Object.keys(value)) {
    if (key !== "step" && key !== "times" && !allowed.includes(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${value.step} does not take ${key}` });
    }
  }
  const required = { wait: "frames", switch_on: "switchId", switch_off: "switchId", change_speed: "value", change_freq: "value",
    change_image: "name", change_opacity: "value", change_blend_mode: "value", play_se: "name", script: "text" } as Record<string, keyof typeof value>;
  const need = required[value.step];
  if (need && value[need] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [need], message: `${value.step} requires ${need}` });
  const range = VALUE_RANGE[value.step];
  if (range && value.value !== undefined && (value.value < range[0] || value.value > range[1])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${value.step} value must be ${range[0]}-${range[1]}` });
  }
});
const moveRouteSchema = z.object({
  kind: z.literal("move_route"), indent: indentField, characterId,
  steps: z.array(routeStepSchema).min(1),
  repeat: z.boolean().default(false), skippable: z.boolean().default(false), wait: z.boolean().default(true),
}).strict();

/** One route step as the editor stores it: parameters only when the step has them, indent null. */
function routeStep(step: z.infer<typeof routeStepSchema>): Record<string, unknown> {
  const code = ROUTE_STEP_CODES[step.step];
  const parameters: unknown[] | undefined =
    step.step === "jump" ? [step.x ?? 0, step.y ?? 0]
    : step.step === "wait" ? [step.frames]
    : step.step === "switch_on" || step.step === "switch_off" ? [step.switchId]
    : step.step === "change_image" ? [step.name, step.index ?? 0]
    : step.step === "play_se" ? [{ name: step.name, pan: step.pan ?? 0, pitch: step.pitch ?? 100, volume: step.volume ?? 90 }]
    : step.step === "script" ? [step.text]
    : ROUTE_STEP_FIELDS[step.step]?.includes("value") ? [step.value]
    : undefined;
  return parameters ? { code, parameters, indent: null } : { code, indent: null };
}

// Show Text wrapping. MV never wraps; these are character budgets for the stock 816px window and font.
const LINE_BUDGET = 55;
const LINE_BUDGET_WITH_FACE = 38;
const MESSAGE_BOX_LINES = 4;
/** Length as drawn: escape codes (\C[2], \I[5], \., \!) draw nothing. */
function visibleLength(line: string): number {
  return line.replace(/\\[A-Za-z]+\[[^\]]*\]/g, "").replace(/\\./g, "").length;
}
/** soft reflows every line as one paragraph; hard keeps each line (and each \n) as a forced break. */
function wrapMessage(lines: string[], width: number, mode: "soft" | "hard"): string[] {
  const paragraphs = mode === "soft" ? [lines.join(" ")] : lines.flatMap(line => line.split("\n"));
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && visibleLength(candidate) > width) { out.push(current); current = word; } else current = candidate;
    }
    if (current || mode === "hard") out.push(current);
  }
  return out;
}

function command(code: number, indent: number, parameters: unknown[] = []): EventCommand {
  return { code, indent, parameters };
}

function conditionParameters(condition: z.infer<typeof conditionSchema>): unknown[] {
  switch (condition.type) {
    case "switch": return [0, condition.switchId, condition.value === "on" ? 0 : 1];
    case "self_switch": return [2, condition.name, condition.value === "on" ? 0 : 1];
    case "variable": return [
      1, condition.variableId, condition.variableOperand === undefined ? 0 : 1,
      condition.variableOperand ?? condition.constant ?? 0,
      { "==": 0, ">=": 1, "<=": 2, ">": 3, "<": 4, "!=": 5 }[condition.comparison],
    ];
    case "actor_in_party": return [4, condition.actorId, 0];
    case "gold": return [7, condition.gold, { ">=": 0, "<=": 1, "<": 2 }[condition.compare]];
    case "item": return [8, condition.itemId];
  }
}

function operandParameters(operand: z.infer<typeof operandSchema>): unknown[] {
  switch (operand.type) {
    case "constant": return [0, operand.value];
    case "variable": return [1, operand.variableId];
    case "random": return [2, operand.min, operand.max];
    case "game_data": return [3, operand.dataType, operand.param1, operand.param2];
  }
}

function branchBody(input: EventCommand[] | undefined, childIndent: number, warnings: string[]): EventCommand[] {
  const source = input ?? [];
  const baseIndent = source.length ? Math.min(...source.map(c => c.indent ?? 0)) : 0;
  const validated = validateEventCommands(source.map(c => ({
    ...c, indent: (c.indent ?? 0) - baseIndent, parameters: structuredClone(c.parameters),
  })), { fragment: true });
  warnings.push(...validated.warnings);
  return [
    ...validated.commands.map(c => ({ ...c, indent: (c.indent ?? 0) + childIndent })),
    command(0, childIndent),
  ];
}

/** Build a validated, read-only MV fragment. Root end markers belong to the destination list. */
export function buildEventCommands(args: Record<string, unknown>): { commands: EventCommand[]; warnings?: string[] } {
  let commands: EventCommand[];
  const warnings: string[] = [];
  switch (args.kind) {
    case "show_text": {
      const a = textSchema.parse(args);
      const header = () => command(101, a.indent, [
        a.faceName, a.faceIndex, backgroundCodes[a.background], { top: 0, middle: 1, bottom: 2 }[a.position],
      ]);
      const width = a.wrapWidth ?? (a.faceName ? LINE_BUDGET_WITH_FACE : LINE_BUDGET);
      if (a.wrap === false) {
        commands = [header(), ...a.lines.map(line => command(401, a.indent, [line]))];
        const long = a.lines.filter(line => visibleLength(line) > width).length;
        if (long) warnings.push(`${long} show_text line(s) exceed ~${width} characters and may be cut off; MV does not wrap (pass wrap: true)`);
      } else {
        // One identical 101 header per four-line box, like a long message split by hand in the editor.
        const wrapped = wrapMessage(a.lines, width, a.wrap === "hard" ? "hard" : "soft");
        commands = [];
        for (let i = 0; i < Math.max(wrapped.length, 1); i += MESSAGE_BOX_LINES) {
          commands.push(header(), ...wrapped.slice(i, i + MESSAGE_BOX_LINES).map(line => command(401, a.indent, [line])));
        }
        if (wrapped.some(line => visibleLength(line) > width)) warnings.push(`a single word is longer than ${width} characters and could not be wrapped`);
      }
      break;
    }
    case "show_choices": {
      const a = choicesSchema.parse(args);
      commands = [command(102, a.indent, [
        [...a.choices], a.cancelType ?? (a.cancelBranch === undefined ? -1 : -2), a.defaultType,
        { left: 0, middle: 1, right: 2 }[a.position], backgroundCodes[a.background],
      ])];
      a.choices.forEach((choice, index) => {
        commands.push(command(402, a.indent, [index, choice]), ...branchBody(a.branches?.[index] as EventCommand[] | undefined, a.indent + 1, warnings));
      });
      if (a.cancelBranch !== undefined) {
        commands.push(command(403, a.indent), ...branchBody(a.cancelBranch as EventCommand[], a.indent + 1, warnings));
      }
      commands.push(command(404, a.indent));
      break;
    }
    case "conditional_branch": {
      const a = conditionalSchema.parse(args);
      commands = [command(111, a.indent, conditionParameters(a.condition)),
        ...branchBody(a.thenBranch as EventCommand[] | undefined, a.indent + 1, warnings)];
      if (a.elseBranch !== undefined) {
        commands.push(command(411, a.indent), ...branchBody(a.elseBranch as EventCommand[], a.indent + 1, warnings));
      }
      commands.push(command(412, a.indent));
      break;
    }
    case "control_switch": {
      const a = switchSchema.parse(args);
      commands = [a.scope === "self_switch"
        ? command(123, a.indent, [a.name, a.value === "on" ? 0 : 1])
        : command(121, a.indent, [a.switchId, a.endId ?? a.switchId, a.value === "on" ? 0 : 1])];
      break;
    }
    case "control_variable": {
      const a = variableSchema.parse(args);
      commands = [command(122, a.indent, [a.variableId, a.endId ?? a.variableId,
        { set: 0, add: 1, sub: 2, mul: 3, div: 4, mod: 5 }[a.operation], ...operandParameters(a.operand)])];
      break;
    }
    case "transfer_player": {
      const a = transferSchema.parse(args);
      commands = [command(201, a.indent, [a.designation === "direct" ? 0 : 1, a.mapId, a.x, a.y,
        { retain: 0, down: 2, left: 4, right: 6, up: 8 }[a.direction], { black: 0, white: 1, none: 2 }[a.fade]])];
      break;
    }
    case "common_event": {
      const a = commonEventSchema.parse(args);
      commands = [command(117, a.indent, [a.commonEventId])];
      break;
    }
    case "flow": {
      const a = flowSchema.parse(args);
      commands = [a.action === "wait" ? command(230, a.indent, [a.frames])
        : a.action === "exit_event" ? command(115, a.indent)
        : command(a.action === "label" ? 118 : 119, a.indent, [a.name])];
      break;
    }
    case "plugin_command": {
      const a = pluginSchema.parse(args);
      commands = [command(356, a.indent, [a.text])];
      break;
    }
    case "change_gold": {
      const a = goldSchema.parse(args);
      commands = [command(125, a.indent, amountParameters(a))];
      break;
    }
    case "change_items": {
      const a = itemsSchema.parse(args);
      const code = { item: 126, weapon: 127, armor: 128 }[a.itemType];
      commands = [command(code, a.indent, [a.itemId, ...amountParameters(a), ...(code === 126 ? [] : [a.includeEquip])])];
      break;
    }
    case "change_party_member": {
      const a = partySchema.parse(args);
      commands = [command(129, a.indent, [a.actorId, a.remove ? 1 : 0, a.initialize])];
      break;
    }
    case "play_audio": {
      const a = audioSchema.parse(args);
      commands = [command({ bgm: 241, bgs: 245, me: 249, se: 250 }[a.channel], a.indent,
        [{ name: a.name, pan: a.pan, pitch: a.pitch, volume: a.volume }])];
      break;
    }
    case "screen_effect": {
      const a = screenSchema.parse(args);
      commands = [a.effect === "fadeout" ? command(221, a.indent)
        : a.effect === "fadein" ? command(222, a.indent)
        : a.effect === "shake" ? command(225, a.indent, [a.power, a.speed, a.duration, a.wait])
        : command(a.effect === "tint" ? 223 : 224, a.indent, [[...a.color], a.duration, a.wait])];
      break;
    }
    case "show_picture": {
      const a = pictureSchema.parse(args);
      commands = [command(231, a.indent, [a.pictureId, a.name, a.origin === "center" ? 1 : 0, a.designation === "variable" ? 1 : 0,
        a.x, a.y, a.scaleX, a.scaleY, a.opacity, { normal: 0, additive: 1, multiply: 2, screen: 3 }[a.blend]])];
      break;
    }
    case "erase_picture": {
      const a = erasePictureSchema.parse(args);
      commands = [command(235, a.indent, [a.pictureId])];
      break;
    }
    case "show_animation": {
      const a = animationSchema.parse(args);
      commands = [command(212, a.indent, [a.characterId, a.animationId, a.wait])];
      break;
    }
    case "show_balloon": {
      const a = balloonSchema.parse(args);
      commands = [command(213, a.indent, [a.characterId, a.balloonId, a.wait])];
      break;
    }
    case "battle_processing": {
      const a = battleSchema.parse(args);
      const source = a.troopId !== undefined ? [0, a.troopId] : a.troopVariableId !== undefined ? [1, a.troopVariableId] : [2, 0];
      commands = [command(301, a.indent, [...source, a.canEscape, a.canLose])];
      // The editor writes result branches only when escaping or losing is allowed.
      if (a.canEscape || a.canLose) {
        commands.push(command(601, a.indent), ...branchBody(a.winBranch as EventCommand[] | undefined, a.indent + 1, warnings));
        if (a.canEscape) commands.push(command(602, a.indent), ...branchBody(a.escapeBranch as EventCommand[] | undefined, a.indent + 1, warnings));
        if (a.canLose) commands.push(command(603, a.indent), ...branchBody(a.loseBranch as EventCommand[] | undefined, a.indent + 1, warnings));
        commands.push(command(604, a.indent));
      }
      break;
    }
    case "shop_processing": {
      const a = shopSchema.parse(args);
      // The engine reads the 302 row itself as the first good and purchaseOnly from its fifth slot.
      const good = (g: (typeof a.goods)[number]) => [{ item: 0, weapon: 1, armor: 2 }[g.type], g.id, g.price === undefined ? 0 : 1, g.price ?? 0];
      commands = [command(302, a.indent, [...good(a.goods[0]), a.purchaseOnly]),
        ...a.goods.slice(1).map(g => command(605, a.indent, good(g)))];
      break;
    }
    case "name_input": {
      const a = nameInputSchema.parse(args);
      commands = [command(303, a.indent, [a.actorId, a.maxLength])];
      break;
    }
    case "change_actor": {
      const a = actorSchema.parse(args);
      const target = a.actorVariableId === undefined ? [0, a.actorId] : [1, a.actorVariableId];
      switch (a.stat) {
        case "hp": commands = [command(311, a.indent, [...target, ...amountParameters(a), a.allowDeath])]; break;
        case "mp": commands = [command(312, a.indent, [...target, ...amountParameters(a)])]; break;
        case "exp": commands = [command(315, a.indent, [...target, ...amountParameters(a), a.showLevelUp])]; break;
        case "level": commands = [command(316, a.indent, [...target, ...amountParameters(a), a.showLevelUp])]; break;
        case "state": commands = [command(313, a.indent, [...target, a.remove ? 1 : 0, a.stateId])]; break;
        case "recover_all": commands = [command(314, a.indent, target)]; break;
      }
      break;
    }
    case "enemy_appear": {
      const a = enemyAppearSchema.parse(args);
      commands = [command(335, a.indent, [a.enemyIndex])];
      break;
    }
    case "change_enemy_state": {
      const a = enemyStateSchema.parse(args);
      commands = [command(333, a.indent, [a.enemyIndex, a.remove ? 1 : 0, a.stateId])];
      break;
    }
    case "abort_battle": {
      const a = abortBattleSchema.parse(args);
      commands = [command(340, a.indent)];
      break;
    }
    case "move_route": {
      const a = moveRouteSchema.parse(args);
      const list = [...a.steps.flatMap(step => Array.from({ length: step.times }, () => routeStep(step))), { code: 0, parameters: [] }];
      // The engine runs parameters[1]; the editor lists the route from the 505 rows, one per step and
      // without the end marker (all 42 routes in the official DLC samples follow this, see #12).
      commands = [command(205, a.indent, [a.characterId, { list, repeat: a.repeat, skippable: a.skippable, wait: a.wait }]),
        ...list.slice(0, -1).map(step => command(505, a.indent, [step]))];
      break;
    }
    default: throw new Error(`Unknown event builder kind: ${String(args.kind)}`);
  }

  const baseIndent = commands[0].indent ?? 0;
  const validated = validateEventCommands(commands.map(c => ({ ...c, indent: (c.indent ?? 0) - baseIndent })), { fragment: true });
  warnings.push(...validated.warnings);
  commands = validated.commands.map(c => ({ ...c, indent: (c.indent ?? 0) + baseIndent }));
  return warnings.length ? { commands, warnings: [...new Set(warnings)] } : { commands };
}
