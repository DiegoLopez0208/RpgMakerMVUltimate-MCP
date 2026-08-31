/**
 * formulaEval.ts — evaluate an RPG Maker MV damage formula without running it.
 *
 * A damage formula is a JavaScript expression the engine evaluates with `a`
 * (the user), `b` (the target) and `v` (game variables) in scope. Anything that
 * wants to reason about balance has to turn that string into a number.
 *
 * The tempting shortcut is to substitute the stat names for numbers and hand
 * the rest to a real evaluator. That is a remote code execution hole: the
 * formula comes from the project's Skills.json, which the person running this
 * tool did not necessarily write, and substituting six known tokens sanitises
 * nothing — everything else in the string still reaches the evaluator.
 *
 * So this is a real parser: tokenise, shunting-yard to RPN, evaluate. It knows
 * arithmetic, parentheses, and the Math functions formulas actually use.
 * Anything it does not recognise makes it return a reason rather than a number.
 * That distinction matters for statistics: a formula scored as 0 because it
 * failed to parse drags an average down and hides the outlier you were looking
 * for, so callers must be able to tell "no damage" from "could not tell".
 */

/** The stats a formula is evaluated against. */
export interface FormulaContext {
  /** The user of the skill. */
  a: Record<string, number>;
  /** The target. */
  b: Record<string, number>;
  /** Game variables, by id. Unknown ids read as 0, as they do in a fresh game. */
  v?: Record<number, number>;
}

/** Reference combatants, so two formulas are compared on the same footing. */
export const REFERENCE_CONTEXT: FormulaContext = {
  a: { hp: 500, mp: 100, tp: 0, mhp: 500, mmp: 100, atk: 20, def: 10, mat: 20, mdf: 10, agi: 15, luk: 15, level: 10 },
  b: { hp: 500, mp: 100, tp: 0, mhp: 500, mmp: 100, atk: 20, def: 10, mat: 20, mdf: 10, agi: 15, luk: 15, level: 10 },
  v: {},
};

export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; reason: string };

type Token =
  | { t: 'num'; v: number }
  | { t: 'op'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

/** Math functions a damage formula realistically uses, with their arity. */
const FUNCTIONS: Record<string, { arity: number; apply: (args: number[]) => number }> = {
  'Math.floor': { arity: 1, apply: (x) => Math.floor(x[0]) },
  'Math.ceil': { arity: 1, apply: (x) => Math.ceil(x[0]) },
  'Math.round': { arity: 1, apply: (x) => Math.round(x[0]) },
  'Math.abs': { arity: 1, apply: (x) => Math.abs(x[0]) },
  'Math.sqrt': { arity: 1, apply: (x) => Math.sqrt(x[0]) },
  'Math.max': { arity: 2, apply: (x) => Math.max(x[0], x[1]) },
  'Math.min': { arity: 2, apply: (x) => Math.min(x[0], x[1]) },
  'Math.pow': { arity: 2, apply: (x) => Math.pow(x[0], x[1]) },
  // Math.random makes a formula non-deterministic; 0.5 keeps comparisons fair.
  'Math.random': { arity: 0, apply: () => 0.5 },
};

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3 };

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isIdentStart(c: string): boolean { return /[A-Za-z_$]/.test(c); }
function isIdentPart(c: string): boolean { return /[A-Za-z0-9_$.]/.test(c); }

/**
 * Turn the formula into tokens, resolving every identifier to a number as it
 * goes. An identifier the context cannot answer aborts the whole evaluation.
 */
function tokenize(src: string, ctx: FormulaContext): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  // True when the previous token can end an expression, which is how a binary
  // minus is told apart from a unary one.
  let prevIsValue = false;

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++;
      const value = Number(src.slice(i, j));
      if (!Number.isFinite(value)) return `malformed number "${src.slice(i, j)}"`;
      tokens.push({ t: 'num', v: value });
      prevIsValue = true;
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      const name = src.slice(i, j);
      i = j;

      // A function is an identifier followed by '(' — anything else is a value.
      let k = i;
      while (k < src.length && src[k] === ' ') k++;
      if (src[k] === '(') {
        if (!FUNCTIONS[name]) return `unsupported function "${name}"`;
        tokens.push({ t: 'fn', v: name });
        prevIsValue = false;
        continue;
      }

      // v[3] reads a game variable.
      if (name === 'v') {
        if (src[i] !== '[') return 'expected [ after v';
        const close = src.indexOf(']', i);
        if (close === -1) return 'unclosed [ after v';
        const id = Number(src.slice(i + 1, close));
        if (!Number.isInteger(id)) return `non-numeric variable index "${src.slice(i + 1, close)}"`;
        tokens.push({ t: 'num', v: ctx.v?.[id] ?? 0 });
        prevIsValue = true;
        i = close + 1;
        continue;
      }

      const dot = name.indexOf('.');
      if (dot === -1) return `unknown name "${name}"`;
      const who = name.slice(0, dot);
      const stat = name.slice(dot + 1);
      const scope = who === 'a' ? ctx.a : who === 'b' ? ctx.b : null;
      if (!scope) return `unknown object "${who}"`;
      const value = scope[stat];
      if (value === undefined) return `unknown stat "${name}"`;
      tokens.push({ t: 'num', v: value });
      prevIsValue = true;
      continue;
    }

    if (c === '(') { tokens.push({ t: 'lparen' }); prevIsValue = false; i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); prevIsValue = true; i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); prevIsValue = false; i++; continue; }

    if ('+-*/%'.includes(c)) {
      const unary = c === '-' && !prevIsValue;
      tokens.push({ t: 'op', v: unary ? 'u-' : c });
      prevIsValue = false;
      i++;
      continue;
    }

    // Comparisons, ternaries, method calls, assignments: all legal JavaScript
    // and all outside what a static reading can answer.
    return `unsupported syntax at "${src.slice(i, i + 12)}"`;
  }

  return tokens;
}

/** Shunting-yard: infix tokens to reverse Polish notation. */
function toRpn(tokens: Token[]): Token[] | string {
  const out: Token[] = [];
  const stack: Token[] = [];

  for (const tok of tokens) {
    if (tok.t === 'num') { out.push(tok); continue; }
    if (tok.t === 'fn') { stack.push(tok); continue; }
    if (tok.t === 'comma') {
      while (stack.length && stack[stack.length - 1].t !== 'lparen') out.push(stack.pop() as Token);
      if (!stack.length) return 'misplaced comma';
      continue;
    }
    if (tok.t === 'op') {
      const prec = PRECEDENCE[tok.v];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.t !== 'op') break;
        // Unary minus is right-associative; the binary operators are not.
        const higher = tok.v === 'u-' ? PRECEDENCE[top.v] > prec : PRECEDENCE[top.v] >= prec;
        if (!higher) break;
        out.push(stack.pop() as Token);
      }
      stack.push(tok);
      continue;
    }
    if (tok.t === 'lparen') { stack.push(tok); continue; }
    if (tok.t === 'rparen') {
      while (stack.length && stack[stack.length - 1].t !== 'lparen') out.push(stack.pop() as Token);
      if (!stack.length) return 'unbalanced parentheses';
      stack.pop();
      if (stack.length && stack[stack.length - 1].t === 'fn') out.push(stack.pop() as Token);
      continue;
    }
  }

  while (stack.length) {
    const top = stack.pop() as Token;
    if (top.t === 'lparen') return 'unbalanced parentheses';
    out.push(top);
  }
  return out;
}

function evalRpn(rpn: Token[]): number | string {
  const stack: number[] = [];
  for (const tok of rpn) {
    if (tok.t === 'num') { stack.push(tok.v); continue; }
    if (tok.t === 'fn') {
      const fn = FUNCTIONS[tok.v];
      if (stack.length < fn.arity) return `not enough arguments for ${tok.v}`;
      const args = fn.arity ? stack.splice(stack.length - fn.arity, fn.arity) : [];
      stack.push(fn.apply(args));
      continue;
    }
    if (tok.t === 'op') {
      if (tok.v === 'u-') {
        if (!stack.length) return 'unary minus with no operand';
        stack.push(-(stack.pop() as number));
        continue;
      }
      if (stack.length < 2) return `not enough operands for "${tok.v}"`;
      const right = stack.pop() as number;
      const left = stack.pop() as number;
      switch (tok.v) {
        case '+': stack.push(left + right); break;
        case '-': stack.push(left - right); break;
        case '*': stack.push(left * right); break;
        // The engine would produce Infinity or NaN here; refusing is more useful
        // than reporting a number nobody can act on.
        case '/': if (right === 0) return 'division by zero'; stack.push(left / right); break;
        case '%': if (right === 0) return 'modulo by zero'; stack.push(left % right); break;
        default: return `unknown operator "${tok.v}"`;
      }
      continue;
    }
    return 'unexpected token';
  }
  if (stack.length !== 1) return 'malformed expression';
  return stack[0];
}

/**
 * Evaluate a damage formula against a set of stats. Returns `ok: false` with a
 * reason for anything it cannot read statically — never a number it guessed.
 */
export function evaluateFormula(formula: string, ctx: FormulaContext = REFERENCE_CONTEXT): EvalResult {
  const src = String(formula ?? '').trim();
  if (!src) return { ok: false, reason: 'empty formula' };
  if (src.length > 500) return { ok: false, reason: 'formula too long to be a damage expression' };

  const tokens = tokenize(src, ctx);
  if (typeof tokens === 'string') return { ok: false, reason: tokens };
  if (tokens.length === 0) return { ok: false, reason: 'empty formula' };

  const rpn = toRpn(tokens);
  if (typeof rpn === 'string') return { ok: false, reason: rpn };

  const value = evalRpn(rpn);
  if (typeof value === 'string') return { ok: false, reason: value };
  if (!Number.isFinite(value)) return { ok: false, reason: 'result is not a finite number' };
  return { ok: true, value };
}
