// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { blankMapData, tileIndex, mapToolDefinitions } from '../src/parity/tools/mapTools.js';
import { MapEvent } from '../src/parity/utils/types.js';

/** Fixture tiles: 100 = fully passable ground, 200 = blocked all directions. */
const GROUND = 100;
const SOLID = 200;

/** Scaffold a project + one 5x5 map: ground everywhere, a solid tile at (2, 2). */
async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-reach-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');

  const map = blankMapData(5, 5, 1);
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) map.data[tileIndex(5, 5, x, y, 0)] = GROUND;
  map.data[tileIndex(5, 5, 2, 2, 0)] = SOLID;
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));

  const flags = new Array(8192).fill(0);
  flags[0] = 0x10; // empty tile is a [*] star, per the engine
  flags[SOLID] = 0x0f; // impassable all directions
  await writeFile(
    join(dir, 'data', 'Tilesets.json'),
    JSON.stringify([null, { id: 1, name: 'Fixture', flags }]),
  );
  return dir;
}

const createMapEventDef = mapToolDefinitions.find((t) => t.name === 'create_map_event')!;

/** A minimal action-button page whose list actually does something. */
const doorPage = (priorityType: number) => ({
  trigger: 0,
  priorityType,
  list: [
    { code: 201, indent: 0, parameters: [0, 1, 1, 1, 2, 0] },
    { code: 0, indent: 0, parameters: [] },
  ],
});

type Result = { event: MapEvent; warnings?: { message: string }[] };

describe('action-button reachability warning (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffold();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses an action-button page with priority below on an impassable tile', async () => {
    await expect(
      createMapEventDef.handler(
        { projectPath: dir },
        { mapId: 1, name: 'Door', x: 2, y: 2, pages: [doorPage(0)] },
      ),
    ).rejects.toThrow(/can never trigger/);

    // The dead event never reached the map.
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as {
      events: (MapEvent | null)[];
    };
    expect(map.events.every((e) => e == null || e.name !== 'Door')).toBe(true);
  });

  it('places the unreachable event anyway when forced, with the warning attached', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Door', x: 2, y: 2, pages: [doorPage(0)], force: true },
    )) as Result;
    expect(warnings?.some((w) => /can never trigger/.test(w.message))).toBe(true);
  });

  it('stays quiet with priority same (fires from facing)', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Door', x: 2, y: 2, pages: [doorPage(1)] },
    )) as Result;
    expect(warnings ?? []).toEqual([]);
  });

  it('stays quiet on a walkable tile (a stand-on trigger works there)', async () => {
    const { warnings } = (await createMapEventDef.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Mat', x: 1, y: 1, pages: [doorPage(0)] },
    )) as Result;
    expect(warnings ?? []).toEqual([]);
  });
});
