/**
 * Minimal, dependency-free PNG codec (Node built-in `zlib` only).
 *
 * Just enough to read the PNG sheets RPG Maker MV ships (8-bit palette, RGB,
 * grayscale, or RGBA) into a flat RGBA buffer and write an RGBA PNG back out —
 * so the tileset slicer needs no `sharp`/`canvas`/`pngjs` install. Not a general
 * PNG library: 8-bit channels only, no interlacing (RPG Maker never interlaces).
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG buffer into `{ width, height, data }` where data is RGBA bytes. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const data = buf.subarray(start, start + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4; // skip data + CRC
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  // Unfilter into a contiguous per-pixel-byte buffer, then expand to RGBA.
  const unfiltered = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const cur = unfiltered.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? unfiltered.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
  }

  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const d = p * 4;
    if (colorType === 6) {
      out[d] = unfiltered[s];
      out[d + 1] = unfiltered[s + 1];
      out[d + 2] = unfiltered[s + 2];
      out[d + 3] = unfiltered[s + 3];
    } else if (colorType === 2) {
      out[d] = unfiltered[s];
      out[d + 1] = unfiltered[s + 1];
      out[d + 2] = unfiltered[s + 2];
      out[d + 3] = 255;
    } else if (colorType === 0) {
      out[d] = out[d + 1] = out[d + 2] = unfiltered[s];
      out[d + 3] = 255;
    } else if (colorType === 4) {
      out[d] = out[d + 1] = out[d + 2] = unfiltered[s];
      out[d + 3] = unfiltered[s + 1];
    } else {
      // palette
      const idx = unfiltered[s];
      out[d] = palette[idx * 3];
      out[d + 1] = palette[idx * 3 + 1];
      out[d + 2] = palette[idx * 3 + 2];
      out[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data: out };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA buffer as an 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
