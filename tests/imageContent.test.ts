import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { imagesFromResult, MAX_INLINE_IMAGE_BYTES } from '../src/utils/imageContent.js';

describe('imagesFromResult', () => {
  let root: string;
  let renders: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'imgcontent-'));
    renders = join(root, '.mcp-cache', 'renders');
    await mkdir(renders, { recursive: true });
    delete process.env.RPGMV_INLINE_IMAGES;
  });
  afterEach(async () => {
    delete process.env.RPGMV_INLINE_IMAGES;
    await rm(root, { recursive: true, force: true });
  });

  it('attaches the PNG a render result points at', async () => {
    const file = join(renders, 'map1.png');
    await writeFile(file, Buffer.from([1, 2, 3]));
    const images = await imagesFromResult({ path: file });
    expect(images).toEqual([{ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' }]);
  });

  it('collects frames from a playtest result, capped', async () => {
    const frames: string[] = [];
    for (let i = 0; i < 6; i++) {
      const file = join(renders, `step${i}.png`);
      await writeFile(file, Buffer.from([i]));
      frames.push(file);
    }
    const images = await imagesFromResult({ frames: frames.map((path) => ({ path })) });
    expect(images).toHaveLength(4);
  });

  it('ignores PNGs outside .mcp-cache renders/screenshots', async () => {
    const outside = join(root, 'secret.png');
    await writeFile(outside, Buffer.from([9]));
    expect(await imagesFromResult({ path: outside })).toEqual([]);
    const wrongDir = join(root, '.mcp-cache', 'other.png');
    await writeFile(wrongDir, Buffer.from([9]));
    expect(await imagesFromResult({ path: wrongDir })).toEqual([]);
  });

  it('skips oversized files, missing files, non-objects and non-PNGs', async () => {
    const big = join(renders, 'big.png');
    await writeFile(big, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
    expect(await imagesFromResult({ path: big })).toEqual([]);
    expect(await imagesFromResult({ path: join(renders, 'gone.png') })).toEqual([]);
    expect(await imagesFromResult(null)).toEqual([]);
    expect(await imagesFromResult('x')).toEqual([]);
    const txt = join(renders, 'a.txt');
    await writeFile(txt, 'x');
    expect(await imagesFromResult({ path: txt })).toEqual([]);
  });

  it('can be switched off with RPGMV_INLINE_IMAGES=0', async () => {
    const file = join(renders, 'map1.png');
    await writeFile(file, Buffer.from([1]));
    process.env.RPGMV_INLINE_IMAGES = '0';
    expect(await imagesFromResult({ path: file })).toEqual([]);
  });
});
