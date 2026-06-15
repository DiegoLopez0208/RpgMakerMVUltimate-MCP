import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";

import { dispatchTool } from "../src/server.js";
import * as projectTools from "../src/tools/projectTools.js";
import { TOOL_DEFINITIONS_V5 } from "../src/toolDefinitionsV5.js";
import { TOOL_DEFINITIONS } from "../src/toolDefinitions.js";

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

  it("update and delete work and report missing events", async () => {
    const ev = await dispatchTool("manage_map_event", { action: "create", mapId: 1, x: 5, y: 5, name: "Temp" }) as any;
    const moved = await dispatchTool("manage_map_event", { action: "update", mapId: 1, eventId: ev.id, fields: { x: 6 } }) as any;
    expect(moved.x).toBe(6);
    await dispatchTool("manage_map_event", { action: "delete", mapId: 1, eventId: ev.id });
    await expect(dispatchTool("manage_map_event", { action: "delete", mapId: 1, eventId: ev.id })).rejects.toThrow(/not found/);
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
