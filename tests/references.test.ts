import { describe, it, expect } from "vitest";
import { extractRefs, extractRefsFromMany, isEmptyRefSet } from "../src/intel/references.js";
import type { RawCommand } from "../src/intel/eventAst.js";

describe("extractRefs", () => {
  it("returns an empty set for empty input", () => {
    const refs = extractRefs([]);
    expect(isEmptyRefSet(refs)).toBe(true);
    expect(extractRefs(null).switches).toEqual([]);
  });

  it("captures switch ranges and self switches", () => {
    const refs = extractRefs([
      { code: 121, parameters: [3, 5, 0] },   // Control Switches 3..5 = ON
      { code: 123, parameters: ["A", 0] },    // Self Switch A
    ]);
    expect(refs.switches).toEqual([3, 4, 5]);
    expect(refs.selfSwitches).toEqual(["A"]);
  });

  it("captures variables including a variable operand", () => {
    const refs = extractRefs([
      { code: 122, parameters: [7, 7, 1, 1, 9] }, // Variable(7) += Variable(9)
    ]);
    expect(refs.variables).toEqual([7, 9]);
  });

  it("captures transfer map destinations but not variable-designated ones as maps", () => {
    const direct = extractRefs([{ code: 201, parameters: [0, 12, 5, 6, 0, 0] }]);
    expect(direct.maps).toEqual([12]);
    const byVar = extractRefs([{ code: 201, parameters: [1, 20, 21, 22, 0, 0] }]);
    expect(byVar.maps).toEqual([]);
    expect(byVar.variables).toEqual([20, 21, 22]);
  });

  it("captures conditional-branch dependencies by type", () => {
    expect(extractRefs([{ code: 111, parameters: [0, 8, 0] }]).switches).toEqual([8]);
    expect(extractRefs([{ code: 111, parameters: [8, 4] }]).items).toEqual([4]);
    expect(extractRefs([{ code: 111, parameters: [1, 2, 0, 10, 0] }]).variables).toEqual([2]);
  });

  it("captures common events, battles, shops and animations", () => {
    expect(extractRefs([{ code: 117, parameters: [6] }]).commonEvents).toEqual([6]);
    expect(extractRefs([{ code: 301, parameters: [0, 14] }]).troops).toEqual([14]);
    const shop = extractRefs([{ code: 302, parameters: [[[0, 3], [1, 2], [2, 5]]] }]);
    expect(shop.items).toEqual([3]);
    expect(shop.weapons).toEqual([2]);
    expect(shop.armors).toEqual([5]);
    expect(extractRefs([{ code: 212, parameters: [0, 0, 41] }]).animations).toEqual([41]);
  });

  it("captures audio and image asset names", () => {
    const refs = extractRefs([
      { code: 250, parameters: [{ name: "Cat", volume: 90, pitch: 100, pan: 0 }] },
      { code: 231, parameters: [1, "Castle", 0, 0, 0, 0, 100, 100, 255, 0] },
    ]);
    expect(refs.audio).toEqual(["Cat"]);
    expect(refs.images).toEqual(["Castle"]);
  });

  it("merges many lists and de-duplicates", () => {
    const refs = extractRefsFromMany([
      [{ code: 121, parameters: [1, 1, 0] }],
      [{ code: 121, parameters: [1, 2, 0] }],
    ]);
    expect(refs.switches).toEqual([1, 2]);
  });
});
