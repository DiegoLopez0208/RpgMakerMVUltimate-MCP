/**
 * graph.ts — relationships and reasoning over the project index.
 *
 * The index records *what each command list touches*; this module inverts that
 * into "who uses X" queries and walks the map transfer network, then layers
 * light reasoning on top so the MCP can answer questions like
 * "why does this door never open?" or "what breaks if I delete this map?".
 *
 * Roadmap #3 (Grafo del proyecto) and #8 (Comprensión del juego).
 */

import type { ProjectIndex, RefSource } from "./projectIndex.js";
import type { RefSet } from "./references.js";

export type RefKind = Extract<
  keyof RefSet,
  "switches" | "variables" | "commonEvents" | "items" | "weapons" | "armors" |
  "troops" | "animations" | "actors" | "states" | "maps"
>;

export type Role = "read" | "write" | "both";

export interface UsageHit {
  source: string;
  kind: RefSource["kind"] | "page-condition" | "common-event-trigger" | "encounter";
  mapId?: number;
  eventId?: number;
  commonEventId?: number;
  troopId?: number;
  role?: Role;
}

/** Every place that references entity `id` of the given kind. */
export function findUsage(index: ProjectIndex, kind: RefKind, id: number): UsageHit[] {
  const hits: UsageHit[] = [];
  const writable = kind === "switches" || kind === "variables";

  for (const src of index.refSources) {
    if (!src.refs[kind].includes(id)) continue;
    let role: Role | undefined;
    if (writable) {
      const writes = kind === "switches" ? src.writes.switches : src.writes.variables;
      const reads = kind === "switches" ? src.reads.switches : src.reads.variables;
      const w = writes.includes(id);
      const r = reads.includes(id);
      role = w && r ? "both" : w ? "write" : "read";
    }
    hits.push({
      source: src.label, kind: src.kind, mapId: src.mapId, eventId: src.eventId,
      commonEventId: src.commonEventId, troopId: src.troopId, role,
    });
  }

  // Page appearance conditions (reads only).
  if (kind === "switches" || kind === "variables" || kind === "items") {
    for (const map of index.maps) {
      for (const ev of map.events) {
        const cond = kind === "switches" ? ev.conditionRefs.switches
          : kind === "variables" ? ev.conditionRefs.variables
            : ev.conditionRefs.items;
        if (cond.includes(id)) {
          hits.push({ source: `Map ${map.id} / event ${ev.id} page condition`, kind: "page-condition", mapId: map.id, eventId: ev.id, role: "read" });
        }
      }
    }
  }

  // Common-event auto/parallel trigger switch.
  if (kind === "switches") {
    for (const ce of index.commonEvents) {
      if (ce.switchId === id && (ce.trigger === 1 || ce.trigger === 2)) {
        hits.push({ source: `Common Event ${ce.id} "${ce.name}" trigger switch`, kind: "common-event-trigger", commonEventId: ce.id, role: "read" });
      }
    }
  }

  // Troop encounter membership.
  if (kind === "troops") {
    for (const map of index.maps) {
      if (map.encounterTroops.includes(id)) {
        hits.push({ source: `Map ${map.id} "${map.name}" random encounters`, kind: "encounter", mapId: map.id });
      }
    }
  }

  return hits;
}

export interface SwitchReport {
  id: number;
  name: string;
  setters: UsageHit[];
  readers: UsageHit[];
  diagnosis: string;
}

/** Reason about a switch: who sets it, who reads it, and what's suspicious. */
export function explainSwitch(index: ProjectIndex, id: number): SwitchReport {
  const name = index.switches[id]?.name ?? "";
  const usage = findUsage(index, "switches", id);
  const setters = usage.filter((u) => u.role === "write" || u.role === "both");
  const readers = usage.filter((u) => u.role === "read" || u.role === "both");

  let diagnosis: string;
  if (setters.length === 0 && readers.length === 0) {
    diagnosis = `Switch ${id}${name ? ` "${name}"` : ""} is never used anywhere.`;
  } else if (setters.length === 0) {
    diagnosis = `Switch ${id}${name ? ` "${name}"` : ""} is read/gated in ${readers.length} place(s) but is NEVER set ON. Anything waiting on it can never trigger — this is a common reason a door, event or page never activates.`;
  } else if (readers.length === 0) {
    diagnosis = `Switch ${id}${name ? ` "${name}"` : ""} is set in ${setters.length} place(s) but never read. It has no effect (dead write) and can likely be removed.`;
  } else {
    diagnosis = `Switch ${id}${name ? ` "${name}"` : ""} is set in ${setters.length} place(s) and read in ${readers.length}.`;
  }
  return { id, name, setters, readers, diagnosis };
}

export interface VariableReport {
  id: number;
  name: string;
  setters: UsageHit[];
  readers: UsageHit[];
  diagnosis: string;
}

export function explainVariable(index: ProjectIndex, id: number): VariableReport {
  const name = index.variables[id]?.name ?? "";
  const usage = findUsage(index, "variables", id);
  const setters = usage.filter((u) => u.role === "write" || u.role === "both");
  const readers = usage.filter((u) => u.role === "read" || u.role === "both");
  let diagnosis: string;
  if (setters.length === 0 && readers.length === 0) diagnosis = `Variable ${id}${name ? ` "${name}"` : ""} is never used.`;
  else if (setters.length === 0) diagnosis = `Variable ${id}${name ? ` "${name}"` : ""} is read but never assigned — it stays 0.`;
  else if (readers.length === 0) diagnosis = `Variable ${id}${name ? ` "${name}"` : ""} is assigned but never read (dead write).`;
  else diagnosis = `Variable ${id}${name ? ` "${name}"` : ""} is assigned in ${setters.length} place(s) and read in ${readers.length}.`;
  return { id, name, setters, readers, diagnosis };
}

// ─── Map connectivity ───

export interface MapGraph {
  nodes: { id: number; name: string }[];
  edges: { from: number; to: number; via: number | null }[];
}

/** Directed graph of player transfers between maps. */
export function buildMapGraph(index: ProjectIndex): MapGraph {
  const nodes = index.maps.map((m) => ({ id: m.id, name: m.name }));
  const edges: MapGraph["edges"] = [];
  const seen = new Set<string>();
  for (const map of index.maps) {
    for (const t of map.transfers) {
      const key = `${t.fromMap}->${t.toMap}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: t.fromMap, to: t.toMap, via: t.fromEvent });
    }
  }
  return { nodes, edges };
}

/** Map ids reachable from `startId` by following transfers (includes startId). */
export function reachableMaps(index: ProjectIndex, startId: number): number[] {
  const adjacency = new Map<number, number[]>();
  for (const map of index.maps) {
    const outs = adjacency.get(map.id) ?? [];
    for (const t of map.transfers) outs.push(t.toMap);
    adjacency.set(map.id, outs);
  }
  const seen = new Set<number>();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adjacency.get(cur) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Maps not reachable from the game's starting map (dead content). */
export function unreachableMaps(index: ProjectIndex): { id: number; name: string }[] {
  const start = index.start.mapId;
  if (!start) return [];
  const reachable = new Set(reachableMaps(index, start));
  return index.maps
    .filter((m) => !m.missing && !reachable.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }));
}

export interface MapRemovalImpact {
  mapId: number;
  incomingTransfers: { fromMap: number; fromEvent: number | null }[];
  newlyUnreachable: { id: number; name: string }[];
  isStartMap: boolean;
}

/** What breaks if a given map is deleted: who pointed at it, what it stranded. */
export function whatBreaksIfMapRemoved(index: ProjectIndex, mapId: number): MapRemovalImpact {
  const incoming: { fromMap: number; fromEvent: number | null }[] = [];
  for (const map of index.maps) {
    if (map.id === mapId) continue;
    for (const t of map.transfers) {
      if (t.toMap === mapId) incoming.push({ fromMap: t.fromMap, fromEvent: t.fromEvent });
    }
  }
  const before = new Set(reachableMaps(index, index.start.mapId));
  // Recompute reachability ignoring the removed map.
  const adjacency = new Map<number, number[]>();
  for (const map of index.maps) {
    if (map.id === mapId) continue;
    const outs: number[] = [];
    for (const t of map.transfers) if (t.toMap !== mapId) outs.push(t.toMap);
    adjacency.set(map.id, outs);
  }
  const seen = new Set<number>();
  const stack = index.start.mapId === mapId ? [] : [index.start.mapId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adjacency.get(cur) ?? []) if (!seen.has(next)) stack.push(next);
  }
  const newlyUnreachable = index.maps
    .filter((m) => !m.missing && m.id !== mapId && before.has(m.id) && !seen.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }));
  return { mapId, incomingTransfers: incoming, newlyUnreachable, isStartMap: index.start.mapId === mapId };
}
