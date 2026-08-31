/**
 * bridgeTools.ts — the tool-level surface of the live game bridge.
 *
 * These sit behind `manage_system` actions "bridge_*". The split from
 * bridge/bridge.ts is deliberate: that module owns sockets and state, this one
 * owns argument shaping, the plugin install, and turning a screenshot frame
 * into a file on disk that `analyze_image` can read.
 */
import { mkdir, writeFile } from 'fs/promises';
import { resolveSafePath } from '../utils/security.js';
import { createPlugin } from './pluginTools.js';
import {
  startBridge, stopBridge, statusBridge, drainTelemetry, requestCommand, sendCommand,
} from '../bridge/bridge.js';
import { BRIDGE_PLUGIN_NAME, buildBridgePlugin } from '../bridge/pluginSource.js';
import { COMMAND_ACTIONS, HOT_RELOADABLE, isCommandAction, type Command } from '../bridge/protocol.js';

/** Write js/plugins/McpBridge.js and register it. Safe to re-run: it overwrites. */
export async function installBridgePlugin(projectPath: string, opts: { port?: number; telemetryInterval?: number } = {}) {
  const spec = buildBridgePlugin(opts);
  const result = await createPlugin(projectPath, {
    name: BRIDGE_PLUGIN_NAME,
    description: spec.description,
    author: spec.author,
    help: spec.help,
    params: spec.params,
    body: spec.body,
    status: true,
  });
  return {
    ...result,
    note: 'Restart the playtest for the plugin to load. It only activates in test mode.',
  };
}

export async function bridgeStart(projectPath: string, port?: number) {
  const status = await startBridge(projectPath, port);
  return {
    ...status,
    note: 'Install the plugin with action "install_bridge_plugin" (once per project), then launch action "playtest".',
  };
}

export async function bridgeStop() {
  return stopBridge();
}

export function bridgeStatus() {
  return statusBridge();
}

export function bridgeTelemetry(args: { limit?: number; types?: string[]; peek?: boolean } = {}) {
  const frames = drainTelemetry(args);
  const byType: Record<string, number> = {};
  for (const f of frames) byType[f.type] = (byType[f.type] || 0) + 1;
  return { count: frames.length, byType, frames };
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
  if (args.wait === false) {
    const delivered = sendCommand({ ...cmd } as Command);
    return { sent: true, awaited: false, clients: delivered };
  }
  const timeout = args.timeoutMs === undefined ? 8000 : Number(args.timeoutMs);
  const reply = await requestCommand(cmd, timeout);
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
export async function bridgeScreenshot(projectPath: string, args: { timeoutMs?: number } = {}) {
  const reply = await requestCommand({ action: 'capture_screenshot' }, args.timeoutMs ?? 15000);
  if (reply.type !== 'screenshot_result') {
    const message = reply.type === 'error' ? reply.message : 'unexpected frame "' + reply.type + '"';
    throw new Error('Screenshot failed: ' + message);
  }
  const dir = resolveSafePath(projectPath, '.mcp-cache', 'screenshots');
  await mkdir(dir, { recursive: true });
  const file = resolveSafePath(projectPath, '.mcp-cache', 'screenshots', 'screenshot-' + stamp() + '.png');
  const bytes = Buffer.from(reply.base64, 'base64');
  await writeFile(file, bytes);
  return { path: file, bytes: bytes.length, mimeType: reply.mimeType };
}
