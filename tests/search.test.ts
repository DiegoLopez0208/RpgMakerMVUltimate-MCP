import { describe, it, expect } from "vitest";
import { rankDocuments, type SearchDoc } from "../src/intel/search.js";

const docs: SearchDoc[] = [
  { type: "event", id: 3, label: "Borin the Blacksmith", text: "I can forge you a fine sword.", mapId: 1 },
  { type: "event", id: 4, label: "Village Elder", text: "The dark forest to the north is dangerous.", mapId: 1 },
  { type: "map", id: 7, label: "Dark Forest", text: "", mapId: 7 },
  { type: "item", id: 2, label: "Iron Sword", text: "A blacksmith-forged blade." },
  { type: "event", id: 9, label: "Guard", text: "Move along, citizen." },
];

describe("rankDocuments", () => {
  it("finds 'the blacksmith' by label first, body second", () => {
    const hits = rankDocuments(docs, "the blacksmith");
    expect(hits[0].label).toBe("Borin the Blacksmith"); // label match beats body match
    expect(hits.map((h) => h.label)).toContain("Iron Sword"); // body mention also surfaces
    expect(hits.find((h) => h.label === "Guard")).toBeUndefined();
  });

  it("matches 'the dark forest' across a map and an NPC line", () => {
    const hits = rankDocuments(docs, "the dark forest");
    const labels = hits.map((h) => h.label);
    expect(labels).toContain("Dark Forest");
    expect(labels).toContain("Village Elder");
    // exact-name phrase match ranks the map at the top
    expect(hits[0].label).toBe("Dark Forest");
  });

  it("supports Spanish stopword-stripped queries", () => {
    const es: SearchDoc[] = [{ type: "event", id: 1, label: "El Herrero", text: "Te forjo una espada.", mapId: 1 }];
    const hits = rankDocuments(es, "el herrero");
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("El Herrero");
  });

  it("returns nothing for an all-stopword or empty query", () => {
    expect(rankDocuments(docs, "the of a")).toEqual([]);
    expect(rankDocuments(docs, "")).toEqual([]);
  });

  it("produces a snippet around the matched term", () => {
    const hits = rankDocuments(docs, "forest");
    const elder = hits.find((h) => h.label === "Village Elder")!;
    expect(elder.snippet.toLowerCase()).toContain("forest");
  });
});
