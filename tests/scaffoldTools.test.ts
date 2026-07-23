import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { scaffoldProject } from "../src/tools/scaffoldTools.js";

let tmp: string;
let source: string; // a fake NewData blank project

function makeBlankProject(dir: string) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  mkdirSync(path.join(dir, "img", "characters"), { recursive: true });
  mkdirSync(path.join(dir, "js", "plugins"), { recursive: true });
  writeFileSync(path.join(dir, "data", "System.json"), JSON.stringify({ gameTitle: "", startMapId: 1, startX: 0, startY: 0 }));
  writeFileSync(path.join(dir, "data", "Actors.json"), JSON.stringify([null, { id: 1, name: "Hero" }]));
  writeFileSync(path.join(dir, "js", "plugins.js"), "var $plugins = [];\n");
  writeFileSync(path.join(dir, "img", "characters", "Actor1.png"), "PNGDATA");
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "rpgmv-scaffold-test-"));
  source = path.join(tmp, "NewData");
  makeBlankProject(source);
  delete process.env.RPGMAKER_MV_INSTALL;
});

afterEach(() => {
  delete process.env.RPGMAKER_MV_INSTALL;
  rmSync(tmp, { recursive: true, force: true });
});

describe("scaffoldProject (Phase 3a)", () => {
  it("clones the blank project tree and rewrites title + start position", async () => {
    const dest = path.join(tmp, "MyGame");
    const res = await scaffoldProject("", { destPath: dest, sourcePath: source, title: "My Game", startMapId: 2, startX: 8, startY: 6 });
    expect(res.created).toBe(dest);
    // Whole tree copied (data + img + js).
    expect(existsSync(path.join(dest, "data", "System.json"))).toBe(true);
    expect(existsSync(path.join(dest, "data", "Actors.json"))).toBe(true);
    expect(existsSync(path.join(dest, "img", "characters", "Actor1.png"))).toBe(true);
    expect(existsSync(path.join(dest, "js", "plugins.js"))).toBe(true);
    // System.json rewritten.
    const sys = JSON.parse(readFileSync(path.join(dest, "data", "System.json"), "utf-8"));
    expect(sys.gameTitle).toBe("My Game");
    expect(sys.startMapId).toBe(2);
    expect(sys.startX).toBe(8);
    expect(sys.startY).toBe(6);
  });

  it("leaves System.json fields untouched when not provided", async () => {
    const dest = path.join(tmp, "Plain");
    await scaffoldProject("", { destPath: dest, sourcePath: source });
    const sys = JSON.parse(readFileSync(path.join(dest, "data", "System.json"), "utf-8"));
    expect(sys.startMapId).toBe(1); // original default preserved
  });

  it("refuses to overwrite a directory that already holds a project", async () => {
    const dest = path.join(tmp, "Existing");
    makeBlankProject(dest); // dest already has data/System.json
    await expect(scaffoldProject("", { destPath: dest, sourcePath: source })).rejects.toThrow(/already contains/);
  });

  it("errors clearly when the source is not a valid blank project", async () => {
    await expect(scaffoldProject("", { destPath: path.join(tmp, "X"), sourcePath: path.join(tmp, "nope") }))
      .rejects.toThrow(/Blank project not found/);
  });

  it("requires destPath", async () => {
    await expect(scaffoldProject("", { destPath: "", sourcePath: source })).rejects.toThrow(/requires destPath/);
  });

  it("falls back to the RPGMAKER_MV_INSTALL env var when sourcePath is omitted", async () => {
    process.env.RPGMAKER_MV_INSTALL = tmp; // env install root; source = <install>/NewData
    const dest = path.join(tmp, "FromEnv");
    const res = await scaffoldProject("", { destPath: dest, title: "Env Game" });
    expect(res.source).toBe(source);
    expect(existsSync(path.join(dest, "data", "System.json"))).toBe(true);
  });
});
