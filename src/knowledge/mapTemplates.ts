import path from "path";
import { readFile, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import type { MapData } from "../types/rpgmaker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MapTemplate {
  id: number;
  name: string;
  category: string;
  theme: string;
  tilesetId: number;
  tilesetName: string;
  width: number;
  height: number;
  eventCount: number;
}
let _index: MapTemplate[] | null = null;
let _mapsDir: string = "";
export function getTemplatesDir(): string {
  if (!_mapsDir) {
    _mapsDir = path.join(__dirname, "..", "..", "knowledge", "maps");
  }
  return _mapsDir;
}
export async function loadIndex(): Promise<MapTemplate[]> {
  if (_index) return _index;
  const idxPath = path.join(__dirname, "..", "..", "knowledge", "map-templates.json");
  try {
    await access(idxPath);
    _index = JSON.parse(await readFile(idxPath, "utf8")) as MapTemplate[];
  } catch { _index = []; }
  return _index;
}
export async function search(category?: string, theme?: string): Promise<MapTemplate[]> {
  const idx = await loadIndex();
  return idx.filter(function(t) {
    if (category && t.category !== category) return false;
    if (theme && t.theme !== theme) return false;
    return true;
  });
}
export async function loadMapData(templateId: number): Promise<MapData | null> {
  const fn = "Map" + String(templateId).padStart(3, "0") + ".json";
  const fp = path.join(getTemplatesDir(), fn);
  try {
    await access(fp);
    return JSON.parse(await readFile(fp, "utf8")) as MapData;
  } catch {
    return null;
  }
}
