#!/usr/bin/env node
// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * Slice an RPG Maker MV tileset sheet into a labelled montage of representative
 * samples — one per autotile *kind* (its shape-0, fully-surrounded tile) or one
 * per flat tile — so Claude can name them by sight without wading through all 47
 * autotile shape variants. Emits:
 *   <out>/<Sheet>.samples.png   — the montage (index printed above each sample)
 *   <out>/<Sheet>.samples.json  — index → {kind, tileId, localIndex, transparent}
 *
 * Usage: node slice-tileset.mjs <sheet.png> <outDir>
 * The sheet role (A1–A5, B–E) is read from the filename suffix.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import {
  TILE,
  BASE_KIND,
  autotileKindCount,
  autotileSample,
  flatSample,
  flatTileCount,
} from './tilegeom.mjs';

const FLAT_BASE = { A5: 1536, B: 0, C: 256, D: 512, E: 768 };

// 3×5 pixel font, digits 0–9, for printing the index labels.
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

const SCALE = 2; // sample 48 → 96px
const DIGIT = 3; // digit pixel size
const LABEL_H = 5 * DIGIT + 6;
const CELL_W = TILE * SCALE + 12;
const CELL_H = LABEL_H + TILE * SCALE + 6;
const COLS = 8;

function roleFromName(file) {
  const m = path.basename(file, '.png').match(/_(A[1-5]|[B-E])$/);
  if (!m) throw new Error(`can't infer sheet role from filename: ${file}`);
  return m[1];
}

function put(canvas, w, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= w) return;
  const d = (y * w + x) * 4;
  if (d < 0 || d + 3 >= canvas.length) return;
  if (a === 255) {
    canvas[d] = r;
    canvas[d + 1] = g;
    canvas[d + 2] = b;
    canvas[d + 3] = 255;
    return;
  }
  const inv = 255 - a;
  canvas[d] = (r * a + canvas[d] * inv) / 255;
  canvas[d + 1] = (g * a + canvas[d + 1] * inv) / 255;
  canvas[d + 2] = (b * a + canvas[d + 2] * inv) / 255;
  canvas[d + 3] = 255;
}

function drawDigits(canvas, w, x, y, text) {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) {
      cx += 4 * DIGIT;
      continue;
    }
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] === '1') {
          for (let py = 0; py < DIGIT; py++)
            for (let px = 0; px < DIGIT; px++)
              put(canvas, w, cx + gx * DIGIT + px, y + gy * DIGIT + py, 255, 255, 255);
        }
      }
    }
    cx += 4 * DIGIT;
  }
}

function main() {
  const [sheetPath, outDir, explicitRole] = process.argv.slice(2);
  if (!sheetPath || !outDir) {
    console.error('usage: node slice-tileset.mjs <sheet.png> <outDir>');
    process.exit(1);
  }
  const role = explicitRole ?? roleFromName(sheetPath);
  if (!/^(A[1-5]|[B-E])$/.test(role)) throw new Error('Role must be A1-A5 or B-E');
  const img = decodePng(fs.readFileSync(sheetPath));
  const autotile = /^A[1-4]$/.test(role);
  const sheetName = path.basename(sheetPath, '.png');

  // Collect samples: {localIndex, kind?, tileId, quarters?/sx,sy}.
  const samples = [];
  if (autotile) {
    const base = BASE_KIND[role];
    const count = autotileKindCount(role, img.width, img.height);
    for (let i = 0; i < count; i++) {
      const kind = base + i;
      const { quarters } = autotileSample(kind);
      samples.push({ localIndex: i, kind, tileId: 2048 + kind * 48, quarters });
    }
  } else {
    const count = flatTileCount(img.width, img.height);
    for (let i = 0; i < count; i++) {
      const { sx, sy } = flatSample(i);
      samples.push({ localIndex: i, tileId: FLAT_BASE[role] + i, sx, sy });
    }
  }

  // Read each sample's 48×48 pixels; drop fully-transparent flat tiles.
  for (const s of samples) {
    const px = new Uint8Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        let sx, sy;
        if (s.quarters) {
          const qi = (y < 24 ? 0 : 2) + (x < 24 ? 0 : 1);
          sx = s.quarters[qi][0] + (x % 24);
          sy = s.quarters[qi][1] + (y % 24);
        } else {
          sx = s.sx + x;
          sy = s.sy + y;
        }
        const src = (sy * img.width + sx) * 4;
        const dst = (y * TILE + x) * 4;
        px[dst] = img.data[src];
        px[dst + 1] = img.data[src + 1];
        px[dst + 2] = img.data[src + 2];
        px[dst + 3] = img.data[src + 3];
      }
    }
    s.px = px;
    s.transparent = !autotile && !px.some((v, i) => i % 4 === 3 && v > 8);
  }

  const visible = samples.filter((s) => !s.transparent);
  const rows = Math.ceil(visible.length / COLS);
  const W = COLS * CELL_W;
  const H = Math.max(1, rows) * CELL_H;
  const canvas = new Uint8Array(W * H * 4);
  // Checkerboard background so transparency is legible.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = ((x >> 3) + (y >> 3)) & 1 ? 90 : 70;
      put(canvas, W, x, y, c, c, c);
    }

  visible.forEach((s, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const ox = col * CELL_W + 6;
    const oy = row * CELL_H;
    // dark label strip + index
    for (let y = 0; y < LABEL_H; y++)
      for (let x = 0; x < TILE * SCALE; x++) put(canvas, W, ox + x, oy + y, 24, 24, 24);
    drawDigits(canvas, W, ox + 2, oy + 3, String(s.localIndex));
    // scaled sample, composited over the checker
    const py = oy + LABEL_H;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const sd = (y * TILE + x) * 4;
        const a = s.px[sd + 3];
        for (let dy = 0; dy < SCALE; dy++)
          for (let dx = 0; dx < SCALE; dx++)
            put(
              canvas,
              W,
              ox + x * SCALE + dx,
              py + y * SCALE + dy,
              s.px[sd],
              s.px[sd + 1],
              s.px[sd + 2],
              a,
            );
      }
  });

  fs.mkdirSync(outDir, { recursive: true });
  const pngOut = path.join(outDir, `${sheetName}.samples.png`);
  const jsonOut = path.join(outDir, `${sheetName}.samples.json`);
  fs.writeFileSync(pngOut, encodePng(W, H, Buffer.from(canvas)));
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        sheet: sheetName,
        role,
        autotile,
        baseKind: autotile ? BASE_KIND[role] : undefined,
        columns: COLS,
        montage: path.basename(pngOut),
        samples: visible.map((s) => ({
          index: s.localIndex,
          kind: s.kind,
          tileId: s.tileId,
        })),
      },
      null,
      2,
    ),
  );
  console.log(
    `${sheetName}: ${visible.length} samples (${autotile ? 'autotile kinds' : 'flat tiles'}) → ${path.basename(pngOut)}`,
  );
}

main();
