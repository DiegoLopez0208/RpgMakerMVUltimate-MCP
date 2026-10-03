import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  commitStore,
  commitText,
  commitTextBatch,
  type CommitContext,
} from '../../src/parity/utils/commit.js';

const failure = vi.hoisted(() => ({ destination: '' }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to === failure.destination) {
        failure.destination = '';
        throw new Error('Injected replacement failure');
      }
      return actual.rename(from, to);
    },
  };
});

describe('text file commit transactions', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mz-text-commit-'));
  });
  afterEach(async () => {
    failure.destination = '';
    await rm(directory, { recursive: true, force: true });
  });

  it('previews plugin and manifest bytes without creating directories or backups', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    const results = await commitStore.run(context, () =>
      commitTextBatch([
        { path: join(directory, 'js/plugins/Bridge.js'), text: 'plugin' },
        { path: join(directory, 'js/plugins.js'), text: 'manifest' },
      ]),
    );
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.changed && result.dryRun)).toBe(true);
    expect(context.commits).toEqual(results);
    expect(await readdir(directory)).toEqual([]);
  });

  it('writes related files, preserving exact prior bytes in unique backups', async () => {
    const plugin = join(directory, 'Bridge.js');
    const manifest = join(directory, 'plugins.js');
    const old = Buffer.from('original\r\n', 'utf8');
    await writeFile(manifest, old);
    await commitTextBatch([
      { path: plugin, text: 'new plugin' },
      { path: manifest, text: 'updated manifest' },
    ]);
    expect(await readFile(plugin, 'utf8')).toBe('new plugin');
    expect(await readFile(manifest, 'utf8')).toBe('updated manifest');
    const backups = await readdir(`${manifest}.mcp-backups`);
    expect(backups).toHaveLength(1);
    expect(await readFile(join(`${manifest}.mcp-backups`, backups[0]))).toEqual(old);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('does not rewrite or back up unchanged text', async () => {
    const path = join(directory, 'Bridge.js');
    await writeFile(path, 'same');
    expect((await commitText(path, 'same')).changed).toBe(false);
    expect(await readdir(directory)).toEqual(['Bridge.js']);
  });

  it('rejects duplicate targets before writing', async () => {
    const path = join(directory, 'Bridge.js');
    await expect(
      commitTextBatch([
        { path, text: 'a' },
        { path, text: 'b' },
      ]),
    ).rejects.toThrow(/Duplicate/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('preserves targets when staging another file fails', async () => {
    const first = join(directory, 'Bridge.js');
    await writeFile(first, 'old');
    await writeFile(join(directory, 'not-a-directory'), 'block');
    await expect(
      commitTextBatch([
        { path: first, text: 'new' },
        { path: join(directory, 'not-a-directory/plugins.js'), text: 'manifest' },
      ]),
    ).rejects.toThrow();
    expect(await readFile(first, 'utf8')).toBe('old');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('rolls back an existing plugin after a manifest replacement failure', async () => {
    const first = join(directory, 'Bridge.js');
    const second = join(directory, 'plugins.js');
    await writeFile(first, 'old plugin\r\n');
    await writeFile(second, 'old manifest');
    failure.destination = second;
    await expect(
      commitTextBatch([
        { path: first, text: 'new' },
        { path: second, text: 'new' },
      ]),
    ).rejects.toThrow(/Injected/);
    expect(await readFile(first, 'utf8')).toBe('old plugin\r\n');
    expect(await readFile(second, 'utf8')).toBe('old manifest');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('removes a newly created plugin on a later replacement failure', async () => {
    const first = join(directory, 'Bridge.js');
    const second = join(directory, 'plugins.js');
    await writeFile(second, 'original');
    failure.destination = second;
    await expect(
      commitTextBatch([
        { path: first, text: 'new' },
        { path: second, text: 'new' },
      ]),
    ).rejects.toThrow(/Injected/);
    await expect(readFile(first)).rejects.toThrow();
    expect(await readFile(second, 'utf8')).toBe('original');
  });

  it('does not treat unreadable targets as absent', async () => {
    const target = join(directory, 'plugins.js');
    await mkdir(target);
    await expect(commitText(target, 'text')).rejects.toThrow();
  });
});
