import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listAssets, assetToolDefinitions } from '../../src/parity/tools/assetTools.js';
import { AssetIndex } from '../../src/parity/tools/assetTools.js';

/** Scaffold a minimal project with a couple of asset directories seeded. */
async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-asset-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');

  await mkdir(join(dir, 'img', 'characters'), { recursive: true });
  await writeFile(join(dir, 'img', 'characters', 'Actor1.png'), '');
  await writeFile(join(dir, 'img', 'characters', '!Door1.png'), '');
  await writeFile(join(dir, 'img', 'characters', 'notes.txt'), ''); // wrong ext → excluded

  await mkdir(join(dir, 'audio', 'bgm'), { recursive: true });
  await writeFile(join(dir, 'audio', 'bgm', 'Theme1.ogg'), '');
  await writeFile(join(dir, 'audio', 'bgm', 'Theme1.m4a'), ''); // same track, other runtime
  await writeFile(join(dir, 'audio', 'bgm', 'Theme2.ogg'), '');

  return dir;
}

describe('asset tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists image basenames with the extension stripped, sorted, excluding other extensions', async () => {
    const result = await listAssets(dir, 'characters');
    expect(result.type).toBe('characters');
    expect(result.names).toEqual(['!Door1', 'Actor1']);
    expect(result.count).toBe(2);
  });

  it('dedupes audio by basename across .ogg and .m4a', async () => {
    const result = await listAssets(dir, 'bgm');
    expect(result.names).toEqual(['Theme1', 'Theme2']);
    expect(result.count).toBe(2);
  });

  it('fails soft on a missing asset directory, returning an empty list', async () => {
    const result = await listAssets(dir, 'faces');
    expect(result).toEqual({ type: 'faces', count: 0, names: [] });
  });

  it('the list_assets tool handler dispatches to listAssets', async () => {
    const def = assetToolDefinitions.find((t) => t.name === 'list_assets')!;
    expect(def.mutates).toBeUndefined();
    const result = (await def.handler({ projectPath: dir }, { type: 'characters' })) as AssetIndex;
    expect(result.names).toContain('Actor1');
  });
});
