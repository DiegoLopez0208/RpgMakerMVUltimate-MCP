import { describe, it, expect } from "vitest";
import {
  CreateMapSchema,
  CreateNpcSchema,
  AnalyzeScreenshotSchema,
  CreateDamageSkillSchema,
  CreateHealingSkillSchema,
  CreateBuffSkillSchema,
  CreateStateSkillSchema,
  RenderMapAsciiSchema,
} from "../src/utils/validation.js";

describe("validation schemas", () => {
  describe("CreateMapSchema", () => {
    it("accepts the camelCase args the create_map tool sends", () => {
      const result = CreateMapSchema.safeParse({
        name: "Test Map",
        width: 25,
        height: 20,
        tilesetId: 4,
        theme: "forest",
        bgmName: "Town1",
        displayName: "Bosque",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // Regression for <=4.1.0: zod stripped unknown (snake_case-mismatched) keys
        expect(result.data.tilesetId).toBe(4);
        expect(result.data.bgmName).toBe("Town1");
        expect(result.data.displayName).toBe("Bosque");
      }
    });

    it("does not require name and uses the documented defaults (17x13, tileset 1)", () => {
      const result = CreateMapSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.width).toBe(17);
        expect(result.data.height).toBe(13);
        expect(result.data.tilesetId).toBe(1);
      }
    });

    it("coerces numeric strings", () => {
      const result = CreateMapSchema.safeParse({ width: "30", height: "20" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.width).toBe(30);
        expect(result.data.height).toBe(20);
      }
    });

    it("rejects unknown themes", () => {
      expect(CreateMapSchema.safeParse({ theme: "moon" }).success).toBe(false);
    });
  });

  describe("CreateNpcSchema", () => {
    it("accepts the camelCase args the create_npc tool sends", () => {
      const result = CreateNpcSchema.safeParse({
        mapId: 1,
        x: 10,
        y: 5,
        name: "Guard",
        dialogues: ["Hello!", "Welcome!"],
        characterName: "People1",
        characterIndex: 3,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mapId).toBe(1);
        expect(result.data.characterName).toBe("People1");
      }
    });

    it("coerces a numeric-string mapId", () => {
      const result = CreateNpcSchema.safeParse({ mapId: "2", x: 0, y: 0, name: "NPC", dialogues: [] });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.mapId).toBe(2);
    });

    it("requires mapId, position, name and dialogues", () => {
      expect(CreateNpcSchema.safeParse({ x: 0, y: 0, name: "NPC", dialogues: [] }).success).toBe(false);
      expect(CreateNpcSchema.safeParse({ mapId: 1, x: 0, y: 0, dialogues: [] }).success).toBe(false);
      expect(CreateNpcSchema.safeParse({ mapId: 1, x: 0, y: 0, name: "NPC" }).success).toBe(false);
    });
  });

  describe("skill helper schemas", () => {
    it("create_damage_skill keeps mpCost and formula (regression for <=4.1.0 silent drop)", () => {
      const result = CreateDamageSkillSchema.safeParse({
        name: "Fireball",
        mpCost: 15,
        scope: 1,
        formula: "a.mat * 4 - b.mdf * 2",
        element: 2,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mpCost).toBe(15);
        expect(result.data.formula).toBe("a.mat * 4 - b.mdf * 2");
        expect(result.data.element).toBe(2);
      }
    });

    it("create_damage_skill rejects a missing formula", () => {
      expect(CreateDamageSkillSchema.safeParse({ name: "Hit", mpCost: 0, scope: 1 }).success).toBe(false);
    });

    it("create_healing_skill keeps its formula", () => {
      const result = CreateHealingSkillSchema.safeParse({ name: "Heal", mpCost: 8, scope: 7, formula: "a.mat * 3 + 100" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.formula).toBe("a.mat * 3 + 100");
    });

    it("create_buff_skill keeps paramId and turns", () => {
      const result = CreateBuffSkillSchema.safeParse({ name: "Protect", mpCost: 10, scope: 7, paramId: 3, turns: 5 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paramId).toBe(3);
        expect(result.data.turns).toBe(5);
      }
    });

    it("create_state_skill keeps stateId and chance, and bounds chance to 0-1", () => {
      const ok = CreateStateSkillSchema.safeParse({ name: "Poison", mpCost: 5, scope: 1, stateId: 4, chance: 0.8 });
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data.stateId).toBe(4);
        expect(ok.data.chance).toBe(0.8);
      }
      expect(CreateStateSkillSchema.safeParse({ name: "Poison", mpCost: 5, scope: 1, stateId: 4, chance: 80 }).success).toBe(false);
    });
  });

  describe("AnalyzeScreenshotSchema", () => {
    it("rejects path traversal", () => {
      expect(AnalyzeScreenshotSchema.safeParse({ image_path: "../../../etc/passwd" }).success).toBe(false);
    });

    it("accepts valid paths", () => {
      expect(AnalyzeScreenshotSchema.safeParse({ image_path: "img/tilesets/Outside.png" }).success).toBe(true);
    });
  });

  describe("RenderMapAsciiSchema", () => {
    it("matches the tool's snake_case contract and defaults", () => {
      const result = RenderMapAsciiSchema.safeParse({ map_id: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.map_id).toBe(3);
        expect(result.data.layer).toBe(0);
        expect(result.data.show_events).toBe(true);
      }
    });
  });
});
