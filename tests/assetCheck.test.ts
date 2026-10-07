import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';

const dirs: string[] = [];
let project: string;
const write = (name: string, value: unknown) => writeFileSync(path.join(project, 'data', name), JSON.stringify(value));
const touch = (dir: string, file: string) => { mkdirSync(path.join(project, dir), { recursive: true }); writeFileSync(path.join(project, dir, file), ''); };
const audio = (name: string) => ({ name, volume: 90, pitch: 100, pan: 0 });
const event = (id: number, characterName: string, list: unknown[] = []) => ({
  id, name: 'EV' + id, note: '', x: id, y: 1,
  pages: [{ conditions: {}, image: { characterName, characterIndex: 0, direction: 2, pattern: 1, tileId: 0 }, list: [...list, { code: 0, indent: 0, parameters: [] }] }],
});

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-assets-'));
  dirs.push(project);
  mkdirSync(path.join(project, 'data'));
  write('Map001.json', {
    width: 5, height: 5, tilesetId: 1, data: new Array(5 * 5 * 6).fill(0), encounterList: [], encounterStep: 30,
    battleback1Name: 'Grassland', battleback2Name: 'NoSuchBack', parallaxName: 'Sky',
    autoplayBgm: true, bgm: audio('Theme'), autoplayBgs: false, bgs: audio('Wind'),
    events: [
      null,
      event(1, 'Hero'),                                   // exists only as "hero.png"
      event(2, 'Ghost', [{ code: 250, indent: 0, parameters: [audio('Cursor')] }]),
      event(3, 'Ghost', [{ code: 241, indent: 0, parameters: [audio('Boss')] }, { code: 231, indent: 0, parameters: [1, 'Poster', 0, 0, 0, 0, 100, 100, 255, 0] }]),
    ],
  });
  write('MapInfos.json', [null, { id: 1, name: 'Field', parentId: 0, order: 1 }]);
  write('System.json', { startMapId: 1, startX: 1, startY: 1, partyMembers: [], switches: [''], variables: [''], optSideView: false, title1Name: 'Castle', title2Name: '', battleBgm: audio('Battle1'), sounds: [audio('Cursor')] });
  write('Actors.json', [null, { id: 1, name: 'A', characterName: 'Hero', faceName: 'Faceless', battlerName: '' }]);
  write('Enemies.json', [null, { id: 1, name: 'Slime', battlerName: 'Slime' }]);
  for (const name of ['Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'States', 'Troops', 'Animations', 'CommonEvents', 'Tilesets']) write(name + '.json', [null]);

  touch('img/battlebacks1', 'Grassland.png');
  touch('img/battlebacks2', 'Other.png');
  touch('img/parallaxes', 'Sky.png');
  touch('img/characters', 'hero.png');
  touch('img/faces', 'Other.png');
  touch('img/enemies', 'Slime.png');
  touch('img/titles1', 'Castle.png');
  // img/pictures and img/sv_actors do not exist: nothing to compare against
  touch('audio/bgm', 'Theme.ogg');
  touch('audio/bgm', 'Battle1.m4a');
  touch('audio/se', 'Cursor.ogg');
  initProjectPath(project);
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Issue = { severity: string; category: string; message: string; mapId?: number; eventId?: number };
const validate = async () => (await dispatchTool('analyze_project', { view: 'validate' }) as { issues: Issue[]; bySeverity: Record<string, number> });
const assetIssues = async () => (await validate()).issues.filter((i) => i.category === 'missing-asset' || i.category === 'asset-case');

describe('analyze_project validate: missing assets', () => {
  it('reports each missing file once, with where it is used', async () => {
    const messages = (await assetIssues()).filter((i) => i.category === 'missing-asset').map((i) => i.message);
    expect(messages).toHaveLength(4);
    expect(messages.find((m) => m.startsWith('img/battlebacks2/NoSuchBack'))).toContain('used by map 1');
    expect(messages.find((m) => m.startsWith('img/characters/Ghost'))).toContain('used 2 times, first by map 1 event 2');
    expect(messages.find((m) => m.startsWith('audio/bgm/Boss'))).toContain('map 1 event 3');
    expect(messages.find((m) => m.startsWith('img/faces/Faceless'))).toContain('actor 1');
  });

  it('flags a file that exists only under another letter case', async () => {
    const cases = (await assetIssues()).filter((i) => i.category === 'asset-case');
    expect(cases).toHaveLength(1);
    expect(cases[0].message).toContain('img/characters/Hero');
    expect(cases[0].message).toContain('"hero"');
  });

  it('accepts audio by base name whatever the extension, and skips folders that do not exist', async () => {
    const all = (await assetIssues()).map((i) => i.message).join('\n');
    expect(all).not.toContain('audio/bgm/Theme');      // Theme.ogg
    expect(all).not.toContain('audio/bgm/Battle1');    // Battle1.m4a
    expect(all).not.toContain('audio/se/Cursor');
    expect(all).not.toContain('Poster');               // img/pictures is absent
    expect(all).not.toContain('audio/bgs/Wind');       // autoplayBgs is off
  });

  it('counts them in bySeverity and in the overview health', async () => {
    const report = await validate();
    expect(report.bySeverity.warning).toBe(5);
    const overview = await dispatchTool('analyze_project', { view: 'overview' }) as { health: Record<string, number> };
    expect(overview.health.warning).toBe(5);
  });

  it('reports nothing for a project whose files are all there', async () => {
    touch('img/battlebacks2', 'NoSuchBack.png');
    // a case-insensitive disk would reuse hero.png for Hero.png, so replace it
    rmSync(path.join(project, 'img/characters/hero.png'));
    touch('img/characters', 'Hero.png');
    touch('img/characters', 'Ghost.png');
    touch('img/faces', 'Faceless.png');
    touch('audio/bgm', 'Boss.ogg');
    expect(await assetIssues()).toEqual([]);
  });

  it('looks for enemy battlers in sv_enemies when the project uses side view', async () => {
    write('System.json', { startMapId: 1, startX: 1, startY: 1, switches: [''], variables: [''], optSideView: true });
    touch('img/sv_enemies', 'Other.png');
    const messages = (await assetIssues()).map((i) => i.message);
    expect(messages.some((m) => m.startsWith('img/sv_enemies/Slime'))).toBe(true);
  });
});
