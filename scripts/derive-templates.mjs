#!/usr/bin/env node
/**
 * derive-templates.mjs — author new themed map templates by transforming existing
 * hand-authored RTP templates, so themes that had no template of their own
 * (beach, harbor, sewer) clone real, coherent content instead of falling back to
 * a generic exterior/dungeon map.
 *
 * Everything here is EMPIRICAL, not guessed: the source templates and the
 * autotile "kinds" (grass=16, sand=32 on the Outside tileset) were measured from
 * the real 106-template index, and every transform preserves the engine's
 * autotile math (makeAutotileId(kind, shape)). Because generateTileLayoutV3 runs
 * applyAutotileShapes on the clone, only the autotile KIND has to be right — the
 * connection shape is re-derived from neighbours at generation time.
 *
 * Derived templates get ids >= DERIVED_ID_BASE so this script is idempotent:
 * re-running removes the previously derived entries/files first.
 *
 * Run:  node scripts/derive-templates.mjs   (then `npm run build` copies knowledge/ to dist/)
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS_DIR = join(ROOT, 'knowledge', 'maps');
const INDEX_PATH = join(ROOT, 'knowledge', 'map-templates.json');

const A1 = 2048, A2 = 2816, A3 = 4352; // autotile id-range boundaries (rpg_core.js)
const DERIVED_ID_BASE = 107;           // real templates are 1..106

const autotileKind = (id) => Math.floor((id - 2048) / 48);
const autotileShape = (id) => (id - 2048) % 48;
const makeAutotileId = (kind, shape) => 2048 + kind * 48 + shape;
const mapFile = (id) => join(MAPS_DIR, 'Map' + String(id).padStart(3, '0') + '.json');

/** Remap one autotile family (kind) to another on the ground layers, keeping shape. */
function remapGroundKind(map, fromKind, toKind) {
  const { width: w, height: h, data: d } = map;
  for (const layer of [0, 1]) { // GROUND1, GROUND2
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (layer * h + y) * w + x;
        const id = d[i];
        if (id >= A2 && id < A3 && autotileKind(id) === fromKind) {
          d[i] = makeAutotileId(toKind, autotileShape(id));
        }
      }
    }
  }
}

// One entry per template to derive. `transform` is optional (harbor/sewer are
// real waterside/wet maps that only need re-tagging).
const RECIPES = [
  // Beach = a coastal forest map with its grass ground (kind 16) turned to sand
  // (kind 32). Trees, water and layout stay; the ground becomes a sandy beach.
  { source: 8,  theme: 'beach',  category: 'exterior', transform: (m) => remapGroundKind(m, 16, 32) },
  { source: 32, theme: 'beach',  category: 'exterior', transform: (m) => remapGroundKind(m, 16, 32) },
  // Harbor = a waterside town (real docks-adjacent town with lots of open water).
  { source: 7,  theme: 'harbor', category: 'town' },
  { source: 9,  theme: 'harbor', category: 'town' },
  // Sewer = a wet cave (real corridors already flanked by water channels).
  { source: 52, theme: 'sewer',  category: 'dungeon' },
];

function main() {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

  // Idempotent: drop previously derived entries + files.
  for (const e of index.filter((t) => t.id >= DERIVED_ID_BASE)) {
    if (existsSync(mapFile(e.id))) rmSync(mapFile(e.id));
  }
  const kept = index.filter((t) => t.id < DERIVED_ID_BASE);

  let nextId = DERIVED_ID_BASE;
  const added = [];
  for (const r of RECIPES) {
    const src = kept.find((t) => t.id === r.source);
    if (!src) throw new Error('Source template ' + r.source + ' not found in index');
    const map = JSON.parse(readFileSync(mapFile(r.source), 'utf8'));
    if (r.transform) r.transform(map);

    const id = nextId++;
    const name = 'MAP' + String(id).padStart(3, '0');
    map.displayName = '';
    writeFileSync(mapFile(id), JSON.stringify(map));
    const entry = {
      id, name,
      category: r.category,
      theme: r.theme,
      tilesetId: src.tilesetId,
      tilesetName: src.tilesetName,
      width: map.width,
      height: map.height,
      eventCount: Array.isArray(map.events) ? map.events.filter(Boolean).length : 0,
    };
    kept.push(entry);
    added.push(entry);
  }

  // The index is pretty-printed (2-space) in the repo — match it to keep the diff clean.
  writeFileSync(INDEX_PATH, JSON.stringify(kept, null, 2));
  console.log('Derived ' + added.length + ' templates:');
  for (const e of added) console.log('  id' + e.id + '  ' + e.theme.padEnd(7) + ' from source, ' + e.width + 'x' + e.height + ' ts' + e.tilesetId);
}

main();
