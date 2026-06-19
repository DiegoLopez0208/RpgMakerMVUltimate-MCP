import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readJson, writeJson, nextId, getDataPath, getMapPath } from "../src/utils/fileHandler.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-fh-test-"));
  mkdirSync(path.join(projectDir, "data"));
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("getDataPath", () => {
  it("constructs path within data directory", () => {
    const p = getDataPath(projectDir, "Actors.json");
    expect(p).toBe(path.join(projectDir, "data", "Actors.json"));
  });
});

describe("getMapPath", () => {
  it("formats map ID with zero-padding", () => {
    expect(getMapPath(projectDir, 1)).toBe(path.join(projectDir, "data", "Map001.json"));
    expect(getMapPath(projectDir, 42)).toBe(path.join(projectDir, "data", "Map042.json"));
  });
});

describe("readJson", () => {
  it("reads and parses JSON", async () => {
    writeFileSync(path.join(projectDir, "data", "Test.json"), "[null,{\"id\":1}]");
    const data = await readJson(projectDir, "Test.json");
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(2);
  });

  it("strips BOM before parsing", async () => {
    writeFileSync(path.join(projectDir, "data", "Bom.json"), "\uFEFF[null]");
    const data = await readJson(projectDir, "Bom.json");
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("writeJson", () => {
  it("writes JSON with backup", async () => {
    writeFileSync(path.join(projectDir, "data", "Backup.json"), "[null]");
    await writeJson(projectDir, "Backup.json", [null, { id: 1 }]);
    const content = readFileSync(path.join(projectDir, "data", "Backup.json"), "utf-8");
    expect(JSON.parse(content)).toEqual([null, { id: 1 }]);
  });
});

describe("nextId", () => {
  it("returns 1 for empty array", () => {
    expect(nextId([null])).toBe(1);
  });

  it("returns next slot after last entry", () => {
    expect(nextId([null, { id: 1 }, { id: 2 }])).toBe(3);
  });

  it("skips gaps and returns highest id + 1", () => {
    expect(nextId([null, { id: 1 }, null, { id: 3 }])).toBe(4);
  });
});
