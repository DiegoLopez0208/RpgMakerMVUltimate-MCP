import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/toolDefinitions.js";
import { TOOL_PROFILES, parseToolset, profileOf } from "../src/toolProfiles.js";

// Every advertised schema is paid for in the client's context on every session.
// These limits make growth a decision: raising one belongs in a PR that says why.
// About 3.5 bytes per token, so 72 KB is roughly 20k tokens.
const TOTAL_BUDGET_BYTES = 72_000;
const PER_TOOL_BUDGET_BYTES = 16_000;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("tool list budget", () => {
  it(`keeps the default tool list under ${TOTAL_BUDGET_BYTES} bytes`, () => {
    expect(bytes(TOOL_DEFINITIONS)).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
  });

  it.each(TOOL_DEFINITIONS.map(tool => [tool.name, tool] as const))(`keeps %s under ${PER_TOOL_BUDGET_BYTES} bytes`, (_name, tool) => {
    expect(bytes(tool)).toBeLessThanOrEqual(PER_TOOL_BUDGET_BYTES);
  });
});

describe("tool profiles", () => {
  it("places every advertised tool in exactly one profile", () => {
    const placed = Object.values(TOOL_PROFILES).flat();
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(TOOL_DEFINITIONS.map(tool => tool.name).sort());
  });

  it("lists everything when unset or set to all", () => {
    expect(parseToolset(undefined)).toBeNull();
    expect(parseToolset("")).toBeNull();
    expect(parseToolset(" all ")).toBeNull();
    expect(parseToolset("events,all")).toBeNull();
  });

  it("always includes core and adds the requested profiles", () => {
    expect([...parseToolset("core")!].sort()).toEqual([...TOOL_PROFILES.core].sort());
    const set = parseToolset(" Events , media ")!;
    for (const tool of [...TOOL_PROFILES.core, ...TOOL_PROFILES.events, ...TOOL_PROFILES.media]) expect(set.has(tool)).toBe(true);
    expect(set.has("generate_map")).toBe(false);
  });

  it("refuses unknown profiles instead of silently hiding tools", () => {
    expect(() => parseToolset("events,maps")).toThrow(/maps/);
  });

  it("knows each tool's profile and ignores legacy names", () => {
    expect(profileOf("generate_map")).toBe("mapgen");
    expect(profileOf("insert_event_commands")).toBe("events");
    expect(profileOf("get_actors")).toBeUndefined();
  });

  it("shrinks the listing meaningfully for a data-only session", () => {
    const core = parseToolset("core")!;
    const coreBytes = bytes(TOOL_DEFINITIONS.filter(tool => core.has(tool.name)));
    expect(coreBytes).toBeLessThan(bytes(TOOL_DEFINITIONS) * 0.75);
  });
});
