import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';
import { applyAutotileShapes, findInvalidAutotiles } from '../src/utils/autotile.js';

const W = 9, H = 7;
const GRASS = 2816;            // A2 kind 0, a floor autotile
const WATER = 2048;            // A1 kind 0, a floor autotile
const dirs: string[] = [];
let project: string;
const mapFile = () => path.join(project, 'data', 'Map001.json');
const readMap = () => JSON.parse(readFileSync(mapFile(), 'utf8')) as { data: number[] };

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-paint-'));
  dirs.push(project);
  mkdirSync(path.join(project, 'data'));
  const data = new Array(W * H * 6).fill(0);
  for (let i = 0; i < W * H; i++) data[i] = GRASS;
  applyAutotileShapes(data, W, H);
  const write = (name: string, value: unknown) => writeFileSync(path.join(project, 'data', name), JSON.stringify(value));
  write('Map001.json', { width: W, height: H, tilesetId: 1, data, events: [null], encounterList: [], encounterStep: 30 });
  write('MapInfos.json', [null, { id: 1, name: 'Field', parentId: 0, order: 1 }]);
  write('System.json', { startMapId: 1, startX: 0, startY: 0, partyMembers: [], switches: [], variables: [] });
  for (const name of ['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'States', 'Troops', 'Animations', 'CommonEvents', 'Tilesets']) write(name + '.json', [null]);
  initProjectPath(project);
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('edit_map paint', () => {
  it('paints a rect and shapes the painted cells and their neighbours like a whole-map pass, leaving the rest as saved', async () => {
    const before = readMap().data;
    const result = await dispatchTool('edit_map', { action: 'paint', mapId: 1, layer: 0, tileId: WATER + 17, rect: { x: 3, y: 2, width: 3, height: 2 } }) as { painted: number; tileId: number; autotilesReshaped: number };
    expect(result.painted).toBe(6);
    expect(result.tileId).toBe(WATER); // written as its kind; the shape comes from the neighbours
    const after = readMap().data;
    const painted = before.slice();
    for (let y = 2; y < 4; y++) for (let x = 3; x < 6; x++) painted[y * W + x] = WATER;
    const expected = painted.slice();
    applyAutotileShapes(expected, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const near = x >= 2 && x <= 6 && y >= 1 && y <= 4;
      expect(after[i], 'cell ' + x + ',' + y).toBe(near ? expected[i] : before[i]);
    }
    expect(result.autotilesReshaped).toBeGreaterThan(6);
  });

  it('paints listed cells, and region ids on layer 5 without reshaping anything', async () => {
    const before = readMap().data;
    const result = await dispatchTool('edit_map', { action: 'paint', mapId: 1, layer: 5, tileId: 7, cells: [[0, 0], [8, 6], [8, 6]] }) as { painted: number; autotilesReshaped: number };
    expect(result).toMatchObject({ painted: 2, autotilesReshaped: 0 });
    const after = readMap().data;
    const region = 5 * W * H;
    expect([after[region], after[region + 6 * W + 8]]).toEqual([7, 7]);
    expect(after.slice(0, 4 * W * H)).toEqual(before.slice(0, 4 * W * H));
  });

  it.each([
    [{ layer: 0, tileId: WATER, cells: [[9, 0]] }, /outside/],
    [{ layer: 0, tileId: WATER, rect: { x: 8, y: 6, width: 2, height: 1 } }, /outside/],
    [{ layer: 4, tileId: 1, cells: [[0, 0]] }, /layers 0-3/],
    [{ layer: 0, tileId: 1100, cells: [[0, 0]] }, /not a tile id/],
    [{ layer: 5, tileId: 256, cells: [[0, 0]] }, /Region ids/],
    [{ layer: 0, tileId: WATER, cells: [[0, 0]], rect: { x: 0, y: 0, width: 1, height: 1 } }, /exactly one/],
    [{ layer: 0, tileId: WATER }, /exactly one/],
    [{ layer: 0, tileId: WATER, rect: { x: 0, y: 0, width: 0, height: 1 } }, /rect/],
  ])('refuses %j and leaves the map untouched', async (args, message) => {
    const before = readFileSync(mapFile(), 'utf8');
    await expect(dispatchTool('edit_map', { action: 'paint', mapId: 1, ...args })).rejects.toThrow(message);
    expect(readFileSync(mapFile(), 'utf8')).toBe(before);
  });

  it('previews with dryRun without writing', async () => {
    const before = readFileSync(mapFile(), 'utf8');
    const result = await dispatchTool('edit_map', { action: 'paint', mapId: 1, layer: 0, tileId: WATER, cells: [[4, 3]], dryRun: true }) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
    expect(readFileSync(mapFile(), 'utf8')).toBe(before);
  });
});

describe('invalid autotiles', () => {
  it('are reported by analyze_project validate and fixed by repair_autotiles, touching nothing else', async () => {
    const map = JSON.parse(readFileSync(mapFile(), 'utf8'));
    map.data[2 * W + 4] = 2048 + 9 * 48 + 40;     // a waterfall with a floor shape, as in a real broken map
    map.data[W * H + 1] = 4352 + 8 * 48 + 20;     // an A3 wall side (16-shape table) with shape 20, on layer 1
    writeFileSync(mapFile(), JSON.stringify(map));
    const before = readMap().data;
    expect(findInvalidAutotiles(before, W, H)).toHaveLength(2);

    const report = await dispatchTool('analyze_project', { view: 'validate' }) as { issues: { category: string; mapId?: number; message: string }[] };
    const issue = report.issues.find((i) => i.category === 'invalid-autotile');
    expect(issue?.mapId).toBe(1);
    expect(issue?.message).toMatch(/2 autotile cell\(s\).*repair_autotiles/);

    const repaired = await dispatchTool('edit_map', { action: 'repair_autotiles', mapId: 1 }) as { invalid: number; repaired: number };
    expect(repaired).toMatchObject({ invalid: 2, repaired: 2 });
    const after = readMap().data;
    expect(findInvalidAutotiles(after, W, H)).toEqual([]);
    const changed = after.map((v, i) => (v !== before[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed).toEqual([2 * W + 4, W * H + 1]);

    const clean = await dispatchTool('analyze_project', { view: 'validate' }) as { issues: { category: string }[] };
    expect(clean.issues.some((i) => i.category === 'invalid-autotile')).toBe(false);
  });
});
