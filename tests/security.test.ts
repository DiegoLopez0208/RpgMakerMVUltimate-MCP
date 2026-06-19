import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveSafePath, SecurityError, validateProjectExists } from "../src/utils/security.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

let projectDir: string;

beforeAll(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-security-test-"));
  mkdirSync(path.join(projectDir, "data"));
  writeFileSync(path.join(projectDir, "data", "System.json"), JSON.stringify({}));
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("resolveSafePath", () => {
  it("allows normal paths within project", () => {
    expect(resolveSafePath(projectDir, "data", "Actors.json")).toBe(path.join(projectDir, "data", "Actors.json"));
  });

  it("blocks path traversal with ../", () => {
    expect(() => resolveSafePath(projectDir, "..", "etc", "passwd")).toThrow(SecurityError);
  });

  it("blocks path traversal in filename", () => {
    expect(() => resolveSafePath(projectDir, "data", "../../etc/passwd")).toThrow(SecurityError);
  });

  it("allows exact base path", () => {
    expect(resolveSafePath(projectDir)).toBe(projectDir);
  });
});

describe("validateProjectExists", () => {
  it("succeeds for valid project", () => {
    expect(() => validateProjectExists(projectDir)).not.toThrow();
  });

  it("throws for non-existent path", () => {
    expect(() => validateProjectExists("/nonexistent/path")).toThrow(/does not exist/);
  });

  it("throws for path without data/ folder", () => {
    const noDataDir = mkdtempSync(path.join(tmpdir(), "rpgmv-nodata-"));
    expect(() => validateProjectExists(noDataDir)).toThrow(/no data\/ folder/);
    rmSync(noDataDir, { recursive: true, force: true });
  });
});
