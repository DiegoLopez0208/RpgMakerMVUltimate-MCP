/**
 * balance.ts — find the database entries that are out of line with their peers.
 *
 * Balance is relative: a skill dealing 400 damage is fine in a game where
 * everything does, and broken in one where nothing else breaks 60. So rather
 * than checking numbers against thresholds invented here, each entry is scored
 * on a power metric and compared against the OTHER entries in its category.
 *
 * The comparison is leave-one-out: the mean and standard deviation an entry is
 * judged against exclude that entry. Without it a single extreme value inflates
 * the very statistics meant to catch it — the more broken the outlier, the
 * further it drags the mean toward itself, and past a point it hides
 * completely. Same reason one bad measurement should never help decide whether
 * it is bad.
 *
 * A formula the evaluator cannot read statically is reported separately, never
 * scored as zero. Counting unreadable formulas as no damage would pull every
 * average down and quietly break the whole analysis.
 */

import { readJson } from '../utils/fileHandler.js';
import { evaluateFormula, REFERENCE_CONTEXT } from '../utils/formulaEval.js';

/** Below this many samples, "unusual compared to its peers" means nothing. */
const MIN_SAMPLE = 4;
const DEFAULT_THRESHOLD_SD = 2;

export interface BalanceOutlier {
  id: number;
  name: string;
  value: number;
  /** How many standard deviations from the leave-one-out mean. */
  deviations: number;
  direction: 'high' | 'low';
  message: string;
}

export interface BalanceCategory {
  category: string;
  /** What was measured, in words, so the numbers can be argued with. */
  metric: string;
  sampled: number;
  /** Entries with no meaningful value for this metric (free skills, etc.). */
  skipped: number;
  stats: { mean: number; sd: number; min: number; max: number; median: number } | null;
  outliers: BalanceOutlier[];
  /** The extremes, for context, whether or not they were flagged. */
  highest: { id: number; name: string; value: number }[];
  lowest: { id: number; name: string; value: number }[];
}

export interface UnreadableFormula {
  id: number;
  name: string;
  formula: string;
  reason: string;
}

export interface BalanceReport {
  thresholdSd: number;
  outlierCount: number;
  categories: BalanceCategory[];
  /**
   * Damage formulas that could not be evaluated without executing them. These
   * are excluded from the statistics rather than counted as zero.
   */
  unreadableFormulas: UnreadableFormula[];
}

interface Sample { id: number; name: string; value: number }

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdev(values: number[], mu: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Score one category and flag its outliers.
 *
 * `describe` turns a flagged entry into a sentence, because "2.4 SD above the
 * mean" is not something anyone can act on without knowing what was measured.
 */
function analyseCategory(
  category: string,
  metric: string,
  samples: Sample[],
  skipped: number,
  thresholdSd: number,
  describe: (s: Sample, dir: 'high' | 'low') => string,
): BalanceCategory {
  const values = samples.map((s) => s.value);
  const sorted = [...values].sort((a, b) => a - b);
  const byValue = [...samples].sort((a, b) => b.value - a.value);

  const stats = values.length
    ? {
      mean: round(mean(values)),
      sd: round(stdev(values, mean(values))),
      min: round(sorted[0]),
      max: round(sorted[sorted.length - 1]),
      median: round(median(sorted)),
    }
    : null;

  const outliers: BalanceOutlier[] = [];
  if (samples.length >= MIN_SAMPLE) {
    for (const s of samples) {
      // Leave-one-out: judge this entry against the others, not against a mean
      // it helped create.
      const others = samples.filter((o) => o !== s).map((o) => o.value);
      const mu = mean(others);
      const sd = stdev(others, mu);
      if (sd === 0) continue; // every peer identical: nothing to be unusual against
      const deviations = (s.value - mu) / sd;
      if (Math.abs(deviations) < thresholdSd) continue;
      const direction = deviations > 0 ? 'high' : 'low';
      outliers.push({
        id: s.id,
        name: s.name,
        value: round(s.value),
        deviations: round(deviations),
        direction,
        message: describe(s, direction),
      });
    }
    outliers.sort((a, b) => Math.abs(b.deviations) - Math.abs(a.deviations));
  }

  return {
    category,
    metric,
    sampled: samples.length,
    skipped,
    stats,
    outliers,
    highest: byValue.slice(0, 3).map((s) => ({ id: s.id, name: s.name, value: round(s.value) })),
    lowest: byValue.slice(-3).reverse().map((s) => ({ id: s.id, name: s.name, value: round(s.value) })),
  };
}

type Entry = Record<string, unknown>;

function entries(raw: unknown): Entry[] {
  return Array.isArray(raw) ? raw.filter((e): e is Entry => !!e && typeof e === 'object') : [];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function params(e: Entry): number[] {
  return Array.isArray(e.params) ? e.params.map(num) : [];
}

async function read(projectPath: string, file: string): Promise<Entry[]> {
  try {
    return entries(await readJson(projectPath, file));
  } catch {
    return []; // a project without this file simply contributes no samples
  }
}

/**
 * Analyse a project's database for balance outliers.
 *
 * Read-only. `thresholdSd` is how far from its peers an entry has to sit before
 * it is worth mentioning; 2 standard deviations is the usual convention and
 * flags roughly the most extreme 5% of a normal distribution.
 */
export async function analyseBalance(
  projectPath: string,
  opts: { thresholdSd?: number; category?: string } = {},
): Promise<BalanceReport> {
  if (!projectPath) throw new Error('No project path set. Use set_project_path or RPGMAKER_PROJECT_PATH first.');
  const thresholdSd = opts.thresholdSd && opts.thresholdSd > 0 ? opts.thresholdSd : DEFAULT_THRESHOLD_SD;
  const only = opts.category && opts.category !== 'all' ? opts.category : null;

  const unreadableFormulas: UnreadableFormula[] = [];
  const categories: BalanceCategory[] = [];

  // ── Skills: damage per point of MP ──
  if (!only || only === 'skills') {
    const skills = await read(projectPath, 'Skills.json');
    const samples: Sample[] = [];
    let skipped = 0;
    for (const s of skills) {
      const damage = (s.damage as Entry) ?? {};
      const type = num(damage.type);
      // 1 = HP damage, 5 = HP drain. The rest heal or have no formula.
      const isDamage = type === 1 || type === 5;
      const mpCost = num(s.mpCost);
      if (!isDamage || mpCost <= 0) { skipped++; continue; }

      const formula = String(damage.formula ?? '');
      const result = evaluateFormula(formula, REFERENCE_CONTEXT);
      if (!result.ok) {
        unreadableFormulas.push({ id: num(s.id), name: String(s.name ?? ''), formula, reason: result.reason });
        skipped++;
        continue;
      }
      samples.push({ id: num(s.id), name: String(s.name ?? ''), value: result.value / mpCost });
    }
    categories.push(analyseCategory(
      'skills',
      'damage per MP, with both combatants on the reference stat line',
      samples, skipped, thresholdSd,
      (s, dir) => dir === 'high'
        ? `Skill ${s.id} "${s.name}" returns far more damage per MP than the rest — it will crowd out every other option in the list.`
        : `Skill ${s.id} "${s.name}" returns far less damage per MP than the rest — there is no reason to ever pick it.`,
    ));
  }

  // ── Weapons and armors: price per point of the stat they exist to give ──
  if (!only || only === 'weapons') {
    const weapons = await read(projectPath, 'Weapons.json');
    const samples: Sample[] = [];
    let skipped = 0;
    for (const w of weapons) {
      const p = params(w);
      const power = num(p[2]) + num(p[4]); // ATK + MAT
      const price = num(w.price);
      if (power <= 0) { skipped++; continue; }
      samples.push({ id: num(w.id), name: String(w.name ?? ''), value: price / power });
    }
    categories.push(analyseCategory(
      'weapons',
      'gold per point of ATK+MAT',
      samples, skipped, thresholdSd,
      (s, dir) => dir === 'high'
        ? `Weapon ${s.id} "${s.name}" costs far more per point of power than its peers — nobody will buy it.`
        : `Weapon ${s.id} "${s.name}" costs far less per point of power than its peers — it makes the rest of the shop pointless.`,
    ));
  }

  if (!only || only === 'armors') {
    const armors = await read(projectPath, 'Armors.json');
    const samples: Sample[] = [];
    let skipped = 0;
    for (const a of armors) {
      const p = params(a);
      const power = num(p[3]) + num(p[5]); // DEF + MDF
      const price = num(a.price);
      if (power <= 0) { skipped++; continue; }
      samples.push({ id: num(a.id), name: String(a.name ?? ''), value: price / power });
    }
    categories.push(analyseCategory(
      'armors',
      'gold per point of DEF+MDF',
      samples, skipped, thresholdSd,
      (s, dir) => dir === 'high'
        ? `Armor ${s.id} "${s.name}" costs far more per point of protection than its peers.`
        : `Armor ${s.id} "${s.name}" costs far less per point of protection than its peers — it trivialises the shop.`,
    ));
  }

  // ── Enemies: how much HP the player chews through per point of EXP ──
  if (!only || only === 'enemies') {
    const enemies = await read(projectPath, 'Enemies.json');
    const samples: Sample[] = [];
    let skipped = 0;
    for (const e of enemies) {
      const exp = num(e.exp);
      const hp = num(params(e)[0]);
      if (exp <= 0 || hp <= 0) { skipped++; continue; }
      samples.push({ id: num(e.id), name: String(e.name ?? ''), value: hp / exp });
    }
    categories.push(analyseCategory(
      'enemies',
      'HP per point of EXP',
      samples, skipped, thresholdSd,
      (s, dir) => dir === 'high'
        ? `Enemy ${s.id} "${s.name}" takes far more effort per point of EXP than the rest — fighting it wastes the player's time.`
        : `Enemy ${s.id} "${s.name}" gives far more EXP for the effort than the rest — it is the one the player will grind.`,
    ));
  }

  return {
    thresholdSd,
    outlierCount: categories.reduce((n, c) => n + c.outliers.length, 0),
    categories,
    unreadableFormulas,
  };
}
