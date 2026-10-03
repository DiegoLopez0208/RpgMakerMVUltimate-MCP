import { describe, expect, it } from "vitest";
import { buildEventCommands } from "../src/utils/eventCommandBuilders.js";

const build = (kind: string, args: Record<string, unknown> = {}) =>
  buildEventCommands({ kind, ...args }).commands;

describe("MV event command builders", () => {
  it("builds four-parameter MV text, preserves escape sequences and coerces numeric strings", () => {
    expect(build("show_text", {
      lines: ["Hello \\N[1]", "Second line"], faceName: "Actor1", faceIndex: "3",
      background: "dim", position: "top", indent: "2",
    })).toEqual([
      { code: 101, indent: 2, parameters: ["Actor1", 3, 1, 0] },
      { code: 401, indent: 2, parameters: ["Hello \\N[1]"] },
      { code: 401, indent: 2, parameters: ["Second line"] },
    ]);
  });

  it("builds choices with nested branches, explicit -2 cancellation and child terminators", () => {
    const nested = build("conditional_branch", {
      condition: { type: "switch", switchId: 1 },
      thenBranch: build("control_switch", { scope: "self_switch", name: "A", indent: 4 }),
      elseBranch: [], indent: 3,
    });
    const before = structuredClone(nested);
    const result = build("show_choices", {
      choices: ["Yes", "No"], branches: [nested, []], cancelBranch: [], cancelType: -2,
    });
    expect(result[0].parameters).toEqual([["Yes", "No"], -2, 0, 2, 0]);
    expect(result.map(c => [c.code, c.indent])).toEqual([
      [102, 0], [402, 0], [111, 1], [123, 2], [0, 2], [411, 1], [0, 2],
      [412, 1], [0, 1], [402, 0], [0, 1], [403, 0], [0, 1], [404, 0],
    ]);
    expect(nested).toEqual(before);
  });

  it("accepts count-based cancel routing and strips a supplied branch root terminator", () => {
    const body = [...build("show_text", { lines: ["Hi"] }), { code: 0, indent: 0, parameters: [] }];
    const result = build("show_choices", {
      choices: ["A"], branches: [body], cancelBranch: [], cancelType: 1,
    });
    expect(result.map(c => c.code)).toEqual([102, 402, 101, 401, 0, 403, 0, 404]);
    expect(result[0].parameters[1]).toBe(1);
    (result[3].parameters as string[])[0] = "changed";
    expect(body[1].parameters).toEqual(["Hi"]);
  });

  it.each([
    [{ type: "switch", switchId: "2", value: "off" }, [0, 2, 1]],
    [{ type: "self_switch", name: "B" }, [2, "B", 0]],
    [{ type: "variable", variableId: 3, comparison: ">=", constant: "10" }, [1, 3, 0, 10, 1]],
    [{ type: "variable", variableId: 3, comparison: "!=", variableOperand: "8" }, [1, 3, 1, 8, 5]],
    [{ type: "actor_in_party", actorId: 2 }, [4, 2, 0]],
    [{ type: "gold", gold: 50, compare: "<" }, [7, 50, 2]],
    [{ type: "item", itemId: 4 }, [8, 4]],
  ])("encodes the condition %j", (condition, parameters) => {
    expect(build("conditional_branch", { condition })).toEqual([
      { code: 111, indent: 0, parameters },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
    ]);
  });

  it("encodes every variable comparison operator", () => {
    ["==", ">=", "<=", ">", "<", "!="].forEach((comparison, code) => {
      expect(build("conditional_branch", {
        condition: { type: "variable", variableId: 1, comparison },
      })[0].parameters).toEqual([1, 1, 0, 0, code]);
    });
  });

  it.each([
    ["control_switch", { scope: "switch", switchId: "2", endId: "4", value: "off" }, 121, [2, 4, 1]],
    ["control_switch", { scope: "self_switch", name: "D" }, 123, ["D", 0]],
    ["control_variable", { variableId: "1", operand: { type: "constant", value: "2.5" } }, 122, [1, 1, 0, 0, 2.5]],
    ["control_variable", { variableId: 2, operation: "add", operand: { type: "variable", variableId: 3 } }, 122, [2, 2, 1, 1, 3]],
    ["control_variable", { variableId: 2, endId: 4, operand: { type: "random", min: "-2", max: "8" } }, 122, [2, 4, 0, 2, -2, 8]],
    ["control_variable", { variableId: 3, operand: { type: "game_data", dataType: 7, param1: 2 } }, 122, [3, 3, 0, 3, 7, 2, 0]],
    ["transfer_player", { mapId: "2", x: "0", y: "4", direction: "up", fade: "none" }, 201, [0, 2, 0, 4, 8, 2]],
    ["transfer_player", { mapId: 1, x: 2, y: 3, designation: "variable" }, 201, [1, 1, 2, 3, 0, 0]],
    ["common_event", { commonEventId: "5" }, 117, [5]],
    ["flow", { action: "wait", frames: "60" }, 230, [60]],
    ["flow", { action: "exit_event" }, 115, []],
    ["flow", { action: "label", name: "restart" }, 118, ["restart"]],
    ["flow", { action: "jump_to_label", name: "restart" }, 119, ["restart"]],
    ["plugin_command", { text: "Example run 1" }, 356, ["Example run 1"]],
  ])("encodes %s arguments %j", (kind, args, code, parameters) => {
    expect(build(kind as string, args as Record<string, unknown>)).toEqual([{ code, indent: 0, parameters }]);
  });

  it("encodes all variable operations", () => {
    ["set", "add", "sub", "mul", "div", "mod"].forEach((operation, code) => {
      expect(build("control_variable", {
        variableId: 1, operation, operand: { type: "constant", value: 2 },
      })[0].parameters[2]).toBe(code);
    });
  });

  it.each([
    { kind: "show_text", lines: ["Hi"], speakerName: "MZ only" },
    { kind: "show_text", lines: [] },
    { kind: "show_text", lines: ["Hi"], faceIndex: 8 },
    { kind: "show_text", lines: ["Hi"], indent: -1 },
    { kind: "show_text", lines: ["Hi"], indent: "1.5" },
    { kind: "show_choices", choices: [] },
    { kind: "show_choices", choices: ["A"], branches: [[], []] },
    { kind: "show_choices", choices: ["A"], defaultType: 1 },
    { kind: "show_choices", choices: ["A"], cancelType: -2 },
    { kind: "show_choices", choices: ["A"], cancelBranch: [], cancelType: 0 },
    { kind: "conditional_branch", condition: { type: "switch" } },
    { kind: "conditional_branch", condition: { type: "variable", variableId: 1, comparison: "==", constant: 2, variableOperand: 3 } },
    { kind: "conditional_branch", condition: { type: "switch", switchId: 1 }, thenBranch: [{ code: 357, indent: 0, parameters: ["x", "y", "z", {}] }] },
    { kind: "conditional_branch", condition: { type: "switch", switchId: 1 }, thenBranch: [{ code: 401, indent: 0, parameters: ["orphan"] }] },
    { kind: "control_switch", scope: "switch", switchId: 3, endId: 2 },
    { kind: "control_switch", scope: "switch", switchId: "" },
    { kind: "control_switch", scope: "switch", switchId: null },
    { kind: "control_switch", scope: "switch", switchId: true },
    { kind: "control_variable", variableId: 1, operand: { type: "constant" } },
    { kind: "control_variable", variableId: 1, endId: 0, operand: { type: "constant", value: 1 } },
    { kind: "control_variable", variableId: 1, operand: { type: "random", min: 3, max: 1 } },
    { kind: "control_variable", variableId: 1, operand: { type: "game_data", dataType: 8 } },
    { kind: "control_variable", variableId: 1, operand: { type: "game_data", dataType: 0 } },
    { kind: "control_variable", variableId: 1, operand: { type: "game_data", dataType: 3, param1: 1, param2: 12 } },
    { kind: "control_variable", variableId: 1, operand: { type: "game_data", dataType: 5, param1: -2 } },
    { kind: "control_variable", variableId: 1, operand: { type: "game_data", dataType: 7, param1: 10 } },
    { kind: "transfer_player", mapId: 1, x: 0, y: 2, designation: "variable" },
    { kind: "common_event", commonEventId: 0 },
    { kind: "flow", action: "label" },
    { kind: "flow", action: "wait", frames: -1 },
    { kind: "flow", action: "wait", frames: 0 },
    { kind: "plugin_command", text: "  " },
    { kind: "plugin_command", text: "Example\nrun" },
    { kind: "unsupported" },
  ])("rejects unsafe or incompatible input %j", args => {
    expect(() => buildEventCommands(args)).toThrow();
  });
});
