/**
 * protocol.ts — the wire contract between the MCP server and the in-game
 * McpBridge plugin.
 *
 * The plugin runs inside RPG Maker MV's nwjs runtime and connects OUT to a
 * loopback WebSocket this server owns, so the game is the client and the MCP
 * server is the listener. Everything is JSON with a `type` discriminator:
 * telemetry flows game -> server, commands flow server -> game.
 *
 * Two rules keep this safe (enforced in bridge.ts):
 *  - the game must authenticate with the session token before anything else;
 *  - the server only ever sends commands from COMMAND_ACTIONS — there is no
 *    "evaluate this JS" primitive, by design.
 */

/** Handshake file written into the project root so the plugin can find us. */
export const HANDSHAKE_FILE = '.mcp-bridge.json';

/** Default loopback port. Overridable per start() call or via RPGMV_BRIDGE_PORT. */
export const DEFAULT_PORT = 32123;

/** How long a freshly connected socket has to send `auth` before we drop it. */
export const AUTH_TIMEOUT_MS = 5000;

/** Maximum telemetry frames retained; older ones are dropped. */
export const TELEMETRY_BUFFER_MAX = 500;

/** What the handshake file holds. The plugin reads it with require('fs'). */
export interface Handshake {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

// ── game -> server ─────────────────────────────────────────────────────────

export type Telemetry =
  | { type: 'auth'; token: string }
  | { type: 'ready'; engine: string; mvVersion: string; scene: string }
  | { type: 'scene_change'; from: string; to: string; mapId?: number }
  | { type: 'player_state'; mapId: number; x: number; y: number; direction: number; isMoving: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'exception'; message: string; filename?: string; line?: number; col?: number; stack?: string }
  | { type: 'interpreter_step'; mapId: number; eventId: number; commandIndex: number; code: number; indent: number }
  | { type: 'state_dump'; requestId?: string; switches: Record<string, boolean>; variables: Record<string, number | string>; message?: { allText: string; index: number | null; length: number | null; paused: boolean; visible: boolean; charWidth: number | null; contentWidth: number | null; fontFace: string | null; fontSize: number | null } }
  | { type: 'performance'; fps: number; memoryMB: number }
  | { type: 'screenshot_result'; requestId: string; mimeType: string; base64: string }
  | { type: 'recording_started'; requestId: string; mimeType: string; fps: number }
  | { type: 'recording_result'; requestId: string; mimeType: string; base64: string; durationMs: number }
  | { type: 'reload_complete'; requestId?: string; target: string; mapId?: number; file?: string }
  | { type: 'error'; requestId?: string; message: string };

/** Telemetry as stored in the ring buffer: stamped with ms since bridge start. */
export type StampedTelemetry = Telemetry & { t: number };

// ── server -> game ─────────────────────────────────────────────────────────

/**
 * The complete set of actions the plugin will honor. Anything else is rejected
 * here AND ignored by the plugin, so a hijacked socket cannot widen the
 * surface. Deliberately no `eval` / `run_js`.
 */
export const COMMAND_ACTIONS = [
  'ping',
  'get_state',
  'reload_map',
  'reload_database',
  'capture_screenshot',
  'teleport_player',
  'interact',
  'press_button',
  'start_recording',
  'stop_recording',
] as const;

export type CommandAction = typeof COMMAND_ACTIONS[number];

export interface Command {
  action: CommandAction;
  requestId?: string;
  /** reload_database: which data file and which global to rebind. */
  file?: string;
  globalVar?: string;
  /** teleport_player: destination. */
  mapId?: number;
  x?: number;
  y?: number;
  direction?: number;
  /** press_button: one safe RPG Maker input and how long to hold it. */
  button?: 'ok' | 'cancel' | 'menu' | 'up' | 'down' | 'left' | 'right';
  durationMs?: number;
  /** start_recording: capture settings for the game canvas. */
  fps?: number;
  bitrateKbps?: number;
}

export function isCommandAction(v: unknown): v is CommandAction {
  return typeof v === 'string' && (COMMAND_ACTIONS as readonly string[]).includes(v);
}

/**
 * Which `$data*` global each data file binds to, for reload_database. Only
 * files the engine re-reads on every lookup are listed — System.json and
 * Tilesets.json need a scene restart, so they are not hot-reload targets.
 */
export const HOT_RELOADABLE: Record<string, string> = {
  'Actors.json': '$dataActors',
  'Classes.json': '$dataClasses',
  'Skills.json': '$dataSkills',
  'Items.json': '$dataItems',
  'Weapons.json': '$dataWeapons',
  'Armors.json': '$dataArmors',
  'Enemies.json': '$dataEnemies',
  'Troops.json': '$dataTroops',
  'States.json': '$dataStates',
  'CommonEvents.json': '$dataCommonEvents',
};
