import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { isWaterfallTile, isFloorTypeAutotile } from '../src/utils/engine.js';
import { applyAutotileShapes } from '../src/utils/autotile.js';

const A1 = 2048;
const A2 = 2816;
const id = (kind: number, shape: number) => A1 + kind * 48 + shape;

describe('waterfall autotiles', () => {
  it('classifies every A1 tile the way rpg_core Tilemap.isWaterfallTile does', () => {
    for (let tile = A1; tile < A2; tile++) {
      // rpg_core: tileId >= TILE_ID_A1 + 192 && tileId < TILE_ID_A2 && kind % 2 === 1
      const engine = tile >= A1 + 192 && ((tile - A1) / 48 | 0) % 2 === 1;
      expect(isWaterfallTile(tile), 'tile ' + tile).toBe(engine);
      if (engine) expect(isFloorTypeAutotile(tile), 'tile ' + tile).toBe(false);
    }
  });

  it('never gives a waterfall a shape outside the engine table, and repairs one that has it', () => {
    const W = 5, H = 3;
    const sea = id(0, 0); // an A1 floor kind around the waterfall column
    const data = new Array(W * H * 6).fill(0);
    for (let i = 0; i < W * H; i++) data[i] = sea;
    // The corrupt shape seen in a real map, a valid one, and another corrupt kind.
    data[0 * W + 2] = id(9, 40);
    data[1 * W + 2] = id(9, 2);
    data[2 * W + 2] = id(13, 46);
    applyAutotileShapes(data, W, H);
    expect(data[0 * W + 2]).toBe(id(9, 0));
    expect(data[1 * W + 2]).toBe(id(9, 2));
    expect(data[2 * W + 2]).toBe(id(13, 0));
  });

  it('produces only valid shapes for every A1 kind on a random layout', () => {
    const W = 12, H = 10;
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const data = new Array(W * H * 6).fill(0);
    for (let i = 0; i < W * H; i++) data[i] = id(Math.floor(rand() * 16), 0);
    applyAutotileShapes(data, W, H);
    for (let i = 0; i < W * H; i++) {
      if (isWaterfallTile(data[i])) expect((data[i] - A1) % 48).toBeLessThan(4);
    }
  });

  it('keeps every waterfall cell of the bundled reference maps exactly as the editor saved it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.json')) files.push(path);
      }
    };
    walk(join(__dirname, '..', 'knowledge', 'maps'));
    let cells = 0;
    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const map = raw?.data && raw?.width ? raw : raw?.map;
      if (!map?.data) continue;
      const before = map.data.slice();
      const after = map.data.slice();
      applyAutotileShapes(after, map.width, map.height);
      for (let i = 0; i < map.width * map.height * 4; i++) {
        if (!isWaterfallTile(before[i])) continue;
        cells++;
        expect(after[i], file + ' cell ' + i).toBe(before[i]);
      }
    }
    expect(cells).toBeGreaterThan(300);
  });
});
