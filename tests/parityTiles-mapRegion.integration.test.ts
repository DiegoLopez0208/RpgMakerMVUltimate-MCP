// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getMapRegion,
  resizeMap,
  deleteMapEvent,
  eventReferenceWarnings,
  blankMapData,
  tileIndex,
  mapToolDefinitions,
} from '../src/parity/tools/mapTools.js';
import { MapData, MapEvent, EventPage } from '../src/parity/utils/types.js';

/** A minimal event page carrying a given command list. */
function pageWith(list: { code: number; indent: number; parameters: unknown[] }[]): EventPage {
  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: 'A',
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { characterName: '', characterIndex: 0, direction: 2, pattern: 0, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
  };
}

function event(id: number, x: number, y: number, pages: EventPage[]): MapEvent {
  return { id, name: `E${id}`, note: '', x, y, pages };
}

/** Scaffold a project with a single Map001.json + optional System.json overrides. */
async function scaffold(map: MapData, system: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-region-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), JSON.stringify(system));
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));
  return dir;
}

describe('get_map includeData', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffold(blankMapData(5, 4, 1));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('omits the data array and reports dataTileCount when includeData is false', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'get_map')!;
    const result = (await def.handler({ projectPath: dir }, { mapId: 1, includeData: false })) as {
      data?: number[];
      dataTileCount: number;
      width: number;
    };
    expect(result.data).toBeUndefined();
    expect(result.dataTileCount).toBe(5 * 4 * 6);
    expect(result.width).toBe(5);
  });

  it('returns the full data array by default (backward compat)', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'get_map')!;
    const result = (await def.handler({ projectPath: dir }, { mapId: 1 })) as MapData;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBe(5 * 4 * 6);
  });
});

describe('getMapRegion', () => {
  let dir: string;

  // A 5x4 map. Seed layer 0 with decodable ids: id = 100 + y*10 + x at each cell.
  beforeEach(async () => {
    const map = blankMapData(5, 4, 1);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        map.data[tileIndex(5, 4, x, y, 0)] = 100 + y * 10 + x;
      }
    }
    // Also put a marker on layer 2 to prove the layer arg is honored.
    map.data[tileIndex(5, 4, 1, 1, 2)] = 777;
    dir = await scaffold(map);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a window as a rows×cols grid of raw tile ids (default layer 0)', async () => {
    const result = await getMapRegion(dir, 1, 1, 1, 3, 2);
    expect(result).toMatchObject({ mapId: 1, x: 1, y: 1, width: 3, height: 2, layer: 0 });
    expect(result.tiles).toEqual([
      [111, 112, 113],
      [121, 122, 123],
    ]);
  });

  it('honors the layer argument', async () => {
    const result = await getMapRegion(dir, 1, 1, 1, 1, 1, 2);
    expect(result.tiles).toEqual([[777]]);
  });

  it('throws when the rectangle runs off the map', async () => {
    await expect(getMapRegion(dir, 1, 3, 0, 3, 1)).rejects.toThrow(/out of bounds/);
    await expect(getMapRegion(dir, 1, 0, 3, 1, 2)).rejects.toThrow(/out of bounds/);
  });
});

describe('resizeMap start-position warning', () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('warns when shrinking the start map pushes the start position out of bounds', async () => {
    dir = await scaffold(blankMapData(17, 13, 1), { startMapId: 1, startX: 15, startY: 3 });
    const result = await resizeMap(dir, 1, 10, 10);
    expect(result.warnings?.some((w) => /Start position/.test(w))).toBe(true);
  });

  it('does not warn when the start position still fits', async () => {
    dir = await scaffold(blankMapData(17, 13, 1), { startMapId: 1, startX: 2, startY: 2 });
    const result = await resizeMap(dir, 1, 10, 10);
    expect(result.warnings).toBeUndefined();
  });

  it('does not warn for a map that is not the start map', async () => {
    dir = await scaffold(blankMapData(17, 13, 1), { startMapId: 2, startX: 15, startY: 3 });
    const result = await resizeMap(dir, 1, 10, 10);
    expect(result.warnings).toBeUndefined();
  });
});

describe('eventReferenceWarnings', () => {
  it('flags Set Event Location / Show Animation / Show Balloon / Movement Route referencing the deleted id', () => {
    const events: (MapEvent | null)[] = [
      null,
      event(1, 0, 0, [pageWith([{ code: 0, indent: 0, parameters: [] }])]), // the deleted one
      event(2, 1, 1, [pageWith([{ code: 203, indent: 0, parameters: [1, 5, 5] }])]),
      event(3, 2, 2, [pageWith([{ code: 212, indent: 0, parameters: [1, 4, false] }])]),
      event(4, 3, 3, [pageWith([{ code: 213, indent: 0, parameters: [1, 2, false] }])]),
      event(5, 4, 4, [pageWith([{ code: 205, indent: 0, parameters: [1, {}] }])]),
    ];
    const warnings = eventReferenceWarnings(events, 1);
    expect(warnings).toHaveLength(4);
    expect(warnings.join(' ')).toMatch(/Set Event Location/);
    expect(warnings.join(' ')).toMatch(/Show Animation/);
    expect(warnings.join(' ')).toMatch(/Show Balloon/);
    expect(warnings.join(' ')).toMatch(/Set Movement Route/);
  });

  it('ignores player (-1) and this-event (0) character ids, and unrelated ids', () => {
    const events: (MapEvent | null)[] = [
      null,
      event(1, 0, 0, [pageWith([{ code: 0, indent: 0, parameters: [] }])]),
      event(2, 1, 1, [pageWith([{ code: 212, indent: 0, parameters: [-1, 4, false] }])]), // player
      event(3, 2, 2, [pageWith([{ code: 213, indent: 0, parameters: [0, 2, false] }])]), // this event
      event(4, 3, 3, [pageWith([{ code: 212, indent: 0, parameters: [9, 4, false] }])]), // other id
    ];
    expect(eventReferenceWarnings(events, 1)).toHaveLength(0);
  });
});

describe('deleteMapEvent reference warnings (integration)', () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns warnings when another event references the deleted one', async () => {
    const map = blankMapData(10, 10, 1);
    map.events = [
      null,
      event(1, 0, 0, [pageWith([{ code: 0, indent: 0, parameters: [] }])]),
      event(2, 1, 1, [pageWith([{ code: 212, indent: 0, parameters: [1, 4, false] }])]),
    ];
    dir = await scaffold(map);
    const result = await deleteMapEvent(dir, 1, 1);
    expect(result.success).toBe(true);
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings![0]).toMatch(/Show Animation/);
  });

  it('returns a bare success when nothing references the deleted event', async () => {
    const map = blankMapData(10, 10, 1);
    map.events = [
      null,
      event(1, 0, 0, [pageWith([{ code: 0, indent: 0, parameters: [] }])]),
      event(2, 1, 1, [pageWith([{ code: 0, indent: 0, parameters: [] }])]),
    ];
    dir = await scaffold(map);
    const result = await deleteMapEvent(dir, 1, 1);
    expect(result).toEqual({ success: true });
  });
});
