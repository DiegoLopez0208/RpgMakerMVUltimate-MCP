import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { dispatchTool } from "../src/server.js";
import * as projectTools from "../src/tools/projectTools.js";
import { normalizeMapEvents } from "../src/utils/eventNormalize.js";

// Issue #15, bug 2: the preset handlers copied x/y and command parameters
// straight out of the tool arguments, and validateConsolidated threw away the
// args Zod had coerced, so an agent passing "x": "1" got "x": "1" in the map
// file where the RPG Maker MV editor writes 1.

let projectDir: string;
const dataDir = () => path.join(projectDir, "data");
const map001 = () => JSON.parse(readFileSync(path.join(dataDir(), "Map001.json"), "utf-8"));
const lastEvent = () => map001().events.filter(Boolean).pop();

/** Every number-looking string leaf under `value`, with the path that reached it. */
function stringNumbers(value: unknown, at = ""): string[] {
  if (typeof value === "string") return /^[+-]?\d+$/.test(value.trim()) ? [at + " = " + JSON.stringify(value)] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringNumbers(v, at + "[" + i + "]"));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => stringNumbers(v, at + "." + k));
  }
  return [];
}

function blankMap(width: number, height: number) {
  return {
    width, height, tilesetId: 1, displayName: "", data: new Array(width * height * 6).fill(0), events: [null],
    encounterList: [], encounterStep: 30, bgm: { name: "", pan: 0, pitch: 100, volume: 90 },
    bgs: { name: "", pan: 0, pitch: 100, volume: 90 }, autoplayBgm: false, autoplayBgs: false,
    disableDashing: false, note: "", parallaxLoopX: false, parallaxLoopY: false, parallaxName: "",
    parallaxShow: true, parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false,
    battleback1Name: "", battleback2Name: "",
  };
}

beforeAll(async () => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-numtypes-"));
  mkdirSync(dataDir());
  mkdirSync(path.join(projectDir, "img"));
  const empty = JSON.stringify([null]);
  for (const f of ["Actors.json", "Classes.json", "Weapons.json", "Armors.json", "States.json", "CommonEvents.json", "Animations.json"]) {
    writeFileSync(path.join(dataDir(), f), empty);
  }
  writeFileSync(path.join(dataDir(), "Items.json"), JSON.stringify([null, { id: 1, name: "Potion", price: 50 }]));
  writeFileSync(path.join(dataDir(), "Enemies.json"), JSON.stringify([null, { id: 1, name: "Slime" }]));
  writeFileSync(path.join(dataDir(), "Troops.json"), JSON.stringify([null, { id: 1, name: "Slime x1", members: [] }]));
  writeFileSync(path.join(dataDir(), "Tilesets.json"), JSON.stringify([null, { id: 1, name: "Overworld", flags: [], tilesetNames: ["", "", "", "", "", "", "", "", ""] }]));
  writeFileSync(path.join(dataDir(), "Skills.json"), JSON.stringify([null, { id: 1, name: "Attack" }, { id: 2, name: "Guard" }]));
  writeFileSync(path.join(dataDir(), "System.json"), JSON.stringify({ gameTitle: "Fixture", switches: ["", "", "", ""], variables: ["", "", "", ""] }));
  writeFileSync(path.join(dataDir(), "MapInfos.json"), JSON.stringify([null,
    { id: 1, name: "A", order: 1, parentId: 0, expanded: false, scrollX: 0, scrollY: 0 },
    { id: 2, name: "B", order: 2, parentId: 0, expanded: false, scrollX: 0, scrollY: 0 },
  ]));
  writeFileSync(path.join(dataDir(), "Map001.json"), JSON.stringify(blankMap(20, 20)));
  writeFileSync(path.join(dataDir(), "Map002.json"), JSON.stringify(blankMap(20, 20)));
  await projectTools.setProjectPath(projectDir);
});
afterAll(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* temp dir */ } });

describe("presets persist numbers, not numeric strings", () => {
  // The exact repro from the issue, plus the other seven presets.
  it("door: x/y and the 201 transfer slots", async () => {
    await dispatchTool("manage_map_event", {
      action: "create", preset: "door", mapId: 1, x: "1", y: "2",
      destMapId: 1, destX: "3", destY: "4", characterIndex: "0",
    });
    const ev = lastEvent();
    expect(ev.x).toBe(1);
    expect(ev.y).toBe(2);
    expect(ev.pages[0].list[0].parameters).toEqual([0, 1, 3, 4, 0, 0]);
    expect(ev.pages[0].image.characterIndex).toBe(0);
    expect(stringNumbers(ev, "door")).toEqual([]);
  });

  it("teleport", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "teleport", mapId: 1, x: "5", y: "6", destMapId: "2", destX: "7", destY: "8" });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([5, 6]);
    expect(ev.pages[0].list[0].parameters).toEqual([0, 2, 7, 8, 0, 0]);
    expect(stringNumbers(ev, "teleport")).toEqual([]);
  });

  it("chest", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "chest", mapId: 1, x: "9", y: "10", items: [{ type: "item", id: "1", amount: "2" }] });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([9, 10]);
    expect(stringNumbers(ev, "chest")).toEqual([]);
  });

  it("npc", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "npc", mapId: 1, x: "11", y: "12", name: "Bob", dialogues: ["hola"], characterIndex: "3" });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([11, 12]);
    expect(ev.pages[0].image.characterIndex).toBe(3);
    expect(stringNumbers(ev, "npc")).toEqual([]);
  });

  it("shop", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "shop", mapId: 1, x: "13", y: "14", name: "Tienda", goods: [["0", "1", "1", "25"]] });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([13, 14]);
    expect(stringNumbers(ev, "shop")).toEqual([]);
  });

  it("inn", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "inn", mapId: 1, x: "15", y: "16", cost: "50" });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([15, 16]);
    expect(stringNumbers(ev, "inn")).toEqual([]);
  });

  it("boss", async () => {
    await dispatchTool("manage_map_event", { action: "create", preset: "boss", mapId: 1, x: "17", y: "18", troopId: "1" });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([17, 18]);
    expect(stringNumbers(ev, "boss")).toEqual([]);
  });

  it("puzzle_switch creates two events, both numeric", async () => {
    await dispatchTool("manage_map_event", {
      action: "create", preset: "puzzle_switch", mapId: 1,
      switchX: "2", switchY: "3", doorX: "4", doorY: "5", gameSwitchId: "2",
    });
    const events = map001().events.filter(Boolean).slice(-2);
    expect(events.length).toBe(2);
    for (const ev of events) expect(stringNumbers(ev, "puzzle")).toEqual([]);
  });

  it("low-level create without a preset", async () => {
    await dispatchTool("manage_map_event", { action: "create", mapId: 1, x: "6", y: "7", name: "Raw" });
    const ev = lastEvent();
    expect([ev.x, ev.y]).toEqual([6, 7]);
  });

  it("update writes numeric fields", async () => {
    const created = await dispatchTool("manage_map_event", { action: "create", mapId: 1, x: 1, y: 1, name: "Movible" }) as { id: number };
    await dispatchTool("manage_map_event", { action: "update", mapId: 1, eventId: created.id, fields: { x: "8", y: "9" } });
    const ev = map001().events[created.id];
    expect([ev.x, ev.y]).toEqual([8, 9]);
  });

  it("add_command normalises the command it appends", async () => {
    const created = await dispatchTool("manage_map_event", { action: "create", mapId: 1, x: 2, y: 2, name: "Comandos" }) as { id: number };
    await dispatchTool("manage_map_event", {
      action: "add_command", mapId: 1, eventId: created.id, pageIndex: 0,
      command: { code: 201, indent: 0, parameters: [0, "2", "3", "4", 0, 0] },
    });
    const ev = map001().events[created.id];
    const transfer = ev.pages[0].list.find((c: { code: number }) => c.code === 201);
    expect(transfer.parameters).toEqual([0, 2, 3, 4, 0, 0]);
  });

  it("edit_map connect writes numeric transfer events on both maps", async () => {
    await dispatchTool("edit_map", {
      action: "connect", mapIdA: 1, mapIdB: 2,
      posA: { x: "3", y: "3" }, posB: { x: "4", y: "4" },
    });
    for (const f of ["Map001.json", "Map002.json"]) {
      const m = JSON.parse(readFileSync(path.join(dataDir(), f), "utf-8"));
      const ev = m.events.filter(Boolean).pop();
      expect(stringNumbers(ev, f)).toEqual([]);
    }
  });
});

describe("junk numbers are rejected instead of silently truncated", () => {
  it.each([
    ["fraction", "2.5"],
    ["trailing junk", "2x"],
    ["hex", "0x10"],
    ["exponent", "1e3"],
    ["empty", ""],
    ["blank", "   "],
  ])("rejects x as a %s", async (_label, x) => {
    await expect(dispatchTool("manage_map_event", { action: "create", preset: "door", mapId: 1, x, y: 1, destMapId: 1, destX: 1, destY: 1 }))
      .rejects.toThrow(/Validation error/);
  });

  it("rejects a fractional trigger", async () => {
    await expect(dispatchTool("manage_map_event", { action: "create", preset: "door", mapId: 1, x: 1, y: 1, destMapId: 1, destX: 1, destY: 1, trigger: "2.5" }))
      .rejects.toThrow(/Validation error/);
  });

  it("still accepts plain numeric strings", async () => {
    const before = map001().events.filter(Boolean).length;
    await dispatchTool("manage_map_event", { action: "create", preset: "door", mapId: 1, x: " 7 ", y: "7", destMapId: 1, destX: 1, destY: 1 });
    expect(map001().events.filter(Boolean).length).toBe(before + 1);
    expect(lastEvent().x).toBe(7);
  });
});

describe("normalizeMapEvents only touches engine-defined numeric slots", () => {
  it("coerces the numeric slots it knows", () => {
    const map = {
      events: [null, {
        id: "3", x: "1", y: "2",
        pages: [{
          trigger: "1", moveSpeed: "4", moveFrequency: "3", moveType: "0", priorityType: "1",
          image: { characterName: "Actor1", characterIndex: "2", direction: "8", pattern: "1", tileId: "0" },
          conditions: { switch1Id: "5", switch1Valid: true, selfSwitchCh: "A", variableValue: "10" },
          list: [
            { code: "201", indent: "0", parameters: [0, "2", "3", "4", 0, 0] },
            { code: 125, indent: 0, parameters: ["0", "0", "100"] },
            { code: 0, indent: 0, parameters: [] },
          ],
          moveRoute: { list: [{ code: "15", parameters: ["30"] }, { code: 41, parameters: ["Actor1", "5"] }, { code: 0, parameters: [] }] },
        }],
      }],
    };
    normalizeMapEvents(map);
    const ev = map.events[1] as Record<string, unknown>;
    expect(stringNumbers(ev, "ev")).toEqual([]);
    const page = (ev.pages as Record<string, unknown>[])[0];
    expect(page.trigger).toBe(1);
    expect((page.list as { parameters: unknown[] }[])[0].parameters).toEqual([0, 2, 3, 4, 0, 0]);
    expect((page.list as { parameters: unknown[] }[])[1].parameters).toEqual([0, 0, 100]);
    expect((page.moveRoute as { list: { parameters: unknown[] }[] }).list[1].parameters).toEqual(["Actor1", 5]);
  });

  it("leaves every string slot the engine defines as text alone", () => {
    // These are the ones a blanket recursion would corrupt.
    const list = [
      { code: 101, indent: 0, parameters: ["1", 0, 0, 2] },        // [0] is a face image filename
      { code: 401, indent: 0, parameters: ["100"] },               // message text that happens to be digits
      { code: 102, indent: 0, parameters: [["1", "2"], -1] },      // choice labels
      { code: 108, indent: 0, parameters: ["42"] },                // comment
      { code: 118, indent: 0, parameters: ["7"] },                 // label name
      { code: 119, indent: 0, parameters: ["7"] },                 // jump to label
      { code: 355, indent: 0, parameters: ["$gameSwitches.setValue(1, true)"] },
      { code: 655, indent: 0, parameters: ["12345"] },             // continuation of a script line
      { code: 356, indent: 0, parameters: ["MyPlugin 1 2 3"] },    // plugin command
      { code: 320, indent: 0, parameters: ["1", "9"] },            // [1] is the new actor name
      { code: 122, indent: 0, parameters: ["1", "1", "0", 4, "$gameParty.gold()"] }, // script operand
    ];
    const map = { events: [null, { id: 1, x: 0, y: 0, pages: [{ list }] }] };
    normalizeMapEvents(map);
    expect(list[0].parameters[0]).toBe("1");
    expect(list[1].parameters[0]).toBe("100");
    expect(list[2].parameters[0]).toEqual(["1", "2"]);
    expect(list[3].parameters[0]).toBe("42");
    expect(list[4].parameters[0]).toBe("7");
    expect(list[5].parameters[0]).toBe("7");
    expect(list[6].parameters[0]).toBe("$gameSwitches.setValue(1, true)");
    expect(list[7].parameters[0]).toBe("12345");
    expect(list[8].parameters[0]).toBe("MyPlugin 1 2 3");
    expect(list[9].parameters).toEqual([1, "9"]);           // actorId coerced, name kept
    expect(list[10].parameters).toEqual([1, 1, 0, 4, "$gameParty.gold()"]); // script operand kept
  });

  it("coerces the operand of a non-script Control Variables", () => {
    const list = [{ code: 122, indent: 0, parameters: ["1", "1", "0", "0", "42"] }];
    normalizeMapEvents({ events: [null, { id: 1, x: 0, y: 0, pages: [{ list }] }] });
    expect(list[0].parameters).toEqual([1, 1, 0, 0, 42]);
  });

  it("leaves an unmodelled opcode completely alone", () => {
    const list = [{ code: 999, indent: 0, parameters: ["1", "2"] }];
    normalizeMapEvents({ events: [null, { id: 1, x: 0, y: 0, pages: [{ list }] }] });
    expect(list[0].parameters).toEqual(["1", "2"]);
  });

  it("survives malformed input without throwing", () => {
    expect(() => normalizeMapEvents(null)).not.toThrow();
    expect(() => normalizeMapEvents({})).not.toThrow();
    expect(() => normalizeMapEvents({ events: "nope" })).not.toThrow();
    expect(() => normalizeMapEvents({ events: [null, { pages: [{ list: [null, 5, "x"] }] }] })).not.toThrow();
  });
});
