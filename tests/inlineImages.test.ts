import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectInlineImages, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGES } from '../src/utils/inlineImages.js';

const dirs: string[] = [];
async function file(bytes: number, name: string) {
  const root = await mkdtemp(join(tmpdir(), 'mv-inline-'));
  dirs.push(root);
  const path = join(root, name);
  await writeFile(path, Buffer.alloc(bytes, 1));
  return path;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('native image response budgets', () => {
  it('limits combined bytes while preserving skipped artifact paths in separate metadata', async () => {
    const first = await file(8, 'first.png');
    const second = await file(8, 'second.png');
    const third = await file(4, 'third.png');
    const result = await collectInlineImages([first, second, third], { maxBytes: 12, maxImages: 8 });
    expect(result.images).toHaveLength(2);
    expect(result.metadata).toMatchObject({ bytes: 12, truncated: true, omitted: [{ path: second, reason: 'aggregate_byte_limit' }] });
  });
  it('uses production limits of eight images and 32 MiB, retaining successful delivery if an artifact disappears', async () => {
    expect(MAX_INLINE_IMAGES).toBe(8);
    expect(MAX_INLINE_IMAGE_BYTES).toBe(32 * 1024 * 1024);
    const image = await file(4, 'image.png');
    const result = await collectInlineImages([image + '.missing', ...Array(9).fill(image)]);
    expect(result.images).toHaveLength(8);
    expect(result.metadata.omitted).toHaveLength(2);
    expect(result.metadata.omitted[1].reason).toBe('image_count_limit');
  });
});
