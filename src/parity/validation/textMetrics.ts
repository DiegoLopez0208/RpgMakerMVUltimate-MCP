/**
 * How wide a Show Text line is, and how wide it is allowed to be.
 *
 * The default is a **character count** — 55 per line, 38 with a face — which is a
 * reasonable estimate for the stock RTP font and needs no configuration. It is only
 * ever an estimate, though, and a project whose font is not the default gets it wrong
 * in one of two directions:
 *
 * - a **narrower** font makes it warn on lines that fit comfortably. One real 8-bit
 *   project was wrapping to about two thirds of its usable width because of this, and
 *   ended up with a dozen standing false positives nobody could act on.
 * - a **wider or larger** font makes it stay silent on lines that genuinely overflow:
 *   38 characters of a 24px glyph is 912px in a 616px window.
 *
 * No single character limit fixes both, because glyph widths in a proportional font
 * span a wide range — measured on that project, `.` is 4.88px and a capital 13px, a
 * 2.7x spread — so a limit strict enough for capitals is far too strict for prose.
 *
 * So a project may supply **pixel metrics** instead: a per-character advance table
 * and the window's real usable width. Then the check is exact rather than estimated.
 * See `loadProjectTextMetrics` in `tools/projectConfig.ts` for where the table comes
 * from, and the README for the config file shape.
 *
 * Pure: no I/O. The active metrics are installed by the caller (see
 * {@link setActiveTextMetrics}); every function here also takes them explicitly so
 * tests never depend on ambient state.
 */

/** Message-window line budget in characters (default 816px window, 26px font). */
export const DEFAULT_LINE_LIMIT = 55;
/** Same budget when a face graphic is shown — the face eats a third of the window. */
export const DEFAULT_LINE_LIMIT_WITH_FACE = 38;

/**
 * Either a character-count estimate (`unit: 'chars'`) or an exact pixel measurement
 * (`unit: 'px'`, which requires `charWidths`).
 */
export interface TextMetrics {
  unit: 'chars' | 'px';
  /** Usable line width, in `unit`, without and with a face graphic. */
  budget: { noFace: number; withFace: number };
  /** `unit: 'px'` only — per-character advance. `_default` covers anything unlisted. */
  charWidths?: Record<string, number>;
  /**
   * How many `_default`-width characters to bill an actor-name escape (`\N[3]`,
   * `\P[1]`) at. A name is typed by the player at runtime, so the safe budget is the
   * Name Input `maxLength`, not the default name — otherwise a long name overflows a
   * line that fitted in testing.
   *
   * Defaults to **0**, which reproduces the historical behaviour of ignoring escapes
   * entirely. A project that cares should set it (8 is MV's usual name length).
   */
  nameBudgetChars: number;
}

/** The estimate used when a project supplies no metrics of its own. */
export const DEFAULT_TEXT_METRICS: TextMetrics = {
  unit: 'chars',
  budget: { noFace: DEFAULT_LINE_LIMIT, withFace: DEFAULT_LINE_LIMIT_WITH_FACE },
  nameBudgetChars: 0,
};

/** Actor/party name escapes, which render as a player-typed name of unknown length. */
const NAME_ESCAPE = /\\[NP]\[\d+\]/gi;
/** Every other escape — colour, gold, icon, speed — draws nothing. */
const OTHER_ESCAPE_WITH_ARG = /\\[A-Z]+\[[^\]]*\]/gi;
const OTHER_ESCAPE = /\\./g;
/**
 * Stands in for a name escape while measuring. A control character, so it can never
 * collide with a real glyph in the width table and always falls through to `_default`
 * — billing the placeholder as a space would quietly under-measure, since a space is
 * one of the narrowest glyphs in most fonts.
 */
const NAME_PLACEHOLDER = '\u0000';

/**
 * The text that actually reaches the window: escape codes resolved or dropped, with
 * name escapes expanded to their worst-case width.
 */
export function displayText(line: string, metrics: TextMetrics): string {
  const budget = Math.max(0, Math.floor(metrics.nameBudgetChars));
  const named = line.replace(NAME_ESCAPE, NAME_PLACEHOLDER.repeat(budget));
  return named.replace(OTHER_ESCAPE_WITH_ARG, '').replace(OTHER_ESCAPE, '');
}

/**
 * Width of one line in `metrics.unit`. In `chars` mode this is a character count; in
 * `px` mode it is the sum of per-character advances.
 *
 * The placeholder standing in for a name escape falls through to `_default`, which is
 * the widest sensible assumption for a glyph the player has not typed yet.
 */
export function measureLine(line: string, metrics: TextMetrics): number {
  const text = displayText(line, metrics);
  if (metrics.unit === 'chars') return text.length;
  const widths = metrics.charWidths ?? {};
  const fallback = widths._default ?? 0;
  let total = 0;
  for (const ch of text) total += widths[ch] ?? fallback;
  return total;
}

/** The budget a line must fit inside, given whether a face graphic is showing. */
export function lineBudget(metrics: TextMetrics, faceShown: boolean): number {
  return faceShown ? metrics.budget.withFace : metrics.budget.noFace;
}

/** How a width is phrased in a warning: `61 visible chars` / `641px`. */
export function formatWidth(value: number, metrics: TextMetrics): string {
  if (metrics.unit === 'chars') return `${value} visible chars`;
  return `${Math.round(value)}px`;
}

/**
 * Parse the `text` section of a project config into {@link TextMetrics}.
 *
 * Fail-soft by design: anything malformed returns `null` and the caller keeps the
 * default estimate. A broken config file must never turn into a wall of bogus
 * warnings, and must never be worse than having no config at all.
 */
export function parseTextMetrics(raw: unknown): TextMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = (raw as Record<string, unknown>).text;
  if (!text || typeof text !== 'object') return null;
  const t = text as Record<string, unknown>;

  const budgetRaw = t.lineBudget;
  if (!budgetRaw || typeof budgetRaw !== 'object') return null;
  const b = budgetRaw as Record<string, unknown>;
  const noFace = Number(b.noFace);
  const withFace = Number(b.withFace);
  if (!Number.isFinite(noFace) || !Number.isFinite(withFace)) return null;
  if (noFace <= 0 || withFace <= 0) return null;

  const nameBudgetChars = Number(t.nameBudgetChars ?? 0);

  const widthsRaw = t.charWidths;
  if (widthsRaw === undefined) {
    // A budget with no width table is a character-count override — still useful for
    // a project that only wants to move the default limits.
    return {
      unit: 'chars',
      budget: { noFace, withFace },
      nameBudgetChars: Number.isFinite(nameBudgetChars) ? nameBudgetChars : 0,
    };
  }
  if (typeof widthsRaw !== 'object') return null;

  const charWidths: Record<string, number> = {};
  for (const [key, value] of Object.entries(widthsRaw as Record<string, unknown>)) {
    const n = Number(value);
    // Keys are single characters, plus the `_default` sentinel. Anything else is a
    // typo that would silently never match, so drop it rather than pretend.
    if (Number.isFinite(n) && n >= 0 && (key === '_default' || [...key].length === 1)) {
      charWidths[key] = n;
    }
  }
  if (charWidths._default === undefined) return null;

  return {
    unit: 'px',
    budget: { noFace, withFace },
    charWidths,
    nameBudgetChars: Number.isFinite(nameBudgetChars) ? nameBudgetChars : 0,
  };
}

/**
 * Ambient metrics for the project currently being served.
 *
 * The line-width check runs deep inside `validateCommandList`, which has eight call
 * sites across six tool modules and no project path in scope — threading metrics
 * through all of them would make every one of them async for a value that is constant
 * per project. So the dispatcher installs the active metrics once per call instead,
 * and every function here still accepts them explicitly for tests.
 */
let activeMetrics: TextMetrics = DEFAULT_TEXT_METRICS;

export function setActiveTextMetrics(metrics: TextMetrics | null): void {
  activeMetrics = metrics ?? DEFAULT_TEXT_METRICS;
}

export function getActiveTextMetrics(): TextMetrics {
  return activeMetrics;
}

/** Lines a single Show Text (101) box holds — the editor's dialog allows four. */
export const MESSAGE_BOX_LINES = 4;

/**
 * How {@link wrapLines} treats the caller's line breaks:
 * - `'soft'` — every array entry and `\n` is just whitespace; the whole text is
 *   reflowed as one paragraph.
 * - `'hard'` — every array entry and `\n` is kept as a forced line break, and only
 *   lines too wide for the window are wrapped.
 */
export type WrapMode = 'soft' | 'hard';

/**
 * One indivisible unit of a word: an escape code (`\C[2]`, `\N[1]`, `\.`) or a single
 * character. Splitting inside an escape would leave a half-code the engine prints
 * literally, so an over-long word is only ever broken between atoms.
 */
const ATOM = /\\[A-Z]+\[[^\]]*\]|\\[\s\S]|[\s\S]/giu;

/**
 * Break a word too wide for the budget on its own into budget-sized pieces, at atom
 * boundaries. A single atom wider than the whole budget is emitted alone — nothing
 * narrower exists to fall back to.
 */
function splitLongWord(word: string, limit: number, metrics: TextMetrics): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const atom of word.match(ATOM) ?? []) {
    const candidate = current + atom;
    if (current !== '' && measureLine(candidate, metrics) > limit) {
      pieces.push(current);
      current = atom;
    } else {
      current = candidate;
    }
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/** Greedy word-wrap of one paragraph to `limit`, measured exactly as the validator does. */
function wrapParagraph(paragraph: string, limit: number, metrics: TextMetrics): string[] {
  const words = paragraph.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [''];
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measureLine(candidate, metrics) <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') out.push(current);
    if (measureLine(word, metrics) <= limit) {
      current = word;
    } else {
      const pieces = splitLongWord(word, limit, metrics);
      out.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/**
 * Word-wrap Show Text lines to the message window, using the very same measurement
 * ({@link measureLine}) and budget ({@link lineBudget}) as the line-width check — so
 * wrapped output can never trip that warning (bar a single glyph or escape wider
 * than the whole window). Escape codes draw nothing and are never split; name
 * escapes are billed at the project's `nameBudgetChars`.
 */
export function wrapLines(
  lines: string[],
  faceShown: boolean,
  mode: WrapMode = 'soft',
  metrics: TextMetrics = getActiveTextMetrics(),
): string[] {
  if (lines.length === 0) return [];
  const limit = lineBudget(metrics, faceShown);
  const paragraphs =
    mode === 'soft'
      ? [lines.map(String).join(' ')]
      : lines.flatMap((line) => String(line).split('\n'));
  return paragraphs.flatMap((p) => wrapParagraph(p, limit, metrics));
}
