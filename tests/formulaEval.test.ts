import { describe, it, expect } from 'vitest';
import { evaluateFormula, REFERENCE_CONTEXT, type FormulaContext } from '../src/utils/formulaEval.js';

/** Small, readable stats so the expected numbers can be worked out by hand. */
const ctx: FormulaContext = {
  a: { atk: 10, mat: 8, def: 4, mdf: 2, hp: 100, mhp: 200, level: 5, agi: 7, luk: 3, mp: 20, mmp: 40, tp: 0 },
  b: { atk: 6, mat: 4, def: 5, mdf: 3, hp: 80, mhp: 160, level: 4, agi: 5, luk: 2, mp: 10, mmp: 30, tp: 0 },
  v: { 1: 25 },
};

function value(formula: string, c: FormulaContext = ctx): number {
  const r = evaluateFormula(formula, c);
  if (!r.ok) throw new Error(`expected a number, got: ${r.reason}`);
  return r.value;
}

function reason(formula: string, c: FormulaContext = ctx): string {
  const r = evaluateFormula(formula, c);
  if (r.ok) throw new Error(`expected a refusal, got ${r.value}`);
  return r.reason;
}

describe('arithmetic', () => {
  it('reads the stats off the context', () => {
    expect(value('a.atk * 4 - b.def * 2')).toBe(30);
    expect(value('a.mat')).toBe(8);
  });

  it('honours precedence and parentheses', () => {
    expect(value('2 + 3 * 4')).toBe(14);
    expect(value('(2 + 3) * 4')).toBe(20);
    expect(value('100 - 10 - 5')).toBe(85);   // left-associative
    expect(value('20 / 4 / 5')).toBe(1);
  });

  it('handles decimals and the modulo operator', () => {
    expect(value('a.atk * 1.5')).toBe(15);
    expect(value('10 % 3')).toBe(1);
  });

  it('tells a unary minus from a subtraction', () => {
    expect(value('-a.atk + 30')).toBe(20);
    expect(value('5 - -3')).toBe(8);
    expect(value('-(2 + 3)')).toBe(-5);
  });

  it('reads game variables, defaulting the unset ones to zero', () => {
    expect(value('v[1] + 5')).toBe(30);
    expect(value('v[99]')).toBe(0);
  });
});

describe('Math functions', () => {
  it('applies the ones damage formulas actually use', () => {
    expect(value('Math.floor(a.atk * 1.7)')).toBe(17);
    expect(value('Math.max(a.atk - b.def, 1)')).toBe(5);
    expect(value('Math.min(a.atk, b.atk)')).toBe(6);
    expect(value('Math.pow(a.atk, 2)')).toBe(100);
    expect(value('Math.abs(b.def - a.atk)')).toBe(5);
  });

  it('nests calls', () => {
    expect(value('Math.floor(Math.max(a.atk - b.def, 0) * 2.5)')).toBe(12);
  });

  it('pins Math.random so two formulas compare fairly', () => {
    // Left free it would make the metric non-deterministic run to run.
    expect(value('Math.random()')).toBe(0.5);
    expect(value('100 * Math.random()')).toBe(50);
  });

  it('refuses a function it does not model', () => {
    expect(reason('Math.tan(a.atk)')).toMatch(/unsupported function/);
  });
});

describe('refusals', () => {
  // The whole point: a formula that cannot be read statically must not be
  // scored as zero, or it drags the average down and hides real outliers.
  it('refuses rather than guessing on a ternary', () => {
    expect(reason('a.hp > 100 ? 200 : 50')).toMatch(/unsupported syntax/);
  });

  it('refuses an unknown stat', () => {
    expect(reason('a.charisma * 2')).toMatch(/unknown stat/);
  });

  it('refuses an unknown object', () => {
    expect(reason('c.atk')).toMatch(/unknown object/);
  });

  it('refuses a bare identifier', () => {
    expect(reason('atk * 2')).toMatch(/unknown name/);
  });

  it('refuses a method call on a combatant', () => {
    expect(reason('a.isStateAffected(4)')).toMatch(/unsupported|unknown/);
  });

  it('refuses unbalanced parentheses', () => {
    expect(reason('(a.atk * 2')).toMatch(/unbalanced/);
    expect(reason('a.atk) * 2')).toMatch(/unbalanced/);
  });

  it('refuses an empty formula', () => {
    expect(reason('')).toMatch(/empty/);
    expect(reason('   ')).toMatch(/empty/);
  });

  it('refuses division by zero instead of reporting Infinity', () => {
    expect(reason('a.atk / 0')).toMatch(/division by zero/);
  });
});

describe('it never executes what it is given', () => {
  // The fork this idea came from substitutes the stat names and hands the rest
  // to eval(). These are the strings that makes dangerous. None of them should
  // do anything here except come back as a refusal.
  const hostile = [
    'process.exit(1)',
    'require("child_process").execSync("calc")',
    'globalThis.leaked = 1',
    'a.atk; process.env.SECRET',
    'constructor.constructor("return 1")()',
    '__import__("os").system("id")',
  ];

  for (const src of hostile) {
    it(`refuses ${JSON.stringify(src.slice(0, 28))}`, () => {
      const r = evaluateFormula(src, ctx);
      expect(r.ok).toBe(false);
    });
  }

  it('leaves no trace on the global object', () => {
    evaluateFormula('globalThis.leaked = 1', ctx);
    expect((globalThis as Record<string, unknown>).leaked).toBeUndefined();
  });
});

describe('REFERENCE_CONTEXT', () => {
  it('gives both sides the same stats, so a formula is judged on its shape', () => {
    expect(REFERENCE_CONTEXT.a.atk).toBe(REFERENCE_CONTEXT.b.atk);
    expect(REFERENCE_CONTEXT.a.def).toBe(REFERENCE_CONTEXT.b.def);
  });

  it('is what evaluateFormula uses when no context is passed', () => {
    const r = evaluateFormula('a.atk * 4 - b.def * 2');
    expect(r.ok && r.value).toBe(REFERENCE_CONTEXT.a.atk * 4 - REFERENCE_CONTEXT.b.def * 2);
  });
});
