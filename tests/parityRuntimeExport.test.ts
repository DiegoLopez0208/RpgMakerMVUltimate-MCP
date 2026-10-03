import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportWeb } from '../src/parity/tools/exportTools.js';
import { installBridgePlugin, bridgeStart, bridgeStop, bridgeCommand, bridgeScreenshot, parseBridgeManifest } from '../src/tools/bridgeTools.js';
import { statusBridge, stopBridge } from '../src/bridge/bridge.js';
import { startStaticServer } from '../src/parity/playtest/staticServer.js';

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mv-runtime-export-'));
  dirs.push(root);
  for (const dir of ['data', 'js/plugins', 'img/pictures', 'img/system', 'audio/bgm', 'img/animations']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html>MV</html>');
  await writeFile(join(root, 'js/plugins.js'), '// editor manifest\nvar $plugins = [];\n');
  await writeFile(join(root, 'js/rpg_managers.js'), 'SceneManager._screenWidth = 816; SceneManager._screenHeight = 624;');
  await writeFile(join(root, 'data/System.json'), JSON.stringify({ hasEncryptedImages: true, hasEncryptedAudio: true, encryptionKey: '1234567890', title: 'Hero', bgm: { name: 'Theme' } }));
  await writeFile(join(root, 'data/Animations.json'), JSON.stringify([null, { animation1Name: 'Spark', animation2Name: '' }]));
  for (const rel of ['img/pictures/Hero.rpgmvp', 'img/pictures/Unused.rpgmvp', 'img/system/Window.rpgmvp', 'img/animations/Spark.rpgmvp', 'audio/bgm/Theme.rpgmvo', 'audio/bgm/Theme.rpgmvm']) await writeFile(join(root, rel), Buffer.from([82,80,71,77,86,0,1,2,3]));
  return root;
}
afterEach(async () => {
  await stopBridge();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('MV encrypted web export', () => {
  it('preserves encrypted asset bytes, both audio variants, animation sheets and encryption metadata', async () => {
    const root = await fixture();
    const result = await exportWeb(root, { outDir: 'web', zip: true });
    expect(result.droppedList).toContain('img/pictures/Unused.rpgmvp');
    for (const rel of ['img/pictures/Hero.rpgmvp', 'img/animations/Spark.rpgmvp', 'img/system/Window.rpgmvp', 'audio/bgm/Theme.rpgmvo', 'audio/bgm/Theme.rpgmvm', 'data/System.json']) expect(await readFile(join(root, 'web', rel))).toEqual(await readFile(join(root, rel)));
    expect((await readFile(result.zipPath!)).subarray(0, 4)).toEqual(Buffer.from([80,75,3,4]));
    expect(result.screen).toEqual({ width: 816, height: 624 });
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
});

describe('protected MV bridge installation', () => {
  it('previews, installs, preserves idempotence and requires explicit replacement', async () => {
    const root = await fixture();
    const manifest = await readFile(join(root, 'js/plugins.js'));
    expect((await installBridgePlugin(root, { dryRun: true })).dryRun).toBe(true);
    expect(await readdir(join(root, 'js/plugins'))).toEqual([]);
    expect(await readFile(join(root, 'js/plugins.js'))).toEqual(manifest);
    expect((await installBridgePlugin(root)).changed).toBe(true);
    expect((await installBridgePlugin(root)).changed).toBe(false);
    const plugin = join(root, 'js/plugins/McpBridge.js');
    await writeFile(plugin, 'custom original');
    await expect(installBridgePlugin(root)).rejects.toThrow(/replaceExisting/);
    expect(await readFile(plugin, 'utf8')).toBe('custom original');
    await installBridgePlugin(root, { replaceExisting: true });
    expect(await readFile(plugin, 'utf8')).toContain("case 'start_recording'");
  });
  it('refuses executable or malformed manifests before writing the plugin', async () => {
    const root = await fixture();
    expect(() => parseBridgeManifest('doSomething(); var $plugins=[];')).toThrow(/plain/);
    await writeFile(join(root, 'js/plugins.js'), 'var $plugins = [badCode()];');
    await expect(installBridgePlugin(root)).rejects.toThrow();
    expect(await readdir(join(root, 'js/plugins'))).toEqual([]);
  });
  it('runtime dry runs have no socket, capture or command effects', async () => {
    const root = await fixture();
    await bridgeStart(root, 0, { dryRun: true });
    expect(statusBridge().running).toBe(false);
    expect(await bridgeCommand({ action: 'press_button', button: 'ok', dryRun: true })).toMatchObject({ dryRun: true });
    await bridgeScreenshot(root, { dryRun: true });
    await bridgeStop({ dryRun: true });
    expect(await readdir(root)).not.toContain('.mcp-cache');
  });
  it('does not serve hidden credentials or project-external junction files', async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(root, '.mcp-bridge.json'), 'secret');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const server = await startStaticServer(root);
    try {
      expect((await fetch(server.origin + '/.mcp-bridge.json')).status).toBe(403);
      expect((await fetch(server.origin + '/linked/data/System.json')).status).toBe(404);
    } finally { await server.close(); }
  });
});
