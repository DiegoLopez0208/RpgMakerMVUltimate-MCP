import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import nodePath, { basename, join } from 'path';
import { randomBytes } from 'crypto';
import { connect, type Socket } from 'net';

import { originAllowed, acceptKey, encodeFrame, decodeFrame } from '../src/bridge/wsServer.js';
import { startBridge, stopBridge, statusBridge, drainTelemetry, requestCommand, sendCommand } from '../src/bridge/bridge.js';
import type { Handshake } from '../src/bridge/protocol.js';
import { HOT_RELOADABLE, isCommandAction } from '../src/bridge/protocol.js';
import { buildBridgePlugin, BRIDGE_PLUGIN_NAME } from '../src/bridge/pluginSource.js';
import { bridgeCommand, bridgeRecordVideo, bridgeScreenshot } from '../src/tools/bridgeTools.js';

/** Mask a payload the way a conforming client must, so decodeFrame accepts it. */
function clientFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

/** CR LF, spelled out so no build step can mangle the escape. */
const CRLF = String.fromCharCode(13, 10);

const projects: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-bridge-'));
  projects.push(dir);
  return dir;
}

/**
 * A WebSocket client built on `net`, standing in for the game.
 *
 * Node only exposes a global WebSocket from v22, and the package supports 18
 * and 20, so the tests cannot use it. This is the client half of the same
 * protocol wsServer speaks: the upgrade handshake, masked text frames out,
 * unmasked frames in.
 */
class TestClient {
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private handlers: ((msg: Record<string, unknown>) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('handshake timed out')), 4000);
      let handshakeDone = false;

      socket.on('connect', () => {
        const request = [
          'GET / HTTP/1.1',
          'Host: 127.0.0.1:' + port,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version: 13',
          '', '',
        ].join(CRLF);
        socket.write(request);
      });

      socket.on('data', (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshakeDone) {
          const end = this.buf.indexOf(CRLF + CRLF);
          if (end === -1) return;
          const head = this.buf.subarray(0, end).toString('utf-8');
          this.buf = this.buf.subarray(end + 4);
          handshakeDone = true;
          clearTimeout(timer);
          if (!head.startsWith('HTTP/1.1 101')) { reject(new Error('upgrade refused: ' + head.split(CRLF)[0])); return; }
          resolve();
        }
        this.drain();
      });

      socket.on('error', () => { clearTimeout(timer); reject(new Error('socket error')); });
      socket.on('close', () => { for (const h of this.closeHandlers) h(); });
    });
  }

  /** Server-to-client frames are never masked, so decodeFrame would reject them. */
  private drain(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      }
      if (this.buf.length < offset + len) return;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (opcode !== 0x1) continue; // close/ping/pong are not part of these assertions
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(payload.toString('utf-8')) as Record<string, unknown>; } catch { continue; }
      for (const h of this.handlers) h(msg);
    }
  }

  onMessage(handler: (msg: Record<string, unknown>) => void): void { this.handlers.push(handler); }
  onClose(handler: () => void): void { this.closeHandlers.push(handler); }

  send(payload: unknown): void {
    if (!this.socket) throw new Error('not connected');
    this.socket.write(clientFrame(JSON.stringify(payload)));
  }

  close(): void { this.socket?.destroy(); }
}

/** Connect a client and resolve once the server has accepted its token. */
async function connectAuthed(port: number, token: string): Promise<TestClient> {
  const client = new TestClient();
  await client.connect(port);
  return new Promise<TestClient>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never acknowledged auth')), 4000);
    // The server answers an accepted auth with a ping command.
    client.onMessage((msg) => {
      if (msg.requestId === 'auth-ok') { clearTimeout(timer); resolve(client); }
    });
    client.send({ type: 'auth', token });
  });
}

afterEach(async () => {
  await stopBridge();
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('WebSocket framing', () => {
  it('computes the RFC 6455 accept key', () => {
    // The example handshake from RFC 6455 section 1.3.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips a masked client frame', () => {
    const frame = decodeFrame(clientFrame('hello bridge'));
    expect(frame).not.toBeNull();
    expect(frame!.opcode).toBe(0x1);
    expect(frame!.fin).toBe(true);
    expect(frame!.payload.toString('utf-8')).toBe('hello bridge');
  });

  it('handles payloads that need the 16-bit length field', () => {
    const long = 'x'.repeat(500);
    const frame = decodeFrame(clientFrame(long));
    expect(frame!.payload.toString('utf-8')).toBe(long);
  });

  it('returns null while the frame is still incomplete', () => {
    const full = clientFrame('partial delivery');
    expect(decodeFrame(full.subarray(0, 4))).toBeNull();
  });

  it('rejects an unmasked client frame', () => {
    // Server-shaped frames must never be accepted from a client.
    expect(() => decodeFrame(encodeFrame(Buffer.from('nope')))).toThrow(/unmasked/);
  });
});

describe('origin policy', () => {
  it('allows the nwjs game page', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('null')).toBe(true);
    expect(originAllowed('file://')).toBe(true);
  });

  it('refuses a web page (cross-site WebSocket hijacking)', () => {
    expect(originAllowed('http://evil.example')).toBe(false);
    expect(originAllowed('https://evil.example')).toBe(false);
  });
});

describe('command surface', () => {
  it('only recognises the fixed action list', () => {
    expect(isCommandAction('reload_map')).toBe(true);
    expect(isCommandAction('eval_js')).toBe(false);
    expect(isCommandAction('')).toBe(false);
  });

  it('maps only hot-reloadable data files to a global', () => {
    expect(HOT_RELOADABLE['Skills.json']).toBe('$dataSkills');
    expect(HOT_RELOADABLE['System.json']).toBeUndefined();
    expect(HOT_RELOADABLE['Tilesets.json']).toBeUndefined();
  });
});

describe('generated plugin', () => {
  it('is syntactically valid JavaScript', () => {
    const spec = buildBridgePlugin();
    expect(() => new Function(spec.body)).not.toThrow();
  });

  it('guards on playtest before doing anything', () => {
    const spec = buildBridgePlugin();
    const guardIndex = spec.body.indexOf('if (!isPlaytest()) return');
    expect(guardIndex).toBeGreaterThan(-1);
    // The guard must precede the socket, or a deployed build could open a port.
    expect(guardIndex).toBeLessThan(spec.body.indexOf('new WebSocket'));
  });

  it('never exposes an eval primitive', () => {
    const spec = buildBridgePlugin();
    expect(spec.body).not.toMatch(/\beval\s*\(/);
    expect(spec.body).not.toMatch(/new Function\s*\(/);
  });

  it('declares its parameters so PluginManager sees the defaults', () => {
    const spec = buildBridgePlugin({ port: 40100, telemetryInterval: 60 });
    expect(BRIDGE_PLUGIN_NAME).toBe('McpBridge');
    expect(spec.params.find((p) => p.name === 'Fallback Port')?.default).toBe(40100);
    expect(spec.body).toContain('40100');
    expect(spec.body).toContain("PluginManager.parameters('McpBridge')");
  });
});

/**
 * The plugin only ever runs inside the game, so the tests that matter run its
 * generated source against stubbed engine globals and assert what it DID —
 * whether it opened a socket, where it looked for the handshake — rather than
 * what its source text says. Asserting on the text passes for any refactor that
 * breaks the behaviour and fails for any that preserves it.
 */
interface RunOptions {
  nwjs?: boolean;
  /** What Utils.isOptionValid('test') returns — MV only inspects argv[0]. */
  optionValid?: boolean;
  argv?: string[] | null;
  protocol?: string;
  pathname?: string;
  cwd?: string;
  handshake?: { port: number; token: string } | null;
}

interface RunResult {
  required: string[];
  socketUrls: string[];
  reads: string[];
  writes: { path: string; content: string }[];
  mkdirs: string[];
}

function runPlugin(opts: RunOptions = {}): RunResult {
  const result: RunResult = { required: [], socketUrls: [], reads: [], writes: [], mkdirs: [] };

  const fsStub = {
    readFileSync: (p: string) => {
      result.reads.push(p);
      if (!opts.handshake) throw new Error('ENOENT: no such file');
      return JSON.stringify(opts.handshake);
    },
    writeFileSync: (p: string, content: string) => { result.writes.push({ path: p, content }); },
    appendFileSync: (p: string, content: string) => { result.writes.push({ path: p, content }); },
    mkdirSync: (p: string) => { result.mkdirs.push(p); },
  };

  const requireStub = (mod: string) => {
    result.required.push(mod);
    if (mod === 'fs') return fsStub;
    if (mod === 'path') return nodePath;
    return {};
  };

  class SocketStub {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(url: string) { result.socketUrls.push(url); }
    send() { /* never reached: the stub never opens */ }
  }

  const utils = {
    isNwjs: () => opts.nwjs !== false,
    isOptionValid: () => (opts.optionValid ? 1 : 0),
    RPGMAKER_VERSION: '1.6.2',
  };
  const nw = opts.argv === null ? undefined : { App: { argv: opts.argv ?? [] } };
  const windowStub = {
    location: { protocol: opts.protocol ?? 'file:', pathname: opts.pathname ?? '/C:/games/Demo/index.html' },
    addEventListener: () => {},
    process: undefined,
  };
  const processStub = { cwd: () => opts.cwd ?? 'C:/cwd', memoryUsage: () => ({ heapUsed: 0 }) };

  const body = buildBridgePlugin().body;
  const fn = new Function(
    'Utils', 'nw', 'window', 'process', 'require', 'WebSocket',
    'PluginManager', 'SceneManager', 'Scene_Map', 'Game_Interpreter', 'Graphics',
    'setTimeout', 'console',
    body,
  );
  fn(
    utils, nw, windowStub, processStub, requireStub, SocketStub,
    { parameters: () => ({}) },
    { goto: () => {}, _scene: null, snap: () => null },
    { prototype: { update: () => {}, onMapLoaded: () => {} } },
    { prototype: { executeCommand: () => {}, currentCommand: () => null } },
    { frameCount: 0 },
    () => 0,                       // no retries: one pass per run
    { error: () => {}, warn: () => {} },
  );
  return result;
}

describe('the playtest guard, executed', () => {
  it('does nothing at all outside nwjs', () => {
    const r = runPlugin({ nwjs: false, optionValid: true });
    expect(r.required).toEqual([]);   // it never even reached require('fs')
    expect(r.writes).toEqual([]);
    expect(r.socketUrls).toEqual([]);
  });

  it('runs when the engine itself reports playtest', () => {
    const r = runPlugin({ optionValid: true, handshake: { port: 32123, token: 'a'.repeat(32) } });
    expect(r.required).toContain('fs');
    expect(r.socketUrls).toEqual(['ws://127.0.0.1:32123']);
  });

  it('runs when the test token trails the project path in argv', () => {
    // Utils.isOptionValid only inspects argv[0], and playtest launches
    // `game.exe <projectPath> test`, so the engine's own check is false here.
    const r = runPlugin({
      optionValid: false,
      argv: ['C:/games/Demo', 'test'],
      handshake: { port: 32123, token: 'a'.repeat(32) },
    });
    expect(r.socketUrls).toEqual(['ws://127.0.0.1:32123']);
  });

  it('stays dormant on a deployed build with no test token anywhere', () => {
    const r = runPlugin({ optionValid: false, argv: ['C:/games/Demo'] });
    expect(r.required).toEqual([]);
    expect(r.socketUrls).toEqual([]);
  });

  it('stays dormant when a path merely contains the word test', () => {
    // Only a whole argument (or an &-separated token) counts, so
    // C:/games/test/Demo must not be mistaken for a playtest flag.
    const r = runPlugin({ optionValid: false, argv: ['C:/games/test/Demo'] });
    expect(r.socketUrls).toEqual([]);
  });

  it('survives a runtime with no nw global', () => {
    const r = runPlugin({ optionValid: false, argv: null });
    expect(r.socketUrls).toEqual([]);
  });
});

describe('the project root, executed', () => {
  const handshake = { port: 32123, token: 'a'.repeat(32) };

  it('derives it from the pathname under the file: scheme', () => {
    const r = runPlugin({ optionValid: true, protocol: 'file:', pathname: '/C:/games/Demo/index.html', handshake });
    expect(r.reads[0]).toBe(nodePath.join('C:/games/Demo', '.mcp-bridge.json'));
  });

  it('falls back to the working directory under chrome-extension:', () => {
    // Recent NW.js serves index.html from an extension origin, where the
    // pathname says nothing about where the project lives.
    //
    // The cwd has to be absolute *for the host platform*: path.resolve treats
    // "C:/games/Demo" as relative on POSIX and prefixes the real cwd, which is
    // a property of the test, not of the plugin.
    const cwd = nodePath.resolve(tmpdir(), 'DemoProject');
    const r = runPlugin({ optionValid: true, protocol: 'chrome-extension:', cwd, handshake });
    expect(r.reads[0]).toBe(nodePath.join(cwd, '.mcp-bridge.json'));
  });
});

describe('the diagnostic log, executed', () => {
  it('goes into .mcp-cache rather than loose in the project root', () => {
    const r = runPlugin({ optionValid: true, protocol: 'file:', pathname: '/C:/games/Demo/index.html' });
    expect(r.mkdirs).toContain(nodePath.join('C:/games/Demo', '.mcp-cache'));
    expect(r.writes.every((w) => w.path.includes('.mcp-cache'))).toBe(true);
  });

  it('records why startup failed when there is no handshake yet', () => {
    const r = runPlugin({ optionValid: true, handshake: null });
    const written = r.writes.map((w) => w.content).join('');
    expect(written).toMatch(/plugin loaded/);
    expect(written).toMatch(/handshake read failed|waiting for bridge handshake/);
  });

  it('never writes the token to disk', () => {
    const token = 'deadbeef'.repeat(4);
    const r = runPlugin({ optionValid: true, handshake: { port: 32123, token } });
    for (const w of r.writes) expect(w.content).not.toContain(token);
  });
});

describe('bridge lifecycle', () => {
  it('writes a handshake file the plugin can read, and removes it on stop', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    const file = join(dir, '.mcp-bridge.json');
    const handshake = JSON.parse(await readFile(file, 'utf-8')) as Handshake;
    expect(handshake.port).toBe(status.port);
    expect(handshake.token).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(handshake.startedAt).toString()).not.toBe('Invalid Date');

    await stopBridge();
    await expect(access(file)).rejects.toThrow();
    expect(statusBridge().running).toBe(false);
  });

  it('refuses to send commands while stopped', () => {
    expect(() => sendCommand({ action: 'ping' })).toThrow(/not running/);
  });

  it('restarts the singleton when the active project changes', async () => {
    const first = await tempProject();
    const second = await tempProject();
    const initial = await startBridge(first, 0);
    const switched = await startBridge(second, 0);

    expect(switched.projectPath).toBe(second);
    expect(switched.token).not.toBe(initial.token);
    await expect(access(join(first, '.mcp-bridge.json'))).rejects.toThrow();
    const handshake = JSON.parse(await readFile(join(second, '.mcp-bridge.json'), 'utf-8')) as Handshake;
    expect(handshake.token).toBe(switched.token);
  });
});

describe('bridge session', () => {
  it('accepts an authenticated client and buffers its telemetry', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);

    expect(statusBridge().authenticatedClients).toBe(1);

    ws.send({ type: 'exception', message: 'TypeError: undefined is not a function' });
    ws.send({ type: 'player_state', mapId: 3, x: 7, y: 9, direction: 2, isMoving: false });
    await new Promise((r) => setTimeout(r, 150));

    const all = drainTelemetry({ peek: true });
    expect(all.map((f) => f.type)).toEqual(expect.arrayContaining(['exception', 'player_state']));

    const onlyErrors = drainTelemetry({ types: ['exception'] });
    expect(onlyErrors).toHaveLength(1);
    expect(onlyErrors[0].type).toBe('exception');
    // Draining is destructive: the exception is gone, the position frame stays.
    expect(drainTelemetry({ peek: true }).map((f) => f.type)).toEqual(['player_state']);

    ws.close();
  });

  it('drops a client that presents the wrong token', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);

    const client = new TestClient();
    await client.connect(status.port!);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      client.onClose(() => { clearTimeout(timer); resolve(true); });
      client.send({ type: 'auth', token: 'deadbeef'.repeat(4) });
    });

    expect(closed).toBe(true);
    expect(statusBridge().authenticatedClients).toBe(0);
  });

  it('matches a reply to its request', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);

    // Stand in for the game: answer get_state with a state dump.
    ws.onMessage((msg) => {
      if (msg.action === 'get_state') {
        ws.send({ type: 'state_dump', requestId: msg.requestId, switches: { 3: true }, variables: { 1: 42 } });
      }
    });

    const reply = await requestCommand({ action: 'get_state' }, 4000);
    expect(reply.type).toBe('state_dump');
    if (reply.type === 'state_dump') {
      expect(reply.switches['3']).toBe(true);
      expect(reply.variables['1']).toBe(42);
    }

    ws.close();
  });

  it('surfaces a game-side command refusal as a failed MCP call', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);
    ws.onMessage((msg) => {
      if (msg.action === 'teleport_player') {
        ws.send({ type: 'error', requestId: msg.requestId, message: 'No active map yet.' });
      }
    });

    await expect(bridgeCommand({ action: 'teleport_player', mapId: 4, x: 15, y: 26 }))
      .rejects.toThrow(/Game refused.*No active map yet/);
    ws.close();
  });

  it('waits for a playtest that authenticates just after the command starts', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const request = requestCommand({ action: 'ping' }, 2000);

    const client = new TestClient();
    await client.connect(status.port!);
    client.onMessage((msg) => {
      if (msg.action === 'ping' && msg.requestId !== 'auth-ok') {
        client.send({ type: 'log', level: 'info', requestId: msg.requestId, message: 'pong' });
      }
    });
    // This used to fail immediately before the newly launched game had time to
    // authenticate, even though the playtest connected a moment later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.send({ type: 'auth', token: status.token });

    const reply = await request;
    expect(reply.type).toBe('log');
    if (reply.type === 'log') expect(reply.message).toBe('pong');
    client.close();
  });

  it('times out instead of hanging when the game never answers', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);

    await expect(requestCommand({ action: 'get_state' }, 200)).rejects.toThrow(/Timed out/);
    ws.close();
  });

  it('reports no client rather than waiting when nothing is connected', async () => {
    const dir = await tempProject();
    await startBridge(dir, 0);
    await expect(requestCommand({ action: 'ping' }, 500)).rejects.toThrow(/No authenticated game client/);
  });

  it('captures a named screenshot through the authenticated bridge', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);
    const png = Buffer.from('fake-png-for-bridge-test');

    ws.onMessage((msg) => {
      if (msg.action === 'capture_screenshot') {
        ws.send({
          type: 'screenshot_result', requestId: msg.requestId,
          mimeType: 'image/png', base64: png.toString('base64'),
        });
      }
    });

    const result = await bridgeScreenshot(dir, { name: 'boss-room', timeoutMs: 4000 });
    expect(result.name).toBe('boss-room');
    expect(basename(result.path)).toMatch(/^boss-room-\d{8}-\d{6}-\d{3}\.png$/);
    expect(await readFile(result.path)).toEqual(png);
    expect(result.bytes).toBe(png.length);
    expect(result.mimeType).toBe('image/png');

    ws.close();
  });

  it('starts and saves a named playtest recording through the bridge', async () => {
    const dir = await tempProject();
    const status = await startBridge(dir, 0);
    const ws = await connectAuthed(status.port!, status.token!);
    const webm = Buffer.from('fake-webm-for-bridge-test');

    ws.onMessage((msg) => {
      if (msg.action === 'start_recording') {
        ws.send({ type: 'recording_started', requestId: msg.requestId, mimeType: 'video/webm;codecs=vp8', fps: 30 });
      }
      if (msg.action === 'stop_recording') {
        ws.send({
          type: 'recording_result', requestId: msg.requestId, mimeType: 'video/webm;codecs=vp8',
          base64: webm.toString('base64'), durationMs: 1234,
        });
      }
    });

    const started = await bridgeRecordVideo(dir, { action: 'start', name: 'ramiro', timeoutMs: 4000 });
    expect(started.recording).toBe(true);
    const stopped = await bridgeRecordVideo(dir, { action: 'stop', name: 'ramiro', timeoutMs: 4000 });
    expect(stopped.recording).toBe(false);
    expect(basename(stopped.path!)).toMatch(/^ramiro-\d{8}-\d{6}-\d{3}\.webm$/);
    expect(await readFile(stopped.path!)).toEqual(webm);
    expect(stopped.durationMs).toBe(1234);
    ws.close();
  });

  it('rejects an unsafe screenshot name before contacting the game', async () => {
    await expect(bridgeScreenshot('C:/unused', { name: '../outside' }))
      .rejects.toThrow(/Screenshot name/);
  });

  it('builds a plugin with safe input and canvas recording commands', () => {
    const body = buildBridgePlugin().body;
    expect(body).toContain("case 'interact':");
    expect(body).toContain("case 'press_button':");
    expect(body).toContain('canvas.captureStream');
    expect(body).toContain("type: 'recording_result'");
  });
});
