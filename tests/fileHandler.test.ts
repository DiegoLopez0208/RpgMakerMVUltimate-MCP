import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import {
  readJson, writeJson, nextId, getDataPath, getMapPath,
  safeWrite, setDryRun, isDryRun, getDryRunLog,
} from "../src/utils/fileHandler.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
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

describe("safeWrite atomicity & backups", () => {
  const backupsDir = () => path.join(projectDir, ".mcp-backups");
  const target = () => path.join(projectDir, "data", "Atomic.json");

  it("writes content and leaves no .tmp scratch file behind", async () => {
    await safeWrite(target(), JSON.stringify({ ok: true }));
    expect(JSON.parse(readFileSync(target(), "utf-8"))).toEqual({ ok: true });
    expect(existsSync(target() + ".tmp")).toBe(false);
  });

  it("keeps the legacy single-level .bak for compatibility", async () => {
    writeFileSync(target(), '{"v":1}');
    await safeWrite(target(), '{"v":2}');
    expect(JSON.parse(readFileSync(target() + ".bak", "utf-8"))).toEqual({ v: 1 });
  });

  it("creates timestamped backups under .mcp-backups for the file", async () => {
    writeFileSync(target(), '{"v":0}');
    await safeWrite(target(), '{"v":1}');
    const backups = readdirSync(backupsDir()).filter(f => f.startsWith("Atomic.") && f.endsWith(".json"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // A backup holds the PRE-write version, so v:0 must be recoverable.
    const restored = JSON.parse(readFileSync(path.join(backupsDir(), backups[0]), "utf-8"));
    expect(restored).toEqual({ v: 0 });
  });

  it("does not back up a file that does not exist yet (first write)", async () => {
    await safeWrite(target(), '{"first":true}');
    // No prior file to protect → no timestamped backup, no legacy .bak.
    expect(existsSync(backupsDir())).toBe(false);
    expect(existsSync(target() + ".bak")).toBe(false);
  });

  it("prunes timestamped backups to at most RPGMV_BACKUP_KEEP (default 10)", async () => {
    writeFileSync(target(), '{"seed":true}');
    for (let i = 0; i < 15; i++) {
      await safeWrite(target(), JSON.stringify({ v: i }));
      await new Promise(r => setTimeout(r, 2)); // spread timestamps for distinct filenames
    }
    const backups = readdirSync(backupsDir()).filter(f => f.startsWith("Atomic.") && f.endsWith(".json"));
    expect(backups.length).toBeLessThanOrEqual(10);
    expect(backups.length).toBeGreaterThan(0);
    // Latest write must be the live content.
    expect(JSON.parse(readFileSync(target(), "utf-8"))).toEqual({ v: 14 });
  });
});

describe("dry-run mode", () => {
  afterEach(() => setDryRun(false)); // never leak the module-global flag between tests

  it("records intent without touching disk", async () => {
    const target = path.join(projectDir, "data", "Dry.json");
    writeFileSync(target, '{"original":true}');
    setDryRun(true);
    expect(isDryRun()).toBe(true);
    await safeWrite(target, '{"changed":true}');
    // File is unchanged...
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ original: true });
    // ...but the intended write is logged.
    const log = getDryRunLog();
    expect(log.length).toBe(1);
    expect(log[0].filePath).toBe(target);
    expect(log[0].bytes).toBeGreaterThan(0);
  });

  it("writeJson also respects dry-run", async () => {
    writeFileSync(path.join(projectDir, "data", "DryJson.json"), "[null]");
    setDryRun(true);
    await writeJson(projectDir, "DryJson.json", [null, { id: 99 }]);
    expect(JSON.parse(readFileSync(path.join(projectDir, "data", "DryJson.json"), "utf-8"))).toEqual([null]);
  });

  it("resumes real writes after dry-run is turned off", async () => {
    const target = path.join(projectDir, "data", "Resume.json");
    setDryRun(true);
    await safeWrite(target, '{"skipped":true}');
    expect(existsSync(target)).toBe(false);
    setDryRun(false);
    expect(getDryRunLog().length).toBe(0); // reset clears the log
    await safeWrite(target, '{"written":true}');
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ written: true });
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
