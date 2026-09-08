import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { dispatchTool } from "../src/server.js";
import * as projectTools from "../src/tools/projectTools.js";
import { generateFromTemplate } from "../src/utils/mapGenerator.js";

// Issue #15, bug 1: generate_map wrote `tilesetId: params.tilesetId || 1` for
// every template clone, so tile data authored for Inside, Dungeon or SF Outside
// was flagged as Overworld and rendered as garbage in the engine. 105 of the
// 111 bundled templates carry a tilesetId other than 1.

let projectDir: string;
const dataDir = () => path.join(projectDir, "data");
const dataFile = (n: string) => JSON.parse(readFileSync(path.join(dataDir(), n), "utf-8"));
const mapOf = (id: number) => dataFile("Map" + String(id).padStart(3, "0") + ".json");
const mapFileCount = () => readdirSync(dataDir()).filter((f) => /^Map\d{3}\.json$/.test(f)).length;

beforeAll(async () => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-tileset-"));
  mkdirSync(dataDir());
  mkdirSync(path.join(projectDir, "img"));
  const empty = JSON.stringify([null]);
  for (const f of ["Actors.json", "Classes.json", "Items.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "Troops.json", "CommonEvents.json", "Animations.json"]) {
    writeFileSync(path.join(dataDir(), f), empty);
  }
  // A real tileset table: ids 1..6, matching the RTP set the templates use.
  const names = ["Overworld", "Outside", "Inside", "Dungeon", "SF Outside", "SF Inside"];
  writeFileSync(path.join(dataDir(), "Tilesets.json"), JSON.stringify([null, ...names.map((name, i) => ({
    id: i + 1, name, mode: 0, note: "", flags: [], tilesetNames: ["", "", "", "", "", "", "", "", ""],
  }))]));
  writeFileSync(path.join(dataDir(), "Skills.json"), JSON.stringify([null, { id: 1, name: "Attack" }, { id: 2, name: "Guard" }]));
  writeFileSync(path.join(dataDir(), "System.json"), JSON.stringify({ gameTitle: "Fixture", switches: ["", ""], variables: ["", ""] }));
  writeFileSync(path.join(dataDir(), "MapInfos.json"), JSON.stringify([null, { id: 1, name: "Test", order: 1, parentId: 0, expanded: false, scrollX: 0, scrollY: 0 }]));
  writeFileSync(path.join(dataDir(), "Map001.json"), JSON.stringify({
    width: 10, height: 10, tilesetId: 1, displayName: "", data: new Array(600).fill(0), events: [null],
    encounterList: [], encounterStep: 30, bgm: { name: "", pan: 0, pitch: 100, volume: 90 },
    bgs: { name: "", pan: 0, pitch: 100, volume: 90 }, autoplayBgm: false, autoplayBgs: false,
    disableDashing: false, note: "", parallaxLoopX: false, parallaxLoopY: false, parallaxName: "",
    parallaxShow: true, parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false,
    battleback1Name: "", battleback2Name: "",
  }));
  await projectTools.setProjectPath(projectDir);
});
afterAll(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* temp dir */ } });

describe("mode template preserves the source tileset", () => {
  // [templateId, tilesetId] straight out of knowledge/map-templates.json:
  // 1 MAP001/Overworld, 7 Normal Town/Outside, 33 House 1/Inside,
  // 60 Underground Town/SF Outside.
  it.each([[1, 1], [7, 2], [33, 3], [60, 5]])(
    "template %i is written with tilesetId %i",
    async (templateId, expected) => {
      const res = await dispatchTool("generate_map", { mode: "template", templateId }) as { mapId: number };
      expect(mapOf(res.mapId).tilesetId).toBe(expected);
    },
  );

  it("the whole bundled index agrees: file tilesetId equals index tilesetId", () => {
    // The fix reads the tileset off the template file while createMapV3 reads it
    // off the index; this pins that the two sources never disagree.
    const idx = JSON.parse(readFileSync(path.join(process.cwd(), "knowledge", "map-templates.json"), "utf-8")) as { id: number; tilesetId: number }[];
    expect(idx.length).toBe(111);
    for (const t of idx) {
      const file = JSON.parse(readFileSync(path.join(process.cwd(), "knowledge", "maps", "Map" + String(t.id).padStart(3, "0") + ".json"), "utf-8"));
      expect(file.tilesetId, "template " + t.id).toBe(t.tilesetId);
    }
    expect(idx.filter((t) => t.tilesetId !== 1).length).toBe(105); // what the old `|| 1` broke
  });

  it("generateFromTemplate surfaces the tileset to its callers", async () => {
    const r = await generateFromTemplate(33) as { tilesetId?: number };
    expect(r.tilesetId).toBe(3);
  });

  it("a valid explicit override still wins over the template", async () => {
    const res = await dispatchTool("generate_map", { mode: "template", templateId: 33, tilesetId: 6 }) as { mapId: number };
    expect(mapOf(res.mapId).tilesetId).toBe(6);
  });

  it("keeps the tileset when the clone is resized", async () => {
    const res = await dispatchTool("generate_map", { mode: "template", templateId: 33, width: 25, height: 20 }) as { mapId: number };
    const m = mapOf(res.mapId);
    expect(m.tilesetId).toBe(3);
    expect(m.width).toBe(25);
    expect(m.data.length).toBe(25 * 20 * 6);
  });

  it("a resized clone keeps the template's events (they used to be dropped)", async () => {
    // Template 33 carries one event; the resize branch returned [] regardless.
    const r = await generateFromTemplate(33, { keepEvents: true, width: 25, height: 20 } as never) as { events: unknown[] };
    expect(r.events.filter(Boolean).length).toBe(1);
  });

  it("a resized clone keeps every surviving event at its own index", async () => {
    // The engine reads an event's id from its index in this array
    // (Game_Map.setupEvents), so an out-of-bounds event has to become null
    // rather than be spliced out - compacting renumbers everything after it.
    // Template 11 is 30x30 with three events, one of them beyond 20x20.
    type Ev = { id: number; x: number; y: number } | null;
    const full = await generateFromTemplate(11, { keepEvents: true } as never) as { events: Ev[] };
    const cropped = await generateFromTemplate(11, { keepEvents: true, width: 20, height: 20 } as never) as { events: Ev[] };
    expect(full.events.filter(Boolean).length).toBe(3);
    expect(cropped.events.filter(Boolean).length).toBe(2);
    expect(cropped.events.length).toBe(full.events.length);
    cropped.events.forEach((e, i) => {
      if (!e) return;
      expect(e.id, "index " + i).toBe(full.events[i]!.id);
      expect(e.id, "id must equal its index").toBe(i);
      expect(e.x).toBeLessThan(20);
      expect(e.y).toBeLessThan(20);
    });
  });

  it("keepEvents false still yields no events", async () => {
    const r = await generateFromTemplate(33, { keepEvents: false } as never) as { events: unknown[] };
    expect(r.events.filter(Boolean).length).toBe(0);
  });
});

describe("tilesetId override is validated before anything is written", () => {
  it.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 2.5],
    ["non-numeric string", "abc"],
    ["empty string", ""],
  ])("rejects a %s override without creating a map", async (_label, tilesetId) => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", { mode: "template", templateId: 33, tilesetId })).rejects.toThrow(/tilesetId/i);
    expect(mapFileCount()).toBe(before);
  });

  it("rejects a tileset id absent from the project without creating a map", async () => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", { mode: "template", templateId: 33, tilesetId: 42 }))
      .rejects.toThrow(/does not exist in this project/);
    expect(mapFileCount()).toBe(before);
  });

  it("accepts a numeric-string override", async () => {
    const res = await dispatchTool("generate_map", { mode: "template", templateId: 33, tilesetId: "4" }) as { mapId: number };
    expect(mapOf(res.mapId).tilesetId).toBe(4);
  });

  it("guards the procedural path the same way", async () => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", { mode: "procedural", theme: "town", width: 20, height: 20, tilesetId: 0 }))
      .rejects.toThrow(/tilesetId/i);
    expect(mapFileCount()).toBe(before);
  });
});

describe("map dimensions are whole numbers inside the editor's range", () => {
  // width/height went straight into Number(), so "2.5" wrote a map with
  // "width": 2.5 and a fractional-length data array, "1e3" wrote a 1000-tile
  // side, and "2x" became NaN and fell back silently (issue #15).
  it.each([
    ["fraction", "2.5"],
    ["trailing junk", "2x"],
    ["hex", "0x10"],
    ["exponent", "1e3"],
    ["empty string", ""],
    ["zero", 0],
    ["over the editor cap", 300],
  ])("rejects a %s width without creating a map", async (_label, width) => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", { mode: "template", templateId: 33, width })).rejects.toThrow();
    expect(mapFileCount()).toBe(before);
  });

  it("accepts a numeric-string size and writes a coherent data array", async () => {
    const res = await dispatchTool("generate_map", { mode: "template", templateId: 33, width: "25", height: "20" }) as { mapId: number };
    const m = mapOf(res.mapId);
    expect([m.width, m.height]).toEqual([25, 20]);
    expect(m.data.length).toBe(25 * 20 * 6);
    expect(Number.isInteger(m.width)).toBe(true);
  });

  it("accepts the editor's maximum side", async () => {
    const res = await dispatchTool("generate_map", { mode: "procedural", theme: "forest", width: 256, height: 20, seed: 2 }) as { mapId: number };
    expect(mapOf(res.mapId).width).toBe(256);
  });

  it("guards batch specs too", async () => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", {
      mode: "batch",
      batch: [{ key: "ok", name: "OK", theme: "forest", width: 20, height: 20 }, { key: "bad", name: "Bad", theme: "forest", width: "2.5", height: 20 }],
    })).rejects.toThrow(/batch\[1\]\.width/);
    // Every spec is validated before any is written, so a bad entry anywhere in
    // the batch leaves no half-written run behind.
    expect(mapFileCount()).toBe(before);
  });

  it("guards a bad tileset in a batch spec the same way", async () => {
    const before = mapFileCount();
    await expect(dispatchTool("generate_map", {
      mode: "batch",
      batch: [{ key: "ok", name: "OK", theme: "forest", width: 20, height: 20 }, { key: "bad", name: "Bad", theme: "forest", width: 20, height: 20, tilesetId: 99 }],
    })).rejects.toThrow(/does not exist in this project/);
    expect(mapFileCount()).toBe(before);
  });
});

describe("procedural mode with a forced template", () => {
  it("uses the forced template's tileset, not the theme default", async () => {
    // theme "town" defaults to tileset 2 (Outside); template 33 is Inside (3).
    const res = await dispatchTool("generate_map", { mode: "procedural", theme: "town", templateId: 33, width: 19, height: 15, seed: 1 }) as { mapId: number };
    expect(mapOf(res.mapId).tilesetId).toBe(3);
  });

  it("an explicit tilesetId still overrides the forced template", async () => {
    const res = await dispatchTool("generate_map", { mode: "procedural", theme: "town", templateId: 33, tilesetId: 2, width: 19, height: 15, seed: 1 }) as { mapId: number };
    expect(mapOf(res.mapId).tilesetId).toBe(2);
  });

  it("auto-picked templates are unchanged: the theme default still wins", async () => {
    // cloneTemplateForTheme hard-filters candidates to the theme's tileset, and
    // every theme has same-tileset candidates in the bundled index, so this path
    // must behave exactly as it did before the fix.
    for (const [theme, expected] of [["town", 2], ["interior", 3], ["dungeon", 4], ["world", 1]] as const) {
      const res = await dispatchTool("generate_map", { mode: "procedural", theme, width: 25, height: 20, seed: 7 }) as { mapId: number };
      expect(mapOf(res.mapId).tilesetId, theme).toBe(expected);
    }
  });

  it("useTemplate false keeps the theme default", async () => {
    const res = await dispatchTool("generate_map", { mode: "procedural", theme: "interior", width: 20, height: 20, seed: 3, useTemplate: false }) as { mapId: number };
    expect(mapOf(res.mapId).tilesetId).toBe(3);
  });

  it("batch specs keep their own tileset resolution", async () => {
    const res = await dispatchTool("generate_map", {
      mode: "batch",
      batch: [
        { key: "a", name: "A", theme: "dungeon", width: 20, height: 20 },
        { key: "b", name: "B", theme: "town", width: 20, height: 20, tilesetId: 2 },
      ],
    }) as { mapIds: Record<string, number> };
    expect(mapOf(res.mapIds.a).tilesetId).toBe(4);
    expect(mapOf(res.mapIds.b).tilesetId).toBe(2);
  });
});
