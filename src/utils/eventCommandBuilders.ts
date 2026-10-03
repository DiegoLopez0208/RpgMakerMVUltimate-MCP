import { z } from "zod";
import type { EventCommand } from "../types/rpgmaker.js";
import { validateEventCommands } from "./eventCommandValidation.js";
import { showText } from "../parity/events/commandBuilders.js";
import { textLineWidthWarnings } from "../parity/validation/eventCommands.js";

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
  wrap: z.union([z.boolean(), z.enum(["soft", "hard"])]).optional(),
}).strict();

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
      const built = showText(a.lines, a);
      commands = built;
      warnings.push(...textLineWidthWarnings(built, "show_text").map(w => w.message));
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
    default: throw new Error(`Unknown event builder kind: ${String(args.kind)}`);
  }

  const baseIndent = commands[0].indent ?? 0;
  const validated = validateEventCommands(commands.map(c => ({ ...c, indent: (c.indent ?? 0) - baseIndent })), { fragment: true });
  warnings.push(...validated.warnings);
  commands = validated.commands.map(c => ({ ...c, indent: (c.indent ?? 0) + baseIndent }));
  return warnings.length ? { commands, warnings: [...new Set(warnings)] } : { commands };
}
