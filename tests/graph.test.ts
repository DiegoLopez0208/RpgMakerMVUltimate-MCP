import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getProjectIndex, clearProjectIndexCache, type ProjectIndex } from "../src/intel/projectIndex.js";
import { explainSwitch, reachableMaps, unreachableMaps, whatBreaksIfMapRemoved, findUsage } from "../src/intel/graph.js";

let dir: string;
let index: ProjectIndex;

function write(name: string, data: unknown): void {
  writeFileSync(path.join(dir, "data", name), JSON.stringify(data));
}

const mapBase = {
  width: 10, height: 10, tilesetId: 1, displayName: "", data: new Array(600).fill(0),
  encounterList: [], encounterStep: 30,
  bgm: { name: "", pan: 0, pitch: 100, volume: 90 }, bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
  autoplayBgm: false, autoplayBgs: false, disableDashing: false, note: "",
  parallaxLoopX: false, parallaxLoopY: false, parallaxName: "", parallaxShow: true,
  parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false,
  battleback1Name: "", battleback2Name: "",
};

function ev(id: number, list: unknown[]) {
  return { id, name: `Ev${id}`, x: 5, y: 5, pages: [{ conditions: { switch1Valid: false, switch2Valid: false, variableValid: false, itemValid: false }, list }] };
}
const transfer = (toMap: number) => ({ code: 201, indent: 0, parameters: [0, toMap, 5, 5, 0, 0] });
const end = { code: 0, indent: 0, parameters: [] };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rpgmv-graph-"));
  mkdirSync(path.join(dir, "data"));
  const emptyDb = [null];
  for (const f of ["Actors.json", "Classes.json", "Skills.json", "Items.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "Troops.json", "Tilesets.json", "Animations.json"]) {
    write(f, emptyDb);
  }
  write("CommonEvents.json", [null, {
    id: 1, name: "Checker", trigger: 0, switchId: 0,
    list: [{ code: 111, indent: 0, parameters: [0, 3, 0] }, { code: 412, indent: 0, parameters: [] }, end], // reads Switch(3 Used)
  }]);
  write("System.json", {
    gameTitle: "Graph", startMapId: 1, startX: 5, startY: 5,
    switches: ["", "GateOpen", "DeadWrite", "Used", "ScriptGate"],
    variables: ["", "Counter"],
  });
  write("MapInfos.json", [null,
    { id: 1, name: "Town", parentId: 0 },
    { id: 2, name: "Cave", parentId: 1 },
    { id: 3, name: "Secret", parentId: 1 },
    { id: 4, name: "Deep", parentId: 2 },
  ]);
  write("Map001.json", { ...mapBase, events: [null, ev(1, [
    { code: 111, indent: 0, parameters: [0, 1, 0] },  // If Switch(1 GateOpen)
    transfer(2),                                       // → Map 2
    { code: 412, indent: 0, parameters: [] },
    { code: 121, indent: 0, parameters: [2, 2, 0] },  // Set Switch(2 DeadWrite) ON  (never read)
    { code: 121, indent: 0, parameters: [3, 3, 0] },  // Set Switch(3 Used) ON
    end,
  ])] });
  write("Map002.json", { ...mapBase, events: [null, ev(1, [transfer(1), transfer(4), end])] });
  // Switch 4 (ScriptGate) is set ONLY from a Script command and read by a
  // conditional — before Phase 4 the script setter was invisible, so it looked
  // "never set". (Map003 has no transfers, so connectivity assertions are unaffected.)
  write("Map003.json", { ...mapBase, events: [null, ev(1, [
    { code: 355, indent: 0, parameters: ["$gameSwitches.setValue(4, true);"] }, // SCRIPT-only setter
    { code: 111, indent: 0, parameters: [0, 4, 0] },                            // If Switch(4 ScriptGate)
    { code: 412, indent: 0, parameters: [] },
    end,
  ])] });
  write("Map004.json", { ...mapBase, events: [null, ev(1, [transfer(2), end])] });

  clearProjectIndexCache();
  index = await getProjectIndex(dir, true);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("explainSwitch", () => {
  it("flags a switch that is read/gated but never set ON", () => {
    const r = explainSwitch(index, 1);
    expect(r.setters).toHaveLength(0);
    expect(r.readers.length).toBeGreaterThan(0);
    expect(r.diagnosis).toMatch(/NEVER set ON/);
  });

  it("flags a dead write (set but never read)", () => {
    const r = explainSwitch(index, 2);
    expect(r.setters.length).toBeGreaterThan(0);
    expect(r.readers).toHaveLength(0);
    expect(r.diagnosis).toMatch(/dead write/);
  });

  it("reports a normal set-and-read switch", () => {
    const r = explainSwitch(index, 3);
    expect(r.setters.length).toBeGreaterThan(0);
    expect(r.readers.length).toBeGreaterThan(0);
    expect(r.diagnosis).toMatch(/set in .* and read in/);
  });

  it("Phase 4: a switch set ONLY via a Script command is not reported as never-set", () => {
    const r = explainSwitch(index, 4);
    expect(r.setters.length).toBeGreaterThan(0);       // the $gameSwitches.setValue(4,…) is now detected
    expect(r.diagnosis).not.toMatch(/NEVER set ON/);
  });
});

describe("findUsage", () => {
  it("locates the conditional that gates on GateOpen", () => {
    const hits = findUsage(index, "switches", 1);
    expect(hits.some((h) => h.mapId === 1 && h.eventId === 1 && h.role === "read")).toBe(true);
  });
});

describe("map connectivity", () => {
  it("computes reachable maps from the start map", () => {
    expect(reachableMaps(index, 1)).toEqual([1, 2, 4]);
  });

  it("reports maps unreachable from the start map", () => {
    expect(unreachableMaps(index)).toEqual([{ id: 3, name: "Secret" }]);
  });

  it("reasons about what a map deletion would strand", () => {
    const impact = whatBreaksIfMapRemoved(index, 2);
    expect(impact.incomingTransfers.map((t) => t.fromMap).sort()).toEqual([1, 4]);
    expect(impact.newlyUnreachable).toEqual([{ id: 4, name: "Deep" }]);
    expect(impact.isStartMap).toBe(false);
  });
});
