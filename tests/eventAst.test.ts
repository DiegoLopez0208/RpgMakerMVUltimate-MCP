import { describe, it, expect } from "vitest";
import { parseEventCommands, astToOutline } from "../src/intel/eventAst.js";
import type { RawCommand } from "../src/intel/eventAst.js";

// A realistic 2-page-style NPC body: greeting, a conditional with an else that
// nests a Show Choices, then a common event call.
const npcBody: RawCommand[] = [
  { code: 101, indent: 0, parameters: ["Actor1", 0, 0, 2] },
  { code: 401, indent: 0, parameters: ["Hello, traveler!"] },
  { code: 401, indent: 0, parameters: ["Welcome to town."] },
  { code: 111, indent: 0, parameters: [0, 5, 0] },            // If Switch(5) == ON
  { code: 101, indent: 1, parameters: ["", 0, 0, 2] },
  { code: 401, indent: 1, parameters: ["The gate is already open."] },
  { code: 411, indent: 0, parameters: [] },                   // Else
  { code: 102, indent: 1, parameters: [["Yes", "No"], 1] },   // Show Choices
  { code: 402, indent: 1, parameters: [0, "Yes"] },           // When "Yes"
  { code: 121, indent: 2, parameters: [5, 5, 0] },            // Set Switch(5) = ON
  { code: 201, indent: 2, parameters: [0, 3, 10, 12, 0, 0] }, // Transfer → Map 3
  { code: 402, indent: 1, parameters: [1, "No"] },            // When "No"
  { code: 101, indent: 2, parameters: ["", 0, 0, 2] },
  { code: 401, indent: 2, parameters: ["Maybe later."] },
  { code: 404, indent: 1, parameters: [] },                   // End Choices
  { code: 412, indent: 0, parameters: [] },                   // End Branch
  { code: 117, indent: 0, parameters: [4] },                  // Call Common Event 4
  { code: 0, indent: 0, parameters: [] },
];

describe("parseEventCommands", () => {
  it("returns an empty array for empty / missing input", () => {
    expect(parseEventCommands([])).toEqual([]);
    expect(parseEventCommands(null)).toEqual([]);
    expect(parseEventCommands(undefined)).toEqual([]);
  });

  it("folds 401 text continuation into the Show Text node", () => {
    const ast = parseEventCommands(npcBody);
    const showText = ast[0];
    expect(showText.code).toBe(101);
    expect(showText.text).toBe("Hello, traveler!\nWelcome to town.");
  });

  it("builds then/else sections for a conditional branch", () => {
    const ast = parseEventCommands(npcBody);
    const cond = ast.find((n) => n.code === 111)!;
    expect(cond).toBeDefined();
    expect(cond.summary).toBe("If Switch(5) == ON");
    expect(cond.sections).toHaveLength(2);
    expect(cond.sections![0].label).toBe("then");
    expect(cond.sections![0].children[0].code).toBe(101);
    expect(cond.sections![1].label).toBe("else");
  });

  it("nests Show Choices with one section per choice", () => {
    const ast = parseEventCommands(npcBody);
    const cond = ast.find((n) => n.code === 111)!;
    const choices = cond.sections![1].children.find((n) => n.code === 102)!;
    expect(choices.summary).toBe("Show Choices [Yes, No]");
    expect(choices.sections).toHaveLength(2);
    expect(choices.sections![0].label).toBe('when "Yes"');
    // "Yes" branch sets the switch and transfers
    const yesCodes = choices.sections![0].children.map((n) => n.code);
    expect(yesCodes).toEqual([121, 201]);
    expect(choices.sections![1].label).toBe('when "No"');
  });

  it("keeps the conditional and the common-event call as siblings at top level", () => {
    const ast = parseEventCommands(npcBody);
    const topCodes = ast.map((n) => n.code);
    expect(topCodes).toEqual([101, 111, 117, 0]);
    const call = ast.find((n) => n.code === 117)!;
    expect(call.summary).toBe("Call Common Event 4");
  });

  it("parses a Loop with a Break inside and consumes Repeat Above", () => {
    const loop: RawCommand[] = [
      { code: 112, indent: 0, parameters: [] },     // Loop
      { code: 121, indent: 1, parameters: [1, 1, 0] },
      { code: 113, indent: 1, parameters: [] },     // Break Loop
      { code: 413, indent: 0, parameters: [] },     // Repeat Above
      { code: 0, indent: 0, parameters: [] },
    ];
    const ast = parseEventCommands(loop);
    expect(ast.map((n) => n.code)).toEqual([112, 0]);
    expect(ast[0].children!.map((n) => n.code)).toEqual([121, 113]);
  });

  it("decodes Control Variables semantics", () => {
    const ast = parseEventCommands([
      { code: 122, indent: 0, parameters: [3, 3, 1, 0, 10] }, // Variable(3) += 10
    ]);
    expect(ast[0].summary).toBe("Variable(3) += 10");
  });

  it("renders a readable outline", () => {
    const outline = astToOutline(parseEventCommands(npcBody));
    expect(outline).toContain("If Switch(5) == ON");
    expect(outline).toContain("else:");
    expect(outline).toContain('when "Yes":');
    expect(outline).toContain("Call Common Event 4");
  });
});
