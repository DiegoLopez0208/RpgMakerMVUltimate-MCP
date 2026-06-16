import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";

import { dispatchTool } from "../src/server.js";
import * as projectTools from "../src/tools/projectTools.js";
import { TOOL_DEFINITIONS_V5 } from "../src/toolDefinitionsV5.js";
import { TOOL_DEFINITIONS } from "../src/toolDefinitions.js";
import { readdirSync } from "fs";
import { applyAutotileShapes, autotileShape, autotileKind } from "../src/utils/autotile.js";
import { makeChestEvent, makeBossEvent } from "../src/utils/mapGenerator.js";
import { cmd } from "../src/utils/commandBuilder.js";

let projectDir: string;

function dataFile(name: string): any {
  return JSON.parse(readFileSync(path.join(projectDir, "data", name), "utf-8"));
}

beforeAll(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-test-"));
  mkdirSync(path.join(projectDir, "data"));
  mkdirSync(path.join(projectDir, "img"));

  const emptyDb = JSON.stringify([null]);
  for (const f of ["Actors.json", "Classes.json", "Skills.json", "Items.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "Troops.json", "Tilesets.json", "CommonEvents.json", "Animations.json"]) {
    writeFileSync(path.join(projectDir, "data", f), emptyDb);
  }
  writeFileSync(path.join(projectDir, "data", "System.json"), JSON.stringify({ gameTitle: "Fixture", switches: ["", ""], variables: ["", ""] }));
  writeFileSync(path.join(projectDir, "data", "MapInfos.json"), JSON.stringify([null, { id: 1, name: "Test", order: 1, parentId: 0, expanded: false, scrollX: 0, scrollY: 0 }]));
  writeFileSync(path.join(projectDir, "data", "Map001.json"), JSON.stringify({
    width: 10, height: 10, tilesetId: 1, displayName: "",
    data: new Array(600).fill(0), events: [null],
    encounterList: [], encounterStep: 30,
    bgm: { name: "", pan: 0, pitch: 100, volume: 90 }, bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
    autoplayBgm: false, autoplayBgs: false, disableDashing: false, note: "",
    parallaxLoopX: false, parallaxLoopY: false, parallaxName: "", parallaxShow: true,
    parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false,
    battleback1Name: "", battleback2Name: ""
  }));

  projectTools.initProjectPath(projectDir);
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("v5 tool surface", () => {
  it("exposes exactly 12 tools, all annotated and described", () => {
    expect(TOOL_DEFINITIONS_V5.length).toBe(12);
    for (const t of TOOL_DEFINITIONS_V5) {
      expect(t.annotations, t.name).toBeDefined();
      expect(t.description.length, t.name).toBeGreaterThan(120);
    }
  });

  it("keeps the legacy v4 definitions available for legacy mode", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(90);
  });
});

describe("query_database", () => {
  it("lists every entity of an empty project as []", async () => {
    for (const entity of ["actors", "classes", "skills", "items", "weapons", "armors", "enemies", "states", "troops", "tilesets", "common_events", "animations"]) {
      const result = await dispatchTool("query_database", { entity });
      expect(Array.isArray(result), entity).toBe(true);
      expect((result as unknown[]).length, entity).toBe(0);
    }
  });

  it("rejects unknown entities", async () => {
    await expect(dispatchTool("query_database", { entity: "vehicles" })).rejects.toThrow(/Unknown entity/);
  });
});

describe("create_database_entry", () => {
  it("preset damage_skill keeps mpCost and formula (4.1.0 regression: zod dropped them)", async () => {
    const skill = await dispatchTool("create_database_entry", {
      preset: "damage_skill",
      data: { name: "Fireball", mpCost: "15", scope: 1, formula: "a.mat * 4 - b.mdf * 2", element: 2 }
    }) as any;
    expect(skill.mpCost).toBe(15); // coerced to number
    expect(skill.damage.formula).toBe("a.mat * 4 - b.mdf * 2");
    expect(skill.damage.elementId).toBe(2);
  });

  it("preset damage_skill fails fast when formula is missing", async () => {
    await expect(dispatchTool("create_database_entry", {
      preset: "damage_skill",
      data: { name: "Broken", mpCost: 5, scope: 1 }
    })).rejects.toThrow(/Validation error/);
  });

  it("classes expand 8 stat seeds into full 1-99 curves (4.1.0 regression: flat array crashed MV)", async () => {
    const cls = await dispatchTool("create_database_entry", {
      entity: "classes",
      data: { name: "Hero", params: [500, 100, 20, 20, 20, 20, 20, 20] }
    }) as any;
    expect(cls.params.length).toBe(8);
    expect(cls.params[0].length).toBe(100);
    expect(cls.params[0][1]).toBe(500);
    expect(cls.params[0][99]).toBe(5000);
  });

  it("rejects creation for editor-only entities", async () => {
    await expect(dispatchTool("create_database_entry", { entity: "animations", data: { name: "Boom" } })).rejects.toThrow(/not supported/);
  });

  it("preset encounter_troop builds positioned members", async () => {
    const troop = await dispatchTool("create_database_entry", {
      preset: "encounter_troop",
      data: { name: "Pack", enemyIds: [1, 1] }
    }) as any;
    expect(troop.members.length).toBe(2);
    expect(troop.members[0].enemyId).toBe(1);
  });
});

describe("query/update/delete round trip", () => {
  it("fetches by id, updates fields, and deletes", async () => {
    const skill = await dispatchTool("query_database", { entity: "skills", id: 1 }) as any;
    expect(skill.name).toBe("Fireball");

    const updated = await dispatchTool("update_database_entry", { entity: "skills", id: 1, fields: { mpCost: 20 } }) as any;
    expect(updated.mpCost).toBe(20);
    expect(updated.id).toBe(1);

    const found = await dispatchTool("query_database", { entity: "skills", query: "fire" }) as any[];
    expect(found.length).toBe(1);

    const deleted = await dispatchTool("delete_database_entry", { entity: "skills", id: 1 }) as any;
    expect(deleted).toBeDefined();
    const gone = await dispatchTool("query_database", { entity: "skills", id: 1 });
    expect(gone).toBeNull();
  });

  it("refuses to delete unsupported entities", async () => {
    await expect(dispatchTool("delete_database_entry", { entity: "troops", id: 1 })).rejects.toThrow(/not supported/);
  });
});

describe("manage_map_event", () => {
  it("preset npc writes Self Switch ON (4.1.0 regression: wrote OFF, page 2 never fired)", async () => {
    const ev = await dispatchTool("manage_map_event", {
      action: "create", preset: "npc",
      mapId: 1, x: 2, y: 2, name: "Bob", dialogues: ["Hola"]
    }) as any;
    const selfSwitch = ev.pages[0].list.find((c: any) => c.code === 123);
    expect(selfSwitch.parameters).toEqual(["A", 0]);
  });

  it("preset shop carries the first good in the 302 command with custom price (4.1.0 regression: hardcoded item 1)", async () => {
    const ev = await dispatchTool("manage_map_event", {
      action: "create", preset: "shop",
      mapId: 1, x: 3, y: 3, name: "Tienda", goods: [[0, 5, 1, 150], [1, 2, 0, 0]]
    }) as any;
    const c302 = ev.pages[0].list.find((c: any) => c.code === 302);
    expect(c302.parameters).toEqual([0, 5, 1, 150, false]);
    const c605 = ev.pages[0].list.filter((c: any) => c.code === 605);
    expect(c605.length).toBe(1);
    expect(c605[0].parameters).toEqual([1, 2, 0, 0]);
  });

  it("preset puzzle_switch names both events and keeps the door open (4.1.0 regressions)", async () => {
    const result = await dispatchTool("manage_map_event", {
      action: "create", preset: "puzzle_switch",
      mapId: 1, switchX: 1, switchY: 1, doorX: 4, doorY: 4, gameSwitchId: 7,
      switchName: "Palanca", doorName: "Puerta"
    }) as any;
    expect(result.switchEvent.name).toBe("Palanca");
    expect(result.doorEvent.name).toBe("Puerta");
    const doorSelfSwitch = result.doorEvent.pages[1].list.find((c: any) => c.code === 123);
    expect(doorSelfSwitch.parameters).toEqual(["A", 0]);
  });

  it("preset door makes an action-button transfer; lockedSwitchId adds a gated second page", async () => {
    const open = await dispatchTool("manage_map_event", {
      action: "create", preset: "door", mapId: 1, x: 4, y: 4, destMapId: 9, destX: 5, destY: 6
    }) as any;
    expect(open.pages.length).toBe(1);
    expect(open.pages[0].trigger).toBe(0); // action button
    const t = open.pages[0].list.find((c: any) => c.code === 201);
    expect(t.parameters).toEqual([0, 9, 5, 6, 0, 0]);

    const locked = await dispatchTool("manage_map_event", {
      action: "create", preset: "door", mapId: 1, x: 8, y: 8,
      destMapId: 9, destX: 1, destY: 1, lockedSwitchId: 3, lockedMessage: "Need a key"
    }) as any;
    expect(locked.pages.length).toBe(2);
    expect(locked.pages[1].conditions.switch1Id).toBe(3);
    expect(locked.pages[1].conditions.switch1Valid).toBe(true);
    // Transfer lives on the unlocked page, not the locked one.
    expect(locked.pages[1].list.some((c: any) => c.code === 201)).toBe(true);
    expect(locked.pages[0].list.some((c: any) => c.code === 201)).toBe(false);
  });

  it("preset inn gold check uses a Script conditional, not the Button type (5.2.0 fix)", async () => {
    const ev = await dispatchTool("manage_map_event", {
      action: "create", preset: "inn", mapId: 1, x: 7, y: 7, cost: 80
    }) as any;
    const cond = ev.pages[0].list.find((c: any) => c.code === 111);
    // type 12 = Script; type 11 was Button (key press) and never checked gold.
    expect(cond.parameters[0]).toBe(12);
    expect(cond.parameters[1]).toContain("gold()");
  });

  it("update and delete work and report missing events", async () => {
    const ev = await dispatchTool("manage_map_event", { action: "create", mapId: 1, x: 5, y: 5, name: "Temp" }) as any;
    const moved = await dispatchTool("manage_map_event", { action: "update", mapId: 1, eventId: ev.id, fields: { x: 6 } }) as any;
    expect(moved.x).toBe(6);
    await dispatchTool("manage_map_event", { action: "delete", mapId: 1, eventId: ev.id });
    await expect(dispatchTool("manage_map_event", { action: "delete", mapId: 1, eventId: ev.id })).rejects.toThrow(/not found/);
  });
});

describe("generator event regressions (5.2.0: 4.1.1 self-switch fix missed the internal makers)", () => {
  it("makeChestEvent turns Self Switch A ON so generated chests stay open", () => {
    const ev = makeChestEvent(0, 5, 5);
    const ss = ev.pages[0].list.find((c: any) => c.code === 123);
    expect(ss!.parameters).toEqual(["A", 0]); // was ["A", 1] = OFF -> reopened forever
  });

  it("makeBossEvent turns Self Switch A ON on victory so generated bosses stay defeated", () => {
    const ev = makeBossEvent(0, 5, 5, 1);
    const ss = ev.pages[0].list.find((c: any) => c.code === 123);
    expect(ss!.parameters).toEqual(["A", 0]); // was ["A", 1] = OFF -> respawned
  });

  it("cmd.conditionalVariable orders params as [1, varId, operandType, value, op]", () => {
    // Compare variable 3 >= 10 (operator 1). Constant operand (type 0).
    expect(cmd.conditionalVariable(3, 1, 10)[0].parameters).toEqual([1, 3, 0, 10, 1]);
  });
});

describe("query_map", () => {
  it("view infos lists the map tree without a mapId", async () => {
    const infos = await dispatchTool("query_map", { view: "infos" }) as any[];
    expect(infos[1].name).toBe("Test");
  });

  it("view events filters by query", async () => {
    const events = await dispatchTool("query_map", { view: "events", mapId: 1, query: "bob" }) as any[];
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("Bob");
  });

  it("view ascii renders a grid with legend", async () => {
    const result = await dispatchTool("query_map", { view: "ascii", mapId: 1 }) as any;
    expect(typeof result.ascii).toBe("string");
    expect(result.ascii.split("\n").length).toBe(10);
  });

  it("view validate accepts the fixed self-switch convention (validator was inverted in <=4.1.0)", async () => {
    const result = await dispatchTool("query_map", { view: "validate", mapId: 1 }) as any;
    const selfSwitchIssues = result.issues.filter((i: any) => i.type === "self_switch_off");
    expect(selfSwitchIssues.length).toBe(0);
  });

  it("requires mapId where the view needs one", async () => {
    await expect(dispatchTool("query_map", { view: "full" })).rejects.toThrow(/mapId/);
  });
});

describe("generate_map and edit_map", () => {
  let generatedMapId: number;

  it("mode procedural returns mapId and seed and is reproducible", async () => {
    const result = await dispatchTool("generate_map", { mode: "procedural", theme: "forest", width: 20, height: 15, seed: 1234, name: "Bosque" }) as any;
    expect(result.mapId).toBeGreaterThan(1);
    expect(result.seed).toBe(1234);
    generatedMapId = result.mapId;
  });

  it("mode town generates enterable house interiors with two-way warps (5.2.0)", async () => {
    const res = await dispatchTool("generate_map", { mode: "procedural", theme: "town", width: 34, height: 28, seed: 5, name: "Villa" }) as any;
    expect(Array.isArray(res.interiorMapIds)).toBe(true);
    expect(res.interiorMapIds.length).toBeGreaterThan(0);
    const pad = (n: number) => "Map" + String(n).padStart(3, "0") + ".json";
    const dests = (mapFile: any) => mapFile.events
      .filter((e: any) => e)
      .flatMap((e: any) => e.pages[0].list.filter((c: any) => c.code === 201).map((c: any) => c.parameters[1]));
    // Exterior has an action-button door transferring to each interior.
    const ext = dataFile(pad(res.mapId));
    for (const iid of res.interiorMapIds) expect(dests(ext)).toContain(iid);
    // Each interior exists, is registered, and warps back to the exterior.
    const mapInfos = dataFile("MapInfos.json");
    for (const iid of res.interiorMapIds) {
      expect(dests(dataFile(pad(iid)))).toContain(res.mapId);
      expect(mapInfos[iid].parentId).toBe(res.mapId);
    }
  });

  it("mode template fails gracefully when the template index is unavailable (dev runs from src/)", async () => {
    await expect(dispatchTool("generate_map", { mode: "template", templateId: 1, name: "T" })).rejects.toThrow(/Template/);
  });

  it("edit_map set_display_names writes the map file displayName (4.1.0 regression: edited MapInfos)", async () => {
    const result = await dispatchTool("edit_map", { action: "set_display_names", names: [{ mapId: 1, name: "Pueblo Inicial" }, { mapId: 999, name: "Nope" }] }) as any;
    expect(result.updated.length).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(dataFile("Map001.json").displayName).toBe("Pueblo Inicial");
  });

  it("edit_map connect creates a transfer event on both maps", async () => {
    const result = await dispatchTool("edit_map", {
      action: "connect", mapIdA: 1, mapIdB: generatedMapId,
      posA: { x: 0, y: 0 }, posB: { x: 1, y: 1 }
    }) as any;
    expect(result.eventA).toBeDefined();
    expect(result.eventB).toBeDefined();
  });
});

describe("autotile shapes (5.1.0: generators painted flat shape-0 tiles)", () => {
  const A2 = 2816; // A2 ground autotile, kind 16, shape 0

  it("an interior cell of a solid autotile block keeps shape 0; edges get borders", () => {
    const w = 5, h = 5;
    const data = new Array(w * h * 6).fill(0);
    for (let i = 0; i < w * h; i++) data[i] = A2; // fill ground layer with solid A2
    applyAutotileShapes(data, w, h);
    const at = (x: number, y: number) => data[y * w + x];
    // Center is fully surrounded (off-map counts as same too) -> interior shape 0.
    expect(autotileShape(at(2, 2))).toBe(0);
    // All cells stay the same A2 kind, only the shape changes.
    for (let i = 0; i < w * h; i++) expect(autotileKind(data[i])).toBe(16);
  });

  it("a one-tile A2 island surrounded by a different kind is shaped as an isolated piece", () => {
    const w = 3, h = 3;
    const data = new Array(w * h * 6).fill(0);
    for (let i = 0; i < w * h; i++) data[i] = 2816 + 48; // A2 kind 17 background
    data[1 * w + 1] = A2;                                 // single kind-16 tile in the middle
    applyAutotileShapes(data, w, h);
    // Isolated floor tile (no same-kind neighbour) is a non-interior shape.
    expect(autotileShape(data[1 * w + 1])).not.toBe(0);
  });

  it("reproduces the bundled reference maps: A1/A2/A3 near-exact (>=90%), A4 walls heuristic (>=65%)", () => {
    const dir = "knowledge/maps";
    let a13Total = 0, a13Match = 0, a4Total = 0, a4Match = 0;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      let m: any;
      try { m = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); } catch { continue; }
      if (!m?.data || !m.width) continue;
      const w = m.width, h = m.height;
      const orig = m.data.slice();
      const test = m.data.slice();
      applyAutotileShapes(test, w, h);
      for (let layer = 0; layer < 4; layer++) {
        const base = layer * w * h;
        for (let i = 0; i < w * h; i++) {
          const o = orig[base + i];
          if (o < 2048) continue;
          if (autotileKind(o) >= 80) { a4Total++; if (test[base + i] === o) a4Match++; }
          else { a13Total++; if (test[base + i] === o) a13Match++; }
        }
      }
    }
    expect(a13Total).toBeGreaterThan(10000);
    expect(a13Match / a13Total).toBeGreaterThan(0.90); // measured ~96%
    expect(a4Match / a4Total).toBeGreaterThan(0.65);   // A4 tall walls ~70% (heuristic)
  });

  it("generated maps no longer render ground as flat shape-0 (beach has shorelines)", async () => {
    const { generateTileLayoutV3 } = await import("../src/utils/mapGenerator.js");
    const m: any = generateTileLayoutV3(40, 30, "beach", { seed: 3, addEvents: false });
    const shapes = new Set<number>();
    for (let i = 0; i < m.width * m.height; i++) {
      const id = m.data[i];
      if (id >= 2048) shapes.add(autotileShape(id));
    }
    expect(shapes.size).toBeGreaterThan(3);
  });
});

describe("manage_system", () => {
  it("sets and reads the game title", async () => {
    await dispatchTool("manage_system", { action: "set_title", title: "Mi Juego" });
    const title = await dispatchTool("manage_system", { action: "get", section: "title" });
    expect(title).toBe("Mi Juego");
  });

  it("names a switch", async () => {
    const result = await dispatchTool("manage_system", { action: "name_switch", id: 7, name: "PuertaAbierta" }) as any;
    expect(result.name).toBe("PuertaAbierta");
    const switches = await dispatchTool("manage_system", { action: "get", section: "switches" }) as string[];
    expect(switches[7]).toBe("PuertaAbierta");
  });
});

describe("get_project_context", () => {
  it("detail summary counts data files", async () => {
    const summary = await dispatchTool("get_project_context", { detail: "summary" }) as any;
    expect(summary.gameTitle).toBe("Mi Juego");
    expect(summary.mapCount).toBeGreaterThanOrEqual(2);
  });

  it("detail templates returns the bundled template index (empty in src/ dev runs)", async () => {
    const templates = await dispatchTool("get_project_context", { detail: "templates" });
    expect(Array.isArray(templates)).toBe(true);
  });
});

describe("analyze_image", () => {
  it("mode grid measures a PNG offline", async () => {
    const png = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    const result = await dispatchTool("analyze_image", { mode: "grid", base64PNG: png.toString("base64") }) as any;
    expect(result.cols).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.totalTiles).toBe(4);
  });

  it("mode ai requires imagePath", async () => {
    await expect(dispatchTool("analyze_image", { mode: "ai" })).rejects.toThrow(/imagePath/);
  });
});

describe("legacy v4 aliases", () => {
  it("v4 tool names still dispatch", async () => {
    const skills = await dispatchTool("get_skills", {});
    expect(Array.isArray(skills)).toBe(true);
    const actors = await dispatchTool("get_actors", {});
    expect(Array.isArray(actors)).toBe(true);
  });

  it("v4 zod-validated names still validate", async () => {
    await expect(dispatchTool("create_npc", { x: 1, y: 1, name: "X", dialogues: [] })).rejects.toThrow(/Validation error/);
  });
});
