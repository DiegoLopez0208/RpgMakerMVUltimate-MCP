// @ts-nocheck
import fs from "fs";
import path from "path";
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
var _index: MapTemplate[] | null = null;
var _mapsDir: string = "";
export function getTemplatesDir(): string {
  if (!_mapsDir) {
    _mapsDir = path.join(__dirname, "..", "..", "knowledge", "maps");
  }
  return _mapsDir;
}
export function loadIndex(): MapTemplate[] {
  if (_index) return _index;
  var idxPath = path.join(__dirname, "..", "..", "knowledge", "map-templates.json");
  if (fs.existsSync(idxPath)) {
    _index = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  } else { _index = []; }
  return _index;
}
export function search(category?: string, theme?: string): MapTemplate[] {
  return loadIndex().filter(function(t) {
    if (category && t.category !== category) return false;
    if (theme && t.theme !== theme) return false;
    return true;
  });
}
export function loadMapData(templateId: number): any {
  var fn = "Map" + String(templateId).padStart(3, "0") + ".json";
  var fp = path.join(getTemplatesDir(), fn);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}
