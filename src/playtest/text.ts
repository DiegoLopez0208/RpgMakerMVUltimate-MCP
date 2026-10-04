/**
 * Message text as the player reads it. The in-page driver runs every line
 * through the engine's `convertEscapeCharacters` (expanding `\V[n]`, `\N[n]`,
 * `\P[n]`, `\G` and `\\`), which leaves the remaining control codes prefixed
 * with ESC — the form the message window then interprets and never prints.
 * This drops them.
 */

/**
 * An ESC control code, matched the way `Window_Base.obtainEscapeCode` reads one
 * — a single symbol (`\.` `\|` `\!` `\>` `\<` `\^` `\{` `\}` `\$`) or a run of
 * letters (`\C`, `\I`, `\FS`, `\PX`, a plugin's own code) — plus its `[param]`.
 * A param is taken whole even when it isn't a number, so a plugin code such as
 * `\MSGCORE[x]` doesn't leave its bracket behind.
 */
const CONTROL_CODE = /\x1b(?:[$.|^!><{}\\]|[A-Z]+)(?:\[[^\]\x1b]*\])?/gi;

/** Strip the ESC control codes left in an engine-converted message line. */
export function stripControlCodes(text: string): string {
  return text.replace(CONTROL_CODE, '').replace(/\x1b/g, '');
}
