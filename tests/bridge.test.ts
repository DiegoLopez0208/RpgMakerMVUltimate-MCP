import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { connect, type Socket } from 'net';

import { originAllowed, acceptKey, encodeFrame, decodeFrame } from '../src/bridge/wsServer.js';
import { startBridge, stopBridge, statusBridge, drainTelemetry, requestCommand, sendCommand } from '../src/bridge/bridge.js';
import type { Handshake } from '../src/bridge/protocol.js';
import { HOT_RELOADABLE, isCommandAction } from '../src/bridge/protocol.js';
import { buildBridgePlugin, BRIDGE_PLUGIN_NAME } from '../src/bridge/pluginSource.js';

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
  it('guards on playtest before doing anything', () => {
    const spec = buildBridgePlugin();
    const guardIndex = spec.body.indexOf("isOptionValid('test')");
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
});
