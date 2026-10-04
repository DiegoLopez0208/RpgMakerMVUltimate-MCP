import { createServer, Server } from 'http';
import { readFile, realpath } from 'fs/promises';
import { AddressInfo } from 'net';
import { extname, resolve, sep } from 'path';

/**
 * A minimal read-only static file server over an RPG Maker project directory,
 * so a headless browser can boot `index.html` over http (the engine's
 * `fetch`/XHR data loading doesn't work from `file://`). Bound to loopback on an
 * ephemeral port; lives only for one render/playtest call.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Map a request URL onto a file under `root`, or `null` when it would escape the
 * root (`..` traversal, encoded or not). Query strings/fragments are ignored;
 * `/` serves `index.html`.
 */
export function resolveRequestPath(root: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.replace(/\\/g, '/').split('/').some((part) => part.startsWith('.') || /\.(?:bak|tmp|mcp-backups)$/.test(part))) return null;
  const base = resolve(root);
  const full = resolve(base, '.' + pathname);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export interface StaticServer {
  /** e.g. `http://127.0.0.1:53211` (no trailing slash). */
  origin: string;
  close: () => Promise<void>;
}

export async function startStaticServer(root: string): Promise<StaticServer> {
  root = await realpath(root);
  const server: Server = createServer((req, res) => {
    const file = resolveRequestPath(root, req.url ?? '/');
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(file ? 405 : 403);
      res.end();
      return;
    }
    realpath(file).then((actual) => {
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Symlink escapes project');
      return readFile(actual);
    }).then(
      (data) => {
        res.writeHead(200, { 'Content-Type': contentTypeFor(file), 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : data);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
