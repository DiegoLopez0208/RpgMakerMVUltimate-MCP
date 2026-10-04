import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportWeb } from '../src/tools/exportTools.js';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';

// Ported from #20's runtime export tests, plus the opt-in pruning and zip protection added here.
const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mv-web-export-'));
  dirs.push(root);
  for (const dir of ['data', 'js/plugins', 'img/pictures', 'img/system', 'audio/bgm', 'img/animations']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html>MV</html>');
  await writeFile(join(root, 'js/plugins.js'), '// editor manifest\nvar $plugins = [];\n');
  await writeFile(join(root, 'js/rpg_managers.js'), 'SceneManager._screenWidth = 816; SceneManager._screenHeight = 624;');
  await writeFile(join(root, 'data/System.json'), JSON.stringify({ hasEncryptedImages: true, hasEncryptedAudio: true, encryptionKey: '1234567890', title: 'Hero', bgm: { name: 'Theme' } }));
  await writeFile(join(root, 'data/Animations.json'), JSON.stringify([null, { animation1Name: 'Spark', animation2Name: '' }]));
  for (const rel of ['img/pictures/Hero.rpgmvp', 'img/pictures/Unused.rpgmvp', 'img/system/Window.rpgmvp', 'img/animations/Spark.rpgmvp', 'audio/bgm/Theme.rpgmvo', 'audio/bgm/Theme.rpgmvm']) {
    await writeFile(join(root, rel), Buffer.from([82, 80, 71, 77, 86, 0, 1, 2, 3]));
  }
  // Only a hero picture name appears in the data, so with pruning Unused.rpgmvp is dropped.
  await writeFile(join(root, 'data/Actors.json'), JSON.stringify([null, { id: 1, name: 'Hero', faceName: 'Hero' }]));
  return root;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('export_web', () => {
  it('preserves encrypted asset bytes, both audio variants, animation sheets and encryption metadata', async () => {
    const root = await fixture();
    const result = await exportWeb(root, { outDir: join(root, '..', 'web-' + root.split(/[\\/]/).pop()), zip: true, prune: true });
    dirs.push(result.outDir, result.zipPath!);
    expect(result.droppedList).toContain('img/pictures/Unused.rpgmvp');
    for (const rel of ['img/pictures/Hero.rpgmvp', 'img/animations/Spark.rpgmvp', 'img/system/Window.rpgmvp', 'audio/bgm/Theme.rpgmvo', 'audio/bgm/Theme.rpgmvm', 'data/System.json']) {
      expect(await readFile(join(result.outDir, rel))).toEqual(await readFile(join(root, rel)));
    }
    expect((await readFile(result.zipPath!)).subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
    expect(result.screen).toEqual({ width: 816, height: 624 });
  });

  it('keeps every asset unless pruning is asked for', async () => {
    const root = await fixture();
    const outDir = join(root, '..', 'web-full-' + root.split(/[\\/]/).pop());
    dirs.push(outDir, outDir + '.zip');
    const result = await exportWeb(root, { outDir, zip: false });
    expect(result.dropped).toBe(0);
    expect(await readdir(join(outDir, 'img/pictures'))).toContain('Unused.rpgmvp');
  });

  it('previews without writing, refuses source paths and unmarked output, excludes backups', async () => {
    const root = await fixture();
    await mkdir(join(root, 'js/plugins.js.mcp-backups'));
    await writeFile(join(root, 'js/plugins.js.mcp-backups/secret.js'), 'old source');
    await writeFile(join(root, 'js/private.js.bak'), 'old source');
    const before = await readdir(root);
    const preview = await exportWeb(root, { outDir: 'web', dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(await readdir(root)).toEqual(before);
    await expect(exportWeb(root, { outDir: 'js' })).rejects.toThrow(/inside/);
    await mkdir(join(root, 'occupied'));
    await writeFile(join(root, 'occupied/keep.txt'), 'preserve');
    await expect(exportWeb(root, { outDir: 'occupied' })).rejects.toThrow(/not empty/);
    await exportWeb(root, { outDir: 'web', zip: false });
    expect(await readdir(join(root, 'web/js'))).toEqual(expect.not.arrayContaining(['plugins.js.mcp-backups', 'private.js.bak']));
  });

  it('never overwrites a zip that a previous export did not write', async () => {
    const root = await fixture();
    await writeFile(join(root, 'release.zip'), 'my own archive');
    await expect(exportWeb(root, { outDir: 'release' })).rejects.toThrow(/release\.zip already exists/);
    expect(await readFile(join(root, 'release.zip'), 'utf8')).toBe('my own archive');
    // A previous export's zip, though, is replaced along with its folder.
    const first = await exportWeb(root, { outDir: 'build' });
    const second = await exportWeb(root, { outDir: 'build' });
    expect(second.zipPath).toBe(first.zipPath);
  });

  it('is reachable as manage_system action export_web', async () => {
    const root = await fixture();
    initProjectPath(root);
    const result = await dispatchTool('manage_system', { action: 'export_web', outDir: 'dist-web', zip: false }) as { files: number; outDir: string };
    expect(result.files).toBeGreaterThan(5);
    expect(await readFile(join(result.outDir, 'index.html'), 'utf8')).toBe('<html>MV</html>');
    await expect(dispatchTool('manage_system', { action: 'export_web' })).rejects.toThrow(/outDir/);
  });
});
