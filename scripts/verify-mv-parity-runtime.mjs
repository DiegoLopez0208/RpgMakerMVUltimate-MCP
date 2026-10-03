#!/usr/bin/env node
// Requires the user's own licensed engine in a disposable fixture, never engine files in this repo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderMap } from '../dist/parity/playtest/render.js';
import { runPlaytest } from '../dist/parity/playtest/playtest.js';
import { exportWeb } from '../dist/parity/tools/exportTools.js';
import { startBridge, stopBridge, statusBridge, drainTelemetry } from '../dist/bridge/bridge.js';
import { installBridgePlugin, parseBridgeManifest, bridgeCommand, bridgeScreenshot, bridgeRecordVideo } from '../dist/tools/bridgeTools.js';
import { playtest } from '../dist/tools/runTools.js';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), args[index + 1]]);
  return pairs;
}, []));
assert.ok(options.project && options['disposable-fixture'] === 'yes',
  'Usage: node scripts/verify-mv-parity-runtime.mjs --project /disposable/mv-project --disposable-fixture yes [--runtime /path/to/game.exe]');
const project = resolve(options.project);
const output = join(project, '.mcp-cache', 'parity-verification');
const mapPath = join(project, 'data', 'Map001.json');
const packagePath = join(project, 'package.json');
const manifestPath = join(project, 'js', 'plugins.js');
const shimPath = join(project, 'js', 'plugins', 'McpParitySmokeHarness.js');
const originalMap = await readFile(mapPath, 'utf8');
const originalPackage = await readFile(packagePath, 'utf8');
const originalManifest = await readFile(manifestPath, 'utf8');
const system = JSON.parse(await readFile(join(project, 'data', 'System.json'), 'utf8'));
const map = JSON.parse(originalMap);
assert.ok(map.events.every((event) => !event), 'Use a disposable Map001 with no existing events.');
assert.equal(system.startMapId, 1);
assert.ok(system.startX > 0 && system.startX < 19 && system.startY > 0 && system.startY < 14);
let childPid;
let shimCreated = false;
let installedManifest;
const command = (code, parameters = [], indent = 0) => ({ code, indent, parameters });
const commands = [
  command(121, [1, 1, 0]), command(122, [1, 1, 0, 0, 42]),
  command(355, ['console.warn("MV_MCP_PARITY_SMOKE");']),
  command(101, ['', 0, 0, 2]), command(401, ['MV bridge and headless event executed.']),
  command(102, [['First', 'Second'], -2, 0, 2, 0]),
  command(402, [0, 'First']), command(121, [2, 2, 1], 1), command(0, [], 1),
  command(402, [1, 'Second']), command(121, [2, 2, 0], 1), command(0, [], 1),
  command(403), command(0, [], 1), command(404), command(0),
];
const page = {
  conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false,
    switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
  directionFix: false, image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
  list: commands, moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
  moveSpeed: 3, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: 0, walkAnime: true,
};

const runtime = async (args) => (await bridgeCommand(args)).reply;
async function until(name, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const errors = drainTelemetry({ types: ['exception', 'log'], peek: true }).filter((frame) => frame.type === 'exception' || frame.level === 'error');
    assert.equal(errors.length, 0, JSON.stringify(errors.slice(0, 3)));
    const result = await predicate();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`${name} did not finish. Telemetry: ${JSON.stringify(drainTelemetry({ limit: 8 }))}`);
}

try {
  await mkdir(output, { recursive: true });
  map.width = 21; map.height = 15; map.tilesetId = 2;
  map.data = [...Array(21 * 15).fill(2816), ...Array(21 * 15 * 5).fill(0)];
  map.encounterList = []; map.autoplayBgm = false; map.autoplayBgs = false;
  map.events[1] = { id: 1, name: 'MCP parity smoke', note: '', x: system.startX, y: system.startY, pages: [page] };
  await writeFile(mapPath, JSON.stringify(map));

  if (options['live-only'] !== 'yes') {
  const whole = await renderMap(project, { mapId: 1, out: join(output, 'whole-map.png') });
  const view = await renderMap(project, { mapId: 1, x: 8, y: 6, out: join(output, 'viewport.png') });
  assert.deepEqual(whole.problems, []); assert.deepEqual(view.problems, []);
  assert.deepEqual(whole.pixels, { width: 1008, height: 720 });
  const png = await readFile(whole.path);
  assert.equal(png.readUInt32BE(16), 1008); assert.equal(png.readUInt32BE(20), 720);
  const progress = [];
  const steps = [
    { action: 'load', mapId: 1, x: system.startX, y: system.startY, party: [1], level: 50, variables: { 3: 8 }, gold: 99 },
    { action: 'walk', direction: 'right' }, { action: 'walk', direction: 'left' },
    { action: 'startEvent', eventId: 1 }, { action: 'advanceText' }, { action: 'choose', index: 1 }, { action: 'advanceText' },
    { action: 'eval', script: '({branch:$gameSwitches.value(2), variable:$gameVariables.value(1), loaded:$gameVariables.value(3)})' },
    { action: 'autoBattle', troopId: 1, canLose: true }, { action: 'screenshot', name: 'after-battle' },
  ];
  const run = await runPlaytest(project, steps, { out: output, onProgress: (...args) => progress.push(args) });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(run.problems, []);
  assert.equal(run.steps[1].walked, 1);
  assert.deepEqual(run.steps[4].choices, ['First', 'Second']);
  assert.deepEqual(run.steps[7].value, { branch: true, variable: 42, loaded: 8 });
  assert.equal(run.steps[8].outcome, 'victory');
  assert.ok(progress.length >= steps.length + 2);
  console.log(JSON.stringify({ headless: 'PASS', whole: whole.path, view: view.path, steps: run.steps.length, battle: run.steps[8].outcome, screenshots: run.screenshots, progress: progress.length }));
  const exported = await exportWeb(project, { outDir: join(output, 'web'), zip: true });
  const deployment = await renderMap(exported.outDir, { mapId: 1, out: join(output, 'exported-map.png') });
  assert.deepEqual(deployment.problems, []);
  console.log(JSON.stringify({ export: 'PASS', files: exported.files, dropped: exported.dropped, zipBytes: exported.zipBytes, screenshot: deployment.path }));

  }

  if (options.runtime) {
    await installBridgePlugin(project, { replaceExisting: true });
    installedManifest = await readFile(manifestPath, 'utf8');
    const manifest = parseBridgeManifest(installedManifest);
    assert.ok(!manifest.entries.some((entry) => entry.name === 'McpParitySmokeHarness'));
    // Hidden NW windows throttle RAF. This disposable verification shim drives
    // MV's update loop with a timer; production bridge code never changes focus/rendering.
    await writeFile(shimPath, 'SceneManager.requestUpdate = function() {}; setInterval(function() { if ((SceneManager._scene || SceneManager._nextScene) && !SceneManager._stopped) SceneManager.update(); }, 16);\n', { flag: 'wx' });
    shimCreated = true;
    manifest.entries.push({ name: 'McpParitySmokeHarness', status: true, description: 'Temporary fixture smoke harness', parameters: {} });
    await writeFile(manifestPath, 'var $plugins = ' + JSON.stringify(manifest.entries) + ';\n');
    const pkg = JSON.parse(originalPackage);
    pkg.window = { ...pkg.window, show: false };
    pkg['chromium-args'] = (pkg['chromium-args'] || '') + ' --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows';
    await writeFile(packagePath, JSON.stringify(pkg));
    await startBridge(project, 0);
    const launched = await playtest(project, { gameExe: options.runtime });
    childPid = launched.pid;
    console.log(`Launched disposable MV fixture PID ${childPid}.`);
    await until('Authentication', () => statusBridge().authenticatedClients === 1);
    await until('Title', async () => (await runtime({ action: 'get_state' })).scene === 'Scene_Title');
    const start = await runtime({ action: 'start_new_game', timeoutMs: 20000 });
    assert.equal(start.target, 'transfer');
    await delay(800);
    await runtime({ action: 'interact' });
    const state = await until('Event', async () => {
      const state = await runtime({ action: 'get_state' });
      return state.variables[1] === 42 && state.message.busy && state;
    });
    assert.equal(state.switches[1], true); assert.equal(state.currentEvent.eventId, 1);
    await delay(700);
    const screenshot = await bridgeScreenshot(project, { name: 'mv-parity-live' });
    await runtime({ action: 'press_button', button: 'ok' });
    await delay(400);
    await runtime({ action: 'press_button', button: 'down' });
    await runtime({ action: 'press_button', button: 'ok' });
    await until('Message close', async () => !(await runtime({ action: 'get_state' })).message.busy);
    await delay(200);
    const transfer = await runtime({ action: 'teleport_player', mapId: 1, x: 9, y: 7, direction: 4 });
    assert.deepEqual([transfer.mapId, transfer.x, transfer.y], [1, 9, 7]);
    await delay(300);
    const reload = await runtime({ action: 'reload_map' });
    assert.equal(reload.target, 'map');
    const db = await runtime({ action: 'reload_database', file: 'Skills.json' });
    assert.equal(db.target, 'database');
    await bridgeRecordVideo(project, { action: 'start', name: 'mv-parity-live' });
    await delay(1100);
    const video = await bridgeRecordVideo(project, { action: 'stop', name: 'mv-parity-live' });
    const telemetry = drainTelemetry();
    assert.ok(telemetry.some((frame) => frame.type === 'performance'));
    assert.equal(telemetry.filter((frame) => frame.type === 'exception').length, 0);
    console.log(JSON.stringify({ live: 'PASS', screenshot: screenshot.path, video: video.path, bytes: video.bytes, transfer, telemetry: telemetry.length }));
  }
} catch (error) {
  console.error('Recent telemetry:', JSON.stringify(drainTelemetry({ limit: 12 })));
  console.error('Runtime state:', JSON.stringify(await runtime({ action: 'get_state', timeoutMs: 1000 }).catch(() => null)));
  throw error;
} finally {
  if (childPid) await new Promise((done) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', done); killer.once('error', done);
    } else { try { process.kill(childPid); } catch { /* already stopped */ } done(); }
  });
  await stopBridge();
  await writeFile(mapPath, originalMap);
  await writeFile(packagePath, originalPackage);
  await writeFile(manifestPath, installedManifest ?? originalManifest);
  if (shimCreated) await unlink(shimPath);
}
