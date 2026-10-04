import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { buildEventCommands } from "../src/utils/eventCommandBuilders.js";
import { validateEventCommands } from "../src/utils/eventCommandValidation.js";
import { buildTroopPage } from "../src/utils/troopPage.js";
import { dispatchTool } from "../src/server.js";
import * as projectTools from "../src/tools/projectTools.js";

const route = (args: Record<string, unknown>) => buildEventCommands({ kind: "move_route", ...args }).commands;

describe("move_route", () => {
  it("writes the route on the 205 row and one 505 row per step, without the end marker", () => {
    const commands = route({ characterId: -1, steps: [{ step: "move_down", times: 2 }, { step: "wait", frames: 30 }] });
    const list = [{ code: 1, indent: null }, { code: 1, indent: null }, { code: 15, parameters: [30], indent: null }, { code: 0, parameters: [] }];
    expect(commands).toEqual([
      { code: 205, indent: 0, parameters: [-1, { list, repeat: false, skippable: false, wait: true }] },
      { code: 505, indent: 0, parameters: [list[0]] },
      { code: 505, indent: 0, parameters: [list[1]] },
      { code: 505, indent: 0, parameters: [list[2]] },
    ]);
    expect(() => validateEventCommands([...commands, { code: 0, indent: 0, parameters: [] }])).not.toThrow();
  });

  it("encodes every parameterised step the way Game_Character reads it", () => {
    const steps = route({ steps: [
      { step: "jump", x: 2, y: -1 }, { step: "switch_off", switchId: 4 }, { step: "change_speed", value: 5 },
      { step: "change_freq", value: 3 }, { step: "change_image", name: "Actor1", index: 2 }, { step: "change_opacity", value: 128 },
      { step: "change_blend_mode", value: 1 }, { step: "play_se", name: "Jump1" }, { step: "script", text: "this.setDirection(2)" },
    ], repeat: true, skippable: true, wait: false })[0].parameters[1] as { list: unknown[]; repeat: boolean; skippable: boolean; wait: boolean };
    expect(steps.list).toEqual([
      { code: 14, parameters: [2, -1], indent: null }, { code: 28, parameters: [4], indent: null },
      { code: 29, parameters: [5], indent: null }, { code: 30, parameters: [3], indent: null },
      { code: 41, parameters: ["Actor1", 2], indent: null }, { code: 42, parameters: [128], indent: null },
      { code: 43, parameters: [1], indent: null }, { code: 44, parameters: [{ name: "Jump1", pan: 0, pitch: 100, volume: 90 }], indent: null },
      { code: 45, parameters: ["this.setDirection(2)"], indent: null }, { code: 0, parameters: [] },
    ]);
    expect([steps.repeat, steps.skippable, steps.wait]).toEqual([true, true, false]);
  });

  it.each([
    { steps: [] },
    { steps: [{ step: "fly" }] },
    { steps: [{ step: "wait" }] },
    { steps: [{ step: "move_down", frames: 3 }] },
    { steps: [{ step: "change_speed", value: 7 }] },
    { steps: [{ step: "change_opacity", value: 256 }] },
    { steps: [{ step: "switch_on" }] },
    { steps: [{ step: "move_down", times: 0 }] },
    { steps: [{ step: "move_down" }], characterId: -2 },
  ])("rejects %j", args => {
    expect(() => route(args)).toThrow();
  });
});

describe("troop pages", () => {
  it("fills the editor's twelve condition fields and turns on only the requested checks", () => {
    const { page } = buildTroopPage({
      when: { turn: [2, 3], enemyHpBelow: [1, 50] }, span: "turn",
      commands: buildEventCommands({ kind: "show_text", lines: ["Enraged!"], indent: 3 }).commands,
    });
    expect(page).toEqual({
      conditions: { actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 1, enemyValid: true,
        switchId: 1, switchValid: false, turnA: 2, turnB: 3, turnEnding: false, turnValid: true },
      list: [{ code: 101, indent: 0, parameters: ["", 0, 0, 2] }, { code: 401, indent: 0, parameters: ["Enraged!"] }, { code: 0, indent: 0, parameters: [] }],
      span: 1,
    });
  });

  it.each([
    { when: {} },
    { when: { turnEnd: false } },
    { when: { enemyHpBelow: [8, 50] } },
    { when: { actorHpBelow: [1, 101] } },
    { when: { switchId: 0 } },
    { when: { turn: [1] } },
    { when: { turnEnd: true }, span: "always" },
    { when: { turnEnd: true }, commands: [{ code: 401, indent: 0, parameters: ["orphan"] }] },
    { when: { turnEnd: true }, extra: 1 },
  ])("rejects %j", input => {
    expect(() => buildTroopPage(input)).toThrow();
  });
});

describe("update_database_entry troops + addPage", () => {
  let projectDir: string;
  const troops = () => JSON.parse(readFileSync(path.join(projectDir, "data", "Troops.json"), "utf8"));
  const blank = { conditions: { turnEnding: false, turnValid: false, enemyValid: false, actorValid: false, switchValid: false }, list: [{ code: 0, indent: 0, parameters: [] }], span: 0 };

  beforeAll(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-troop-page-"));
    mkdirSync(path.join(projectDir, "data"));
    const write = (name: string, value: unknown) => writeFileSync(path.join(projectDir, "data", name), JSON.stringify(value));
    write("Troops.json", [null, { id: 1, name: "Slimes", members: [{ enemyId: 1, x: 300, y: 300, hidden: false }], pages: [blank] }]);
    write("Actors.json", [null, { id: 1, name: "Hero" }]);
    write("States.json", [null, { id: 1, name: "Knockout" }]);
    write("System.json", { switches: ["", "Boss"], variables: ["", ""] });
    projectTools.initProjectPath(projectDir);
  });
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  it("appends a page, or inserts it at a position, without touching the others", async () => {
    const appended = await dispatchTool("update_database_entry", { entity: "troops", id: 1, addPage: { when: { switchId: 1 } } }) as { pageIndex: number; pageCount: number };
    expect([appended.pageIndex, appended.pageCount]).toEqual([1, 2]);
    const inserted = await dispatchTool("update_database_entry", { entity: "troops", id: "1", addPage: { when: { turnEnd: true }, position: 0, span: "moment" } }) as { pageIndex: number };
    expect(inserted.pageIndex).toBe(0);
    const pages = troops()[1].pages;
    expect(pages).toHaveLength(3);
    expect(pages[0].conditions.turnEnding).toBe(true);
    expect(pages[0].span).toBe(2);
    expect(pages[1]).toEqual(blank);
    expect(pages[2].conditions.switchValid).toBe(true);
  });

  it.each([
    { when: { enemyHpBelow: [1, 50] } },
    { when: { actorHpBelow: [2, 50] } },
    { when: { switchId: 2 } },
    { when: { turnEnd: true }, commands: buildEventCommands({ kind: "change_actor", stat: "state", actorId: 1, stateId: 9 }).commands },
    { when: { turnEnd: true }, position: 9 },
    { when: {} },
  ])("refuses %j and leaves Troops.json unchanged", async addPage => {
    const before = readFileSync(path.join(projectDir, "data", "Troops.json"), "utf8");
    await expect(dispatchTool("update_database_entry", { entity: "troops", id: 1, addPage })).rejects.toThrow();
    expect(readFileSync(path.join(projectDir, "data", "Troops.json"), "utf8")).toBe(before);
  });

  it("previews with dryRun without writing", async () => {
    const before = readFileSync(path.join(projectDir, "data", "Troops.json"), "utf8");
    const result = await dispatchTool("update_database_entry", { entity: "troops", id: 1, addPage: { when: { turn: [1, 0] } }, dryRun: true }) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
    expect(readFileSync(path.join(projectDir, "data", "Troops.json"), "utf8")).toBe(before);
  });
});
