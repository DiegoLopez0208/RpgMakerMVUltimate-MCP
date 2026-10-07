import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';
import { generatedMapIds, mapWalkReport, withWalkReport } from '../src/tools/walkability.js';

const W = 10, H = 8;
const FLOOR = 10;   // flags 0: walkable
const WALL = 11;    // flags 0x0f: blocked from every side
const WALL_X = 5;   // a wall column splits the map into a 5-wide west part and a 4-wide east part
const dirs: string[] = [];
let project: string;
const write = (name: string, value: unknown) => writeFileSync(path.join(project, 'data', name), JSON.stringify(value));
const readMap = () => JSON.parse(readFileSync(path.join(project, 'data', 'Map001.json'), 'utf8')) as { events: Array<{ id: number; x: number; y: number; name: string } | null> };

function writeMap(id: number, wall: boolean) {
  const data = new Array(W * H * 6).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = wall && x === WALL_X ? WALL : FLOOR;
  write('Map' + String(id).padStart(3, '0') + '.json', { width: W, height: H, tilesetId: 1, data, events: [null], encounterList: [], encounterStep: 30 });
}

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-safety-'));
  dirs.push(project);
  mkdirSync(path.join(project, 'data'));
  const flags = new Array(32).fill(0);
  flags[WALL] = 0x0f;
  writeMap(1, true);   // split by a wall
  writeMap(2, false);  // open
  write('MapInfos.json', [null, { id: 1, name: 'Split', parentId: 0, order: 1 }, { id: 2, name: 'Open', parentId: 0, order: 2 }]);
  write('System.json', { startMapId: 1, startX: 0, startY: 0, partyMembers: [], switches: new Array(11).fill(''), variables: [] });
  write('Tilesets.json', [null, { id: 1, name: 'Test', flags }]);
  write('Items.json', [null, { id: 1, name: 'Potion' }]);
  write('Weapons.json', [null, { id: 1, name: 'Sword' }]);
  write('Troops.json', [null, { id: 1, name: 'Slime', members: [], pages: [] }]);
  for (const name of ['Actors', 'Classes', 'Skills', 'Armors', 'Enemies', 'States', 'Animations', 'CommonEvents']) write(name + '.json', [null]);
  initProjectPath(project);
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('walkability report', () => {
  it('flags a wall that cuts off part of the map', async () => {
    const report = await mapWalkReport(project, 1);
    expect(report).toMatchObject({ standableTiles: 72, mainRegionTiles: 40, isolatedTiles: 32 });
    expect(report!.warnings[0]).toContain('32 of 72 walkable tiles are cut off');
  });

  it('has nothing to say about an open map', async () => {
    expect(await mapWalkReport(project, 2)).toMatchObject({ standableTiles: 80, mainRegionTiles: 80, isolatedTiles: 0, warnings: [] });
  });

  it('is attached to generator results as walkability and warnings, whatever key carries the map ids', async () => {
    expect(generatedMapIds({ mapId: 1, mapIds: [2, 2], interiorMapIds: [] })).toEqual([1, 2]);
    const result = await withWalkReport(project, { mapIds: [1, 2] }) as { walkability: Array<{ mapId: number }>; warnings: string[] };
    expect(result.walkability.map((entry) => entry.mapId)).toEqual([1, 2]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^map 1: /);
    expect(await withWalkReport(project, { ok: true })).toEqual({ ok: true });
  });

  it('is skipped when the tileset has no passage flags', async () => {
    write('Tilesets.json', [null]);
    expect(await mapWalkReport(project, 1)).toBeNull();
  });
});

describe('populate', () => {
  it('places events only on free tiles of the main walkable area', async () => {
    await dispatchTool('manage_map_event', { action: 'populate', mapId: 1, eventType: 'npc', count: 30 });
    const events = readMap().events.filter(Boolean) as Array<{ x: number; y: number }>;
    expect(events).toHaveLength(30);
    for (const event of events) expect(event.x).toBeLessThan(WALL_X); // the west part is the larger one
    expect(new Set(events.map((event) => event.x + ',' + event.y)).size).toBe(30);
  });

  it('stops with a warning when there is no room left, and refuses a map with no free tile', async () => {
    const result = await dispatchTool('manage_map_event', { action: 'populate', mapId: 1, eventType: 'npc', count: 45 }) as { added: unknown[]; warnings: string[] };
    expect(result.added).toHaveLength(40);
    expect(result.warnings[0]).toContain('Placed 40 of 45');
    await expect(dispatchTool('manage_map_event', { action: 'populate', mapId: 1, eventType: 'npc', count: 1 })).rejects.toThrow('no free walkable tile');
  });

  it('keeps explicit coordinates as given', async () => {
    await dispatchTool('manage_map_event', { action: 'populate', mapId: 1, eventType: 'npc', count: 1, opts: { x: WALL_X, y: 3 } });
    expect(readMap().events[1]).toMatchObject({ x: WALL_X, y: 3 });
  });
});

describe('manage_map_event presets', () => {
  const create = (args: Record<string, unknown>) => dispatchTool('manage_map_event', { action: 'create', mapId: 1, ...args });

  it('creates a teleport to a map that does not exist yet, with a warning', async () => {
    const result = await create({ preset: 'teleport', x: 1, y: 1, destMapId: 9, destX: 1, destY: 1 }) as { warnings: string[] };
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Destination map 9 does not exist yet');
    expect(readMap().events.filter(Boolean)).toHaveLength(1);
  });

  it('warns about an unwalkable destination and an occupied tile, but still creates the event', async () => {
    const result = await create({ preset: 'teleport', x: 1, y: 1, destMapId: 1, destX: WALL_X, destY: 2 }) as { warnings: string[] };
    expect(result.warnings).toEqual([`Destination (${WALL_X},2) is not a walkable tile on map 1.`]);
    const second = await create({ preset: 'npc', x: 1, y: 1, name: 'Ana', dialogues: ['hi'] }) as { warnings: string[] };
    expect(second.warnings[0]).toContain('already holds event 1');
  });

  it('puts an npc on a wall tile in warnings, and a door there without complaint', async () => {
    const npc = await create({ preset: 'npc', x: WALL_X, y: 0, name: 'Ana', dialogues: ['hi'] }) as { warnings: string[] };
    expect(npc.warnings[0]).toContain('is not a walkable tile');
    const door = await create({ preset: 'door', x: WALL_X, y: 1, destMapId: 2, destX: 1, destY: 1 }) as { warnings?: string[] };
    expect(door.warnings).toBeUndefined();
  });

  it('refuses positions outside the map and references that do not exist', async () => {
    await expect(create({ preset: 'npc', x: W, y: 0, name: 'Ana', dialogues: ['hi'] })).rejects.toThrow('outside map 1');
    await expect(create({ preset: 'boss', x: 1, y: 1, troopId: 7 })).rejects.toThrow('Troop 7 does not exist');
    await expect(create({ preset: 'chest', x: 1, y: 1, items: [{ type: 'item', id: 9, amount: 1 }] })).rejects.toThrow('item 9 does not exist');
    await expect(create({ preset: 'shop', x: 1, y: 1, goods: [[1, 9, 0, 0]] })).rejects.toThrow('does not exist in Weapons.json');
    await expect(create({ preset: 'door', x: 1, y: 1, destMapId: 2, destX: 1, destY: 1, lockedSwitchId: 99 })).rejects.toThrow('lockedSwitchId 99 exceeds');
    expect(readMap().events.filter(Boolean)).toHaveLength(0);
  });

  it('creates a clean event without warnings when everything checks out', async () => {
    const result = await create({ preset: 'boss', x: 2, y: 2, troopId: 1 }) as { warnings?: string[] };
    expect(result.warnings).toBeUndefined();
    expect(readMap().events.filter(Boolean)).toHaveLength(1);
  });
});
