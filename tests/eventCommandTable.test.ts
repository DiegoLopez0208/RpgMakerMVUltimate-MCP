import { describe, expect, it } from 'vitest';
import {
  BLOCK_ENDS, BLOCK_OPENERS, BLOCK_SECTIONS, CONTINUATION_FOR, EVENT_COMMANDS, FOLDED_CONTINUATIONS, commandName,
} from '../src/utils/eventCommandTable.js';

const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

describe('event command table', () => {
  it('derives the block structure the parser and validator rely on', () => {
    expect(sorted(BLOCK_OPENERS)).toEqual([102, 111, 112, 301]);
    expect(sorted(BLOCK_SECTIONS)).toEqual([402, 403, 411, 601, 602, 603]);
    expect(sorted(BLOCK_ENDS)).toEqual([404, 412, 413, 604]);
    expect(sorted(FOLDED_CONTINUATIONS)).toEqual([401, 405, 408, 605, 655]);
    expect(CONTINUATION_FOR).toEqual({ 101: 401, 105: 405, 108: 408, 205: 505, 302: 605, 355: 655 });
  });

  it('keeps every entry internally consistent', () => {
    for (const [code, spec] of Object.entries(EVENT_COMMANDS)) {
      expect(spec.name.trim(), `code ${code}`).not.toBe('');
      if (spec.continues !== undefined) expect(EVENT_COMMANDS[spec.continues], `header of ${code}`).toBeDefined();
      if (spec.folds) expect(spec.continues, `${code} folds but continues nothing`).toBeDefined();
      if (Array.isArray(spec.arity)) expect(spec.arity.length, `code ${code}`).toBeGreaterThan(0);
      const counts = spec.arity === undefined ? [] : typeof spec.arity === 'number' ? [spec.arity] : spec.arity;
      if (counts.length > 0 && spec.numeric) {
        const widest = Math.max(...counts);
        for (const slot of spec.numeric) expect(slot, `numeric slot of ${code}`).toBeLessThan(widest);
      }
    }
  });

  it('names unknown codes without throwing', () => {
    expect(commandName(121)).toBe('Control Switches');
    expect(commandName(342)).toBe('Change Enemy TP');
    expect(commandName(9999)).toBe('Command 9999');
  });
});
