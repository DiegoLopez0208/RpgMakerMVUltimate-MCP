import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import {
  createEnemy,
  updateEnemy,
  getEnemies,
  searchEnemies,
  defaultEnemy,
  createTroop,
  updateTroop,
  getTroops,
  blankTroopPage,
  buildTroopPage,
  addTroopPage,
  battleToolDefinitions,
} from '../src/parity/tools/battleTools.js';
import { listNames } from '../src/parity/tools/listTools.js';
import { Enemy, Troop } from '../src/parity/utils/types.js';

/** Scaffold a minimal project with seeded Enemies.json and Troops.json. */
async function scaffoldProject(
  enemies: (Enemy | null)[],
  troops: (Troop | null)[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-battle-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Enemies.json'), JSON.stringify(enemies));
  await writeFile(join(dir, 'data', 'Troops.json'), JSON.stringify(troops));
  return dir;
}

const slime: Enemy = { ...defaultEnemy(), id: 1, name: 'Slime' };

describe('enemy tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // 1-indexed arrays whose slot 0 is null.
    dir = await scaffoldProject([null, slime], [null]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createEnemy assigns the next id, applies defaults, and persists compactly', async () => {
    const created = await createEnemy(dir, { name: 'Bat' });
    expect(created.id).toBe(2);
    expect(created.params).toEqual([100, 0, 10, 10, 10, 10, 10, 10]);
    expect(created.dropItems).toHaveLength(3);

    const enemies = await getEnemies(dir);
    expect(enemies.find((e) => e?.id === 2)?.name).toBe('Bat');

    const raw = await readFile(join(dir, 'data', 'Enemies.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createEnemy honors overrides but never lets a caller set the id', async () => {
    const created = await createEnemy(dir, {
      name: 'Dragon',
      exp: 500,
      params: [9999, 0, 200, 200, 100, 100, 80, 50],
      id: 99,
    } as Partial<Omit<Enemy, 'id'>> & { id: number });
    expect(created.id).toBe(2);
    expect(created.exp).toBe(500);
    expect(created.params[0]).toBe(9999);
  });

  it('createEnemy ignores undefined optional fields, keeping template defaults', async () => {
    const created = await createEnemy(dir, { name: 'Ghost', exp: undefined });
    expect(created.exp).toBe(0);
    expect(created.gold).toBe(0);
  });

  it('updateEnemy merges and refuses an unknown id', async () => {
    const updated = await updateEnemy(dir, 1, { gold: 42 });
    expect(updated.gold).toBe(42);
    expect(updated.name).toBe('Slime');
    await expect(updateEnemy(dir, 99, { gold: 1 })).rejects.toThrow(/not found/);
  });

  it('searchEnemies matches by name, case-insensitively', async () => {
    expect((await searchEnemies(dir, 'SLIME')).map((e) => e.id)).toEqual([1]);
    expect(await searchEnemies(dir, 'nobody')).toEqual([]);
  });

  it('list_names indexes enemies', async () => {
    const result = await listNames(dir, 'enemies');
    expect(result.entries).toEqual([{ id: 1, name: 'Slime' }]);
  });

  it('the create_enemy tool handler dispatches to createEnemy', async () => {
    const def = battleToolDefinitions.find((t) => t.name === 'create_enemy')!;
    expect(def.mutates).toBe(true);
    const result = (await def.handler({ projectPath: dir }, { name: 'ViaTool' })) as {
      enemy: Enemy;
      warnings?: unknown[];
    };
    expect(result.enemy.id).toBe(2);
    // No enemies asset dir in the fixture → the battler check is skipped (no false positive).
    expect(result.warnings).toBeUndefined();
  });

  it('create_enemy warns on an unknown battlerName when the asset dir has entries', async () => {
    // Seed an img/enemies dir with one real battler so the check can run.
    await mkdir(join(dir, 'img', 'enemies'), { recursive: true });
    await writeFile(join(dir, 'img', 'enemies', 'Bat.png'), '');
    const def = battleToolDefinitions.find((t) => t.name === 'create_enemy')!;
    const result = (await def.handler(
      { projectPath: dir },
      { name: 'Ghost', battlerName: 'NoSuchSprite' },
    )) as { enemy: Enemy; warnings?: { path: string }[] };
    expect(result.warnings?.some((w) => w.path === 'battlerName')).toBe(true);

    // A battlerName that DOES exist produces no warning.
    const ok = (await def.handler(
      { projectPath: dir },
      { name: 'RealBat', battlerName: 'Bat' },
    )) as { enemy: Enemy; warnings?: unknown[] };
    expect(ok.warnings).toBeUndefined();
  });

  describe('battlerName folder follows System.optSideView', () => {
    const setSideView = (on: boolean) =>
      writeFile(join(dir, 'data', 'System.json'), JSON.stringify({ optSideView: on }));
    const seed = async (folder: string, name: string) => {
      await mkdir(join(dir, 'img', folder), { recursive: true });
      await writeFile(join(dir, 'img', folder, `${name}.png`), '');
    };
    type Result = { enemy: Enemy; warnings?: { path: string; message: string }[] };
    const create = (args: Record<string, unknown>) =>
      battleToolDefinitions
        .find((t) => t.name === 'create_enemy')!
        .handler({ projectPath: dir }, args);

    it('side-view: accepts a battler in img/sv_enemies', async () => {
      await setSideView(true);
      await seed('sv_enemies', 'Orc');
      const result = (await create({ name: 'Orc', battlerName: 'Orc' })) as Result;
      expect(result.warnings).toBeUndefined();
    });

    it('side-view: warns when the battler is only in img/enemies, naming that folder', async () => {
      await setSideView(true);
      await seed('enemies', 'Orc');
      const result = (await create({ name: 'Orc', battlerName: 'Orc' })) as Result;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]!.path).toBe('battlerName');
      expect(result.warnings![0]!.message).toMatch(/sv_enemies/);
      expect(result.warnings![0]!.message).toMatch(/found in img\/enemies.*side-view/);
    });

    it('front-view: warns when the battler is only in img/sv_enemies, naming that folder', async () => {
      await setSideView(false);
      await seed('sv_enemies', 'Orc');
      const result = (await create({ name: 'Orc', battlerName: 'Orc' })) as Result;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]!.message).toMatch(/found in img\/sv_enemies.*front-view/);
    });

    it('front-view: accepts a battler in img/enemies (update path too)', async () => {
      await setSideView(false);
      await seed('enemies', 'Orc');
      await seed('sv_enemies', 'Other');
      const def = battleToolDefinitions.find((t) => t.name === 'update_enemy')!;
      const result = (await def.handler(
        { projectPath: dir },
        { enemyId: 1, updates: { battlerName: 'Orc' } },
      )) as Result;
      expect(result.warnings).toBeUndefined();
    });
  });
});

describe('troop tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject([null, slime], [null]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createTroop allocates an id, defaults to one blank page, and persists compactly', async () => {
    const troop = await createTroop(dir, { name: 'Slime x2', members: [] });
    expect(troop.id).toBe(1);
    expect(troop.pages).toHaveLength(1);
    expect(troop.pages[0]).toEqual(blankTroopPage());

    const raw = await readFile(join(dir, 'data', 'Troops.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createTroop accepts members that reference existing enemies', async () => {
    const troop = await createTroop(dir, {
      name: 'Ambush',
      members: [{ enemyId: 1, x: 100, y: 200, hidden: false }],
    });
    expect(troop.members[0].enemyId).toBe(1);
    const troops = await getTroops(dir);
    expect(troops.find((t) => t?.id === troop.id)?.name).toBe('Ambush');
  });

  it('createTroop rejects a member referencing a non-existent enemy', async () => {
    await expect(
      createTroop(dir, { name: 'Bad', members: [{ enemyId: 99, x: 0, y: 0, hidden: false }] }),
    ).rejects.toThrow(/enemyId 99/);
  });

  it('updateTroop revalidates members and refuses an unknown id', async () => {
    const troop = await createTroop(dir, { name: 'T' });
    const updated = await updateTroop(dir, troop.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await expect(
      updateTroop(dir, troop.id, { members: [{ enemyId: 99, x: 0, y: 0, hidden: false }] }),
    ).rejects.toThrow(/enemyId 99/);
    await expect(updateTroop(dir, 999, { name: 'X' })).rejects.toThrow(/not found/);
  });

  it('the create_troop handler refuses a structurally bad command list and writes nothing', async () => {
    const def = battleToolDefinitions.find((t) => t.name === 'create_troop')!;
    // A page whose list is not terminated by the code-0 end marker is structural.
    const args = {
      name: 'Refused',
      pages: [{ ...blankTroopPage(), list: [{ code: 101, indent: 0, parameters: [] }] }],
    };
    await expect(def.handler({ projectPath: dir }, args)).rejects.toThrow(/Refusing to write/);

    // The whole point: the bad troop never reached disk.
    const troops = await getTroops(dir);
    expect(troops.every((t) => t == null || t.name !== 'Refused')).toBe(true);
  });

  it('the create_troop handler writes a structurally bad command list when forced', async () => {
    const def = battleToolDefinitions.find((t) => t.name === 'create_troop')!;
    const result = (await def.handler(
      { projectPath: dir },
      {
        name: 'Forced',
        pages: [{ ...blankTroopPage(), list: [{ code: 101, indent: 0, parameters: [] }] }],
        force: true,
      },
    )) as { troop: Troop; warnings?: unknown[] };
    expect(result.troop.name).toBe('Forced');
    // Forcing writes it, but still reports what's wrong.
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
    const troops = await getTroops(dir);
    expect(troops.some((t) => t != null && t.name === 'Forced')).toBe(true);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await createTroop(dir, { name: 'Preview' });
    });
    expect(context.commits.some((c) => c.path.endsWith('Troops.json'))).toBe(true);
    const troops = await getTroops(dir);
    expect(troops.every((t) => t == null || t.name !== 'Preview')).toBe(true);
  });
});

describe('battle templates', () => {
  it('defaultEnemy has 8 params and 3 drop slots', () => {
    const e = defaultEnemy();
    expect(e.params).toHaveLength(8);
    expect(e.dropItems).toHaveLength(3);
    expect(e.actions[0].skillId).toBe(1);
  });

  it('blankTroopPage list ends with the code-0 marker', () => {
    const page = blankTroopPage();
    expect(page.list[page.list.length - 1].code).toBe(0);
    expect(page.span).toBe(0);
  });
});

describe('troop battle-event pages', () => {
  let dir: string;
  const troop: Troop = {
    id: 1,
    name: 'Boss',
    members: [{ enemyId: 1, x: 400, y: 300, hidden: false }],
    pages: [blankTroopPage()],
  };

  beforeEach(async () => {
    dir = await scaffoldProject([null, slime], [null, troop]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('buildTroopPage fills the full conditions object and appends the end marker', () => {
    const text = { code: 101, indent: 0, parameters: ['', 0, 0, 2] };
    const page = buildTroopPage({ turn: [2, 3], turnEnd: true }, 'turn', [text]);
    expect(page.span).toBe(1);
    expect(page.conditions).toEqual({
      ...blankTroopPage().conditions,
      turnValid: true,
      turnA: 2,
      turnB: 3,
      turnEnding: true,
    });
    expect(page.list).toEqual([text, { code: 0, indent: 0, parameters: [] }]);
  });

  it('buildTroopPage encodes HP and switch triggers', () => {
    const c = buildTroopPage({
      enemyHpBelow: [0, 50],
      actorHpBelow: [2, 25],
      switch: 7,
    }).conditions;
    expect(c).toMatchObject({
      enemyValid: true,
      enemyIndex: 0,
      enemyHp: 50,
      actorValid: true,
      actorId: 2,
      actorHp: 25,
      switchValid: true,
      switchId: 7,
      turnValid: false,
    });
  });

  it('buildTroopPage rejects a page with no condition (it would never run)', () => {
    expect(() => buildTroopPage({})).toThrow(/at least one condition/);
    expect(() => buildTroopPage({ enemyHpBelow: [0, 150] })).toThrow(/0–100/);
  });

  it('addTroopPage appends without touching existing pages, or inserts at position', async () => {
    const page = buildTroopPage({ turn: [1, 0] }, 'battle', [
      { code: 340, indent: 0, parameters: [] },
    ]);
    const added = await addTroopPage(dir, 1, page);
    expect(added.pageIndex).toBe(1);
    let saved = (await getTroops(dir))[1]!;
    expect(saved.pages).toHaveLength(2);
    expect(saved.pages[0]).toEqual(blankTroopPage());
    expect(saved.pages[1].list[0].code).toBe(340);

    const first = await addTroopPage(dir, 1, buildTroopPage({ switch: 3 }), 0);
    expect(first.pageIndex).toBe(0);
    saved = (await getTroops(dir))[1]!;
    expect(saved.pages.map((p) => p.conditions.switchValid)).toEqual([true, false, false]);
    await expect(addTroopPage(dir, 99, page)).rejects.toThrow(/not found/);
  });

  it('the add_troop_page handler refuses a bad command list and warns on an out-of-range slot', async () => {
    const def = battleToolDefinitions.find((t) => t.name === 'add_troop_page')!;
    const bad = buildTroopPage({ turn: [0, 0] });
    bad.list.unshift({ code: 335, indent: 0, parameters: [] });
    await expect(def.handler({ projectPath: dir }, { troopId: 1, page: bad })).rejects.toThrow(
      /Refusing to write/,
    );
    expect((await getTroops(dir))[1]!.pages).toHaveLength(1);

    const result = (await def.handler(
      { projectPath: dir },
      { troopId: 1, page: buildTroopPage({ enemyHpBelow: [3, 50] }) },
    )) as { pageIndex: number; warnings?: { message: string }[] };
    expect(result.pageIndex).toBe(1);
    expect(result.warnings?.some((w) => /enemyIndex 3/.test(w.message))).toBe(true);
  });

  it('the build_troop_page handler returns { page }', async () => {
    const def = battleToolDefinitions.find((t) => t.name === 'build_troop_page')!;
    const result = (await def.handler(
      { projectPath: dir },
      { when: { enemyHpBelow: [0, 30] }, span: 'moment' },
    )) as { page: { span: number; conditions: { enemyHp: number } } };
    expect(result.page.span).toBe(2);
    expect(result.page.conditions.enemyHp).toBe(30);
  });
});
