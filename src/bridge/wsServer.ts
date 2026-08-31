/**
 * wsServer.ts — a minimal RFC 6455 WebSocket server, hand-rolled.
 *
 * The package ships three runtime dependencies and adding `ws` for one loopback
 * socket is not worth it, so this implements exactly the slice the bridge
 * needs: the upgrade handshake, text frames, ping/pong and close. Binary frames
 * are accepted and dropped; no extensions or subprotocols are negotiated.
 *
 * It binds the loopback interface only — never 0.0.0.0 — and refuses any
 * upgrade carrying a browser Origin, which is the first half of the defence
 * against cross-site WebSocket hijacking (the token check in bridge.ts is the
 * other half, because a non-browser client can forge any header it likes).
 */
import { createServer, type Server, type IncomingMessage } from 'http';
import { createHash } from 'crypto';
import type { Duplex } from 'stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Frames larger than this are refused; a base64 screenshot is the big one. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface WsConnection {
  id: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
  /** Per-connection state the owner attaches (auth status, timers). */
  meta: Record<string, unknown>;
}

export interface WsServerHandlers {
  onConnection(conn: WsConnection, req: IncomingMessage): void;
  onMessage(conn: WsConnection, text: string): void;
  onClose(conn: WsConnection): void;
}

/**
 * An Origin header proves a browser made the request. The nwjs game page loads
 * from file:// and sends either no Origin or "null"/"file://", so any http(s)
 * origin is a web page reaching for us and is refused outright.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const o = origin.trim().toLowerCase();
  if (o === 'null' || o === 'file://') return true;
  return o.startsWith('chrome-extension://') || o.startsWith('app://') || o.startsWith('nw://');
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one server-to-client frame (never masked, per the RFC). */
export function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Total bytes consumed from the input buffer. */
  size: number;
}

/**
 * Try to decode one frame off the front of `buf`. Returns null when the buffer
 * does not yet hold a complete frame, so the caller keeps accumulating. Throws
 * when the frame is malformed or oversized — the caller must then close.
 */
export function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame too large');
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_FRAME_BYTES) throw new Error('frame too large');
  // Client-to-server frames MUST be masked (RFC 6455 section 5.1).
  if (!masked) throw new Error('unmasked client frame');
  if (buf.length < offset + 4 + len) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
  return { fin, opcode, payload, size: offset + len };
}

export interface WsServer {
  readonly port: number;
  close(): Promise<void>;
  connections(): WsConnection[];
}

/**
 * Start a loopback WebSocket server. Resolves once it is accepting
 * connections; rejects if the port cannot be bound.
 */
export function startWsServer(port: number, handlers: WsServerHandlers): Promise<WsServer> {
  const http: Server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint only speaks WebSocket.\n');
  });

  const conns = new Map<number, WsConnection>();
  let nextId = 1;

  http.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const origin = req.headers.origin as string | undefined;
    if (typeof key !== 'string' || String(version) !== '13' || !originAllowed(origin)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    // `upgrade` hands us a Duplex; the concrete object is a net.Socket.
    (socket as unknown as { setNoDelay?(v: boolean): void }).setNoDelay?.(true);

    const id = nextId++;
    let closed = false;
    let buf: Buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    // Accumulator for fragmented text messages.
    let fragOpcode = 0;
    let frag: Buffer[] = [];

    const conn: WsConnection = {
      id,
      meta: {},
      get closed() { return closed; },
      send(text: string) {
        if (closed) return;
        try { socket.write(encodeFrame(Buffer.from(text, 'utf-8'))); } catch { /* peer vanished */ }
      },
      close(code = 1000, reason = '') {
        if (closed) return;
        closed = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try { socket.write(encodeFrame(body, 0x8)); } catch { /* ignore */ }
        socket.destroy();
      },
    };

    const finish = () => {
      if (!conns.has(id)) return;
      conns.delete(id);
      closed = true;
      handlers.onClose(conn);
    };

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        let frame: DecodedFrame | null;
        try {
          frame = decodeFrame(buf);
        } catch {
          conn.close(1002, 'protocol error');
          finish();
          return;
        }
        if (!frame) return;
        buf = buf.subarray(frame.size);
        const op = frame.opcode;
        if (op === 0x8) { conn.close(1000); finish(); return; }
        if (op === 0x9) { try { socket.write(encodeFrame(frame.payload, 0xa)); } catch { /* ignore */ } continue; }
        if (op === 0xa) continue; // pong
        if (op === 0x2) continue; // binary is not part of the contract
        if (op === 0x0 || op === 0x1) {
          if (op === 0x1) { fragOpcode = 0x1; frag = []; }
          frag.push(frame.payload);
          if (!frame.fin) continue;
          if (fragOpcode !== 0x1) { frag = []; continue; }
          const text = Buffer.concat(frag).toString('utf-8');
          frag = [];
          try { handlers.onMessage(conn, text); } catch { /* a bad frame must not kill the server */ }
        }
      }
    });

    socket.on('error', finish);
    socket.on('close', finish);

    conns.set(id, conn);
    handlers.onConnection(conn, req);
  });

  return new Promise<WsServer>((resolve, reject) => {
    const onError = (err: Error) => { http.removeListener('error', onError); reject(err); };
    http.on('error', onError);
    http.listen(port, '127.0.0.1', () => {
      http.removeListener('error', onError);
      const addr = http.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: bound,
        connections: () => [...conns.values()],
        close: () => new Promise<void>((done) => {
          for (const c of conns.values()) c.close(1001, 'server shutting down');
          conns.clear();
          http.close(() => done());
        }),
      });
    });
  });
}
