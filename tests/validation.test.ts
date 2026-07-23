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
  validateConsolidated,
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

  describe("validateConsolidated (Phase 1b)", () => {
    it("is a no-op for read-only / unschema'd tools", () => {
      expect(() => validateConsolidated("query_database", { entity: "actors" })).not.toThrow();
      expect(() => validateConsolidated("analyze_project", { view: "overview" })).not.toThrow();
    });

    it("accepts a well-formed create_database_entry with valid effects/damage", () => {
      expect(() => validateConsolidated("create_database_entry", {
        entity: "skills",
        data: {
          name: "Fireball",
          damage: { type: 1, elementId: 2, formula: "a.mat * 4 - b.mdf * 2" },
          effects: [{ code: 21, dataId: 4, value1: 1 }], // ADD_STATE
        },
      })).not.toThrow();
    });

    it("rejects an unknown effect code", () => {
      expect(() => validateConsolidated("create_database_entry", {
        entity: "skills",
        data: { name: "Bad", effects: [{ code: 999, dataId: 1 }] },
      })).toThrow(/effect code/i);
    });

    it("rejects a damage type out of range", () => {
      expect(() => validateConsolidated("create_database_entry", {
        entity: "items",
        data: { name: "Bad", damage: { type: 9, formula: "1" } },
      })).toThrow(/Validation error/);
    });

    it("rejects an unknown trait code", () => {
      expect(() => validateConsolidated("create_database_entry", {
        entity: "actors",
        data: { name: "Hero", traits: [{ code: 99, dataId: 1, value: 1 }] },
      })).toThrow(/trait code/i);
    });

    it("requires either entity or preset for create", () => {
      expect(() => validateConsolidated("create_database_entry", { data: { name: "x" } })).toThrow(/entity.*preset/i);
      expect(() => validateConsolidated("create_database_entry", { preset: "damage_skill", data: {} })).not.toThrow();
    });

    it("accepts every real MV database as an entity (verb-support is the router's job)", () => {
      for (const entity of ["animations", "tilesets", "troops"]) {
        expect(() => validateConsolidated("delete_database_entry", { entity, id: 1 })).not.toThrow();
      }
      expect(() => validateConsolidated("delete_database_entry", { entity: "foobar", id: 1 })).toThrow(/Validation error/);
    });

    it("validates update_database_entry appendCommand as an event command", () => {
      expect(() => validateConsolidated("update_database_entry", {
        entity: "common_events", id: 1, appendCommand: { code: 101, indent: 0, parameters: ["", 0, 0, 2] },
      })).not.toThrow();
      expect(() => validateConsolidated("update_database_entry", {
        entity: "common_events", id: 1, appendCommand: { code: "not-a-number" },
      })).toThrow(/Validation error/);
    });

    it("edit_map fill_layer bounds the layer to 0-5", () => {
      expect(() => validateConsolidated("edit_map", { action: "fill_layer", mapId: 1, layer: 3, tileId: 0 })).not.toThrow();
      expect(() => validateConsolidated("edit_map", { action: "fill_layer", mapId: 1, layer: 9, tileId: 0 })).toThrow(/layer/);
    });

    it("edit_map rejects an unknown action", () => {
      expect(() => validateConsolidated("edit_map", { action: "nuke_everything" })).toThrow(/Validation error/);
    });

    it("manage_map_event bounds trigger to 0-4 and validates a command", () => {
      expect(() => validateConsolidated("manage_map_event", { action: "create", mapId: 1, trigger: 3 })).not.toThrow();
      expect(() => validateConsolidated("manage_map_event", { action: "create", mapId: 1, trigger: 7 })).toThrow(/trigger/);
      expect(() => validateConsolidated("manage_map_event", {
        action: "add_command", mapId: 1, eventId: 1, command: { code: 0.5 },
      })).toThrow(/Validation error/);
    });

    it("manage_map_event requires mapId", () => {
      expect(() => validateConsolidated("manage_map_event", { action: "create" })).toThrow(/Validation error/);
    });

    it("manage_system rejects an unknown action", () => {
      expect(() => validateConsolidated("manage_system", { action: "delete_everything" })).toThrow(/Validation error/);
      expect(() => validateConsolidated("manage_system", { action: "set_title", title: "My Game" })).not.toThrow();
    });

    it("accepts numeric-string ids without coercing them away", () => {
      expect(() => validateConsolidated("delete_database_entry", { entity: "actors", id: "3" })).not.toThrow();
      expect(() => validateConsolidated("edit_map", { action: "fill_layer", mapId: "1", layer: "0", tileId: "0" })).not.toThrow();
    });
  });
});
