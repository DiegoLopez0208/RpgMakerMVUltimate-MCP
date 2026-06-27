/**
 * refactor.ts — detect duplicated event logic worth consolidating.
 *
 * Copy-pasted command sequences are the most common source of event-logic rot:
 * the same shop/heal/cutscene block lives in five NPCs and they drift apart.
 * This finds identical contiguous command runs shared across events / common
 * events and suggests extracting them into a Common Event (called with command
 * 117), so a fix happens in one place.
 *
 * Read-only analysis (roadmap #9). It proposes; the editor tools act.
 */

import type { RawCommand } from "./eventAst.js";

export interface RefactorSource {
  label: string;
  commands: RawCommand[];
}

export interface DuplicateOccurrence {
  label: string;
  startIndex: number;
}

export interface DuplicateBlock {
  length: number;
  occurrences: DuplicateOccurrence[];
  /** Command codes of the shared run, for a quick eyeball. */
  codes: number[];
  suggestion: string;
}

export interface RefactorReport {
  blockCount: number;
  duplicateBlocks: DuplicateBlock[];
}

/** Stable per-command signature: identical commands (code + params) hash equal. */
function signature(cmd: RawCommand): string {
  return `${Number(cmd?.code)}:${JSON.stringify(cmd?.parameters ?? [])}`;
}

function distinctCodes(commands: RawCommand[], start: number, len: number): Set<number> {
  const s = new Set<number>();
  for (let i = start; i < start + len; i++) s.add(Number(commands[i]?.code));
  return s;
}

/**
 * Find identical command runs of at least `minLen` shared by 2+ locations.
 * Reports each maximal run once with all the places it appears.
 */
export function detectDuplicates(sources: RefactorSource[], minLen = 4, maxResults = 25): RefactorReport {
  const tokens = sources.map((s) => s.commands.map(signature));

  // Index every minLen window by its joined signature.
  const windows = new Map<string, { s: number; pos: number }[]>();
  for (let s = 0; s < tokens.length; s++) {
    const t = tokens[s];
    for (let pos = 0; pos + minLen <= t.length; pos++) {
      const key = t.slice(pos, pos + minLen).join("|");
      const arr = windows.get(key);
      if (arr) arr.push({ s, pos });
      else windows.set(key, [{ s, pos }]);
    }
  }

  const covered = new Set<string>(); // `${s}:${pos}` already inside an emitted block
  const blocks: DuplicateBlock[] = [];

  for (let s = 0; s < tokens.length; s++) {
    const t = tokens[s];
    for (let pos = 0; pos + minLen <= t.length; pos++) {
      if (covered.has(`${s}:${pos}`)) continue;
      const key = t.slice(pos, pos + minLen).join("|");
      const group = windows.get(key);
      if (!group || group.length < 2) continue;

      // Extend the run as far as ALL occurrences keep matching.
      let len = minLen;
      for (;;) {
        const first = group[0];
        const next = tokens[first.s][first.pos + len];
        if (next === undefined) break;
        let allMatch = true;
        for (const occ of group) {
          if (tokens[occ.s][occ.pos + len] !== next) { allMatch = false; break; }
        }
        if (!allMatch) break;
        len++;
      }

      // Skip trivial runs (a single repeated command, e.g. a row of Waits).
      if (distinctCodes(sources[s].commands, pos, len).size < 2) {
        covered.add(`${s}:${pos}`);
        continue;
      }

      // Emit once and mark every occurrence's range covered.
      for (const occ of group) {
        for (let k = 0; k < len; k++) covered.add(`${occ.s}:${occ.pos + k}`);
      }
      blocks.push({
        length: len,
        occurrences: group.map((o) => ({ label: sources[o.s].label, startIndex: o.pos })),
        codes: sources[s].commands.slice(pos, pos + len).map((c) => Number(c.code)),
        suggestion: `${group.length} locations share an identical ${len}-command sequence. Extract it into a Common Event and replace each copy with a single Call Common Event (command 117) so the logic lives in one place.`,
      });
    }
  }

  blocks.sort((a, b) => b.length * b.occurrences.length - a.length * a.occurrences.length);
  return { blockCount: blocks.length, duplicateBlocks: blocks.slice(0, maxResults) };
}
