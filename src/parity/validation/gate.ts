import { ValidationWarning } from './eventCommands.js';

/**
 * Throw-by-default write gating.
 *
 * Validation used to be warn-by-default everywhere: a tool wrote the file, then
 * validated what it had written and returned the findings. A malformed event
 * therefore **landed on disk**, and the warning was easy for an LLM client to
 * skim past — the caller had to notice the problem and undo it. Now a
 * structural finding (`severity: 'error'` — see {@link ValidationWarning})
 * aborts the write *before* it happens, and the caller must opt back in with
 * `force: true`.
 *
 * The two tiers matter: only findings that are almost always bugs block. A
 * finding that is legitimately possible (an unrecognized command code may be a
 * plugin command, an over-long text line still runs) stays advisory and is
 * reported exactly as before, so this can't manufacture false failures.
 */

/**
 * A hook run with the fully-built value immediately **before** it is committed.
 * Throwing aborts the write — nothing reaches disk, and in dry-run nothing is
 * reported as `wouldChange`, so a preview of a bad write fails the same way the
 * real write would.
 */
export type PreCommit<T> = (value: T) => void | Promise<void>;

/** The findings that refuse a write: structural problems, not advice. */
export function blockingWarnings(warnings: ValidationWarning[]): ValidationWarning[] {
  return warnings.filter((warning) => warning.severity === 'error');
}

/**
 * Refuse a write whose result is structurally malformed, unless the caller has
 * explicitly forced it. The message lists every blocking finding (an LLM caller
 * usually wants to fix them all in one go) and names the escape hatch.
 */
export function assertWritable(
  warnings: ValidationWarning[],
  force: boolean | undefined,
  subject: string,
): void {
  if (force) return;

  const blocking = blockingWarnings(warnings);
  if (blocking.length === 0) return;

  const detail = blocking.map((w) => `  - ${w.path}: ${w.message}`).join('\n');
  throw new Error(
    `Refusing to write ${subject}: the result would be structurally invalid, so nothing was written.\n` +
      `${detail}\n` +
      `Fix the problem(s) above, or pass force: true to write anyway.`,
  );
}

/**
 * Build a {@link PreCommit} hook that validates the would-be result, refuses the
 * write when anything blocks, and keeps the findings for the tool's response.
 *
 * The returned `warnings` array is filled in when the hook runs (i.e. once the
 * mutating function has built its result), so a handler reads it *after* the
 * call:
 *
 * ```ts
 * const gate = writeGate<MapEvent>(args.force, `event on map ${mapId}`, (event) =>
 *   validateEvent(event).warnings,
 * );
 * const event = await createMapEvent(projectPath, mapId, data, gate.precommit);
 * return gate.respond({ event });
 * ```
 */
export function writeGate<T>(
  force: boolean | undefined,
  subject: string,
  compute: (value: T) => ValidationWarning[] | Promise<ValidationWarning[]>,
): {
  precommit: PreCommit<T>;
  warnings: ValidationWarning[];
  respond: <R extends object>(result: R) => R & { warnings?: ValidationWarning[] };
} {
  const warnings: ValidationWarning[] = [];

  return {
    warnings,
    precommit: async (value: T) => {
      warnings.push(...(await compute(value)));
      assertWritable(warnings, force, subject);
    },
    // Advisory findings still ride along on a successful write; a clean write
    // keeps the tidy no-`warnings` response shape it has always had.
    respond: (result) => (warnings.length > 0 ? { ...result, warnings } : result),
  };
}
