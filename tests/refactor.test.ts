import { describe, it, expect } from "vitest";
import { detectDuplicates, type RefactorSource } from "../src/intel/refactor.js";
import type { RawCommand } from "../src/intel/eventAst.js";

// A shared "heal + thanks" block copy-pasted into two NPCs, plus unique tails.
const healBlock: RawCommand[] = [
  { code: 311, indent: 0, parameters: [0, 1, 0, 0, 999, false] }, // recover HP
  { code: 312, indent: 0, parameters: [0, 1, 0, 0, 999, false] }, // recover MP
  { code: 250, indent: 0, parameters: [{ name: "Heal", volume: 90, pitch: 100, pan: 0 }] },
  { code: 101, indent: 0, parameters: ["", 0, 0, 2] },
  { code: 401, indent: 0, parameters: ["You are healed!"] },
];

function npc(switchId: number): RawCommand[] {
  return [
    ...healBlock,
    { code: 121, indent: 0, parameters: [switchId, switchId, 0] }, // diverges immediately
    { code: 0, indent: 0, parameters: [] },
  ];
}

describe("detectDuplicates", () => {
  it("finds a command run shared by two events", () => {
    const sources: RefactorSource[] = [
      { label: "Map 1 / event 3 (Priest)", commands: npc(10) },
      { label: "Map 4 / event 1 (Nurse)", commands: npc(11) },
    ];
    const report = detectDuplicates(sources, 4);
    expect(report.blockCount).toBe(1);
    const block = report.duplicateBlocks[0];
    expect(block.length).toBe(healBlock.length); // extended to the full shared run
    expect(block.occurrences.map((o) => o.label).sort()).toEqual(["Map 1 / event 3 (Priest)", "Map 4 / event 1 (Nurse)"]);
    expect(block.suggestion).toMatch(/Common Event/);
  });

  it("reports nothing when there is no duplication", () => {
    const report = detectDuplicates([
      { label: "A", commands: [{ code: 121, parameters: [1, 1, 0] }, { code: 201, parameters: [0, 2, 3, 4, 0, 0] }, { code: 0, parameters: [] }] },
      { label: "B", commands: [{ code: 122, parameters: [5, 5, 0, 0, 1] }, { code: 117, parameters: [3] }, { code: 0, parameters: [] }] },
    ], 4);
    expect(report.blockCount).toBe(0);
  });

  it("ignores a trivial single-command repetition (row of identical waits)", () => {
    const waits: RawCommand[] = Array.from({ length: 6 }, () => ({ code: 230, parameters: [10] }));
    const report = detectDuplicates([
      { label: "A", commands: waits },
      { label: "B", commands: waits },
    ], 4);
    expect(report.blockCount).toBe(0);
  });

  it("does not double-report overlapping windows of the same block", () => {
    const sources: RefactorSource[] = [
      { label: "A", commands: npc(10) },
      { label: "B", commands: npc(11) },
    ];
    // A 5-command shared run yields multiple 4-grams; only one block should surface.
    expect(detectDuplicates(sources, 4).duplicateBlocks).toHaveLength(1);
  });
});
