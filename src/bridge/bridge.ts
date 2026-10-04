/**
 * bridge.ts — the live link between the MCP server and a running playtest.
 *
 * `playtest` used to be fire-and-forget: the agent launched the game and got
 * nothing back. With the bridge running, the McpBridge plugin inside the game
 * connects to a loopback WebSocket and streams telemetry (exceptions, scene
 * changes, player position) into a ring buffer the agent drains; the agent can
 * also send a small, fixed set of commands back and await the reply.
 *
 * The bridge is a process-wide singleton because the MCP server serializes tool
 * calls and there is exactly one active project at a time.
 *
 * Security posture, in order of who it stops:
 *  - the socket binds 127.0.0.1 only, so nothing off-box can reach it;
 *  - a browser Origin is refused at the handshake (wsServer.ts);
 *  - every connection must present the session token within AUTH_TIMEOUT_MS,
 *    which is what actually stops a non-browser local process;
 *  - the token must come with the realpath of the bridge's project, so a game
 *    from another project cannot attach to it;
 *  - outbound commands are restricted to COMMAND_ACTIONS — there is no way to
 *    ask the game to evaluate arbitrary JavaScript;
 *  - frames and the telemetry buffer are size-capped, so a misbehaving game
 *    cannot grow the server's memory without bound.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { writeFile, unlink, readFile, realpath } from 'fs/promises';
import path from 'path';
import { projectFile } from './projectPaths.js';
import * as logger from '../utils/logger.js';
import { startWsServer, type WsConnection, type WsServer } from './wsServer.js';
import {
  AUTH_TIMEOUT_MS, DEFAULT_PORT, HANDSHAKE_FILE, TELEMETRY_BUFFER_MAX,
  isCommandAction, type Command, type Handshake, type StampedTelemetry, type Telemetry,
} from './protocol.js';

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  projectPath: string | null;
  clients: number;
  authenticatedClients: number;
  buffered: number;
  droppedFrames: number;
  startedAt: string | null;
  handshakeFile: string | null;
  /** Why the last game that tried to connect was turned away, until one succeeds. */
  lastAuthError: string | null;
}

interface Pending {
  resolve: (t: StampedTelemetry) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let server: WsServer | null = null;
let token = '';
let projectRoot = '';
let startedAtMs = 0;
let startedAtIso: string | null = null;
let handshakePath: string | null = null;
let dropped = 0;
let requestSeq = 0;
let bufferedBytes = 0;
let lastAuthError: string | null = null;
/** A telemetry frame larger than this is dropped rather than buffered. */
const FRAME_LIMIT = 64 * 1024;
/** Total bytes of buffered telemetry; the oldest frames go first past this. */
const BUFFER_LIMIT = 2 * 1024 * 1024;
const frameSizes = new WeakMap<StampedTelemetry, number>();

const buffer: StampedTelemetry[] = [];
const pending = new Map<string, Pending>();

interface AuthWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const authWaiters = new Set<AuthWaiter>();

function settleAuthWaiters(error?: Error): void {
  for (const waiter of authWaiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error); else waiter.resolve();
  }
  authWaiters.clear();
}

function waitForAuthenticatedClient(timeoutMs: number): Promise<void> {
  if (authedConnections().length > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter: AuthWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        authWaiters.delete(waiter);
        reject(new Error(
          'No authenticated game client connected within ' + timeoutMs +
          'ms. Is the playtest running with the McpBridge plugin enabled?'
        ));
      }, timeoutMs),
    };
    authWaiters.add(waiter);
  });
}

/** Constant-time token comparison so a local process cannot time its way in. */
function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !token) return false;
  const a = Buffer.from(candidate, 'utf-8');
  const b = Buffer.from(token, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthed(conn: WsConnection): boolean {
  return conn.meta.authed === true;
}

function push(frame: Telemetry): void {
  const stamped = { ...frame, t: Date.now() - startedAtMs } as StampedTelemetry;
  // Binary capture replies are delivered directly to their waiter. Keeping a
  // second base64 copy in telemetry wastes tens of MB for a short video.
  if (frame.type !== 'screenshot_result' && frame.type !== 'recording_result') {
    const bytes = Buffer.byteLength(JSON.stringify(stamped));
    if (bytes <= FRAME_LIMIT) {
      buffer.push(stamped);
      frameSizes.set(stamped, bytes);
      bufferedBytes += bytes;
      while (buffer.length > TELEMETRY_BUFFER_MAX || bufferedBytes > BUFFER_LIMIT) {
        bufferedBytes -= frameSizes.get(buffer.shift()!) ?? 0;
        dropped++;
      }
    } else {
      dropped++;
    }
  }
  const id = (frame as { requestId?: string }).requestId;
  if (id) {
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(stamped);
    }
  }
}

function handleMessage(conn: WsConnection, text: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    conn.close(1003, 'expected JSON');
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'auth') {
    if (!tokenMatches(msg.token)) {
      logger.warn('Bridge auth rejected', { conn: conn.id });
      conn.close(4401, 'bad token');
      return;
    }
    if (msg.projectPath === undefined) {
      // Plugins installed before project-bound auth send only the token.
      lastAuthError = 'The game runs an outdated McpBridge plugin. Run manage_system action "install_bridge_plugin", then restart the playtest.';
      logger.warn('Bridge auth rejected: outdated plugin', { conn: conn.id });
      conn.close(4426, 'outdated plugin');
      return;
    }
    if (!samePath(msg.projectPath, projectRoot)) {
      // Both paths are reported: a mismatch here is almost always a junction, subst
      // drive or casing difference, and the two strings make that obvious.
      lastAuthError = 'A game from another folder presented the token: game "' + String(msg.projectPath) + '", bridge "' + projectRoot + '".';
      logger.warn('Bridge auth rejected: game runs from another project', { conn: conn.id, game: String(msg.projectPath), bridge: projectRoot });
      conn.close(4403, 'wrong project');
      return;
    }
    lastAuthError = null;
    // One game at a time, and the newest wins: after an F5 the old socket may
    // not have closed yet, and refusing the reloaded game would strand it.
    for (const other of authedConnections()) { other.meta.authed = false; other.close(4409, 'replaced by a newer game connection'); }
    conn.meta.authed = true;
    const timer = conn.meta.authTimer as NodeJS.Timeout | undefined;
    if (timer) clearTimeout(timer);
    conn.send(JSON.stringify({ action: 'ping', requestId: 'auth-ok' }));
    settleAuthWaiters();
    logger.info('Bridge client authenticated', { conn: conn.id });
    return;
  }

  // Nothing but `auth` is accepted before authentication.
  if (!isAuthed(conn)) {
    conn.close(4401, 'not authenticated');
    return;
  }
  push(msg as unknown as Telemetry);
}

/**
 * Start the bridge for a project. Starting an already-running bridge returns
 * its current status instead of throwing. `port` 0 asks the OS for a free
 * port, which is what the tests use.
 */
export async function startBridge(projectPath: string, port?: number): Promise<BridgeStatus> {
  if (!projectPath) throw new Error('No project path set — call set_project_path first.');
  projectPath = await realpath(projectPath);
  if (server) {
    if (samePath(projectRoot, projectPath)) return statusBridge();
    // The active MCP project changed. Keeping the old singleton would leave
    // the new project's plugin reading a stale/missing handshake while tools
    // reported that a bridge was already running.
    await stopBridge();
  }

  const wanted = port ?? Number(process.env.RPGMV_BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) throw new Error('Bridge port must be an integer from 0 to 65535.');
  const handshakeTarget = await projectFile(projectPath, HANDSHAKE_FILE);
  token = randomBytes(16).toString('hex');
  projectRoot = projectPath;
  startedAtMs = Date.now();
  startedAtIso = new Date(startedAtMs).toISOString();
  buffer.length = 0;
  bufferedBytes = 0;
  dropped = 0;
  lastAuthError = null;

  server = await startWsServer(wanted, {
    onConnection(conn) {
      // A connection that never authenticates is dropped, so an unauthorized
      // local process cannot hold the socket open and watch for frames.
      conn.meta.authTimer = setTimeout(() => {
        if (!isAuthed(conn)) conn.close(4408, 'auth timeout');
      }, AUTH_TIMEOUT_MS);
    },
    onMessage: handleMessage,
    onClose(conn) {
      const timer = conn.meta.authTimer as NodeJS.Timeout | undefined;
      if (timer) clearTimeout(timer);
    },
  });

  // The plugin has no way to learn the port or token except from disk.
  const handshake: Handshake = {
    port: server.port,
    token,
    pid: process.pid,
    startedAt: startedAtIso,
  };
  try {
    await claimHandshake(handshakeTarget, handshake);
  } catch (error) {
    await stopBridge();
    throw error;
  }
  handshakePath = handshakeTarget;
  logger.info('Bridge listening', { port: server.port });
  return statusBridge();
}

/** Stop the bridge, drop every client and remove the handshake file. */
export async function stopBridge(): Promise<BridgeStatus> {
  settleAuthWaiters(new Error('bridge stopped'));
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('bridge stopped')); }
  pending.clear();
  if (server) {
    await server.close();
    server = null;
  }
  if (handshakePath) {
    // Only remove the handshake this bridge wrote; another server may own it by now.
    try {
      const existing = JSON.parse(await readFile(handshakePath, 'utf8')) as Partial<Handshake>;
      if (existing.token === token) await unlink(handshakePath);
    } catch { /* already gone or unreadable: leave it */ }
    handshakePath = null;
  }
  token = '';
  buffer.length = 0;
  bufferedBytes = 0;
  startedAtIso = null;
  return statusBridge();
}

export function statusBridge(): BridgeStatus {
  const conns = server ? server.connections() : [];
  return {
    running: server !== null,
    port: server ? server.port : null,
    projectPath: server ? projectRoot : null,
    clients: conns.length,
    authenticatedClients: authedConnections().length,
    buffered: buffer.length,
    droppedFrames: dropped,
    startedAt: startedAtIso,
    handshakeFile: handshakePath,
    lastAuthError,
  };
}

/**
 * Take telemetry out of the buffer. Draining is destructive by default so an
 * agent polling in a loop sees each frame once; pass `peek` to leave it in
 * place. `types` filters to specific frame types (e.g. only exceptions).
 */
export function drainTelemetry(opts: { limit?: number; types?: string[]; peek?: boolean } = {}): StampedTelemetry[] {
  const wanted = opts.types && opts.types.length ? new Set(opts.types) : null;
  const matching = wanted ? buffer.filter((f) => wanted.has(f.type)) : buffer.slice();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : matching.length;
  const out = matching.slice(-limit);
  if (!opts.peek) {
    const taken = new Set(out);
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (!taken.has(buffer[i])) continue;
      bufferedBytes -= frameSizes.get(buffer[i]) ?? 0;
      buffer.splice(i, 1);
    }
  }
  return out;
}

function authedConnections(): WsConnection[] {
  return server ? server.connections().filter((conn) => isAuthed(conn) && !conn.closed) : [];
}

/** Send a command to the authenticated game. Returns how many clients got it (0 or 1). */
export function sendCommand(cmd: Command): number {
  if (!server) throw new Error('Bridge is not running — start it with manage_system action "bridge_start".');
  if (!isCommandAction(cmd.action)) throw new Error('Refused command action "' + String(cmd.action) + '".');
  const conns = authedConnections();
  const text = JSON.stringify(cmd);
  for (const c of conns) c.send(text);
  return conns.length;
}

/**
 * Send a command and wait for the frame carrying the same requestId. Rejects on
 * timeout rather than hanging a tool call forever.
 */
export async function requestCommand(cmd: Omit<Command, 'requestId'>, timeoutMs = 8000): Promise<StampedTelemetry> {
  if (!server) {
    throw new Error('Bridge is not running — start it with manage_system action "bridge_start".');
  }
  const deadline = Date.now() + timeoutMs;
  if (authedConnections().length === 0) await waitForAuthenticatedClient(timeoutMs);

  const requestId = 'r' + (++requestSeq) + '-' + randomBytes(4).toString('hex');
  const full = { ...cmd, requestId } as Command;
  return new Promise<StampedTelemetry>((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for "' + cmd.action + '".'));
    }, remaining);
    pending.set(requestId, { resolve, reject, timer });

    // Register the waiter before writing to the socket. Besides making the
    // ordering explicit, this prevents a very fast loopback reply from being
    // buffered without resolving the command that caused it.
    const delivered = sendCommand(full);
    if (delivered === 0) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(new Error('The authenticated game client disconnected before "' + cmd.action + '" could be sent.'));
    }
  });
}


/**
 * Whether two project paths name the same folder. Windows paths compare without
 * case and with either slash; trailing separators never matter.
 */
export function samePath(a: unknown, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof a !== 'string' || !a || !b) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (value: string) => p.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Write the handshake without clobbering a live bridge. A handshake left by a
 * server that died without stopBridge (killed client, crash) is replaced;
 * one whose pid is still alive belongs to another MCP server and is refused.
 */
export async function claimHandshake(file: string, handshake: Handshake): Promise<void> {
  const text = JSON.stringify(handshake, null, 2);
  try { await writeFile(file, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 }); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let owner: number | undefined;
  try { owner = (JSON.parse(await readFile(file, 'utf8')) as Partial<Handshake>).pid; } catch { owner = undefined; }
  if (typeof owner === 'number' && owner !== process.pid && processAlive(owner)) {
    throw new Error('Another process (pid ' + owner + ') holds the bridge handshake ' + file + '. Stop that MCP server first; if pid ' + owner + ' is not an MCP server, delete the file.');
  }
  logger.info('Replacing a stale bridge handshake', { file, pid: owner });
  await writeFile(file, text, { encoding: 'utf-8', mode: 0o600 });
}

/** Stop a bridge left running for another project before any tool can observe or drive that game. */
export async function assertBridgeProject(projectPath: string): Promise<void> {
  if (server && !samePath(await realpath(projectPath), projectRoot)) {
    await stopBridge();
    throw new Error('The live bridge belonged to another project and was stopped. Start it again for the active project with bridge_start.');
  }
}
