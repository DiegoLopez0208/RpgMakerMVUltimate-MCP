/**
 * Tools-layer bridge for tile transparency: loads a tileset sheet PNG (cached by
 * path + mtime, failing soft when the image is missing/unreadable) and answers
 * "does this raw tile id need an opaque base beneath it?" — plus a base-aware
 * paint warning that fires when a transparent tile lands with the map's void
 * showing through.
 *
 * The pixel work is pure (`../tiles/transparency`, `../tiles/png`); this module
 * only does the I/O, the raw-id → (sheet, role, local index) resolution, and the
 * per-map layer scan.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, DecodedImage } from '../tiles/png.js';
import { TileRole, tileTransparentFraction, needsBase } from '../tiles/transparency.js';
import { BASE_KIND } from '../tiles/tilegeom.js';
import { decodeTile } from '../tiles/tileCodec.js';
import { tileIndex } from './mapTools.js';
import { MapData, Tileset } from '../utils/types.js';
import { CatalogEntry, validSheetName } from '../tiles/catalog/index.js';

/** `tilesetNames` slot index for each sheet role. */
const SLOT_INDEX: Record<TileRole, number> = {
  A1: 0,
  A2: 1,
  A3: 2,
  A4: 3,
  A5: 4,
  B: 5,
  C: 6,
  D: 7,
  E: 8,
};

/** In-process cache of decoded sheets, keyed by file path. `img: null` = a load that failed. */
const sheetCache = new Map<string, { mtimeMs: number; img: DecodedImage | null }>();

/**
 * Decode a tileset sheet PNG from `img/tilesets/<name>.png`, cached by mtime.
 * Returns `undefined` (never throws) when the sheet name is empty or the file is
 * missing/undecodable — transparency is simply unknown for that sheet.
 */
async function loadSheetImage(
  projectPath: string,
  sheetName: string,
): Promise<DecodedImage | undefined> {
  if (!validSheetName(sheetName)) return undefined;
  const path = join(projectPath, 'img', 'tilesets', `${sheetName}.png`);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = sheetCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.img ?? undefined;
  try {
    const img = decodePng(await readFile(path));
    sheetCache.set(path, { mtimeMs, img });
    return img;
  } catch {
    sheetCache.set(path, { mtimeMs, img: null });
    return undefined;
  }
}

/** Resolve a raw tile id to its sheet role + local index within that sheet, or null. */
function tileSlot(tileId: number): { role: TileRole; localIndex: number } | null {
  const d = decodeTile(tileId);
  if (d.empty || !d.sheet) return null;
  if (d.autotile) {
    const role = d.sheet as 'A1' | 'A2' | 'A3' | 'A4';
    return { role, localIndex: d.kind! - BASE_KIND[role] };
  }
  return { role: d.sheet, localIndex: d.sheetIndex };
}

/**
 * Whether a raw tile id is transparent enough to need an opaque base beneath it.
 * `undefined` = unknown (empty tile, or the sheet PNG couldn't be read). A small
 * `cache` map memoises results within one operation so a big fill doesn't
 * reclassify the same id repeatedly.
 */
export async function isTileTransparent(
  projectPath: string,
  tileset: Tileset,
  tileId: number,
  cache?: Map<number, boolean | undefined>,
): Promise<boolean | undefined> {
  if (cache?.has(tileId)) return cache.get(tileId);
  const result = await classify(projectPath, tileset, tileId);
  cache?.set(tileId, result);
  return result;
}

async function classify(
  projectPath: string,
  tileset: Tileset,
  tileId: number,
): Promise<boolean | undefined> {
  return (await tileTransparencyDetail(projectPath, tileset, tileId))?.transparent;
}

/**
 * The transparency reading for one tile: whether it needs a base and the percent
 * of its sample that is transparent (for `describe_tile`). `undefined` when the
 * tile is empty or the sheet PNG can't be read.
 */
export async function tileTransparencyDetail(
  projectPath: string,
  tileset: Tileset,
  tileId: number,
): Promise<{ transparent: boolean; transparentPercent: number } | undefined> {
  const slot = tileSlot(tileId);
  if (!slot) return undefined;
  const img = await loadSheetImage(projectPath, tileset.tilesetNames[SLOT_INDEX[slot.role]]);
  if (!img) return undefined;
  const fraction = tileTransparentFraction(img, slot.role, slot.localIndex);
  return { transparent: needsBase(fraction), transparentPercent: Math.round(fraction * 100) };
}

/**
 * Set each catalog entry's `transparent` flag by inspecting its tileset sheet
 * (in place). Entries whose sheet PNG can't be read are left unset (unknown).
 * Only worth calling on a bounded entry list (one sheet, or `find_tile` matches).
 */
export async function annotateTransparency(
  projectPath: string,
  tileset: Tileset,
  entries: CatalogEntry[],
): Promise<void> {
  const cache = new Map<number, boolean | undefined>();
  for (const entry of entries) {
    const transparent = await isTileTransparent(projectPath, tileset, entry.tileId, cache);
    if (transparent !== undefined) entry.transparent = transparent;
  }
}

/** A cell paint plus the layer it landed on — the input to the base-aware scan. */
export interface PaintedCell {
  x: number;
  y: number;
  tileId: number;
  layer: number;
}

/**
 * Scan painted cells for the transparent-tile-without-a-base footgun: a
 * transparent tile on layer L with no *opaque* tile on any lower layer in the
 * same cell will show the map's void through its see-through areas. Returns a
 * single aggregated warning (or `undefined`) so a large fill doesn't spam one
 * line per cell. Fails soft — cells whose transparency can't be read are ignored.
 */
export async function baseAwareTransparencyWarning(
  projectPath: string,
  map: MapData,
  tileset: Tileset,
  cells: PaintedCell[],
): Promise<string | undefined> {
  const cache = new Map<number, boolean | undefined>();
  const offenders: { x: number; y: number; layer: number }[] = [];

  for (const cell of cells) {
    if (cell.tileId === 0) continue;
    const transparent = await isTileTransparent(projectPath, tileset, cell.tileId, cache);
    if (transparent !== true) continue; // opaque or unknown — no footgun

    let hasBase = false;
    for (let z = 0; z < cell.layer; z++) {
      const below = map.data[tileIndex(map.width, map.height, cell.x, cell.y, z)];
      if (below === 0) continue;
      if ((await isTileTransparent(projectPath, tileset, below, cache)) === false) {
        hasBase = true; // an opaque tile beneath covers the void
        break;
      }
    }
    if (!hasBase) offenders.push({ x: cell.x, y: cell.y, layer: cell.layer });
  }

  if (offenders.length === 0) return undefined;
  const first = offenders[0];
  const where =
    offenders.length === 1
      ? `(${first.x}, ${first.y})`
      : `${offenders.length} cells (e.g. (${first.x}, ${first.y}))`;
  return (
    `${where} paint a transparent tile on layer ${first.layer} with no opaque base beneath — ` +
    `its see-through areas will show the map's void. Paint an opaque ground tile on a lower layer ` +
    `first (layer 0), or place this on an upper tile layer over existing ground.`
  );
}
