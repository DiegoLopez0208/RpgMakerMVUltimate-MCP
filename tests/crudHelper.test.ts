import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createCrud } from "../src/utils/crudHelper.js";
import { NotFoundError } from "../src/utils/errors.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

interface TestEntry {
  id: number;
  name: string;
  value: number;
}

function testFactory(id: number): TestEntry {
  return { id, name: "", value: 0 };
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "rpgmv-crud-test-"));
  mkdirSync(path.join(projectDir, "data"));
  writeFileSync(path.join(projectDir, "data", "Test.json"), "[null]");
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("createCrud", () => {
  it("getAll returns empty array for empty db", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    const all = await crud.getAll(projectDir);
    expect(all).toEqual([]);
  });

  it("create assigns next id", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    const entry = await crud.create(projectDir, (id) => ({ ...testFactory(id), name: "First" }));
    expect(entry.id).toBe(1);
  });

  it("getById returns null for missing entry", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    const found = await crud.getById(projectDir, 99);
    expect(found).toBeNull();
  });

  it("update throws NotFoundError for missing id", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    await expect(crud.update(projectDir, 99, { name: "X" })).rejects.toThrow(NotFoundError);
  });

  it("delete throws NotFoundError for missing id", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    await expect(crud.delete(projectDir, 99)).rejects.toThrow(NotFoundError);
  });

  it("search finds by name", async () => {
    const crud = createCrud<TestEntry>("Test.json", testFactory);
    await crud.create(projectDir, (id) => ({ ...testFactory(id), name: "Alpha" }));
    await crud.create(projectDir, (id) => ({ ...testFactory(id), name: "Beta" }));
    const results = await crud.search(projectDir, "alp");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Alpha");
  });

  it("fillEngineDefaults adds missing fields", async () => {
    interface ActorLike extends TestEntry {
      classId?: number;
      initialLevel?: number;
    }
    writeFileSync(path.join(projectDir, "data", "Actors.json"), "[null]");
    const actorFactory = (id: number): ActorLike => ({ id, name: "Hero" });
    const crud = createCrud<ActorLike>("Actors.json", actorFactory);
    const entry = await crud.create(projectDir, actorFactory);
    expect(entry.classId).toBe(1);
    expect(entry.initialLevel).toBe(1);
  });
});
