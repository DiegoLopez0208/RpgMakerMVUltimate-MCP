import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { knowledgeDir, knowledgePath } from "../src/utils/knowledgePath.js";
import { generateFromTemplate, loadTemplateIndex } from "../src/utils/mapGenerator.js";
import { getStamps, hasStamps } from "../src/utils/stamps.js";
import { loadIndex, loadMapData, getTemplatesDir } from "../src/knowledge/mapTemplates.js";

// Issue #15 root cause: knowledge/ was resolved with a single hardcoded relative
// path that only matched the built layout (dist/utils -> ../knowledge). Loaded
// from src/utils that resolved to src/knowledge, which holds only .ts modules —
// so every template lookup silently returned null and the entire
// generate_map mode:"template" write path shipped with no test touching it.
describe("knowledge/ resolution (issue #15)", () => {
  it("resolves a directory that actually holds the bundled knowledge files", () => {
    const dir = knowledgeDir();
    expect(existsSync(path.join(dir, "map-templates.json"))).toBe(true);
    expect(existsSync(path.join(dir, "maps"))).toBe(true);
    expect(existsSync(path.join(dir, "stamps.json"))).toBe(true);
  });

  it("memoises to a stable absolute path", () => {
    expect(path.isAbsolute(knowledgeDir())).toBe(true);
    expect(knowledgeDir()).toBe(knowledgeDir());
    expect(knowledgePath("maps", "Map007.json")).toBe(path.join(knowledgeDir(), "maps", "Map007.json"));
  });

  it("loads the full template index from src/ (was []: the silent failure)", async () => {
    const idx = await loadTemplateIndex();
    expect(idx.length).toBe(111);
  });

  it("loads template map data from src/ (was null for every id)", async () => {
    for (const [id, w, h] of [[1, 17, 13], [7, 40, 40], [33, 19, 15]] as const) {
      const r = await generateFromTemplate(id) as { data: number[]; width: number; height: number } | null;
      expect(r, "template " + id).not.toBeNull();
      expect(r!.width).toBe(w);
      expect(r!.height).toBe(h);
      expect(r!.data.length).toBe(w * h * 6);
    }
  });

  it("still returns null for an id with no bundled file", async () => {
    expect(await generateFromTemplate(9999)).toBeNull();
  });

  it("stamps load through the same resolver", () => {
    expect(hasStamps(2, "house")).toBe(true);
    expect(getStamps(2, "tree").length).toBeGreaterThan(0);
  });

  it("knowledge/mapTemplates.ts resolves the same directory", async () => {
    expect(getTemplatesDir()).toBe(knowledgePath("maps"));
    expect((await loadIndex()).length).toBe(111);
    const m = await loadMapData(33) as { tilesetId: number } | null;
    expect(m).not.toBeNull();
    expect(m!.tilesetId).toBe(3);
  });
});
