import path from "path";
import { readdir, readFile } from 'fs/promises';
import sharp from 'sharp';
import { readJson } from '../utils/fileHandler.js';
import type { SheetInfo } from '../types/rpgmaker.js';

const TILE_SIZE = 48;
const IMG_SUBDIRS = ['characters', 'faces', 'enemies', 'tilesets', 'parallaxes', 'battlebacks1', 'battlebacks2', 'animations'];

const SHEET_KEYS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'];

type AvailableTiles = { ground: any[]; water: any[]; wallSide: any[]; wallTop: any[]; roof: any[]; decoration: any[] };

type TilesetResult = {
  id: number;
  name: string;
  mode: number;
  tilesetNames: string[];
  flags: number[];
  sheets: Record<string, SheetInfo | null>;
  availableTiles: AvailableTiles;
};

async function getImageMetadata(imagePath: string) {
  try {
    const meta = await sharp(imagePath).metadata();
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height };
  } catch (_) {
    return null;
  }
}

function computeSheetInfo(sheetKey: string, filename: string, width: number, height: number): SheetInfo | null {
  if (!width || !height) return null;
  const cols = Math.floor(width / TILE_SIZE);
  const rows = Math.floor(height / TILE_SIZE);
  const info: SheetInfo = { filename: filename, width: width, height: height, cols: cols, rows: rows };

  if (sheetKey === 'A1') {
    var kinds = Math.floor(rows / 6) * 8;
    if (kinds < 1) kinds = 1;
    info.tileCount = kinds * 48;
    info.kinds = kinds;
    info.autotile = true;
  } else if (sheetKey === 'A2') {
    var blocksX = Math.floor(width / 96);
    var blocksY = Math.floor(height / 144);
    var kinds = blocksX * blocksY;
    if (kinds < 1) kinds = 1;
    info.tileCount = kinds * 48;
    info.kinds = kinds;
    info.autotile = true;
  } else if (sheetKey === 'A3') {
    var blocksX = Math.floor(width / 96);
    var blocksY = Math.floor(height / 96);
    var kinds = blocksX * blocksY;
    if (kinds < 1) kinds = 1;
    info.tileCount = kinds * 48;
    info.kinds = kinds;
    info.autotile = true;
  } else if (sheetKey === 'A4') {
    var blocksX = Math.floor(width / 96);
    var blocksY = Math.floor(height / 120);
    var kinds = blocksX * blocksY;
    if (kinds < 1) kinds = 1;
    info.tileCount = kinds * 48;
    info.kinds = kinds;
    info.autotile = true;
  } else {
    info.tileCount = cols * rows;
    info.autotile = false;
  }

  return info;
}

function categorizeTiles(tilesetId: number, tilesetNames: string[], sheets: Record<string, SheetInfo | null>): AvailableTiles {
  const available: AvailableTiles = { ground: [], water: [], wallSide: [], wallTop: [], roof: [], decoration: [] };

  if (!sheets) return available;

  const a1 = sheets['A1'];
  if (a1 && a1.kinds) {
    for (var k = 0; k < a1.kinds; k++) {
      const baseId = 2048 + k * 48;
      if (k <= 1) {
        available.water.push({ tileId: baseId, kind: k, description: (k === 0 ? 'water surface' : 'deep water') + ' A1 kind ' + k });
      } else if (k <= 3) {
        available.water.push({ tileId: baseId, kind: k, description: 'deep water/ground A1 kind ' + k });
        available.ground.push({ tileId: baseId, kind: k, description: 'waterfall/ground A1 kind ' + k });
      } else {
        available.ground.push({ tileId: baseId, kind: k, description: 'ground/waterfall A1 kind ' + k });
      }
    }
  }

  const a2 = sheets['A2'];
  if (a2 && a2.kinds) {
    for (var k = 0; k < a2.kinds; k++) {
      var tileId = 2816 + k * 48;
      let desc = 'floor A2 kind ' + k;
      if (k === 0) desc = 'grass floor A2 kind 0';
      else if (k === 6) desc = 'stone floor A2 kind 6';
      else if (k === 8) desc = 'dirt floor A2 kind 8';
      available.ground.push({ tileId: tileId, kind: k, description: desc });
    }
  }

  const a3 = sheets['A3'];
  if (a3 && a3.kinds) {
    for (var k = 0; k < a3.kinds; k++) {
      var tileId = 4352 + k * 48;
      if (k < 8) {
        available.roof.push({ tileId: tileId, kind: k, description: 'roof A3 kind ' + k });
        available.wallTop.push({ tileId: tileId, kind: k, description: 'roof/wallTop A3 kind ' + k });
      } else {
        available.wallSide.push({ tileId: tileId, kind: k, description: 'wallSide A3 kind ' + k });
      }
    }
  }

  const a4 = sheets['A4'];
  if (a4 && a4.kinds) {
    for (var k = 0; k < a4.kinds; k++) {
      var tileId = 5888 + k * 48;
      if (k % 2 === 0) {
        available.wallTop.push({ tileId: tileId, kind: k, description: 'wallTop/floor A4 kind ' + k });
        available.ground.push({ tileId: tileId, kind: k, description: 'floor A4 kind ' + k });
      } else {
        available.wallSide.push({ tileId: tileId, kind: k, description: 'wallSide A4 kind ' + k });
      }
    }
  }

  const a5 = sheets['A5'];
  if (a5 && a5.tileCount) {
    for (var i = 0; i < a5.tileCount; i++) {
      available.decoration.push({ tileId: 1536 + i, kind: -1, description: 'static tile A5 index ' + i });
    }
    available.ground.push({ tileId: 1536, kind: -1, description: 'A5 static tile 0' });
  }

  const beSheets = ['B', 'C', 'D', 'E'];
  const beBase: Record<string, number> = { B: 0, C: 256, D: 512, E: 768 };
  for (let si = 0; si < beSheets.length; si++) {
    const key = beSheets[si];
    const sheet = sheets[key];
    if (sheet && sheet.tileCount) {
      for (var i = 0; i < sheet.tileCount; i++) {
        available.decoration.push({ tileId: beBase[key] + i, kind: -1, description: 'decoration ' + key + ' index ' + i });
      }
    }
  }

  return available;
}

async function scanProjectAssets(projectPath: string): Promise<{ tilesets: Record<string, any>; images: Record<string, string[]> }> {
  const result: { tilesets: Record<string, any>; images: Record<string, string[]> } = { tilesets: {}, images: {} };

  for (let di = 0; di < IMG_SUBDIRS.length; di++) {
    const subdir = IMG_SUBDIRS[di];
    const dirPath = path.join(projectPath, 'img', subdir);
    try {
      const files = await readdir(dirPath);
      result.images[subdir] = files
        .filter(function(f) { return /\.png$/i.test(f); })
        .map(function(f) { return f.replace(/\.png$/i, ''); })
        .sort();
    } catch (_) {
      result.images[subdir] = [];
    }
  }

  let tilesetsData: any[];
  try {
    tilesetsData = await readJson(projectPath, 'Tilesets.json') as any[];
  } catch (_) {
    return result;
  }

  for (let i = 1; i < tilesetsData.length; i++) {
    const ts: any = tilesetsData[i];
    if (!ts) continue;

    const tsResult: TilesetResult = {
      id: ts.id,
      name: ts.name,
      mode: ts.mode || 0,
      tilesetNames: ts.tilesetNames || [],
      flags: ts.flags || [],
      sheets: {},
      availableTiles: { ground: [], water: [], wallSide: [], wallTop: [], roof: [], decoration: [] }
    };

    const names: string[] = ts.tilesetNames || [];
    for (let si = 0; si < SHEET_KEYS.length && si < names.length; si++) {
      const sheetKey = SHEET_KEYS[si];
      const filename = names[si];
      if (!filename) continue;

      const imgDir = 'tilesets';
      const imagePath = path.join(projectPath, 'img', imgDir, filename + '.png');
      const meta = await getImageMetadata(imagePath);

      if (meta) {
        tsResult.sheets[sheetKey] = computeSheetInfo(sheetKey, filename, meta.width, meta.height);
      } else {
        tsResult.sheets[sheetKey] = null;
      }
    }

    tsResult.availableTiles = categorizeTiles(ts.id, ts.tilesetNames, tsResult.sheets);
    result.tilesets[String(i)] = tsResult;
  }

  return result;
}

async function getTileIdsForTileset(projectPath: string, tilesetId: number | string): Promise<{ availableTiles: AvailableTiles }> {
  let tilesetsData: any[];
  try {
    tilesetsData = await readJson(projectPath, 'Tilesets.json') as any[];
  } catch (_) {
    return { availableTiles: { ground: [], water: [], wallSide: [], wallTop: [], roof: [], decoration: [] } };
  }

  const id = parseInt(String(tilesetId), 10);
  if (id <= 0 || id >= tilesetsData.length || !tilesetsData[id]) {
    return { availableTiles: { ground: [], water: [], wallSide: [], wallTop: [], roof: [], decoration: [] } };
  }

  const ts: any = tilesetsData[id];
  const names: string[] = ts.tilesetNames || [];
  const sheets: Record<string, SheetInfo | null> = {};

  for (let si = 0; si < SHEET_KEYS.length && si < names.length; si++) {
    const sheetKey = SHEET_KEYS[si];
    const filename = names[si];
    if (!filename) continue;

    const imagePath = path.join(projectPath, 'img', 'tilesets', filename + '.png');
    const meta = await getImageMetadata(imagePath);

    if (meta) {
      sheets[sheetKey] = computeSheetInfo(sheetKey, filename, meta.width, meta.height);
    } else {
      sheets[sheetKey] = null;
    }
  }

    return { availableTiles: categorizeTiles(id, ts.tilesetNames, sheets) };
}

export { scanProjectAssets };
export { getTileIdsForTileset };
