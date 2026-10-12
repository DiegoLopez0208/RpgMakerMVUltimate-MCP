import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJson, writeJson, safeWrite, validateProjectPath } from '../src/utils/fileHandler.js';
import { resolveSafePath } from '../src/utils/security.js';
import { analyzeProject } from '../src/intel/analyze.js';
import { getProjectIndex } from '../src/intel/projectIndex.js';
import { validateProject } from '../src/intel/validate.js';
import { rankDocuments } from '../src/intel/search.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mv-audit-regression-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(join(project, 'data'), { recursive: true });
  await writeFile(join(project, 'data/System.json'), '{"gameTitle":"Fixture","switches":[""],"variables":[""]}');
  return { root, project };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('audit regressions', () => {
  it('refuses reads and writes through a directory junction escaping the project', async () => {
    const { root, project } = await fixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'Actors.json'), '[null]');
    await symlink(outside, join(project, 'linked'), 'junction');
    expect(() => resolveSafePath(project, 'linked/Actors.json')).toThrow(/escapes/);
    expect(() => resolveSafePath(project, 'linked/new/nested.json')).toThrow(/escapes/);
    await rm(join(project, 'data'), { recursive: true });
    await symlink(outside, join(project, 'data'), 'junction');
    await expect(readJson(project, 'Actors.json')).rejects.toThrow(/escapes/);
    await expect(writeJson(project, 'Actors.json', [null, { id: 1 }])).rejects.toThrow(/escapes/);
    expect(await readFile(join(outside, 'Actors.json'), 'utf8')).toBe('[null]');
    await expect(getProjectIndex(project, true)).rejects.toThrow(/escapes/);
  });

  it('accepts an internal link and rejects a dangling one', async () => {
    const { project } = await fixture();
    await symlink(join(project, 'data'), join(project, 'internal'), 'junction');
    expect(resolveSafePath(project, 'internal/new.json')).toBe(join(project, 'internal/new.json'));
    await symlink(join(project, 'missing'), join(project, 'dangling'), 'junction');
    expect(() => resolveSafePath(project, 'dangling/new.json')).toThrow();
  });

  it('rejects invalid JSON, arrays, invalid fields and MZ while accepting partial MV data', async () => {
    const { project } = await fixture();
    expect(await validateProjectPath(project)).toBe(true);
    for (const invalid of ['broken', 'null', '[]', '{"switches":123}', '{"startX":-1}']) {
      await writeFile(join(project, 'data/System.json'), invalid);
      expect(await validateProjectPath(project)).toBe(false);
    }
    await writeFile(join(project, 'data/System.json'), '\uFEFF{"gameTitle":"Valid"}');
    expect(await validateProjectPath(project)).toBe(true);
    await mkdir(join(project, 'js'));
    await writeFile(join(project, 'js/rmmz_core.js'), 'Utils.RPGMAKER_NAME = "MZ";');
    expect(await validateProjectPath(project)).toBe(false);
  });

  it('finds Japanese, Cyrillic, single-character CJK and normalized Unicode names', () => {
    for (const [name, query] of [['武器屋', '武器屋'], ['店', '店'], ['Кузнец', 'кузнец'], ['Café', 'Cafe\u0301'], ['ＡＢＣ', 'abc']]) {
      expect(rankDocuments([{ type: 'event', id: 1, label: name, text: '' }], query)).toHaveLength(1);
    }
    expect(rankDocuments([{ type: 'event', id: 1, label: 'Blacksmith', text: '' }], 'herrero')).toEqual([]);
  });

  it('reports damaged data instead of implying an empty complete search or clean health', async () => {
    const { project } = await fixture();
    await writeFile(join(project, 'data/Actors.json'), 'broken');
    const search = await analyzeProject(project, { view: 'search', query: 'Harold' }) as { complete: boolean; skippedFiles: string[]; results: unknown[]; noResultsReason: string };
    expect(search.complete).toBe(false);
    expect(search.skippedFiles).toContain('Actors.json');
    expect(search.results).toEqual([]);
    expect(search.noResultsReason).toContain('readable files');
    const index = await getProjectIndex(project, true);
    expect(index.diagnostics?.complete).toBe(false);
    expect(validateProject(index).issues.some(issue => issue.category === 'unreadable-data' && issue.message.includes('Actors.json'))).toBe(true);
  });

  it('refuses a stale read after an editor changes the file; a fresh read permits writing', async () => {
    const { project } = await fixture();
    const file = join(project, 'data/Actors.json');
    await writeFile(file, '[null]');
    await readJson(project, 'Actors.json');
    await writeFile(file, '[null,{"id":1,"name":"Editor"}]');
    await expect(writeJson(project, 'Actors.json', [null])).rejects.toThrow(/changed since/);
    expect(JSON.parse(await readFile(file, 'utf8'))[1].name).toBe('Editor');
    await readJson(project, 'Actors.json');
    await writeJson(project, 'Actors.json', [null]);
    expect(await readFile(file, 'utf8')).toBe('[null]');
  });

  it('refuses competing writers and backup failures without replacing the original', async () => {
    const { project } = await fixture();
    const file = join(project, 'data/Actors.json');
    await writeFile(file, '[null]');
    const lock = join(project, 'data/.Actors.json.mcp-write.lock');
    await writeFile(lock, '');
    await expect(safeWrite(file, '[]')).rejects.toThrow(/locked/);
    await rm(lock);
    await writeFile(join(project, '.mcp-backups'), 'not a directory');
    await expect(safeWrite(file, '[]')).rejects.toThrow(/Backup failed/);
    expect(await readFile(file, 'utf8')).toBe('[null]');
  });
});
