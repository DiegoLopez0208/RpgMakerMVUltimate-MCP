import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createPlugin } from "../src/tools/pluginTools.js";

let projectDir: string;
const pluginFile = (name: string) => path.join(projectDir, "js", "plugins", name + ".js");
const manifest = () => readFileSync(path.join(projectDir, "js", "plugins.js"), "utf-8");
// Reuse the engine's own parse: pull the [...] out of js/plugins.js.
const parseManifest = () => {
  const src = manifest();
  return JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
};

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-plugin-test-"));
  mkdirSync(path.join(projectDir, "data"), { recursive: true });
  mkdirSync(path.join(projectDir, "js", "plugins"), { recursive: true });
  // Seed an existing manifest to verify append + load order.
  writeFileSync(
    path.join(projectDir, "js", "plugins.js"),
    'var $plugins =\n' + JSON.stringify([{ name: "Community_Basic", status: true, description: "", parameters: {} }], null, 4) + ";\n"
  );
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe("createPlugin (Phase 3c)", () => {
  it("writes js/plugins/<name>.js with a valid @plugindesc/@author/@param header", async () => {
    const res = await createPlugin(projectDir, {
      name: "DoubleXP",
      description: "Doubles battle EXP",
      author: "Diego",
      help: "Grants 2x EXP.\nToggle with the switch.",
      params: [{ name: "Multiplier", type: "number", desc: "EXP multiplier", default: 2 }],
    });
    expect(res.registered).toBe(true);
    expect(existsSync(pluginFile("DoubleXP"))).toBe(true);
    const src = readFileSync(pluginFile("DoubleXP"), "utf-8");
    expect(src).toMatch(/\/\*:/);
    expect(src).toContain("@plugindesc Doubles battle EXP");
    expect(src).toContain("@author Diego");
    expect(src).toContain("@param Multiplier");
    expect(src).toContain("@type number");
    expect(src).toContain("@default 2");
    expect(src).toContain("PluginManager.parameters(\"DoubleXP\")");
  });

  it("registers the plugin in js/plugins.js preserving load order and param defaults", async () => {
    await createPlugin(projectDir, {
      name: "DoubleXP",
      params: [{ name: "Multiplier", default: 2 }],
    });
    const entries = parseManifest();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["Community_Basic", "DoubleXP"]); // appended last = loads last
    const mine = entries.find((e: { name: string }) => e.name === "DoubleXP");
    expect(mine.status).toBe(true);
    expect(mine.parameters.Multiplier).toBe("2"); // manifest values are always strings
  });

  it("wires a classic-MV pluginCommand hook when commands are declared", async () => {
    await createPlugin(projectDir, { name: "DoorCtl", commands: ["openDoor", "closeDoor"] });
    const src = readFileSync(pluginFile("DoorCtl"), "utf-8");
    expect(src).toContain("@command openDoor");
    expect(src).toContain("Game_Interpreter.prototype.pluginCommand");
    expect(src).toContain('"openDoor"');
  });

  it("is idempotent: re-authoring replaces the file and manifest entry in place", async () => {
    await createPlugin(projectDir, { name: "DoubleXP", description: "v1" });
    const res2 = await createPlugin(projectDir, { name: "DoubleXP", description: "v2" });
    expect(res2.replaced).toBe(true);
    const entries = parseManifest();
    expect(entries.filter((e: { name: string }) => e.name === "DoubleXP").length).toBe(1); // no duplicate
    expect(entries.find((e: { name: string }) => e.name === "DoubleXP").description).toBe("v2");
    expect(readFileSync(pluginFile("DoubleXP"), "utf-8")).toContain("@plugindesc v2");
  });

  it("can disable the plugin via status:false", async () => {
    await createPlugin(projectDir, { name: "WIP", status: false });
    const mine = parseManifest().find((e: { name: string }) => e.name === "WIP");
    expect(mine.status).toBe(false);
  });

  it("rejects a name with path separators or an extension (traversal guard)", async () => {
    await expect(createPlugin(projectDir, { name: "../evil" })).rejects.toThrow(/Invalid plugin name/);
    await expect(createPlugin(projectDir, { name: "foo/bar" })).rejects.toThrow(/Invalid plugin name/);
    await expect(createPlugin(projectDir, { name: "foo.js" })).rejects.toThrow(/Invalid plugin name/);
  });

  it("creates a fresh manifest when js/plugins.js does not exist yet", async () => {
    rmSync(path.join(projectDir, "js", "plugins.js"));
    await createPlugin(projectDir, { name: "First" });
    const entries = parseManifest();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("First");
  });
});
