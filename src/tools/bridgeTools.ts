/**
 * bridgeTools.ts — the tool-level surface of the live game bridge.
 *
 * These sit behind `manage_system` actions "bridge_*". The split from
 * bridge/bridge.ts is deliberate: that module owns sockets and state, this one
 * owns argument shaping, the plugin install, and turning a screenshot frame
 * into a file on disk that `analyze_image` can read.
 */
import { mkdir, writeFile, readFile } from 'fs/promises';
import { projectFile } from '../bridge/projectPaths.js';
import { commitStore, commitTextBatch } from '../parity/utils/commit.js';
import {
  startBridge, stopBridge, statusBridge, drainTelemetry, requestCommand, sendCommand, assertBridgeProject,
} from '../bridge/bridge.js';
import { BRIDGE_PLUGIN_NAME, buildBridgePlugin } from '../bridge/pluginSource.js';
import { COMMAND_ACTIONS, HOT_RELOADABLE, isCommandAction, type Command } from '../bridge/protocol.js';

function previewRequested(args: { dryRun?: unknown }): boolean {
  return args.dryRun === true || commitStore.getStore()?.dryRun === true;
}

/** Parse only the editor's JSON assignment; never execute plugin manifests. */
export function parseBridgeManifest(source: string): { prefix: string; entries: Record<string, unknown>[] } {
  const match = source.match(/^([\s\S]*?)(?:var|let|const)\s+\$plugins\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
  if (!match || match[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim()) throw new Error('js/plugins.js must be a plain editor-generated JSON assignment. Nothing changed.');
  const entries: unknown = JSON.parse(match[2]);
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.name !== 'string' || typeof entry.status !== 'boolean')) throw new Error('Invalid plugin manifest. Nothing changed.');
  return { prefix: match[1], entries };
}

export async function installBridgePlugin(projectPath: string, opts: {
  port?: number; telemetryInterval?: number; replaceExisting?: boolean; dryRun?: boolean;
} = {}) {
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) throw new Error('Plugin port must be 1-65535.');
  if (opts.telemetryInterval !== undefined && (!Number.isInteger(opts.telemetryInterval) || opts.telemetryInterval < 1 || opts.telemetryInterval > 3600)) throw new Error('telemetryInterval must be 1-3600 frames.');
  const spec = buildBridgePlugin(opts);
  const header = ['/*:', ' * @plugindesc ' + spec.description, ' * @author ' + spec.author];
  for (const param of spec.params) header.push(' *', ' * @param ' + param.name, ' * @type ' + param.type, ' * @desc ' + param.desc, ' * @default ' + param.default);
  header.push(' *', ' * @help', ...spec.help.split('\n').map((line) => ' * ' + line), ' */');
  const source = header.join('\n') + '\n\n' + spec.body + '\n';
  const pluginPath = await projectFile(projectPath, 'js', 'plugins', BRIDGE_PLUGIN_NAME + '.js');
  const manifestPath = await projectFile(projectPath, 'js', 'plugins.js');
  let old: string | undefined;
  try { old = await readFile(pluginPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (old !== undefined && old !== source && !opts.replaceExisting) throw new Error('McpBridge.js already exists with different contents. Review it before using replaceExisting:true.');
  const manifest = await readFile(manifestPath, 'utf8');
  const { prefix, entries } = parseBridgeManifest(manifest);
  const matches = entries.filter((entry) => entry.name === BRIDGE_PLUGIN_NAME);
  if (matches.length > 1) throw new Error('Duplicate McpBridge manifest entries. Nothing changed.');
  const entry = { name: BRIDGE_PLUGIN_NAME, status: true, description: spec.description,
    parameters: Object.fromEntries(spec.params.map((param) => [param.name, String(param.default)])) };
  const index = entries.findIndex((value) => value.name === BRIDGE_PLUGIN_NAME);
  const unchanged = index >= 0 && JSON.stringify(entries[index]) === JSON.stringify(entry);
  if (index >= 0) entries[index] = entry; else entries.push(entry);
  const manifestText = unchanged ? manifest : prefix + 'var $plugins =\n' + JSON.stringify(entries, null, 4) + ';\n';
  const perform = () => commitTextBatch([{ path: pluginPath, text: source }, { path: manifestPath, text: manifestText }]);
  const changes = opts.dryRun && !commitStore.getStore()?.dryRun
    ? await commitStore.run({ dryRun: true, commits: [] }, perform) : await perform();
  return { name: BRIDGE_PLUGIN_NAME, registered: true, enabled: true, replaced: index >= 0,
    dryRun: changes.some((change) => change.dryRun), changed: changes.some((change) => change.changed),
    files: changes.map((change) => ({ path: change.path, changed: change.changed })),
    note: 'Restart the playtest for the plugin to load. It only activates in test mode.' };
}

export async function bridgeStart(projectPath: string, port?: number, opts: { dryRun?: boolean } = {}) {
  if (previewRequested(opts)) return { dryRun: true, action: 'bridge_start', projectPath, port: port ?? 32123 };
  const status = await startBridge(projectPath, port);
  return {
    ...status,
    note: 'Install the plugin with action "install_bridge_plugin" (once per project), then launch action "playtest".',
  };
}

export async function bridgeStop(opts: { dryRun?: boolean } = {}) {
  if (previewRequested(opts)) return { dryRun: true, action: 'bridge_stop' };
  return stopBridge();
}

export function bridgeStatus() {
  return statusBridge();
}

export function bridgeTelemetry(args: { limit?: number; types?: string[]; peek?: boolean; dryRun?: boolean } = {}) {
  const preview = previewRequested(args);
  const frames = drainTelemetry({ ...args, peek: preview || args.peek });
  const byType: Record<string, number> = {};
  for (const f of frames) byType[f.type] = (byType[f.type] || 0) + 1;
  return { ...(preview ? { dryRun: true } : {}), count: frames.length, byType, frames };
}

/**
 * Send one command to the game. Commands that produce an answer are awaited;
 * `wait: false` turns any of them into fire-and-forget.
 */
export async function bridgeCommand(args: Record<string, unknown>) {
  const action = args.action;
  if (!isCommandAction(action)) {
    throw new Error('Unknown bridge command "' + String(action) + '". Valid: ' + COMMAND_ACTIONS.join(', '));
  }
  const cmd: Omit<Command, 'requestId'> = { action };
  if (action === 'reload_database') {
    const file = String(args.file || '');
    const globalVar = HOT_RELOADABLE[file];
    if (!globalVar) {
      throw new Error(
        'Cannot hot-reload "' + file + '". Reloadable files: ' + Object.keys(HOT_RELOADABLE).join(', ') +
        '. System.json and Tilesets.json need a fresh playtest.'
      );
    }
    cmd.file = file;
    cmd.globalVar = globalVar;
  }
  if (action === 'teleport_player') {
    if (args.x === undefined || args.y === undefined) throw new Error('teleport_player requires x and y.');
    cmd.mapId = args.mapId === undefined ? undefined : Number(args.mapId);
    cmd.x = Number(args.x);
    cmd.y = Number(args.y);
    if (args.direction !== undefined) cmd.direction = Number(args.direction);
  }
  if (action === 'press_button') {
    const button = String(args.button || '');
    if (!['ok', 'cancel', 'menu', 'up', 'down', 'left', 'right'].includes(button)) {
      throw new Error('press_button needs button: ok, cancel, menu, up, down, left or right.');
    }
    cmd.button = button as Command['button'];
    cmd.durationMs = args.durationMs === undefined ? 80 : Number(args.durationMs);
  }
  const timeout = args.timeoutMs === undefined ? 8000 : Number(args.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('timeoutMs must be 1-60000.');
  if (action === 'teleport_player' && (![cmd.x, cmd.y].every((n) => Number.isInteger(n) && Number(n) >= 0) || (cmd.mapId !== undefined && (!Number.isInteger(cmd.mapId) || cmd.mapId < 1)) || (cmd.direction !== undefined && ![2,4,6,8].includes(cmd.direction)))) throw new Error('Invalid transfer coordinates/direction.');
  if (action === 'press_button' && (!Number.isInteger(cmd.durationMs) || Number(cmd.durationMs) < 30 || Number(cmd.durationMs) > 1000)) throw new Error('durationMs must be 30-1000.');
  if (previewRequested(args)) return { dryRun: true, command: cmd };
  if (args.wait === false) {
    const delivered = sendCommand({ ...cmd } as Command);
    return { sent: true, awaited: false, clients: delivered };
  }
  const reply = await requestCommand(cmd, timeout);
  if (reply.type === 'error') {
    throw new Error('Game refused "' + action + '": ' + reply.message);
  }
  return { sent: true, awaited: true, reply };
}

/** Compact sortable timestamp for screenshot filenames: YYYYMMDD-HHMMSS-mmm. */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/**
 * Ask the game for a screenshot and write it to disk. Returns the path rather
 * than the base64 so the agent can hand it straight to `analyze_image` without
 * a megabyte of payload passing through the conversation.
 */
export async function bridgeScreenshot(projectPath: string, args: { timeoutMs?: number; name?: string; dryRun?: boolean } = {}) {
  const name = args.name === undefined ? 'screenshot' : String(args.name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Screenshot name must be 1-64 characters using only letters, numbers, "_" or "-".');
  }
  if (previewRequested(args)) return { dryRun: true, action: 'capture_screenshot', name };
  await assertBridgeProject(projectPath);
  const reply = await requestCommand({ action: 'capture_screenshot' }, args.timeoutMs ?? 15000);
  if (reply.type !== 'screenshot_result') {
    const message = reply.type === 'error' ? reply.message : 'unexpected frame "' + reply.type + '"';
    throw new Error('Screenshot failed: ' + message);
  }
  const dir = await projectFile(projectPath, '.mcp-cache', 'screenshots');
  await mkdir(dir, { recursive: true });
  const file = await projectFile(projectPath, '.mcp-cache', 'screenshots', name + '-' + stamp() + '.png');
  const bytes = captureBytes(reply.base64, reply.mimeType, 'png');
  await writeFile(file, bytes, { flag: 'wx' });
  return { path: file, bytes: bytes.length, mimeType: reply.mimeType, name };
}

export async function bridgeRecordVideo(projectPath: string, args: {
  action: 'start' | 'stop'; name?: string; fps?: number; bitrateKbps?: number; timeoutMs?: number; dryRun?: boolean;
}) {
  const name = args.name === undefined ? 'recording' : String(args.name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Recording name must be 1-64 characters using only letters, numbers, "_" or "-".');
  }
  if (!['start', 'stop'].includes(args.action)) throw new Error('Recording action must be start or stop.');
  if (previewRequested(args)) return { dryRun: true, action: args.action, name };
  await assertBridgeProject(projectPath);
  if (args.action === 'start') {
    const reply = await requestCommand({
      action: 'start_recording',
      fps: args.fps === undefined ? 30 : Number(args.fps),
      bitrateKbps: args.bitrateKbps === undefined ? 2500 : Number(args.bitrateKbps),
    }, args.timeoutMs ?? 15000);
    if (reply.type !== 'recording_started') {
      const message = reply.type === 'error' ? reply.message : 'unexpected frame "' + reply.type + '"';
      throw new Error('Recording start failed: ' + message);
    }
    return { recording: true, name, mimeType: reply.mimeType, fps: reply.fps };
  }
  const reply = await requestCommand({ action: 'stop_recording' }, args.timeoutMs ?? 60000);
  if (reply.type !== 'recording_result') {
    const message = reply.type === 'error' ? reply.message : 'unexpected frame "' + reply.type + '"';
    throw new Error('Recording stop failed: ' + message);
  }
  const dir = await projectFile(projectPath, '.mcp-cache', 'recordings');
  await mkdir(dir, { recursive: true });
  const file = await projectFile(projectPath, '.mcp-cache', 'recordings', name + '-' + stamp() + '.webm');
  const bytes = captureBytes(reply.base64, reply.mimeType, 'webm');
  await writeFile(file, bytes, { flag: 'wx' });
  return { recording: false, path: file, bytes: bytes.length, mimeType: reply.mimeType, durationMs: reply.durationMs, name };
}

/** Bound and validate binary replies before persisting any capture. */
function captureBytes(base64: string, mime: string, format: 'png' | 'webm'): Buffer {
  if (typeof base64 !== 'string' || base64.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid or oversized capture.');
  if (format === 'png' ? mime !== 'image/png' : !/^video\/webm(?:;|$)/.test(mime)) throw new Error('Unexpected capture MIME type.');
  const bytes = Buffer.from(base64, 'base64');
  const signature = format === 'png' ? Buffer.from([137,80,78,71,13,10,26,10]) : Buffer.from([26,69,223,163]);
  if (bytes.length > 24 * 1024 * 1024 || !bytes.subarray(0, signature.length).equals(signature)) throw new Error('Invalid capture signature or size.');
  return bytes;
}
