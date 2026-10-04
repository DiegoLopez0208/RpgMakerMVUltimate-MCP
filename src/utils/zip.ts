import { open, readFile, stat } from 'fs/promises';
import { deflateRawSync } from 'zlib';

/**
 * A minimal, dependency-free ZIP writer (PKWARE APPNOTE 4.5, no ZIP64) built on
 * `node:zlib`'s raw deflate. Enough for a web-game deployment archive: each entry
 * is deflated, or **stored** when deflate doesn't shrink it (PNG/OGG/M4A/WebM are
 * already compressed, so storing them saves CPU and a few bytes).
 *
 * Why hand-rolled rather than a dependency: the server ships with only two
 * runtime deps (`@modelcontextprotocol/sdk`, `zod`), and a store/deflate writer
 * is ~100 lines over primitives Node already provides — the same trade-off the
 * dependency-free PNG decoder (`tiles/png.ts`) made. `zlib.crc32` only landed in
 * Node 20.15/22.2 and `engines` is `>=18`, so the CRC table is local too.
 *
 * Limits (thrown, never silently truncated): at most 65 534 entries, and every
 * offset/size must fit in 32 bits (~4 GB) — far beyond itch.io's own caps.
 */

export interface ZipEntry {
  /** Archive path, forward slashes, no leading slash (e.g. `img/system/Window.png`). */
  name: string;
  /** Absolute source path on disk. */
  source: string;
}

export interface ZipResult {
  path: string;
  entries: number;
  bytes: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time words for a JS Date (local time, 2-second resolution). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX_U32 = 0xffffffff;
const UTF8_FLAG = 0x0800; // general-purpose bit 11: names are UTF-8

/**
 * Write `entries` to a new ZIP at `zipPath` (overwriting). Files are streamed one
 * at a time — only one entry's bytes are held in memory at once.
 */
export async function writeZip(zipPath: string, entries: ZipEntry[]): Promise<ZipResult> {
  if (entries.length >= 0xffff) {
    throw new Error(`Too many files for a non-ZIP64 archive: ${entries.length} (max 65534).`);
  }
  const handle = await open(zipPath, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const data = await readFile(entry.source);
      const { mtime } = await stat(entry.source);
      const crc = crc32(data);
      const deflated = deflateRawSync(data);
      const useDeflate = deflated.length < data.length;
      const body = useDeflate ? deflated : data;
      const method = useDeflate ? 8 : 0;
      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosDateTime(mtime);
      if (data.length > MAX_U32 || offset + 30 + name.length + body.length > MAX_U32) {
        throw new Error(`Archive exceeds 4 GB (non-ZIP64) at ${entry.name}.`);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra length
      await handle.write(local);
      await handle.write(name);
      await handle.write(body);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(UTF8_FLAG, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(name.length, 28);
      // extra len, comment len, disk start, internal attrs, external attrs = 0
      cd.writeUInt32LE(offset, 42);
      central.push(cd, name);

      offset += local.length + name.length + body.length;
    }

    const cdBuf = Buffer.concat(central);
    if (offset + cdBuf.length > MAX_U32) throw new Error('Archive exceeds 4 GB (non-ZIP64).');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(cdBuf);
    await handle.write(end);
    return { path: zipPath, entries: entries.length, bytes: offset + cdBuf.length + end.length };
  } finally {
    await handle.close();
  }
}
