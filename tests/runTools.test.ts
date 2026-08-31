import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { playtest, openInEditor } from "../src/tools/runTools.js";

// One test needs to see the options playtest spawns with, without launching a
// game. vi.hoisted keeps the recorder reachable from the hoisted mock factory.
const { spawnCalls } = vi.hoisted(() => ({
  spawnCalls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
}));

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, opts });
    return { pid: 4242, unref: () => {} };
  },
}));

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

  it("launches the game FROM the project directory", async () => {
    // The bridge plugin falls back to process.cwd() to find the project root,
    // because recent NW.js serves index.html from a chrome-extension origin
    // that says nothing about where the project lives. Inheriting the MCP
    // server's directory instead would send it looking for the handshake file
    // somewhere else entirely.
    spawnCalls.length = 0;
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "index.html" }));
    const install = mkdtempSync(path.join(tmpdir(), "rpgmv-install-"));
    mkdirSync(path.join(install, "nwjs-win-test"));
    writeFileSync(path.join(install, "nwjs-win-test", "game.exe"), "");
    try {
      const result = await playtest(dir, { install });
      expect(result.launched).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].opts.cwd).toBe(dir);
      expect(spawnCalls[0].args).toEqual([dir, "test"]);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
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
