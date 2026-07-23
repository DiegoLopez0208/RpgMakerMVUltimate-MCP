import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
// NOTE: imported from dist (not src) on purpose. Template loading resolves the
// knowledge/ dir relative to the compiled module, so these tests require a fresh
// `npm run build` (the town-clone test in integration.test.ts does the same).
import {
  scoreTemplate,
  loadTemplateIndex,
  THEME_CATEGORIES,
  THEME_TEMPLATE_THEMES,
  THEME_TILESET,
  TILESETS,
  generateTileLayoutV3,
  normalizeAvailableTiles,
  resolveTilesConfig,
} from "../dist/utils/mapGenerator.js";

type Meta = { id: number; category: string; theme: string; tilesetId: number; width: number; height: number };

const mapsDir = () => join(process.cwd(), "knowledge", "maps");

// Replicates the candidate selection inside cloneTemplateForTheme so we can
// assert the routing behaviour without the function being exported: pool =
// (category ∈ THEME_CATEGORIES[theme]) OR (theme tag ∈ THEME_TEMPLATE_THEMES[theme]),
// hard-filtered to the theme's tileset, then ranked by scoreTemplate.
function selectFor(idx: Meta[], theme: string, w: number, h: number) {
  const cats: string[] = THEME_CATEGORIES[theme] || [];
  const affinity: string[] = THEME_TEMPLATE_THEMES[theme] || [];
  let candidates = idx.filter((t) => cats.indexOf(t.category) >= 0 || affinity.indexOf(t.theme) >= 0);
  const ts = THEME_TILESET[theme] || 1;
  const sameTs = candidates.filter((t) => t.tilesetId === ts);
  if (sameTs.length > 0) candidates = sameTs;
  const ranked = candidates
    .map((t) => ({ t, score: scoreTemplate(t as never, w, h, theme, ts, affinity) }))
    .sort((a, b) => a.score - b.score);
  return { candidates, ranked, affinity, ts };
}

describe("mapGenerator template routing (Phase 2a)", () => {
  describe("scoreTemplate theme preference", () => {
    const base = { id: 1, category: "x", tilesetId: 2, width: 30, height: 25 };

    it("prefers an exact theme tag over an unrelated one", () => {
      const exact = { ...base, theme: "snow" };
      const other = { ...base, theme: "generic" };
      expect(scoreTemplate(exact as never, 30, 25, "snow", 2, ["snow"]))
        .toBeLessThan(scoreTemplate(other as never, 30, 25, "snow", 2, ["snow"]));
    });

    it("prefers an AFFINITY theme (volcano→lava) over an unrelated one, same geometry", () => {
      const lava = { ...base, theme: "lava" };
      const other = { ...base, theme: "generic" };
      // Isolate the affinity bonus: identical size/tileset, so only the theme differs.
      expect(scoreTemplate(lava as never, 30, 25, "volcano", 2, ["lava"]))
        .toBeLessThan(scoreTemplate(other as never, 30, 25, "volcano", 2, ["lava"]));
    });

    it("orders exact < affinity < none for otherwise-identical templates", () => {
      const exact = scoreTemplate({ ...base, theme: "forest" } as never, 30, 25, "forest", 2, ["forest", "dark"]);
      const affin = scoreTemplate({ ...base, theme: "dark" } as never, 30, 25, "forest", 2, ["forest", "dark"]);
      const none = scoreTemplate({ ...base, theme: "generic" } as never, 30, 25, "forest", 2, ["forest", "dark"]);
      expect(exact).toBeLessThan(affin);
      expect(affin).toBeLessThan(none);
    });
  });

  describe("affinity map wiring", () => {
    it("aliases the mismatched request themes to the real template tags", () => {
      expect(THEME_TEMPLATE_THEMES.snow).toContain("snow");
      expect(THEME_TEMPLATE_THEMES.volcano).toContain("lava");
      expect(THEME_TEMPLATE_THEMES.ruins).toContain("dark");
      expect(THEME_TEMPLATE_THEMES.magic_forest).toContain("forest");
    });
  });

  describe("selection against the real 106-template index", () => {
    it("makes snow templates reachable and top-ranked (regression: they were unreachable via ['exterior'])", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      expect(idx.length).toBeGreaterThan(0); // requires a built dist/knowledge
      // Before the fix: snow → categories ['exterior'], and NO snow template is
      // filed under 'exterior', so the pool never contained one.
      const byCategoryOnly = idx.filter((t) => (THEME_CATEGORIES.snow || []).includes(t.category) && t.tilesetId === THEME_TILESET.snow);
      expect(byCategoryOnly.some((t) => t.theme === "snow")).toBe(false);
      // After the fix: the affinity pool includes real snow templates and ranks one first.
      const { candidates, ranked } = selectFor(idx, "snow", 40, 30);
      expect(candidates.some((t) => t.theme === "snow")).toBe(true);
      expect(ranked[0].t.theme).toBe("snow");
    });

    it("makes ruins reach the 'dark' templates that ['exterior'] alone missed", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      const { candidates } = selectFor(idx, "ruins", 30, 25);
      expect(candidates.some((t) => t.theme === "dark")).toBe(true);
    });

    it("keeps volcano reaching the lava template and now prefers it", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      const { candidates, ranked } = selectFor(idx, "volcano", 20, 15);
      expect(candidates.some((t) => t.theme === "lava")).toBe(true);
      expect(ranked[0].t.theme).toBe("lava");
    });
  });

  describe("derived templates (Phase 2a authoring: beach/harbor/sewer)", () => {
    it("beach/harbor/sewer now have real themed templates in the index", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      for (const theme of ["beach", "harbor", "sewer"]) {
        expect(idx.some((t) => t.theme === theme)).toBe(true);
      }
    });

    it("a beach request reaches a beach template and ranks it first", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      const { candidates, ranked } = selectFor(idx, "beach", 40, 30);
      expect(candidates.some((t) => t.theme === "beach")).toBe(true);
      expect(ranked[0].t.theme).toBe("beach");
    });

    it("beach templates have sand ground (A2 kind 32), not grass (kind 16)", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      const beach = idx.find((t) => t.theme === "beach")!;
      const raw = readFileSync(join(mapsDir(), "Map" + beach.id + ".json"), "utf8");
      const m = JSON.parse(raw) as { data: number[] };
      const kindOf = (id: number) => Math.floor((id - 2048) / 48);
      let sand = 0, grass = 0;
      for (const t of m.data) {
        if (t >= 2816 && t < 4352) {
          if (kindOf(t) === 32) sand++;
          if (kindOf(t) === 16) grass++;
        }
      }
      expect(sand).toBeGreaterThan(50);
      expect(grass).toBe(0); // the grass→sand remap left no grass behind
    });

    it("sewer reaches its (wet-cave) template", async () => {
      const idx = (await loadTemplateIndex()) as unknown as Meta[];
      const { candidates } = selectFor(idx, "sewer", 30, 25);
      expect(candidates.some((t) => t.theme === "sewer")).toBe(true);
    });
  });

  describe("adaptive tile IDs (Phase 2b)", () => {
    it("normalizeAvailableTiles extracts tileId from assetTools objects and passes numbers through", () => {
      const n = normalizeAvailableTiles({ ground: [{ tileId: 2816, kind: 0 }], decoration: [100, { tileId: 101 }] });
      expect(n).toBeTruthy();
      expect(n!.ground).toEqual([2816]);
      expect(n!.decoration).toEqual([100, 101]);
      expect(n!.water).toEqual([]); // missing roles normalize to empty arrays
    });

    it("does NOT write object tiles when availableTiles arrives as {tileId} objects (corruption regression)", async () => {
      // Before Phase 2b this wrote {tileId,kind} objects into the tile array on
      // custom (no-stamp) tilesets, corrupting the map.
      const avail = { ground: [{ tileId: 2816, kind: 0 }], water: [{ tileId: 2048, kind: 0 }], decoration: [{ tileId: 100 }, { tileId: 101 }] };
      const m = await generateTileLayoutV3(20, 15, "forest", { seed: 1, addEvents: false, useTemplate: false, tilesetId: 999, availableTiles: avail } as never) as { data: number[] };
      expect(m.data.every((t) => typeof t === "number" && Number.isInteger(t))).toBe(true);
    });

    it("resolveTilesConfig leaves an RTP-valid config unchanged (no regression)", () => {
      const outside = TILESETS.outside;
      const rtp = { ground: [outside.grass, outside.dirt], water: [outside.water], wallSide: [outside.wallSide], wallTop: [outside.wallTop], roof: [outside.roof], decoration: [] };
      const resolved = resolveTilesConfig(outside, rtp);
      expect(resolved.grass).toBe(outside.grass);
      expect(resolved.water).toBe(outside.water);
      expect(resolved.wallSide).toBe(outside.wallSide);
      expect(resolved.wallTop).toBe(outside.wallTop);
    });

    it("resolveTilesConfig repairs structural roles whose hardcoded ID is absent from the project's tileset", () => {
      const outside = TILESETS.outside;
      const custom = { ground: [7777], water: [8888], wallSide: [6600], wallTop: [6601], roof: [], decoration: [] };
      const repaired = resolveTilesConfig(outside, custom);
      expect(repaired.grass).toBe(7777);   // invalid RTP grass id → real scanned ground
      expect(repaired.water).toBe(8888);
      expect(repaired.wallSide).toBe(6600);
      expect(repaired.wallTop).toBe(6601);
    });

    it("resolveTilesConfig with no scanned tiles returns the base config (identity)", () => {
      expect(resolveTilesConfig(TILESETS.dungeon, undefined)).toBe(TILESETS.dungeon);
    });
  });

  describe("end-to-end clone", () => {
    it("snow generation clones a real template (overlay building/decoration tiles present, all tile IDs valid)", async () => {
      const m = await generateTileLayoutV3(40, 30, "snow", { seed: 11, addEvents: false, tilesetId: 2 } as never) as { data: number[] };
      // B/C/D/E overlay tiles occupy ids 1..1535 and only appear in hand-authored
      // templates; a blank procedural fallback would have almost none.
      let overlay = 0;
      for (const t of m.data) if (t > 0 && t < 1536) overlay++;
      expect(overlay).toBeGreaterThan(20);
      // Every tile ID must be within the engine's valid range (0..8191).
      expect(m.data.every((t) => t >= 0 && t < 8192)).toBe(true);
    });
  });
});
