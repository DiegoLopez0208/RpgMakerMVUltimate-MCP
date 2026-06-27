import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getProjectIndex, clearProjectIndexCache } from "../src/intel/projectIndex.js";

let dir: string;

function write(name: string, data: unknown): void {
  writeFileSync(path.join(dir, "data", name), JSON.stringify(data));
}

function event(id: number, x: number, y: number, list: unknown[], conditions?: unknown) {
  return {
    id, name: `Ev${id}`, x, y,
    pages: [{
      conditions: conditions ?? { switch1Valid: false, switch2Valid: false, variableValid: false, itemValid: false },
      list,
    }],
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rpgmv-index-"));
  mkdirSync(path.join(dir, "data"));

  const emptyDb = [null];
  for (const f of ["Actors.json", "Classes.json", "Skills.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "Tilesets.json", "Animations.json"]) {
    write(f, emptyDb);
  }
  write("Items.json", [null, { id: 1, name: "Potion" }, { id: 2, name: "Key" }]);
  write("Troops.json", [null, {
    id: 1, name: "Slime x2", members: [],
    pages: [{ list: [{ code: 121, indent: 0, parameters: [9, 9, 0] }, { code: 0, indent: 0, parameters: [] }] }],
  }]);
  write("CommonEvents.json", [null, {
    id: 1, name: "Heal", trigger: 0, switchId: 0,
    list: [{ code: 117, indent: 0, parameters: [1] }, { code: 121, indent: 0, parameters: [5, 5, 0] }],
  }]);
  write("System.json", {
    gameTitle: "IndexFixture", startMapId: 1, startX: 5, startY: 5,
    switches: ["", "GateOpen", "", "", "", "QuestDone"],
    variables: ["", "Gold", "PuzzleStep"],
  });
  write("MapInfos.json", [null,
    { id: 1, name: "Town", parentId: 0 },
    { id: 2, name: "Cave", parentId: 1 },
  ]);

  const mapBase = {
    width: 10, height: 10, tilesetId: 1, displayName: "", data: new Array(600).fill(0),
    encounterList: [{ troopId: 1, weight: 5 }], encounterStep: 30,
    bgm: { name: "", pan: 0, pitch: 100, volume: 90 }, bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
    autoplayBgm: false, autoplayBgs: false, disableDashing: false, note: "",
    parallaxLoopX: false, parallaxLoopY: false, parallaxName: "", parallaxShow: true,
    parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false,
    battleback1Name: "", battleback2Name: "",
  };

  write("Map001.json", {
    ...mapBase,
    events: [null,
      event(1, 3, 4, [
        { code: 111, indent: 0, parameters: [0, 1, 0] },   // If Switch(1 GateOpen)
        { code: 201, indent: 1, parameters: [0, 2, 5, 5, 0, 0] }, // Transfer → Map 2
        { code: 412, indent: 0, parameters: [] },
        { code: 117, indent: 0, parameters: [1] },          // Call Common Event 1
        { code: 0, indent: 0, parameters: [] },
      ]),
      // event whose page only appears when Switch(5 QuestDone) is ON
      event(2, 6, 6, [{ code: 0, indent: 0, parameters: [] }],
        { switch1Valid: true, switch1Id: 5, switch2Valid: false, variableValid: false, itemValid: false }),
    ],
  });

  write("Map002.json", {
    ...mapBase,
    events: [null,
      event(1, 5, 5, [
        { code: 122, indent: 0, parameters: [2, 2, 0, 0, 1] }, // Variable(2 PuzzleStep) = 1
        { code: 201, indent: 0, parameters: [0, 1, 3, 4, 0, 0] }, // Transfer back → Map 1
        { code: 0, indent: 0, parameters: [] },
      ]),
    ],
  });

  clearProjectIndexCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getProjectIndex", () => {
  it("indexes system metadata, switches and variables", async () => {
    const idx = await getProjectIndex(dir, true);
    expect(idx.gameTitle).toBe("IndexFixture");
    expect(idx.start).toEqual({ mapId: 1, x: 5, y: 5 });
    expect(idx.switches[1].name).toBe("GateOpen");
    expect(idx.counts.namedSwitches).toBe(2);
    expect(idx.counts.items).toBe(2);
  });

  it("indexes maps with events, refs and transfers", async () => {
    const idx = await getProjectIndex(dir);
    const town = idx.maps.find((m) => m.id === 1)!;
    expect(town.name).toBe("Town");
    expect(town.eventCount).toBe(2);
    expect(town.refs.switches).toContain(1);
    expect(town.refs.commonEvents).toContain(1);
    expect(town.transfers).toEqual([{ fromMap: 1, fromEvent: 1, toMap: 2, x: 5, y: 5 }]);
    expect(town.encounterTroops).toEqual([1]);
  });

  it("captures page appearance conditions", async () => {
    const idx = await getProjectIndex(dir);
    const town = idx.maps.find((m) => m.id === 1)!;
    const gated = town.events.find((e) => e.id === 2)!;
    expect(gated.conditionRefs.switches).toEqual([5]);
  });

  it("indexes common events and their refs", async () => {
    const idx = await getProjectIndex(dir);
    const heal = idx.commonEvents.find((c) => c.id === 1)!;
    expect(heal.name).toBe("Heal");
    expect(heal.refs.commonEvents).toEqual([1]);
    expect(heal.refs.switches).toEqual([5]);
  });

  it("collects ref sources across maps, common events and troops", async () => {
    const idx = await getProjectIndex(dir);
    const kinds = new Set(idx.refSources.map((s) => s.kind));
    expect(kinds.has("map-event")).toBe(true);
    expect(kinds.has("common-event")).toBe(true);
    expect(kinds.has("troop")).toBe(true);
    const troopSrc = idx.refSources.find((s) => s.kind === "troop")!;
    expect(troopSrc.refs.switches).toEqual([9]);
  });

  it("serves a cached index until force is passed", async () => {
    const a = await getProjectIndex(dir);
    const b = await getProjectIndex(dir);
    expect(b.builtAt).toBe(a.builtAt); // same cached object
    const c = await getProjectIndex(dir, true);
    expect(c.builtAt).toBeGreaterThanOrEqual(a.builtAt);
  });
});
