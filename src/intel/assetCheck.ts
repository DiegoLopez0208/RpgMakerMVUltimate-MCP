/**
 * assetCheck.ts — image and audio files the project data points at but the project folder lacks.
 *
 * The engine only finds out when the file is requested: a missing battleback or BGM shows up as a
 * 404 in the middle of a playtest. This reads the same names the engine would request (maps,
 * events, actors, enemies, animations, tilesets, System.json) and compares them with img/ and audio/.
 *
 * Judged against the project folder only: assets that come from the RTP and are not copied into
 * the project are reported too, and the message says so. A folder that does not exist at all is
 * skipped, because there is nothing to compare against.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { readJson } from '../utils/fileHandler.js';
import { validateProject, type ValidationIssue, type ValidationReport } from './validate.js';
import type { ProjectIndex } from './projectIndex.js';

const IMAGE_EXT = /\.(png|rpgmvp)$/i;
const AUDIO_EXT = /\.(ogg|m4a|rpgmvo|rpgmvm)$/i;

interface Ref {
  dir: string;      // folder under the project, e.g. "img/battlebacks1" or "audio/bgm"
  name: string;
  where: string;    // human description of the first place that uses it
  mapId?: number;
  eventId?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
/** An audio object {name, volume, ...}; its name, or "". */
const audioName = (value: unknown): string => (isObject(value) ? text(value.name) : '');

/** Audio and picture/graphic references in an event command list (codes as the engine reads them). */
function commandRefs(commands: unknown, where: string, base: Partial<Ref>, out: Ref[]) {
  for (const command of list(commands)) {
    if (!isObject(command) || !Array.isArray(command.parameters)) continue;
    const p = command.parameters as unknown[];
    const add = (dir: string, name: string) => { if (name) out.push({ ...base, dir, name, where }); };
    switch (command.code) {
      case 241: add('audio/bgm', audioName(p[0])); break;
      case 245: add('audio/bgs', audioName(p[0])); break;
      case 249: add('audio/me', audioName(p[0])); break;
      case 250: add('audio/se', audioName(p[0])); break;
      case 132: add('audio/bgm', audioName(p[0])); break;
      case 133: add('audio/me', audioName(p[0])); break;
      case 139: add('audio/me', audioName(p[0])); break;
      case 231: add('img/pictures', text(p[1])); break;
      case 283: add('img/battlebacks1', text(p[0])); add('img/battlebacks2', text(p[1])); break;
      case 284: add('img/parallaxes', text(p[0])); break;
      case 322: add('img/characters', text(p[1])); add('img/faces', text(p[3])); add('img/sv_actors', text(p[5])); break;
      default: break;
    }
  }
}

function eventRefs(events: unknown, mapId: number, out: Ref[]) {
  for (const event of list(events)) {
    if (!isObject(event)) continue;
    const eventId = typeof event.id === 'number' ? event.id : undefined;
    const where = `map ${mapId} event ${eventId ?? '?'}`;
    for (const page of list(event.pages)) {
      if (!isObject(page)) continue;
      const character = isObject(page.image) ? text(page.image.characterName) : '';
      if (character) out.push({ dir: 'img/characters', name: character, where, mapId, eventId });
      commandRefs(page.list, where, { mapId, eventId }, out);
    }
  }
}

async function readOptional(projectPath: string, file: string): Promise<unknown> {
  try { return await readJson(projectPath, file); } catch { return null; }
}

async function collectRefs(projectPath: string, mapIds: number[]): Promise<Ref[]> {
  const out: Ref[] = [];

  for (const mapId of mapIds) {
    const map = await readOptional(projectPath, `Map${String(mapId).padStart(3, '0')}.json`);
    if (!isObject(map)) continue;
    const where = `map ${mapId}`;
    const add = (dir: string, name: string) => { if (name) out.push({ dir, name, where, mapId }); };
    add('img/battlebacks1', text(map.battleback1Name));
    add('img/battlebacks2', text(map.battleback2Name));
    add('img/parallaxes', text(map.parallaxName));
    if (map.autoplayBgm) add('audio/bgm', audioName(map.bgm));
    if (map.autoplayBgs) add('audio/bgs', audioName(map.bgs));
    eventRefs(map.events, mapId, out);
  }

  const system = await readOptional(projectPath, 'System.json');
  const sideView = isObject(system) && system.optSideView === true;

  for (const [index, entry] of list(await readOptional(projectPath, 'CommonEvents.json')).entries()) {
    if (isObject(entry)) commandRefs(entry.list, `common event ${index}`, {}, out);
  }
  for (const [index, troop] of list(await readOptional(projectPath, 'Troops.json')).entries()) {
    if (!isObject(troop)) continue;
    for (const page of list(troop.pages)) if (isObject(page)) commandRefs(page.list, `troop ${index}`, {}, out);
  }
  for (const [index, actor] of list(await readOptional(projectPath, 'Actors.json')).entries()) {
    if (!isObject(actor)) continue;
    const where = `actor ${index}`;
    for (const [dir, key] of [['img/characters', 'characterName'], ['img/faces', 'faceName'], ['img/sv_actors', 'battlerName']] as const) {
      if (text(actor[key])) out.push({ dir, name: text(actor[key]), where });
    }
  }
  for (const [index, enemy] of list(await readOptional(projectPath, 'Enemies.json')).entries()) {
    if (isObject(enemy) && text(enemy.battlerName)) out.push({ dir: sideView ? 'img/sv_enemies' : 'img/enemies', name: text(enemy.battlerName), where: `enemy ${index}` });
  }
  for (const [index, animation] of list(await readOptional(projectPath, 'Animations.json')).entries()) {
    if (!isObject(animation)) continue;
    for (const key of ['animation1Name', 'animation2Name']) {
      if (text(animation[key])) out.push({ dir: 'img/animations', name: text(animation[key]), where: `animation ${index}` });
    }
  }
  for (const [index, tileset] of list(await readOptional(projectPath, 'Tilesets.json')).entries()) {
    if (!isObject(tileset)) continue;
    for (const name of list(tileset.tilesetNames)) if (text(name)) out.push({ dir: 'img/tilesets', name: text(name), where: `tileset ${index}` });
  }

  if (isObject(system)) {
    const where = 'System.json';
    const add = (dir: string, name: string) => { if (name) out.push({ dir, name, where }); };
    add('img/titles1', text(system.title1Name));
    add('img/titles2', text(system.title2Name));
    add('img/battlebacks1', text(system.battleback1Name));
    add('img/battlebacks2', text(system.battleback2Name));
    add('audio/bgm', audioName(system.titleBgm));
    add('audio/bgm', audioName(system.battleBgm));
    for (const key of ['victoryMe', 'defeatMe', 'gameoverMe']) add('audio/me', audioName(system[key]));
    for (const key of ['boat', 'ship', 'airship']) {
      const vehicle = system[key];
      if (isObject(vehicle)) { add('img/characters', text(vehicle.characterName)); add('audio/bgm', audioName(vehicle.bgm)); }
    }
    for (const sound of list(system.sounds)) add('audio/se', audioName(sound));
  }
  return out;
}

/** Base names in a folder (extension removed); null when the folder does not exist. */
async function listFolder(projectPath: string, dir: string): Promise<Set<string> | null> {
  const pattern = dir.startsWith('img/') ? IMAGE_EXT : AUDIO_EXT;
  try {
    return new Set((await readdir(join(projectPath, dir))).filter((file) => pattern.test(file)).map((file) => file.replace(pattern, '')));
  } catch {
    return null;
  }
}

/**
 * Issues for every distinct asset the data requests that the project folder lacks (`missing-asset`),
 * or has only under a different letter case (`asset-case`, which breaks on a case-sensitive web host).
 */
export async function missingAssetIssues(projectPath: string, mapIds: number[]): Promise<ValidationIssue[]> {
  const refs = await collectRefs(projectPath, mapIds);
  const folders = new Map<string, Set<string> | null>();
  for (const dir of new Set(refs.map((ref) => ref.dir))) folders.set(dir, await listFolder(projectPath, dir));

  const groups = new Map<string, { ref: Ref; uses: number }>();
  for (const ref of refs) {
    const names = folders.get(ref.dir);
    if (!names || names.has(ref.name)) continue;
    const key = ref.dir + '/' + ref.name;
    const group = groups.get(key);
    if (group) group.uses++;
    else groups.set(key, { ref, uses: 1 });
  }

  const issues: ValidationIssue[] = [];
  for (const { ref, uses } of groups.values()) {
    const names = folders.get(ref.dir) as Set<string>;
    const lower = ref.name.toLowerCase();
    const sameName = [...names].find((candidate) => candidate.toLowerCase() === lower);
    const used = uses === 1 ? `used by ${ref.where}` : `used ${uses} times, first by ${ref.where}`;
    const place = { mapId: ref.mapId, eventId: ref.eventId };
    if (sameName) {
      issues.push({ severity: 'warning', category: 'asset-case', ...place, message: `${ref.dir}/${ref.name} (${used}) exists only as "${sameName}"; it loads on Windows but fails on a case-sensitive web host` });
    } else {
      issues.push({ severity: 'warning', category: 'missing-asset', ...place, message: `${ref.dir}/${ref.name} (${used}) is not in the project folder; the game requests it and gets a 404 (an RTP asset must be copied in to ship)` });
    }
  }
  return issues.sort((a, b) => a.message.localeCompare(b.message));
}

/** validateProject plus the missing-asset issues; an unreadable data folder never fails the report. */
export async function validateWithAssets(projectPath: string, index: ProjectIndex): Promise<ValidationReport> {
  const report = validateProject(index);
  const assets = await missingAssetIssues(projectPath, index.maps.filter((m) => !m.missing).map((m) => m.id)).catch(() => []);
  if (assets.length === 0) return report;
  const issues = [...report.issues, ...assets];
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) bySeverity[issue.severity]++;
  return { issueCount: issues.length, bySeverity, issues };
}
