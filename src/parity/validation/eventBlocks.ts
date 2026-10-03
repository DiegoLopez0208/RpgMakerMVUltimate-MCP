import { EventCommand } from '../utils/types.js';
import { ValidationWarning } from './eventCommands.js';

/**
 * Block-structure validation for event command lists — the check that looks at
 * how commands relate to each other, rather than at one command's parameters.
 *
 * Three vanilla commands open a *block* that later rows must close, all written
 * by the editor at the **same indent as their opener**:
 *
 * - **102 Show Choices** → one **402 When [choice]** per choice (optionally a
 *   **403 When Cancel**), closed by **404 End Choices**
 * - **111 Conditional Branch** → an optional **411 Else**, closed by **412 End**
 * - **112 Loop** → closed by **413 Repeat Above**
 *
 * The builders in `events/commandBuilders.ts` always emit these correctly; a
 * *hand-built* list (or one stitched together from fragments) is where they drift
 * — and the resulting page is broken in ways the per-command checks can't see: an
 * unclosed 102 swallows the rest of the list, a 402 whose index doesn't match its
 * slot makes that choice do nothing, an orphan 412 desyncs the editor's display.
 *
 * Pure — no I/O. Bad *pairing* is reported as `severity: 'error'` (structural, so
 * it refuses a write via `assertWritable`); findings that are merely dead-code or
 * cosmetic stay advisory.
 */

/** The block-opening command codes and the marker rows that belong to each. */
const BLOCKS = {
  102: { name: 'Show Choices', closer: 404, branches: [402, 403] },
  111: { name: 'Conditional Branch', closer: 412, branches: [411] },
  112: { name: 'Loop', closer: 413, branches: [] as number[] },
} as const;

type BlockCode = keyof typeof BLOCKS;

/** Every marker row (branch or closer) mapped to the opener it belongs to. */
const MARKER_OWNER: Record<number, BlockCode> = {
  402: 102,
  403: 102,
  404: 102,
  411: 111,
  412: 111,
  413: 112,
};

const MARKER_NAME: Record<number, string> = {
  402: 'When [choice] (402)',
  403: 'When Cancel (403)',
  404: 'End Choices (404)',
  411: 'Else (411)',
  412: 'End Conditional Branch (412)',
  413: 'Repeat Above (413)',
};

/** One block opener still waiting for its closer. */
interface OpenBlock {
  code: BlockCode;
  /** Index of the opener in the list, for the message. */
  index: number;
  /** The opener's indent — every marker of this block must sit at it too. */
  indent: number;
  /** Choice labels from a 102's `parameters[0]` (empty for other blocks). */
  choices: string[];
  /** `parameters[1]` of a 102 — the cancel routing (see `setupChoices`). */
  cancelType: number;
  /** The `parameters[0]` index of each 402 row seen, in order. */
  choiceIndices: number[];
  /** Whether a 403 When Cancel row was seen. */
  hasCancelRow: boolean;
  /** How many 411 Else rows were seen (more than one is malformed). */
  elseCount: number;
}

function indentOf(command: EventCommand): number {
  return typeof command?.indent === 'number' ? command.indent : 0;
}

function openerLabel(block: OpenBlock): string {
  return `${BLOCKS[block.code].name} (${block.code}) opened at command ${block.index}`;
}

function error(path: string, code: number | undefined, message: string): ValidationWarning {
  return { path, code, message, severity: 'error' };
}

function advisory(path: string, code: number | undefined, message: string): ValidationWarning {
  return { path, code, message, severity: 'warning' };
}

/**
 * Checks that only make sense once a Show Choices block is complete: every choice
 * needs exactly one 402 branch, and the cancel routing has to agree with whether a
 * 403 row exists. The engine reads `cancelType = params[1] < choices.length ?
 * params[1] : -2`, and `command403` runs only for that `-2` case.
 */
function choiceBlockWarnings(block: OpenBlock, path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const { choices, choiceIndices } = block;

  const expected = [...choices.keys()];
  const sameOrder =
    choiceIndices.length === expected.length && choiceIndices.every((v, i) => v === expected[i]);

  if (!sameOrder) {
    const missing = expected.filter((i) => !choiceIndices.includes(i));
    const detail = missing.length
      ? `no When branch for choice ${missing.join(', ')} (that choice would do nothing)`
      : `branch indices [${choiceIndices.join(', ')}] do not match choices 0..${choices.length - 1} in order`;
    warnings.push(
      error(
        path,
        102,
        `${openerLabel(block)} has ${choiceIndices.length} When [choice] (402) branch(es) for ${choices.length} choice(s): ${detail}`,
      ),
    );
  }

  const cancelRoutesToBranch = block.cancelType === -2 || block.cancelType >= choices.length;
  if (block.hasCancelRow && !cancelRoutesToBranch) {
    warnings.push(
      advisory(
        path,
        403,
        `${openerLabel(block)} has a When Cancel (403) branch but its cancelType is ${block.cancelType} — the engine only runs that branch when cancelType is -2 or >= the choice count (${choices.length}), so it is dead code`,
      ),
    );
  } else if (!block.hasCancelRow && cancelRoutesToBranch) {
    warnings.push(
      advisory(
        path,
        102,
        `${openerLabel(block)} routes Cancel to a branch (cancelType ${block.cancelType}) but the block has no When Cancel (403) branch — cancelling skips the whole block`,
      ),
    );
  }

  return warnings;
}

/**
 * Validate the block structure of one command list: that every 102/111/112 is
 * closed by its own closer at its own indent, that no marker row is orphaned, and
 * that a Show Choices block's When branches line up with its choices.
 *
 * Returns findings in list order. Used by `validateCommandList`, so every write
 * that goes through the gate is covered, and `validate_event`/`validate_project`
 * report it as a read-only audit.
 */
export function blockStructureWarnings(list: EventCommand[], path: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const stack: OpenBlock[] = [];

  /**
   * Pop (and report) every block opened *inside* the one a marker belongs to —
   * an inner block that never closed. Returns the matching block, or undefined
   * when no open block owns this marker at this indent (an orphan row), in which
   * case the stack is left untouched.
   */
  function unwindTo(owner: BlockCode, indent: number, at: string): OpenBlock | undefined {
    let match = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].code === owner && stack[i].indent === indent) {
        match = i;
        break;
      }
    }
    if (match === -1) return undefined;
    while (stack.length - 1 > match) {
      const unclosed = stack.pop()!;
      warnings.push(
        error(
          at,
          unclosed.code,
          `${openerLabel(unclosed)} is not closed by ${BLOCKS[unclosed.code].closer} before its enclosing block ends`,
        ),
      );
    }
    return stack[match];
  }

  list.forEach((command, i) => {
    if (!command || typeof command.code !== 'number') return;
    const at = `${path} / command ${i}`;
    const indent = indentOf(command);
    const { code } = command;

    if (code in BLOCKS) {
      const blockCode = code as BlockCode;
      const params = Array.isArray(command.parameters) ? command.parameters : [];
      const choices = blockCode === 102 && Array.isArray(params[0]) ? (params[0] as string[]) : [];
      stack.push({
        code: blockCode,
        index: i,
        indent,
        choices,
        cancelType: typeof params[1] === 'number' ? params[1] : -1,
        choiceIndices: [],
        hasCancelRow: false,
        elseCount: 0,
      });
      return;
    }

    const owner = MARKER_OWNER[code];
    if (owner === undefined) return;

    const block = unwindTo(owner, indent, at);
    if (!block) {
      warnings.push(
        error(
          at,
          code,
          `${MARKER_NAME[code]} has no matching ${BLOCKS[owner].name} (${owner}) open at indent ${indent} — a branch/closer row must sit at the same indent as the command that opened its block`,
        ),
      );
      return;
    }

    if (code === 402) {
      const params = Array.isArray(command.parameters) ? command.parameters : [];
      block.choiceIndices.push(typeof params[0] === 'number' ? params[0] : -1);
      return;
    }
    if (code === 403) {
      if (block.hasCancelRow) {
        warnings.push(error(at, code, `${openerLabel(block)} has more than one When Cancel (403)`));
      }
      block.hasCancelRow = true;
      return;
    }
    if (code === 411) {
      block.elseCount++;
      if (block.elseCount > 1) {
        warnings.push(
          error(
            at,
            code,
            `${openerLabel(block)} has ${block.elseCount} Else (411) rows — a conditional branch takes at most one`,
          ),
        );
      }
      return;
    }

    // Closer: 404 / 412 / 413.
    if (code === 404) warnings.push(...choiceBlockWarnings(block, at));
    stack.pop();
  });

  // Anything still open at the end of the list never got its closer.
  for (const unclosed of stack) {
    warnings.push(
      error(
        `${path} / command ${unclosed.index}`,
        unclosed.code,
        `${openerLabel(unclosed)} is never closed by ${BLOCKS[unclosed.code].closer} (${MARKER_NAME[BLOCKS[unclosed.code].closer]})`,
      ),
    );
  }

  return warnings;
}
