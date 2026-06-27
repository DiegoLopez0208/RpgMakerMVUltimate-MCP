import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getProjectIndex, clearProjectIndexCache, type ProjectIndex } from "../src/intel/projectIndex.js";
import { validateProject } from "../src/intel/validate.js";

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
const end = { code: 0, indent: 0, parameters: [] };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rpgmv-validate-"));
  mkdirSync(path.join(dir, "data"));
  const emptyDb = [null];
  for (const f of ["Actors.json", "Classes.json", "Skills.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "Troops.json", "Tilesets.json", "Animations.json"]) {
    write(f, emptyDb);
  }
  write("Items.json", [null, { id: 1, name: "Potion" }]);
  write("CommonEvents.json", [null]); // no common events at all → calling CE 9 is dangling
  write("System.json", {
    gameTitle: "Validate", startMapId: 1, startX: 5, startY: 5,
    switches: ["", "GhostSwitch"],     // named but unused
    variables: ["", ""],
  });
  // Map 2 is listed but its file is intentionally missing.
  write("MapInfos.json", [null,
    { id: 1, name: "Town", parentId: 0 },
    { id: 2, name: "Ghost", parentId: 1 },
  ]);
  write("Map001.json", { ...mapBase, events: [null, ev(1, [
    { code: 201, indent: 0, parameters: [0, 7, 5, 5, 0, 0] }, // transfer to non-existent map 7
    { code: 117, indent: 0, parameters: [9] },                // call non-existent common event 9
    { code: 126, indent: 0, parameters: [3, 0, 0, 1] },       // change item 3 (does not exist)
    end,
  ])] });

  clearProjectIndexCache();
  index = await getProjectIndex(dir, true);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateProject", () => {
  it("detects a broken transfer to a non-existent map", () => {
    const r = validateProject(index);
    expect(r.issues.some((i) => i.category === "broken-transfer" && i.message.includes("map 7"))).toBe(true);
  });

  it("detects a missing map file listed in MapInfos", () => {
    const r = validateProject(index);
    expect(r.issues.some((i) => i.category === "missing-map" && i.mapId === 2)).toBe(true);
  });

  it("detects dangling common-event and item references", () => {
    const r = validateProject(index);
    expect(r.issues.some((i) => i.category === "dangling-ref" && i.entity === "common_events" && i.id === 9)).toBe(true);
    expect(r.issues.some((i) => i.category === "dangling-ref" && i.entity === "items" && i.id === 3)).toBe(true);
  });

  it("warns about a named-but-unused switch", () => {
    const r = validateProject(index);
    expect(r.issues.some((i) => i.category === "unused-switch" && i.id === 1)).toBe(true);
  });

  it("summarises issues by severity", () => {
    const r = validateProject(index);
    expect(r.issueCount).toBe(r.issues.length);
    expect(r.bySeverity.error).toBeGreaterThan(0);
    expect(r.bySeverity.warning).toBeGreaterThan(0);
  });
});
