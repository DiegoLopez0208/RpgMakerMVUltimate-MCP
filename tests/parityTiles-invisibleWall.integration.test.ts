// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  blankMapData,
  blankEventPage,
  tileIndex,
  invisibleWallFindings,
  mapToolDefinitions,
} from '../src/parity/tools/mapTools.js';
import { validateEventTool, validateProjectTool } from '../src/parity/tools/validationTools.js';
import { MapEvent, EventPage } from '../src/parity/utils/types.js';

/**
 * Fixture tiles: 100 = fully passable floor, 200 = blocked all directions,
 * 33 = a [*] star B-sheet landmark (drawn, but passable — "Temple B").
 */
const FLOOR = 100;
const WALL = 200;
const LANDMARK = 33;

/**
 * Scaffold a project + one 5x5 map: floor everywhere, a wall tile at (2, 2) and
 * a passable upper-layer landmark drawn over the floor at (3, 3).
 */
async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-wall-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(
    join(dir, 'data', 'MapInfos.json'),
    JSON.stringify([null, { id: 1, name: 'Map1', parentId: 0, order: 1 }]),
  );

  const map = blankMapData(5, 5, 1);
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) map.data[tileIndex(5, 5, x, y, 0)] = FLOOR;
  map.data[tileIndex(5, 5, 2, 2, 0)] = WALL;
  map.data[tileIndex(5, 5, 3, 3, 2)] = LANDMARK;
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));

  const flags = new Array(8192).fill(0);
  flags[0] = 0x10; // empty tile is a [*] star, per the engine
  flags[LANDMARK] = 0x10; // [*] star: drawn above the player, passable
  flags[WALL] = 0x0f; // impassable all directions
  await writeFile(
    join(dir, 'data', 'Tilesets.json'),
    JSON.stringify([null, { id: 1, name: 'Fixture', flags }]),
  );
  return dir;
}

const createMapEventDef = mapToolDefinitions.find((t) => t.name === 'create_map_event')!;

/** A graphic-less page (the create_map_event default image) with priority "same". */
const blankSame = (extra: Record<string, unknown> = {}) => ({ priorityType: 1, ...extra });

type Result = { event: { id: number }; warnings?: { message: string; severity?: string }[] };

const isWall = (w: { message: string }) => /invisible wall/.test(w.message);

describe('invisible-wall advisory (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffold();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('warns (without refusing) on a blank priority-same page on a floor tile', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Mira', x: 1, y: 1, pages: [blankSame()] },
    )) as Result;
    const wall = (warnings ?? []).filter(isWall);
    expect(wall).toHaveLength(1);
    expect(wall[0].severity).toBe('warning');
    expect(wall[0].message).toMatch(/"Mira" page 1 .*at \(1, 1\).*through: true/);
  });

  it('stays quiet on a wall tile', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Mira', x: 2, y: 2, pages: [blankSame()] },
    )) as Result;
    expect(warnings ?? []).toEqual([]);
  });

  it('stays quiet with through: true', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Mira', x: 1, y: 1, pages: [blankSame({ through: true })] },
    )) as Result;
    expect(warnings ?? []).toEqual([]);
  });

  it('stays quiet with a graphic, a tile graphic, or priority below', async () => {
    for (const page of [
      blankSame({ image: { characterName: 'Actor1', characterIndex: 0 } }),
      blankSame({ image: { tileId: 5 } }),
      { priorityType: 0 },
    ]) {
      const { warnings } = (await createMapEventDef.handler(
        { projectPath: dir },
        { mapId: 1, name: 'Mira', x: 1, y: 1, pages: [page] },
      )) as Result;
      expect(warnings ?? []).toEqual([]);
    }
  });

  it('stays quiet on an action-button solid landmark over a drawn B/C object', async () => {
    const { event, warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Temple', x: 3, y: 3, pages: [blankSame({ trigger: 0 })] },
    )) as Result;
    expect(warnings ?? []).toEqual([]);

    const single = await validateEventTool(dir, 1, event.id);
    expect(single.warnings.filter(isWall)).toEqual([]);
    const project = await validateProjectTool(dir);
    expect(project.warnings.filter(isWall)).toEqual([]);
  });

  it('still warns on a touch page over a drawn B/C object', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Temple', x: 3, y: 3, pages: [blankSame({ trigger: 1 })] },
    )) as Result;
    expect((warnings ?? []).filter(isWall)).toHaveLength(1);
  });

  it("flags a cutscene NPC's blanked self-switch 'after' page, and validate_* report it", async () => {
    const { event, warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      {
        mapId: 1,
        name: 'Mira',
        x: 3,
        y: 1,
        pages: [
          blankSame({ image: { characterName: 'Actor1', characterIndex: 2 } }),
          blankSame({ conditions: { selfSwitchValid: true, selfSwitchCh: 'A' } }),
        ],
      },
    )) as Result;
    expect((warnings ?? []).filter(isWall).map((w) => w.message)).toEqual([
      expect.stringMatching(/"Mira" page 2 \(index 1\)/),
    ]);

    const single = await validateEventTool(dir, 1, event.id);
    expect(single.ok).toBe(false);
    expect(single.warnings.filter(isWall)).toHaveLength(1);

    const project = await validateProjectTool(dir);
    expect(project.ok).toBe(false);
    expect(project.warnings.filter(isWall).map((w) => w.mapId)).toEqual([1]);
  });
});

describe('invisibleWallFindings (pure)', () => {
  const event = (pages: Partial<EventPage>[]): MapEvent => ({
    id: 3,
    name: 'Mira',
    note: '',
    x: 7,
    y: 8,
    pages: pages.map((p) => ({ ...blankEventPage(), ...p })),
  });

  it('skips a page shadowed by a later unconditional page', () => {
    const e = event([{ priorityType: 1 }, { priorityType: 0 }]);
    expect(invisibleWallFindings(e, true)).toEqual([]);
  });

  it('still flags a page followed only by conditional pages', () => {
    const later = { ...blankEventPage(), priorityType: 0 };
    later.conditions = { ...later.conditions, switch1Valid: true, switch1Id: 1 };
    const e = event([{ priorityType: 1 }, later]);
    expect(invisibleWallFindings(e, true)).toEqual([
      expect.objectContaining({ path: 'event 3 / page 0', severity: 'warning' }),
    ]);
  });

  it('never fires when the cell is not walkable', () => {
    expect(invisibleWallFindings(event([{ priorityType: 1 }]), false)).toEqual([]);
  });

  it('skips only action-button pages when the cell has a drawn object', () => {
    expect(invisibleWallFindings(event([{ priorityType: 1, trigger: 0 }]), true, true)).toEqual([]);
    for (const trigger of [1, 2, 3, 4]) {
      expect(invisibleWallFindings(event([{ priorityType: 1, trigger }]), true, true)).toEqual([
        expect.objectContaining({ path: 'event 3 / page 0', severity: 'warning' }),
      ]);
    }
  });
});
