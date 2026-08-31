import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { analyseBalance } from '../src/intel/balance.js';

const dirs: string[] = [];

async function project(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-balance-'));
  dirs.push(dir);
  await mkdir(join(dir, 'data'), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, 'data', name), JSON.stringify(data), 'utf-8');
  }
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A damage skill costing `mpCost`, dealing a flat amount. */
function skill(id: number, name: string, flatDamage: number, mpCost: number) {
  return { id, name, mpCost, damage: { type: 1, formula: String(flatDamage) } };
}

function weapon(id: number, name: string, atk: number, price: number) {
  return { id, name, price, params: [0, 0, atk, 0, 0, 0, 0, 0] };
}

function enemy(id: number, name: string, hp: number, exp: number) {
  return { id, name, exp, params: [hp, 0, 0, 0, 0, 0, 0, 0] };
}

function category(report: Awaited<ReturnType<typeof analyseBalance>>, name: string) {
  const c = report.categories.find((x) => x.category === name);
  if (!c) throw new Error(`no category ${name}`);
  return c;
}

describe('analyseBalance — skills', () => {
  it('flags the skill that returns far more damage per MP than its peers', async () => {
    const dir = await project({
      'Skills.json': [null,
        skill(1, 'Fire', 100, 10),      // 10 dmg/MP
        skill(2, 'Ice', 110, 10),       // 11
        skill(3, 'Bolt', 90, 10),       // 9
        skill(4, 'Wind', 105, 10),      // 10.5
        skill(5, 'Ruin', 2000, 10),     // 200 — the broken one
      ],
    });

    const report = await analyseBalance(dir);
    const skills = category(report, 'skills');

    expect(skills.sampled).toBe(5);
    expect(skills.outliers).toHaveLength(1);
    expect(skills.outliers[0].id).toBe(5);
    expect(skills.outliers[0].direction).toBe('high');
    expect(skills.outliers[0].message).toContain('Ruin');
    expect(report.outlierCount).toBeGreaterThan(0);
  });

  it('finds the outlier even though it is extreme enough to skew a naive mean', async () => {
    // With the outlier included in its own statistics its distance from the
    // mean collapses; leave-one-out is what keeps it visible.
    const dir = await project({
      'Skills.json': [null,
        skill(1, 'A', 10, 1), skill(2, 'B', 11, 1), skill(3, 'C', 9, 1),
        skill(4, 'D', 10, 1), skill(5, 'E', 12, 1), skill(6, 'F', 9, 1),
        skill(7, 'Godslayer', 100000, 1),
      ],
    });

    const skills = category(await analyseBalance(dir), 'skills');
    expect(skills.outliers.map((o) => o.id)).toContain(7);
  });

  it('ignores skills that cost nothing or do not deal damage', async () => {
    const dir = await project({
      'Skills.json': [null,
        skill(1, 'Free Hit', 100, 0),                                          // no MP cost
        { id: 2, name: 'Heal', mpCost: 5, damage: { type: 3, formula: '50' } },  // healing
        { id: 3, name: 'Talk', mpCost: 0, damage: { type: 0, formula: '' } },    // no damage
      ],
    });

    const skills = category(await analyseBalance(dir), 'skills');
    expect(skills.sampled).toBe(0);
    expect(skills.skipped).toBe(3);
    expect(skills.stats).toBeNull();
  });

  it('reports an unreadable formula instead of scoring it zero', async () => {
    const dir = await project({
      'Skills.json': [null,
        skill(1, 'Fire', 100, 10),
        skill(2, 'Ice', 110, 10),
        { id: 3, name: 'Conditional', mpCost: 10, damage: { type: 1, formula: 'a.hp > 100 ? 500 : 20' } },
      ],
    });

    const report = await analyseBalance(dir);
    const skills = category(report, 'skills');

    expect(skills.sampled).toBe(2);
    expect(report.unreadableFormulas).toHaveLength(1);
    expect(report.unreadableFormulas[0]).toMatchObject({ id: 3, name: 'Conditional' });
    expect(report.unreadableFormulas[0].reason).toMatch(/unsupported syntax/);
    // Scored as zero it would have dragged the mean of 10 and 11 down to ~7.
    expect(skills.stats!.mean).toBeCloseTo(10.5, 5);
  });

  it('says nothing about a sample too small to have peers', async () => {
    const dir = await project({
      'Skills.json': [null, skill(1, 'Fire', 10, 1), skill(2, 'Nuke', 9000, 1)],
    });
    const skills = category(await analyseBalance(dir), 'skills');
    expect(skills.sampled).toBe(2);
    expect(skills.outliers).toEqual([]); // two points cannot establish a norm
  });

  it('says nothing when every peer is identical', async () => {
    const dir = await project({
      'Skills.json': [null,
        skill(1, 'A', 100, 10), skill(2, 'B', 100, 10),
        skill(3, 'C', 100, 10), skill(4, 'D', 100, 10),
      ],
    });
    const skills = category(await analyseBalance(dir), 'skills');
    expect(skills.stats!.sd).toBe(0);
    expect(skills.outliers).toEqual([]);
  });
});

describe('analyseBalance — shop and enemies', () => {
  it('flags a weapon priced far under its peers', async () => {
    const dir = await project({
      'Weapons.json': [null,
        weapon(1, 'Bronze', 10, 500),     // 50 gold per ATK
        weapon(2, 'Iron', 20, 1000),      // 50
        weapon(3, 'Steel', 30, 1560),     // 52
        weapon(4, 'Silver', 40, 1920),    // 48
        weapon(5, 'Legendary', 100, 100), // 1 — free power
      ],
    });

    const weapons = category(await analyseBalance(dir), 'weapons');
    expect(weapons.outliers).toHaveLength(1);
    expect(weapons.outliers[0].id).toBe(5);
    expect(weapons.outliers[0].direction).toBe('low');
  });

  it('flags the enemy worth grinding', async () => {
    const dir = await project({
      'Enemies.json': [null,
        enemy(1, 'Slime', 100, 10),      // 10 HP per EXP
        enemy(2, 'Bat', 90, 9),          // 10
        enemy(3, 'Wolf', 120, 12),       // 10
        enemy(4, 'Bandit', 110, 10),     // 11
        enemy(5, 'Piggy Bank', 50, 500), // 0.1 — free EXP
      ],
    });

    const enemies = category(await analyseBalance(dir), 'enemies');
    expect(enemies.outliers.map((o) => o.id)).toContain(5);
    expect(enemies.outliers[0].message).toMatch(/grind/);
  });

  it('skips entries with nothing to measure', async () => {
    const dir = await project({
      'Weapons.json': [null, weapon(1, 'Stick', 0, 10)],   // no power
      'Enemies.json': [null, enemy(1, 'Trainer', 100, 0)], // no exp
    });
    const report = await analyseBalance(dir);
    expect(category(report, 'weapons').skipped).toBe(1);
    expect(category(report, 'enemies').skipped).toBe(1);
  });
});

describe('analyseBalance — options', () => {
  it('honours a stricter threshold', async () => {
    const files = {
      'Skills.json': [null,
        skill(1, 'A', 100, 10), skill(2, 'B', 110, 10), skill(3, 'C', 90, 10),
        skill(4, 'D', 105, 10), skill(5, 'E', 160, 10),
      ],
    };
    // Leave-one-out puts this outlier at roughly 6.9 SD, so "loose" has to be
    // above that to demonstrate the threshold doing anything.
    const loose = await analyseBalance(await project(files), { thresholdSd: 10 });
    const strict = await analyseBalance(await project(files), { thresholdSd: 1.5 });

    expect(category(loose, 'skills').outliers).toHaveLength(0);
    expect(category(strict, 'skills').outliers.length).toBeGreaterThan(0);
    expect(strict.thresholdSd).toBe(1.5);
  });

  it('can analyse one category on its own', async () => {
    const dir = await project({
      'Skills.json': [null, skill(1, 'A', 10, 1)],
      'Enemies.json': [null, enemy(1, 'Slime', 100, 10)],
    });
    const report = await analyseBalance(dir, { category: 'enemies' });
    expect(report.categories.map((c) => c.category)).toEqual(['enemies']);
  });

  it('survives a project missing the files entirely', async () => {
    const dir = await project({});
    const report = await analyseBalance(dir);
    expect(report.outlierCount).toBe(0);
    for (const c of report.categories) expect(c.sampled).toBe(0);
  });

  it('refuses without a project path', async () => {
    await expect(analyseBalance('')).rejects.toThrow(/No project path/);
  });
});
