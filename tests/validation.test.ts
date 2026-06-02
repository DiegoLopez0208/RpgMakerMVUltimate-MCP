import { describe, it, expect } from "vitest";
import { CreateMapSchema, CreateNpcSchema, AnalyzeScreenshotSchema, CreateSkillSchema } from "../src/utils/validation.js";

describe("validation schemas", () => {
  describe("CreateMapSchema", () => {
    it("should validate valid map creation params", () => {
      const result = CreateMapSchema.safeParse({
        name: "Test Map",
        width: 25,
        height: 20,
        tileset_id: 1,
        theme: "forest",
      });
      expect(result.success).toBe(true);
    });

    it("should reject name > 100 chars", () => {
      const result = CreateMapSchema.safeParse({
        name: "x".repeat(101),
        width: 25,
        height: 20,
      });
      expect(result.success).toBe(false);
    });

    it("should use defaults for missing fields", () => {
      const result = CreateMapSchema.safeParse({ name: "Test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.width).toBe(25);
        expect(result.data.height).toBe(20);
        expect(result.data.tileset_id).toBe(1);
        expect(result.data.scroll_type).toBe(0);
      }
    });
  });

  describe("CreateNpcSchema", () => {
    it("should validate valid NPC creation params", () => {
      const result = CreateNpcSchema.safeParse({
        map_id: 1,
        x: 10,
        y: 5,
        name: "Guard",
        dialogues: ["Hello!", "Welcome!"],
      });
      expect(result.success).toBe(true);
    });

    it("should default dialogues to empty array", () => {
      const result = CreateNpcSchema.safeParse({
        map_id: 1,
        x: 0,
        y: 0,
        name: "NPC",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dialogues).toEqual([]);
      }
    });
  });

  describe("AnalyzeScreenshotSchema", () => {
    it("should reject path traversal", () => {
      const result = AnalyzeScreenshotSchema.safeParse({
        image_path: "../../../etc/passwd",
      });
      expect(result.success).toBe(false);
    });

    it("should accept valid paths", () => {
      const result = AnalyzeScreenshotSchema.safeParse({
        image_path: "img/tilesets/Outside.png",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("CreateSkillSchema", () => {
    it("should validate skill creation with defaults", () => {
      const result = CreateSkillSchema.safeParse({
        name: "Fireball",
        mp_cost: 15,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scope).toBe(1);
        expect(result.data.damage_formula).toBe("a.atk * 4 - b.def * 2");
      }
    });
  });
});
