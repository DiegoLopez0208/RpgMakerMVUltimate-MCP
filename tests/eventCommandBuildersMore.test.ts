import { describe, expect, it } from "vitest";
import { buildEventCommands } from "../src/utils/eventCommandBuilders.js";

const build = (kind: string, args: Record<string, unknown> = {}) => buildEventCommands({ kind, ...args }).commands;
const c = (code: number, parameters: unknown[] = [], indent = 0) => ({ code, indent, parameters });

// Expected parameters follow Game_Interpreter in MV 1.6.1 (rpg_objects.js), slot by slot.
describe("MV builders for party, presentation and scene commands", () => {
  it.each([
    ["change_gold", { amount: 50 }, [c(125, [0, 0, 50])]],
    ["change_gold", { amountVariableId: 4, decrease: true }, [c(125, [1, 1, 4])]],
    ["change_items", { itemId: 3, amount: 2 }, [c(126, [3, 0, 0, 2])]],
    ["change_items", { itemType: "weapon", itemId: 1, amount: 1, decrease: true, includeEquip: true }, [c(127, [1, 1, 0, 1, true])]],
    ["change_items", { itemType: "armor", itemId: 2, amountVariableId: 7 }, [c(128, [2, 0, 1, 7, false])]],
    ["change_party_member", { actorId: 2 }, [c(129, [2, 0, false])]],
    ["change_party_member", { actorId: 2, remove: true }, [c(129, [2, 1, false])]],
    ["play_audio", { channel: "bgm", name: "Theme1" }, [c(241, [{ name: "Theme1", pan: 0, pitch: 100, volume: 90 }])]],
    ["play_audio", { channel: "se", name: "Cursor1", volume: 80, pitch: 120, pan: -10 }, [c(250, [{ name: "Cursor1", pan: -10, pitch: 120, volume: 80 }])]],
    ["screen_effect", { effect: "fadeout" }, [c(221)]],
    ["screen_effect", { effect: "fadein" }, [c(222)]],
    ["screen_effect", { effect: "tint", color: [-68, -68, 0, 68] }, [c(223, [[-68, -68, 0, 68], 60, true])]],
    ["screen_effect", { effect: "flash", color: [255, 255, 255, 170], duration: 8, wait: false }, [c(224, [[255, 255, 255, 170], 8, false])]],
    ["screen_effect", { effect: "shake", power: 7, speed: 3, duration: 30 }, [c(225, [7, 3, 30, true])]],
    ["show_picture", { pictureId: 1, name: "Title", origin: "center", x: 408, y: 312, opacity: 128, blend: "additive" },
      [c(231, [1, "Title", 1, 0, 408, 312, 100, 100, 128, 1])]],
    ["show_picture", { pictureId: 2, name: "Map", designation: "variable", x: 3, y: 4 }, [c(231, [2, "Map", 0, 1, 3, 4, 100, 100, 255, 0])]],
    ["erase_picture", { pictureId: 1 }, [c(235, [1])]],
    ["show_animation", { characterId: -1, animationId: 41, wait: true }, [c(212, [-1, 41, true])]],
    ["show_balloon", { balloonId: 1 }, [c(213, [0, 1, false])]],
    ["shop_processing", { goods: [{ id: 1 }, { type: "weapon", id: 2, price: 300 }], purchaseOnly: true },
      [c(302, [0, 1, 0, 0, true]), c(605, [1, 2, 1, 300])]],
    ["name_input", { actorId: 1 }, [c(303, [1, 8])]],
    ["change_actor", { stat: "hp", actorId: 0, amount: 10, decrease: true, allowDeath: true }, [c(311, [0, 0, 1, 0, 10, true])]],
    ["change_actor", { stat: "mp", actorVariableId: 5, amount: 20 }, [c(312, [1, 5, 0, 0, 20])]],
    ["change_actor", { stat: "exp", actorId: 1, amount: 100, showLevelUp: true }, [c(315, [0, 1, 0, 0, 100, true])]],
    ["change_actor", { stat: "level", actorId: 1, amountVariableId: 2 }, [c(316, [0, 1, 0, 1, 2, false])]],
    ["change_actor", { stat: "state", actorId: 1, stateId: 4, remove: true }, [c(313, [0, 1, 1, 4])]],
    ["change_actor", { stat: "recover_all", actorId: 0 }, [c(314, [0, 0])]],
    ["enemy_appear", { enemyIndex: 2 }, [c(335, [2])]],
    ["change_enemy_state", { enemyIndex: -1, stateId: 1 }, [c(333, [-1, 0, 1])]],
    ["abort_battle", {}, [c(340)]],
  ])("%s %j", (kind, args, expected) => {
    expect(build(kind, args as Record<string, unknown>)).toEqual(expected);
  });

  it("writes battle result branches only when escaping or losing is allowed", () => {
    expect(build("battle_processing", { troopId: 3 })).toEqual([c(301, [0, 3, false, false])]);
    expect(build("battle_processing", { randomEncounter: true })).toEqual([c(301, [2, 0, false, false])]);
    const reward = build("change_gold", { amount: 100 });
    expect(build("battle_processing", { troopVariableId: 6, canEscape: true, canLose: true, winBranch: reward, indent: 1 })).toEqual([
      c(301, [1, 6, true, true], 1),
      c(601, [], 1), c(125, [0, 0, 100], 2), c(0, [], 2),
      c(602, [], 1), c(0, [], 2),
      c(603, [], 1), c(0, [], 2),
      c(604, [], 1),
    ]);
    expect(build("battle_processing", { troopId: 1, canLose: true })).toEqual([
      c(301, [0, 1, false, true]), c(601), c(0, [], 1), c(603), c(0, [], 1), c(604),
    ]);
  });

  it("wraps long text into four-line boxes with one header each", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const commands = build("show_text", { lines: [words.join(" ")], wrap: true });
    const headers = commands.filter(command => command.code === 101);
    const lines = commands.filter(command => command.code === 401).map(command => command.parameters[0] as string);
    expect(lines.every(line => line.length <= 55)).toBe(true);
    expect(lines.join(" ")).toBe(words.join(" "));
    expect(headers).toHaveLength(Math.ceil(lines.length / 4));
    expect(commands[0]).toEqual(c(101, ["", 0, 0, 2]));
  });

  it("wraps narrower with a face, ignores escape codes and keeps hard breaks", () => {
    const withFace = build("show_text", { lines: ["a ".repeat(40).trim()], faceName: "Actor1", wrap: true })
      .filter(command => command.code === 401);
    expect(withFace.every(command => (command.parameters[0] as string).length <= 38)).toBe(true);
    const colored = build("show_text", { lines: ["\\C[2]" + "x".repeat(50) + "\\C[0] end"], wrap: true }).filter(command => command.code === 401);
    expect(colored.map(command => command.parameters[0])).toEqual(["\\C[2]" + "x".repeat(50) + "\\C[0] end"]);
    const hard = build("show_text", { lines: ["First line.", "Second line."], wrap: "hard" }).filter(command => command.code === 401);
    expect(hard.map(command => command.parameters[0])).toEqual(["First line.", "Second line."]);
  });

  it("warns about long unwrapped lines without changing them", () => {
    const long = "x ".repeat(40).trim();
    const result = buildEventCommands({ kind: "show_text", lines: [long] });
    expect(result.commands[1]).toEqual(c(401, [long]));
    expect(result.warnings?.join(" ")).toMatch(/exceed ~55/);
    expect(buildEventCommands({ kind: "show_text", lines: ["short"] }).warnings).toBeUndefined();
  });

  it.each([
    { kind: "change_gold" },
    { kind: "change_gold", amount: 1, amountVariableId: 2 },
    { kind: "change_gold", amount: -5 },
    { kind: "change_items", itemId: 1, amount: 1, includeEquip: true },
    { kind: "change_party_member", actorId: 0 },
    { kind: "play_audio", channel: "voice", name: "x" },
    { kind: "play_audio", channel: "bgm", name: "x", volume: 101 },
    { kind: "screen_effect", effect: "tint" },
    { kind: "screen_effect", effect: "tint", color: [0, 0, 0] },
    { kind: "screen_effect", effect: "flash", color: [-1, 0, 0, 0] },
    { kind: "screen_effect", effect: "fadeout", duration: 30 },
    { kind: "show_picture", pictureId: 0, name: "x" },
    { kind: "show_picture", pictureId: 101, name: "x" },
    { kind: "show_picture", pictureId: 1, name: "x", designation: "variable", x: 0, y: 1 },
    { kind: "show_balloon", balloonId: 16 },
    { kind: "show_animation", characterId: -2, animationId: 1 },
    { kind: "battle_processing" },
    { kind: "battle_processing", troopId: 1, randomEncounter: true },
    { kind: "battle_processing", troopId: 1, winBranch: [] },
    { kind: "battle_processing", troopId: 1, canLose: true, escapeBranch: [] },
    { kind: "shop_processing", goods: [] },
    { kind: "shop_processing", goods: [{ type: "skill", id: 1 }] },
    { kind: "name_input", actorId: 1, maxLength: 17 },
    { kind: "change_actor", stat: "hp", amount: 1 },
    { kind: "change_actor", stat: "hp", actorId: 1, actorVariableId: 2, amount: 1 },
    { kind: "change_actor", stat: "hp", actorId: 1 },
    { kind: "change_actor", stat: "mp", actorId: 1, amount: 1, allowDeath: true },
    { kind: "change_actor", stat: "recover_all", actorId: 1, amount: 1 },
    { kind: "change_actor", stat: "state", actorId: 1 },
    { kind: "enemy_appear", enemyIndex: -1 },
    { kind: "change_enemy_state", enemyIndex: 8, stateId: 1 },
    { kind: "abort_battle", indent: -1 },
    { kind: "show_text", lines: ["x"], wrapWidth: 30 },
    { kind: "show_text", lines: ["x"], wrap: "soft" },
  ])("rejects %j", args => {
    expect(() => buildEventCommands(args)).toThrow();
  });
});
