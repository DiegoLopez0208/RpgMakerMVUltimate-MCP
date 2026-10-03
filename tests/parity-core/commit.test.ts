import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { diffJson, commitChange, commitStore, CommitContext } from '../../src/parity/utils/commit.js';

describe('diffJson', () => {
  it('reports no changes for equal values', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }).changes).toEqual([]);
  });

  it('is insensitive to object key order', () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 }).changes).toEqual([]);
  });

  it('records a changed primitive with from/to and a path', () => {
    expect(diffJson({ hp: 10 }, { hp: 20 }).changes).toEqual([{ path: 'hp', from: 10, to: 20 }]);
  });

  it('records nested and array-element changes with dotted/indexed paths', () => {
    const diff = diffJson(
      { stats: { atk: 5 }, tags: ['a', 'b'] },
      { stats: { atk: 7 }, tags: ['a', 'c'] },
    );
    expect(diff.changes).toEqual([
      { path: 'stats.atk', from: 5, to: 7 },
      { path: 'tags[1]', from: 'b', to: 'c' },
    ]);
  });

  it('marks additions (no `from`) and removals (no `to`)', () => {
    const added = diffJson({}, { name: 'Reid' }).changes[0];
    expect(added).toEqual({ path: 'name', to: 'Reid' });
    expect('from' in added).toBe(false);

    const removed = diffJson({ name: 'Reid' }, {}).changes[0];
    expect(removed).toEqual({ path: 'name', from: 'Reid' });
    expect('to' in removed).toBe(false);
  });

  it('caps the change list and flags truncation', () => {
    const oldArr = Array.from({ length: 500 }, () => 0);
    const newArr = Array.from({ length: 500 }, (_, i) => i + 1);
    const diff = diffJson(oldArr, newArr);
    expect(diff.truncated).toBe(true);
    expect(diff.changes.length).toBe(200);
  });
});

describe('commitChange', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rpgmv-commit-'));
    file = join(dir, 'data.json');
    await writeFile(file, JSON.stringify({ hp: 10 }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const withContext = <T>(ctx: CommitContext, fn: () => Promise<T>): Promise<T> =>
    commitStore.run(ctx, fn);

  it('writes when there is no commit context (direct call)', async () => {
    const result = await commitChange(file, { hp: 20 });
    expect(result.changed).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ hp: 20 });
  });

  it('does not write in dry-run mode, but records the diff', async () => {
    const ctx: CommitContext = { dryRun: true, commits: [] };
    const result = await withContext(ctx, () => commitChange(file, { hp: 20 }));

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(ctx.commits).toHaveLength(1);
    // File on disk is untouched.
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ hp: 10 });
  });

  it('writes and records when the context is not dry-run', async () => {
    const ctx: CommitContext = { dryRun: false, commits: [] };
    await withContext(ctx, () => commitChange(file, { hp: 30 }));
    expect(ctx.commits).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ hp: 30 });
  });

  it('reports changed=false and skips the write when data is identical', async () => {
    const before = await readFile(file, 'utf-8');
    const result = await commitChange(file, { hp: 10 });
    expect(result.changed).toBe(false);
    // Untouched (including the original hand-written formatting).
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('treats a missing file as a full addition at the root path', async () => {
    const result = await commitChange(join(dir, 'new.json'), { created: true });
    expect(result.changed).toBe(true);
    // Old value is undefined, so the whole document is a single root-level add.
    expect(result.diff.changes).toEqual([{ path: '', to: { created: true } }]);
  });
});
