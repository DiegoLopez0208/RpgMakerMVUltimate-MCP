import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import {
  createMoveRoute,
  moveRouteCommands,
  setMovementRoute,
  moveToolDefinitions,
} from '../src/parity/tools/moveTools.js';
import { blankMapData } from '../src/parity/tools/mapTools.js';
import { MapData, MapEvent, MoveRoute } from '../src/parity/utils/types.js';

/** A minimal event with one page holding an empty (code-0-terminated) list. */
function eventWithEmptyPage(id: number): MapEvent {
  return {
    id,
    name: `EV${id}`,
    note: '',
    x: 0,
    y: 0,
    pages: [
      {
        conditions: {} as never,
        directionFix: false,
        image: {} as never,
        list: [{ code: 0, indent: 0, parameters: [] }],
        moveFrequency: 3,
        moveRoute: { list: [], repeat: false, skippable: false, wait: false },
        moveSpeed: 3,
        moveType: 0,
        priorityType: 1,
        stepAnime: false,
        through: false,
        trigger: 0,
        walkAnime: true,
      },
    ],
  };
}

/** Scaffold a minimal project with a single map that has one event. */
async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-move-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  const map: MapData = blankMapData(17, 13, 1);
  map.events = [null, eventWithEmptyPage(1)];
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));
  return dir;
}

describe('createMoveRoute (pure builder)', () => {
  it('patrol walks a direction and back, terminated by code 0', () => {
    const route = createMoveRoute('patrol', { direction: 'right', steps: 2 });
    expect(route.list.map((c) => c.code)).toEqual([3, 3, 2, 2, 0]);
    expect(route.repeat).toBe(true);
    expect(route.list[route.list.length - 1].code).toBe(0);
  });

  it('approach/flee/wander produce their single directive and loop by default', () => {
    expect(createMoveRoute('approach').list.map((c) => c.code)).toEqual([10, 0]);
    expect(createMoveRoute('flee').list.map((c) => c.code)).toEqual([11, 0]);
    expect(createMoveRoute('wander').list.map((c) => c.code)).toEqual([9, 0]);
    expect(createMoveRoute('approach').repeat).toBe(true);
  });

  it('custom normalizes parameters, strips a caller terminator, and defaults repeat off', () => {
    const route = createMoveRoute('custom', {
      commands: [{ code: 15, parameters: [30] }, { code: 1 } as never, { code: 0, parameters: [] }],
    });
    expect(route.list).toEqual([
      { code: 15, parameters: [30] },
      { code: 1, parameters: [] },
      { code: 0, parameters: [] },
    ]);
    expect(route.repeat).toBe(false);
  });

  it('honors explicit flags and rejects a bad direction / empty custom', () => {
    const route = createMoveRoute('wander', { repeat: false, skippable: true, wait: true });
    expect(route).toMatchObject({ repeat: false, skippable: true, wait: true });
    expect(() => createMoveRoute('patrol', { direction: 'sideways' as never })).toThrow(
      /direction/,
    );
    expect(() => createMoveRoute('custom', { commands: [] })).toThrow(/non-empty/);
  });
});

describe('moveRouteCommands', () => {
  it('emits a 205 carrying the route plus one 505 per step', () => {
    const route = createMoveRoute('patrol', { steps: 1 }); // [right, left, end] => 3 steps
    const commands = moveRouteCommands(-1, route);
    expect(commands[0].code).toBe(205);
    expect(commands[0].parameters[0]).toBe(-1);
    expect((commands[0].parameters[1] as MoveRoute).list).toHaveLength(3);
    expect(commands.slice(1).map((c) => c.code)).toEqual([505, 505, 505]);
    // Each 505 wraps the corresponding move step.
    expect(commands[1].parameters[0]).toEqual({ code: 3, parameters: [] });
  });
});

describe('setMovementRoute (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('inserts the 205 + 505 sequence before the end marker and persists compactly', async () => {
    const route = createMoveRoute('approach');
    await setMovementRoute(dir, 1, 1, 0, 0, route);

    const raw = await readFile(join(dir, 'data', 'Map001.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    const map = JSON.parse(raw) as MapData;
    const list = map.events[1]!.pages[0].list;
    // 205, then 2 x 505 (approach => [10, 0]), then the original code-0 end marker.
    expect(list.map((c) => c.code)).toEqual([205, 505, 505, 0]);
  });

  it('surfaces validation warnings for an unrecognized move command', async () => {
    const badRoute: MoveRoute = {
      list: [
        { code: 999, parameters: [] },
        { code: 0, parameters: [] },
      ],
      repeat: false,
      skippable: false,
      wait: false,
    };
    const def = moveToolDefinitions.find((t) => t.name === 'set_movement_route')!;
    const result = (await def.handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, characterId: 0, moveRoute: badRoute },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
  });

  it('auto-appends the Route-End terminator instead of refusing an unterminated route', async () => {
    const unterminated: MoveRoute = {
      list: [{ code: 4, parameters: [] }], // no { code: 0 } terminator
      repeat: false,
      skippable: true,
      wait: true,
    };
    const def = moveToolDefinitions.find((t) => t.name === 'set_movement_route')!;
    const result = (await def.handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, characterId: -1, moveRoute: unterminated },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings ?? []).toEqual([]);
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    const list = map.events[1]!.pages[0].list;
    expect(list.map((c) => c.code)).toEqual([205, 505, 505, 0]);
    const written = list[0].parameters[1] as MoveRoute;
    expect(written.list.map((c) => c.code)).toEqual([4, 0]);
  });

  it('rejects an unknown event or page', async () => {
    const route = createMoveRoute('wander');
    await expect(setMovementRoute(dir, 1, 99, 0, 0, route)).rejects.toThrow(/Event 99/);
    await expect(setMovementRoute(dir, 1, 1, 5, 0, route)).rejects.toThrow(/Page 5/);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await setMovementRoute(dir, 1, 1, 0, -1, createMoveRoute('flee'));
    });
    expect(context.commits.some((c) => c.path.endsWith('Map001.json'))).toBe(true);
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[1]!.pages[0].list.map((c) => c.code)).toEqual([0]);
  });
});

describe('move tool handlers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('create_move_route is read-only and returns a route', async () => {
    const def = moveToolDefinitions.find((t) => t.name === 'create_move_route')!;
    expect(def.mutates).toBeUndefined();
    const result = (await def.handler(
      { projectPath: dir },
      { pattern: 'patrol', direction: 'up', steps: 1 },
    )) as { moveRoute: MoveRoute };
    expect(result.moveRoute.list.map((c) => c.code)).toEqual([4, 1, 0]);
  });

  it('set_movement_route is marked as mutating', () => {
    const def = moveToolDefinitions.find((t) => t.name === 'set_movement_route')!;
    expect(def.mutates).toBe(true);
  });
});
