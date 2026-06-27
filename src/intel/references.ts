/**
 * references.ts — extract the project entities a command list depends on.
 *
 * Given a flat MV command list (an event page, a common event, a troop page…)
 * this returns the set of switches, variables, common events, maps, items and
 * assets the logic touches. It is the raw material for the project graph
 * (roadmap #3), the "why does X happen" reasoning (#8) and the validation
 * passes (#10).
 *
 * Pure, defensive, never throws on malformed parameters.
 */

import type { RawCommand } from "./eventAst.js";

export interface RefSet {
  switches: number[];
  variables: number[];
  selfSwitches: string[];
  commonEvents: number[];
  maps: number[];
  items: number[];
  weapons: number[];
  armors: number[];
  troops: number[];
  animations: number[];
  actors: number[];
  states: number[];
  audio: string[];
  images: string[];
}

interface RefAccumulator {
  switches: Set<number>;
  variables: Set<number>;
  selfSwitches: Set<string>;
  commonEvents: Set<number>;
  maps: Set<number>;
  items: Set<number>;
  weapons: Set<number>;
  armors: Set<number>;
  troops: Set<number>;
  animations: Set<number>;
  actors: Set<number>;
  states: Set<number>;
  audio: Set<string>;
  images: Set<string>;
}

function newAccumulator(): RefAccumulator {
  return {
    switches: new Set(), variables: new Set(), selfSwitches: new Set(),
    commonEvents: new Set(), maps: new Set(), items: new Set(), weapons: new Set(),
    armors: new Set(), troops: new Set(), animations: new Set(), actors: new Set(),
    states: new Set(), audio: new Set(), images: new Set(),
  };
}

function freeze(acc: RefAccumulator): RefSet {
  const nums = (s: Set<number>) => [...s].sort((a, b) => a - b);
  const strs = (s: Set<string>) => [...s].filter((v) => v !== '').sort();
  return {
    switches: nums(acc.switches), variables: nums(acc.variables), selfSwitches: strs(acc.selfSwitches),
    commonEvents: nums(acc.commonEvents), maps: nums(acc.maps), items: nums(acc.items),
    weapons: nums(acc.weapons), armors: nums(acc.armors), troops: nums(acc.troops),
    animations: nums(acc.animations), actors: nums(acc.actors), states: nums(acc.states),
    audio: strs(acc.audio), images: strs(acc.images),
  };
}

/** Add every id in the inclusive range start..end to a set (handles reversed/garbage input). */
function addRange(set: Set<number>, start: unknown, end: unknown): void {
  const a = Number(start); const b = Number(end);
  if (!Number.isFinite(a)) return;
  const hi = Number.isFinite(b) ? b : a;
  const lo = Math.min(a, hi); const top = Math.max(a, hi);
  if (top - lo > 10000) { set.add(a); return; } // guard against absurd ranges
  for (let i = lo; i <= top; i++) if (i > 0) set.add(i);
}

function addNum(set: Set<number>, v: unknown): void {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) set.add(n);
}

function addAudio(set: Set<string>, v: unknown): void {
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    const name = String((v as Record<string, unknown>).name ?? '');
    if (name) set.add(name);
  }
}

function accumulate(acc: RefAccumulator, commands: RawCommand[]): void {
  for (const cmd of commands) {
    const code = Number(cmd?.code);
    const p = Array.isArray(cmd?.parameters) ? cmd.parameters! : [];
    switch (code) {
      case 121: addRange(acc.switches, p[0], p[1]); break;                       // Control Switches
      case 122:                                                                  // Control Variables
        addRange(acc.variables, p[0], p[1]);
        if (p[3] === 1) addNum(acc.variables, p[4]);                             // operand is another variable
        break;
      case 123: if (typeof p[0] === 'string') acc.selfSwitches.add(p[0]); break; // Control Self Switch
      case 111: accumulateConditional(acc, p); break;                            // Conditional Branch
      case 117: addNum(acc.commonEvents, p[0]); break;                           // Call Common Event
      case 201:                                                                  // Transfer Player
        if (p[0] === 0) addNum(acc.maps, p[1]);
        else { addNum(acc.variables, p[1]); addNum(acc.variables, p[2]); addNum(acc.variables, p[3]); }
        break;
      case 126: addNum(acc.items, p[0]); break;                                  // Change Items
      case 127: addNum(acc.weapons, p[0]); break;                                // Change Weapons
      case 128: addNum(acc.armors, p[0]); break;                                 // Change Armors
      case 302: accumulateShop(acc, p[0]); break;                               // Shop Processing
      case 301: if (p[0] === 0) addNum(acc.troops, p[1]); break;                // Battle Processing
      case 212: addNum(acc.animations, p[2]); break;                            // Show Animation
      case 337: addNum(acc.animations, p[1]); break;                            // Show Battle Animation
      case 129: addNum(acc.actors, p[0]); break;                                // Change Party Member
      case 311: case 312: case 315: case 316: case 317: case 318:               // actor-targeting changes
      case 319: case 320: case 321: case 324: case 325: case 326:
        if (p[0] === 0) addNum(acc.actors, p[1]);
        break;
      case 313: if (p[0] === 0) addNum(acc.actors, p[1]); addNum(acc.states, p[3]); break; // Change State
      case 322:                                                                  // Change Actor Images
        addNum(acc.actors, p[0]);
        for (const i of [1, 3, 5]) if (typeof p[i] === 'string' && p[i]) acc.images.add(p[i] as string);
        break;
      case 231: if (typeof p[1] === 'string' && p[1]) acc.images.add(p[1] as string); break; // Show Picture
      case 284: if (typeof p[0] === 'string' && p[0]) acc.images.add(p[0] as string); break; // Change Parallax
      case 283: for (const i of [0, 1]) if (typeof p[i] === 'string' && p[i]) acc.images.add(p[i] as string); break;
      case 241: case 242: case 245: case 249: case 250:                          // audio playback / change
      case 132: case 133: case 139: case 140:
        addAudio(acc.audio, p[0]);
        break;
      default: break;
    }
  }
}

function accumulateConditional(acc: RefAccumulator, p: unknown[]): void {
  switch (Number(p[0])) {
    case 0: addNum(acc.switches, p[1]); break;
    case 1:
      addNum(acc.variables, p[1]);
      if (p[2] === 1) addNum(acc.variables, p[3]);
      break;
    case 2: if (typeof p[1] === 'string') acc.selfSwitches.add(p[1]); break;
    case 4: addNum(acc.actors, p[1]); break;
    case 8: addNum(acc.items, p[1]); break;
    case 9: addNum(acc.weapons, p[1]); break;
    case 10: addNum(acc.armors, p[1]); break;
    default: break;
  }
}

function accumulateShop(acc: RefAccumulator, goods: unknown): void {
  if (!Array.isArray(goods)) return;
  for (const g of goods) {
    if (!Array.isArray(g)) continue;
    const type = Number(g[0]); const id = g[1];
    if (type === 0) addNum(acc.items, id);
    else if (type === 1) addNum(acc.weapons, id);
    else if (type === 2) addNum(acc.armors, id);
  }
}

export interface WriteSet {
  switches: number[];
  variables: number[];
  selfSwitches: string[];
}

function accumulateWrites(sw: Set<number>, va: Set<number>, ss: Set<string>, commands: RawCommand[]): void {
  for (const cmd of commands) {
    const code = Number(cmd?.code);
    const p = Array.isArray(cmd?.parameters) ? cmd.parameters! : [];
    if (code === 121) addRange(sw, p[0], p[1]);
    else if (code === 122) addRange(va, p[0], p[1]);
    else if (code === 123 && typeof p[0] === "string") ss.add(p[0]);
  }
}

export interface ReadSet {
  switches: number[];
  variables: number[];
  selfSwitches: string[];
}

function accumulateReads(sw: Set<number>, va: Set<number>, ss: Set<string>, commands: RawCommand[]): void {
  for (const cmd of commands) {
    const code = Number(cmd?.code);
    const p = Array.isArray(cmd?.parameters) ? cmd.parameters! : [];
    if (code === 111) {                                  // Conditional Branch
      const type = Number(p[0]);
      if (type === 0) addNum(sw, p[1]);
      else if (type === 1) { addNum(va, p[1]); if (p[2] === 1) addNum(va, p[3]); }
      else if (type === 2 && typeof p[1] === "string") ss.add(p[1]);
    } else if (code === 122 && p[3] === 1) {             // Control Variables, operand = another variable
      addNum(va, p[4]);
    } else if (code === 201 && p[0] === 1) {             // Transfer designated by variables
      addNum(va, p[1]); addNum(va, p[2]); addNum(va, p[3]);
    }
  }
}

/** Extract the switches/variables/self-switches a command list *reads* (conditions/operands). */
export function extractReads(commands: RawCommand[] | undefined | null): ReadSet {
  const sw = new Set<number>(); const va = new Set<number>(); const ss = new Set<string>();
  if (Array.isArray(commands)) accumulateReads(sw, va, ss, commands);
  return {
    switches: [...sw].sort((a, b) => a - b),
    variables: [...va].sort((a, b) => a - b),
    selfSwitches: [...ss].filter((v) => v !== "").sort(),
  };
}

/** Merge the reads of several command lists. */
export function extractReadsFromMany(lists: (RawCommand[] | undefined | null)[]): ReadSet {
  const sw = new Set<number>(); const va = new Set<number>(); const ss = new Set<string>();
  for (const list of lists) if (Array.isArray(list)) accumulateReads(sw, va, ss, list);
  return {
    switches: [...sw].sort((a, b) => a - b),
    variables: [...va].sort((a, b) => a - b),
    selfSwitches: [...ss].filter((v) => v !== "").sort(),
  };
}

/** Extract the switches/variables/self-switches a command list *writes to*. */
export function extractWrites(commands: RawCommand[] | undefined | null): WriteSet {
  const sw = new Set<number>(); const va = new Set<number>(); const ss = new Set<string>();
  if (Array.isArray(commands)) accumulateWrites(sw, va, ss, commands);
  return {
    switches: [...sw].sort((a, b) => a - b),
    variables: [...va].sort((a, b) => a - b),
    selfSwitches: [...ss].filter((v) => v !== "").sort(),
  };
}

/** Merge the writes of several command lists. */
export function extractWritesFromMany(lists: (RawCommand[] | undefined | null)[]): WriteSet {
  const sw = new Set<number>(); const va = new Set<number>(); const ss = new Set<string>();
  for (const list of lists) if (Array.isArray(list)) accumulateWrites(sw, va, ss, list);
  return {
    switches: [...sw].sort((a, b) => a - b),
    variables: [...va].sort((a, b) => a - b),
    selfSwitches: [...ss].filter((v) => v !== "").sort(),
  };
}

/** Extract every entity reference from a single command list. */
export function extractRefs(commands: RawCommand[] | undefined | null): RefSet {
  const acc = newAccumulator();
  if (Array.isArray(commands)) accumulate(acc, commands);
  return freeze(acc);
}

/** Merge several command lists into one combined reference set. */
export function extractRefsFromMany(lists: (RawCommand[] | undefined | null)[]): RefSet {
  const acc = newAccumulator();
  for (const list of lists) if (Array.isArray(list)) accumulate(acc, list);
  return freeze(acc);
}

/** True when the reference set carries no references at all. */
export function isEmptyRefSet(refs: RefSet): boolean {
  return (Object.keys(refs) as (keyof RefSet)[]).every((k) => refs[k].length === 0);
}
