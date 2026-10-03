import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkAssets, AssetProjectData, AvailableAssets } from '../../src/parity/validation/assets.js';
import { validationToolDefinitions } from '../../src/parity/tools/validationTools.js';

/** An all-empty AssetProjectData; override just the slices a case exercises. */
function emptyData(over: Partial<AssetProjectData> = {}): AssetProjectData {
  return {
    actors: [],
    enemies: [],
    tilesets: [],
    maps: [],
    troops: [],
    commonEvents: [],
    system: null,
    ...over,
  };
}

/** AvailableAssets from plain type→names; a type with no entry is "can't verify". */
function assetsFrom(over: Record<string, string[]>): AvailableAssets {
  const a: AvailableAssets = {};
  for (const [type, names] of Object.entries(over)) a[type] = new Set(names);
  return a;
}

describe('checkAssets — records', () => {
  it('flags an enemy battlerName with no matching file (the Mudcrab case)', () => {
    const data = emptyData({
      enemies: [
        null,
        { id: 1, battlerName: 'Mudcrab' } as unknown as AssetProjectData['enemies'][0],
      ],
    });
    const warnings = checkAssets(data, assetsFrom({ enemies: ['Bat', 'Slime'] }));
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'enemy', path: 'enemy 1 / battlerName' }),
    );
  });

  it('is silent when the battlerName exists', () => {
    const data = emptyData({
      enemies: [null, { id: 1, battlerName: 'Slime' } as unknown as AssetProjectData['enemies'][0]],
    });
    expect(checkAssets(data, assetsFrom({ enemies: ['Bat', 'Slime'] }))).toEqual([]);
  });

  it('checks actor character/face/battler against their own folders', () => {
    const data = emptyData({
      actors: [
        null,
        {
          id: 1,
          characterName: 'Hero',
          faceName: 'GhostFace',
          battlerName: 'Hero',
        } as unknown as AssetProjectData['actors'][0],
      ],
    });
    const warnings = checkAssets(
      data,
      assetsFrom({ characters: ['Hero'], faces: ['Actor1'], sv_actors: ['Hero'] }),
    );
    // Only faceName is dangling.
    expect(warnings.map((w) => w.path)).toEqual(['actor 1 / faceName']);
  });

  it('skips a blank name (no asset set)', () => {
    const data = emptyData({
      actors: [
        null,
        {
          id: 1,
          characterName: '',
          faceName: '',
          battlerName: '',
        } as unknown as AssetProjectData['actors'][0],
      ],
    });
    expect(checkAssets(data, assetsFrom({ characters: ['Hero'] }))).toEqual([]);
  });

  it('skips a type whose directory is empty/unverifiable (never false-positives)', () => {
    const data = emptyData({
      enemies: [
        null,
        { id: 1, battlerName: 'Mudcrab' } as unknown as AssetProjectData['enemies'][0],
      ],
    });
    // enemies not present in the available map at all -> can't verify -> no warning.
    expect(checkAssets(data, assetsFrom({ characters: ['Hero'] }))).toEqual([]);
    // enemies present but empty -> same.
    expect(checkAssets(data, assetsFrom({ enemies: [] }))).toEqual([]);
  });

  describe('enemy battler folder follows System.optSideView', () => {
    const enemyData = (sideView: boolean | undefined): AssetProjectData =>
      emptyData({
        enemies: [null, { id: 1, battlerName: 'Orc' } as unknown as AssetProjectData['enemies'][0]],
        system: (sideView === undefined
          ? null
          : { optSideView: sideView }) as unknown as AssetProjectData['system'],
      });

    it('front-view checks img/enemies', () => {
      expect(checkAssets(enemyData(false), assetsFrom({ enemies: ['Orc'] }))).toEqual([]);
      expect(checkAssets(enemyData(undefined), assetsFrom({ enemies: ['Orc'] }))).toEqual([]);
    });

    it('side-view checks img/sv_enemies', () => {
      expect(checkAssets(enemyData(true), assetsFrom({ sv_enemies: ['Orc'] }))).toEqual([]);
      const warnings = checkAssets(enemyData(true), assetsFrom({ sv_enemies: ['Slime'] }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toMatch(/img\/sv_enemies/);
    });

    it('side-view flags a battler found only in img/enemies, naming that folder', () => {
      const warnings = checkAssets(enemyData(true), assetsFrom({ enemies: ['Orc'] }));
      expect(warnings).toEqual([
        expect.objectContaining({ category: 'enemy', path: 'enemy 1 / battlerName' }),
      ]);
      expect(warnings[0]!.message).toMatch(/missing from img\/sv_enemies/);
      expect(warnings[0]!.message).toMatch(/found in img\/enemies.*side-view/);
    });

    it('front-view flags a battler found only in img/sv_enemies, naming that folder', () => {
      const warnings = checkAssets(
        enemyData(false),
        assetsFrom({ sv_enemies: ['Orc'], enemies: ['Bat'] }),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toMatch(/missing from img\/enemies/);
      expect(warnings[0]!.message).toMatch(/found in img\/sv_enemies.*front-view/);
    });
  });

  it('flags a tileset sheet slot', () => {
    const data = emptyData({
      tilesets: [
        null,
        {
          id: 1,
          tilesetNames: ['World_A1', '', 'Ghost_A3', '', '', '', '', '', ''],
        } as unknown as AssetProjectData['tilesets'][0],
      ],
    });
    const warnings = checkAssets(data, assetsFrom({ tilesets: ['World_A1', 'World_A2'] }));
    expect(warnings).toContainEqual(
      expect.objectContaining({ category: 'tileset', path: 'tileset 1 / tilesetNames[2]' }),
    );
  });
});

describe('checkAssets — event commands', () => {
  it('flags a Play SE with a missing audio file inside a map event', () => {
    const map = {
      bgm: { name: '' },
      bgs: { name: '' },
      parallaxName: '',
      battleback1Name: '',
      battleback2Name: '',
      events: [
        null,
        {
          id: 3,
          pages: [
            {
              image: { characterName: '' },
              list: [
                {
                  code: 250,
                  indent: 0,
                  parameters: [{ name: 'Ghost', volume: 90, pitch: 100, pan: 0 }],
                },
                { code: 0, indent: 0, parameters: [] },
              ],
            },
          ],
        },
      ],
    } as unknown as AssetProjectData['maps'][0]['map'];
    const warnings = checkAssets(
      emptyData({ maps: [{ id: 5, map }] }),
      assetsFrom({ se: ['Cursor', 'Decision'] }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        category: 'event-command',
        path: 'map 5 / event 3 / page 0 / command 0 (Play SE)',
      }),
    );
  });
});

describe('validate_assets tool (integration)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function scaffold(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'rpgmv-assets-'));
    await writeFile(join(d, 'Game.rpgproject'), 'RPGMV 1.6.1');
    await mkdir(join(d, 'data'));
    await mkdir(join(d, 'img', 'enemies'), { recursive: true });
    await writeFile(join(d, 'img', 'enemies', 'Slime.png'), '');
    await writeFile(join(d, 'data', 'System.json'), '{}');
    await writeFile(join(d, 'data', 'MapInfos.json'), '[null]');
    await writeFile(
      join(d, 'data', 'Enemies.json'),
      JSON.stringify([null, { id: 1, battlerName: 'Mudcrab' }]),
    );
    return d;
  }

  it('reports a dangling enemy battler through the handler', async () => {
    dir = await scaffold();
    const tool = validationToolDefinitions.find((t) => t.name === 'validate_assets')!;
    const result = (await tool.handler({ projectPath: dir }, {})) as {
      ok: boolean;
      warnings: Array<{ category: string; message: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.category === 'enemy' && /Mudcrab/.test(w.message))).toBe(
      true,
    );
  });
});
