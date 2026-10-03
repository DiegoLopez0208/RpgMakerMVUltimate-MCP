import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { dispatchTool } from '../src/server.js';
import { getProjectPath, initProjectPath } from '../src/tools/projectTools.js';
import { startBridge, statusBridge, stopBridge } from '../src/bridge/bridge.js';
import { bridgeCommand, bridgeScreenshot, bridgeRecordVideo } from '../src/tools/bridgeTools.js';
import { commitStore } from '../src/parity/utils/commit.js';

const dirs: string[] = [];
const originalProject = getProjectPath();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mv-runtime-dispatch-'));
  dirs.push(root);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/System.json'), '{}');
  return root;
}
afterEach(async () => {
  await stopBridge();
  initProjectPath(originalProject);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('runtime previews through consolidated dispatch', () => {
  it('preserves screenshot and recording dryRun through validation and routing', async () => {
    const root = await fixture();
    initProjectPath(root);
    for (const [name, args] of [
      ['take_screenshot', {}],
      ['record_video', { action: 'start' }],
      ['record_video', { action: 'stop' }],
      ['manage_system', { action: 'take_screenshot' }],
    ] as const) {
      const result = await dispatchTool(name, { ...args, dryRun: true }) as { result: { dryRun: boolean } };
      expect(result.result.dryRun).toBe(true);
    }
    expect(statusBridge().running).toBe(false);
    expect(await readdir(root)).toEqual(['data']);
  });

  it('honors the outer commit preview even when an intermediate caller omits the flag', async () => {
    const root = await fixture();
    await commitStore.run({ dryRun: true, commits: [] }, async () => {
      expect(await bridgeScreenshot(root)).toMatchObject({ dryRun: true });
      expect(await bridgeRecordVideo(root, { action: 'start' })).toMatchObject({ dryRun: true });
      expect(await bridgeCommand({ action: 'press_button', button: 'ok' })).toMatchObject({ dryRun: true });
    });
    expect(await readdir(root)).toEqual(['data']);
  });
});

describe('project retargeting', () => {
  it('keeps the active bridge for invalid, unchanged, and previewed targets; closes it only on a real change', async () => {
    const first = await fixture();
    const second = await fixture();
    initProjectPath(first);
    const initial = await startBridge(first, 0);
    const handshake = await readFile(initial.handshakeFile!);
    await expect(dispatchTool('set_project_path', { path: join(first, 'missing') })).rejects.toThrow(/Invalid project path/);
    expect(getProjectPath()).toBe(first);
    expect(statusBridge().port).toBe(initial.port);
    await dispatchTool('set_project_path', { path: join(first, '.') });
    expect(statusBridge().port).toBe(initial.port);
    expect(await readFile(initial.handshakeFile!)).toEqual(handshake);
    await dispatchTool('set_project_path', { path: second, dryRun: true });
    expect(getProjectPath()).toBe(first);
    expect(statusBridge().port).toBe(initial.port);
    await dispatchTool('set_project_path', { path: second });
    expect(getProjectPath()).toBe(second);
    expect(statusBridge().running).toBe(false);
    await expect(readFile(initial.handshakeFile!)).rejects.toThrow();
  });
});
