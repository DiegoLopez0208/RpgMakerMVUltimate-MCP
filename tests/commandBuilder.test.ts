import { describe, it, expect } from "vitest";
import { cmd } from "../src/utils/commandBuilder.js";

describe("commandBuilder", () => {
  const assertValidCommand = (result: unknown) => {
    expect(result).toBeDefined();
  };

  describe("message", () => {
    it("should create show text commands", () => {
      const result = cmd.message("Hello", "Actor1", 0);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].code).toBe(101);
    });
  });

  describe("choice", () => {
    it("should create show choices command", () => {
      const result = cmd.choice(["Yes", "No"], 2);
      expect(result[0].code).toBe(102);
    });
  });

  describe("giveItem", () => {
    it("should create change items command", () => {
      const result = cmd.giveItem(1, 1);
      expect(result[0].code).toBe(126);
    });
  });

  describe("giveWeapon", () => {
    it("should create change weapons command", () => {
      const result = cmd.giveWeapon(1, 1);
      expect(result[0].code).toBe(127);
    });
  });

  describe("giveArmor", () => {
    it("should create change armors command", () => {
      const result = cmd.giveArmor(1, 1);
      expect(result[0].code).toBe(128);
    });
  });

  describe("giveMoney", () => {
    it("should create change gold command", () => {
      const result = cmd.giveMoney(100);
      expect(result[0].code).toBe(125);
    });
  });

  describe("teleport", () => {
    it("should create transfer player command", () => {
      const result = cmd.teleport(5, 10, 15, 2, 0);
      expect(result[0].code).toBe(201);
    });
  });

  describe("battleProcessing", () => {
    it("should create battle processing command", () => {
      const result = cmd.battleProcessing(1, false, false);
      expect(result[0].code).toBe(301);
    });
  });

  describe("switchControl", () => {
    it("should create control switches command", () => {
      const result = cmd.switchControl(5, true);
      expect(result[0].code).toBe(121);
    });
  });

  describe("variableControl", () => {
    it("should create control variables command", () => {
      const result = cmd.variableControl(10, 0, 42);
      expect(result[0].code).toBe(122);
    });
  });

  describe("showAnimation", () => {
    it("should create show animation command", () => {
      const result = cmd.showAnimation(1, 5);
      expect(result[0].code).toBe(212);
    });
  });

  describe("comment", () => {
    it("should create comment command with correct code", () => {
      const result = cmd.comment("test");
      expect(result[0].code).toBe(108);
    });
  });

  describe("pluginCommand", () => {
    it("should create plugin command", () => {
      const result = cmd.pluginCommand("Test");
      expect(result[0].code).toBe(356);
    });
  });

  describe("shopProcessing", () => {
    it("should create shop processing command", () => {
      const result = cmd.shopProcessing([[1, 0, 0, 100]]);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("playBGM", () => {
    it("should create play BGM command", () => {
      const result = cmd.playBGM("Field1", 90, 100, 0);
      expect(result).toBeDefined();
    });
  });
});
