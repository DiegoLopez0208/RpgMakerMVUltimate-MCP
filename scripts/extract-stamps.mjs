#!/usr/bin/env node
/**
 * extract-stamps.mjs — dev tool: mine real multi-tile object "stamps"
 * (houses, trees, props) from the bundled reference maps, so the generator can
 * stamp coherent objects instead of scattering single tiles. Output is committed
 * to knowledge/stamps.json, keyed by tilesetId.
 *
 * A stamp = the upper-layer tiles of one connected object, relative to its
 * top-left: { w, h, cells:[{l,dx,dy,t}], door?:{dx,dy}, count }.
 *   l = MV layer index (2 = upper1, 3 = upper2). t = tileId.
 *
 * Run: node scripts/extract-stamps.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';

const MAPS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'knowledge', 'maps');
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'knowledge', 'stamps.json');

const A3 = (t) => t >= 4352 && t < 5888;            // roofs/exterior walls
const A4 = (t) => t >= 5888 && t < 8192;            // interior walls
const isRoofOrWall = (t) => A3(t) || A4(t);

// Per-tileset accumulators: category -> Map(signature -> {stamp, count})
const acc = {};
function bucket(ts, cat) {
  acc[ts] = acc[ts] || {};
  acc[ts][cat] = acc[ts][cat] || new Map();
  return acc[ts][cat];
}

for (const f of readdirSync(MAPS).filter((f) => f.endsWith('.json'))) {
  let m;
  try { m = JSON.parse(readFileSync(path.join(MAPS, f), 'utf8')); } catch { continue; }
  if (!m || !m.data || !m.width) continue;
  const w = m.width, h = m.height, ts = m.tilesetId;
  const at = (layer, x, y) => m.data[(layer * h + y) * w + x];
  const occupied = (x, y) => at(2, x, y) !== 0 || at(3, x, y) !== 0;

  const seen = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (seen[y * w + x] || !occupied(x, y)) continue;
      // BFS connected component (8-connectivity)
      const comp = [];
      const stack = [[x, y]];
      seen[y * w + x] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        comp.push([cx, cy]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (seen[ny * w + nx] || !occupied(nx, ny)) continue;
          seen[ny * w + nx] = 1; stack.push([nx, ny]);
        }
      }
      // bbox
      let minX = w, minY = h, maxX = 0, maxY = 0;
      for (const [px, py] of comp) { if (px < minX) minX = px; if (py < minY) minY = py; if (px > maxX) maxX = px; if (py > maxY) maxY = py; }
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      // skip terrain-scale blobs and trivial singletons
      if (cw > 10 || ch > 10 || cw * ch > 90) continue;
      if (comp.length < 2) continue; // single tiles aren't "objects" worth stamping

      const cells = [];
      let beCount = 0, autotileCount = 0;
      for (let yy = minY; yy <= maxY; yy++) for (let xx = minX; xx <= maxX; xx++) {
        for (const layer of [2, 3]) {
          const t = at(layer, xx, yy);
          if (t === 0) continue;
          cells.push({ l: layer, dx: xx - minX, dy: yy - minY, t });
          if (t < 1536) beCount++;          // B/C/D/E object tile
          if (isRoofOrWall(t)) autotileCount++;
        }
      }
      const buildingLike = beCount >= cells.length * 0.5; // mostly B/C graphics, not autotile cliffs/roofs

      // categorize (RTP Outside houses are B/C building clusters, not A3 roofs)
      let cat;
      if (cw >= 4 && ch >= 4 && buildingLike) cat = 'house';
      else if (cw >= 2 && cw <= 3 && ch >= 2 && ch <= 4 && beCount > 0) cat = 'tree';
      else if (cw <= 3 && ch <= 3 && comp.length >= 2) cat = 'prop';
      else continue;

      const stamp = { w: cw, h: ch, cells };
      if (cat === 'house') stamp.door = { dx: Math.floor(cw / 2), dy: ch - 1 };
      const sig = cat + ':' + cells.map((c) => c.l + ',' + c.dx + ',' + c.dy + ',' + c.t).join('|');
      const b = bucket(ts, cat);
      if (b.has(sig)) b.get(sig).count++;
      else b.set(sig, { stamp, count: 1 });
    }
  }
}

// keep the most common stamps per (tileset, category)
const LIMITS = { house: 10, tree: 12, prop: 16 };
const out = {};
for (const ts of Object.keys(acc)) {
  out[ts] = {};
  for (const cat of Object.keys(acc[ts])) {
    const arr = [...acc[ts][cat].values()].sort((a, b) => b.count - a.count).slice(0, LIMITS[cat] || 10);
    out[ts][cat] = arr.map((e) => Object.assign({ count: e.count }, e.stamp));
  }
}

writeFileSync(OUT, JSON.stringify(out));
for (const ts of Object.keys(out)) {
  const parts = Object.entries(out[ts]).map(([c, a]) => `${c}:${a.length}`).join(' ');
  console.log(`tileset ${ts}: ${parts}`);
}
console.log('Wrote', OUT);
