/**
 * validate.ts — whole-project consistency checks built on the index.
 *
 * Surfaces the broken references, dead content and dangling links that the
 * editor never warns about: transfers to non-existent maps, events that call
 * missing common events / items / troops, switches and variables that are
 * declared but never touched, duplicate database IDs, and maps the player can
 * never reach.
 *
 * Roadmap #10 (Validaciones automáticas).
 */

import type { ProjectIndex, EntityKind } from "./projectIndex.js";
import type { RefSet } from "./references.js";
import { unreachableMaps } from "./graph.js";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: Severity;
  category: string;
  message: string;
  mapId?: number;
  eventId?: number;
  entity?: string;
  id?: number;
}

export interface ValidationReport {
  issueCount: number;
  bySeverity: Record<Severity, number>;
  issues: ValidationIssue[];
}

/** Map a RefSet entity key to the index entity kind it should exist in. */
const REF_TO_ENTITY: Partial<Record<keyof RefSet, EntityKind>> = {
  items: "items", weapons: "weapons", armors: "armors", troops: "troops",
  animations: "animations", actors: "actors", states: "states",
};

function idSet(entities: { id: number }[]): Set<number> {
  return new Set(entities.map((e) => e.id));
}

export function validateProject(index: ProjectIndex): ValidationReport {
  const issues: ValidationIssue[] = [];

  // Existence sets.
  const entityIds: Partial<Record<EntityKind, Set<number>>> = {};
  for (const kind of Object.keys(index.entities) as EntityKind[]) entityIds[kind] = idSet(index.entities[kind]);
  const commonIds = new Set(index.commonEvents.map((c) => c.id));
  const liveMapIds = new Set(index.maps.filter((m) => !m.missing).map((m) => m.id));

  // 1. Duplicate database IDs.
  for (const kind of Object.keys(index.entities) as EntityKind[]) {
    const seen = new Set<number>();
    for (const e of index.entities[kind]) {
      if (seen.has(e.id)) issues.push({ severity: "error", category: "duplicate-id", entity: kind, id: e.id, message: `Duplicate ${kind} id ${e.id}` });
      seen.add(e.id);
    }
  }

  // 2. Missing map files referenced by the map tree.
  for (const m of index.maps) {
    if (m.missing) issues.push({ severity: "error", category: "missing-map", mapId: m.id, message: `MapInfos lists map ${m.id} "${m.name}" but data/Map${String(m.id).padStart(3, "0")}.json is missing` });
  }

  // 3. Broken transfers.
  for (const m of index.maps) {
    for (const t of m.transfers) {
      if (t.toMap <= 0 || !liveMapIds.has(t.toMap)) {
        issues.push({ severity: "error", category: "broken-transfer", mapId: m.id, eventId: t.fromEvent ?? undefined, message: `Map ${m.id} event ${t.fromEvent} transfers to map ${t.toMap}, which does not exist` });
      }
    }
  }

  // 4. Dangling entity references from any command list.
  for (const src of index.refSources) {
    for (const refKey of Object.keys(REF_TO_ENTITY) as (keyof RefSet)[]) {
      const kind = REF_TO_ENTITY[refKey]!;
      const present = entityIds[kind]!;
      for (const id of src.refs[refKey] as number[]) {
        if (!present.has(id)) issues.push({ severity: "error", category: "dangling-ref", entity: kind, id, message: `${src.label} references ${kind} ${id}, which does not exist` });
      }
    }
    for (const id of src.refs.commonEvents) {
      if (!commonIds.has(id)) issues.push({ severity: "error", category: "dangling-ref", entity: "common_events", id, message: `${src.label} calls common event ${id}, which does not exist` });
    }
  }

  // 5. Unused named switches / variables.
  const usedSwitches = new Set<number>();
  const usedVariables = new Set<number>();
  for (const src of index.refSources) {
    for (const id of src.refs.switches) usedSwitches.add(id);
    for (const id of src.refs.variables) usedVariables.add(id);
  }
  for (const m of index.maps) {
    for (const e of m.events) {
      for (const id of e.conditionRefs.switches) usedSwitches.add(id);
      for (const id of e.conditionRefs.variables) usedVariables.add(id);
    }
  }
  for (const ce of index.commonEvents) if (ce.trigger === 1 || ce.trigger === 2) usedSwitches.add(ce.switchId);

  for (const s of index.switches) {
    if (s.id > 0 && s.name && !usedSwitches.has(s.id)) issues.push({ severity: "warning", category: "unused-switch", id: s.id, message: `Switch ${s.id} "${s.name}" is named but never used` });
  }
  for (const v of index.variables) {
    if (v.id > 0 && v.name && !usedVariables.has(v.id)) issues.push({ severity: "warning", category: "unused-variable", id: v.id, message: `Variable ${v.id} "${v.name}" is named but never used` });
  }

  // 6. Starting position sanity.
  if (index.start.mapId && !liveMapIds.has(index.start.mapId)) {
    issues.push({ severity: "error", category: "bad-start", mapId: index.start.mapId, message: `Starting map ${index.start.mapId} does not exist` });
  } else {
    const startMap = index.maps.find((m) => m.id === index.start.mapId);
    if (startMap && (index.start.x >= startMap.width || index.start.y >= startMap.height)) {
      issues.push({ severity: "warning", category: "bad-start", mapId: index.start.mapId, message: `Starting position (${index.start.x},${index.start.y}) is outside map ${index.start.mapId} bounds (${startMap.width}x${startMap.height})` });
    }
  }

  // 7. Maps unreachable from the start map.
  for (const m of unreachableMaps(index)) {
    issues.push({ severity: "info", category: "unreachable-map", mapId: m.id, message: `Map ${m.id} "${m.name}" has no transfer path from the starting map` });
  }

  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) bySeverity[i.severity]++;
  return { issueCount: issues.length, bySeverity, issues };
}
