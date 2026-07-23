import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { playtest, openInEditor } from "../src/tools/runTools.js";

// These tests exercise validation/location logic only — they never actually spawn
// the engine (no install is provided and the project is deliberately incomplete),
// so no game window or editor is launched during the suite.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rpgmv-run-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("playtest (Phase: run)", () => {
  it("rejects a directory that is not a runnable MV project", async () => {
    // No index.html / package.json.
    await expect(playtest(dir, { install: dir })).rejects.toThrow(/Not a runnable MV project/);
  });

  it("requires an active project path", async () => {
    await expect(playtest("", { install: dir })).rejects.toThrow(/requires an active project path/);
  });

  it("errors clearly when the nwjs runtime is missing from the install", async () => {
    // Make it look like a runnable project, but point install at an empty dir.
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "index.html" }));
    const emptyInstall = mkdtempSync(path.join(tmpdir(), "rpgmv-install-"));
    try {
      await expect(playtest(dir, { install: emptyInstall })).rejects.toThrow(/No nwjs runtime found/);
    } finally {
      rmSync(emptyInstall, { recursive: true, force: true });
    }
  });
});

describe("openInEditor (Phase: run)", () => {
  it("errors clearly when the editor exe is missing from the install", async () => {
    const emptyInstall = mkdtempSync(path.join(tmpdir(), "rpgmv-install-"));
    try {
      await expect(openInEditor(dir, { install: emptyInstall })).rejects.toThrow(/Editor not found/);
    } finally {
      rmSync(emptyInstall, { recursive: true, force: true });
    }
  });

  it("requires an active project path", async () => {
    await expect(openInEditor("", { install: dir })).rejects.toThrow(/requires an active project path/);
  });
});
