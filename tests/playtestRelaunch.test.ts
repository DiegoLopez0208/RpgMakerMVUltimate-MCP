import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { playtest, stopGameProcess, stopPlaytest } from '../src/tools/runTools.js';

// `node <dir> test` runs the directory's package.json "main", which here just stays alive: a stand-in
// for NW.js that needs no engine install (playtest accepts an explicit gameExe).
let project: string;
const pids: number[] = [];

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function exited(pid: number, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
const launch = async (extra: Record<string, unknown> = {}) => {
  const result = await playtest(project, { gameExe: process.execPath, ...extra });
  if (result.pid) pids.push(result.pid);
  // give the process a moment to exist as a named process before the next call looks at it
  await new Promise((r) => setTimeout(r, 300));
  return result;
};

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-relaunch-'));
  writeFileSync(path.join(project, 'index.html'), '');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'g', main: 'alive.js' }));
  writeFileSync(path.join(project, 'alive.js'), 'require("fs").writeFileSync(__dirname + "/argv.json", JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000);');
});
afterEach(async () => {
  await stopPlaytest(project);
  const left = pids.splice(0);
  // false means already gone, or a pid that is now someone else's: either way, leave it alone
  for (const pid of left) stopGameProcess(pid, process.execPath);
  // on Windows a process still running inside the folder keeps it from being removed
  for (const pid of left) await exited(pid);
  rmSync(project, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

describe('playtest relaunch', () => {
  it('closes the game an earlier playtest started before launching the next one', async () => {
    const first = await launch();
    expect(first.replacedPid).toBeNull();
    expect(alive(first.pid as number)).toBe(true);
    const second = await launch();
    expect(second.replacedPid).toBe(first.pid);
    expect(await exited(first.pid as number)).toBe(true);
    expect(alive(second.pid as number)).toBe(true);
  });

  it('gives each project its own NW.js profile, so a launch is never handed to a game that is already open', async () => {
    await launch();
    const args = JSON.parse(readFileSync(path.join(project, 'argv.json'), 'utf8')) as string[];
    expect(args).toEqual(['test', '--user-data-dir=' + path.join(project, '.mcp-cache', 'nw-profile')]);
  });

  it('leaves the earlier game open with keepRunning', async () => {
    const first = await launch();
    const second = await launch({ keepRunning: true });
    expect(second.replacedPid).toBeNull();
    expect(alive(first.pid as number)).toBe(true);
    expect(alive(second.pid as number)).toBe(true);
  });

  it('stop_playtest closes the game, and says so when there is nothing to close', async () => {
    expect(await stopPlaytest(project)).toMatchObject({ stopped: false });
    const game = await launch();
    expect(await stopPlaytest(project)).toEqual({ stopped: true, pid: game.pid });
    expect(await exited(game.pid as number)).toBe(true);
    expect(await stopPlaytest(project)).toMatchObject({ stopped: false });
  });
});

describe('stopGameProcess', () => {
  it('never touches a process that is not the executable that was launched', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    pids.push(child.pid as number);
    await new Promise((r) => setTimeout(r, 300));
    expect(stopGameProcess(child.pid as number, 'C:/engine/Game.exe')).toBe(false);
    expect(alive(child.pid as number)).toBe(true);
  });

  it('reports a pid that no longer exists as not stopped', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid as number;
    await exited(pid);
    expect(stopGameProcess(pid, process.execPath)).toBe(false);
  });
});
