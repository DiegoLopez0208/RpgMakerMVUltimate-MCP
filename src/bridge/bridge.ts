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
 *  - outbound commands are restricted to COMMAND_ACTIONS — there is no way to
 *    ask the game to evaluate arbitrary JavaScript.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { resolveSafePath } from '../utils/security.js';
import * as logger from '../utils/logger.js';
import { startWsServer, type WsConnection, type WsServer } from './wsServer.js';
import {
  AUTH_TIMEOUT_MS, DEFAULT_PORT, HANDSHAKE_FILE, TELEMETRY_BUFFER_MAX,
  isCommandAction, type Command, type Handshake, type StampedTelemetry, type Telemetry,
} from './protocol.js';

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  /** Present only while running; the plugin needs it, nobody else does. */
  token: string | null;
  projectPath: string | null;
  clients: number;
  authenticatedClients: number;
  buffered: number;
  droppedFrames: number;
  startedAt: string | null;
  handshakeFile: string | null;
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

const buffer: StampedTelemetry[] = [];
const pending = new Map<string, Pending>();

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
  buffer.push(stamped);
  while (buffer.length > TELEMETRY_BUFFER_MAX) { buffer.shift(); dropped++; }
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
    conn.meta.authed = true;
    const timer = conn.meta.authTimer as NodeJS.Timeout | undefined;
    if (timer) clearTimeout(timer);
    conn.send(JSON.stringify({ action: 'ping', requestId: 'auth-ok' }));
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
  if (server) return statusBridge();
  if (!projectPath) throw new Error('No project path set — call set_project_path first.');

  const wanted = port ?? Number(process.env.RPGMV_BRIDGE_PORT || DEFAULT_PORT);
  token = randomBytes(16).toString('hex');
  projectRoot = projectPath;
  startedAtMs = Date.now();
  startedAtIso = new Date(startedAtMs).toISOString();
  buffer.length = 0;
  dropped = 0;

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
  handshakePath = resolveSafePath(projectRoot, HANDSHAKE_FILE);
  const handshake: Handshake = {
    port: server.port,
    token,
    pid: process.pid,
    startedAt: startedAtIso,
  };
  await writeFile(handshakePath, JSON.stringify(handshake, null, 2), 'utf-8');
  logger.info('Bridge listening', { port: server.port });
  return statusBridge();
}

/** Stop the bridge, drop every client and remove the handshake file. */
export async function stopBridge(): Promise<BridgeStatus> {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('bridge stopped')); }
  pending.clear();
  if (server) {
    await server.close();
    server = null;
  }
  if (handshakePath) {
    await unlink(handshakePath).catch(() => {}); // already gone is fine
    handshakePath = null;
  }
  token = '';
  startedAtIso = null;
  return statusBridge();
}

export function statusBridge(): BridgeStatus {
  const conns = server ? server.connections() : [];
  return {
    running: server !== null,
    port: server ? server.port : null,
    token: server ? token : null,
    projectPath: server ? projectRoot : null,
    clients: conns.length,
    authenticatedClients: conns.filter(isAuthed).length,
    buffered: buffer.length,
    droppedFrames: dropped,
    startedAt: startedAtIso,
    handshakeFile: handshakePath,
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
    for (let i = buffer.length - 1; i >= 0; i--) if (taken.has(buffer[i])) buffer.splice(i, 1);
  }
  return out;
}

function authedConnections(): WsConnection[] {
  return server ? server.connections().filter(isAuthed) : [];
}

/** Send a command to every authenticated client. Returns how many got it. */
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
export function requestCommand(cmd: Omit<Command, 'requestId'>, timeoutMs = 8000): Promise<StampedTelemetry> {
  const requestId = 'r' + (++requestSeq) + '-' + randomBytes(4).toString('hex');
  const full = { ...cmd, requestId } as Command;
  const delivered = sendCommand(full);
  if (delivered === 0) {
    return Promise.reject(new Error('No authenticated game client is connected. Is the playtest running with the McpBridge plugin enabled?'));
  }
  return new Promise<StampedTelemetry>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for "' + cmd.action + '".'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
  });
}

/** Test seam: forget buffered state without going through the socket lifecycle. */
export function _resetForTests(): void {
  buffer.length = 0;
  pending.clear();
  dropped = 0;
}
