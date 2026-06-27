/**
 * critique.ts — review a map the way a game designer would.
 *
 * Beyond "is it valid?" (that's validate.ts), this asks "is it good?": how much
 * dead space, whether the playable area feels empty or cluttered, whether
 * interactables are spread out or all bunched in one corner, whether the floor
 * is visually monotonous, and whether the walkable space is fragmented. Each
 * finding carries a justification and an actionable suggestion.
 *
 * Roadmap #7 (Crítica de mapas) and #11 (IA orientada al diseño).
 */

import { isStandable, type PlaceableMap } from "../utils/placement.js";

export interface CritiqueEvent { id: number; name: string; x: number; y: number; }

export type FindingKind = "praise" | "info" | "suggestion";

export interface CritiqueFinding {
  kind: FindingKind;
  category: string;
  message: string;
}

export interface MapCritique {
  mapId?: number;
  hasPassability: boolean;
  metrics: {
    width: number;
    height: number;
    totalTiles: number;
    walkableTiles: number;
    walkablePct: number;
    decorationTiles: number;
    decorationPctOfWalkable: number;
    eventCount: number;
    eventsPer100Walkable: number;
    distinctGroundTiles: number;
    standableRegions: number;
    emptyQuadrants: string[];
  };
  findings: CritiqueFinding[];
  score: number;
}

function tileAt(map: PlaceableMap, x: number, y: number, z: number): number {
  return map.data[(z * map.height + y) * map.width + x] | 0;
}

/** Count standable tiles and the number of disconnected standable regions. */
function walkability(map: PlaceableMap, flags: number[]): { walkable: boolean[]; count: number; regions: number } {
  const w = map.width, h = map.height;
  const walkable = new Array<boolean>(w * h).fill(false);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isStandable(map, flags, x, y)) { walkable[y * w + x] = true; count++; }
    }
  }
  // Count 4-connected regions.
  const seen = new Uint8Array(w * h);
  let regions = 0;
  for (let i = 0; i < w * h; i++) {
    if (!walkable[i] || seen[i]) continue;
    regions++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % w, cy = (c - cx) / w;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seen[ni] && walkable[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
  }
  return { walkable, count, regions };
}

function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Produce a designer-style critique of a single map. */
export function critiqueMap(
  map: PlaceableMap,
  flags: number[] | null,
  events: CritiqueEvent[],
  mapId?: number,
): MapCritique {
  const w = map.width, h = map.height;
  const totalTiles = w * h;
  const findings: CritiqueFinding[] = [];

  // Decoration = non-empty upper (object) layers 2 and 3.
  let decorationTiles = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tileAt(map, x, y, 2) !== 0 || tileAt(map, x, y, 3) !== 0) decorationTiles++;
    }
  }

  // Distinct ground tiles on layer 0.
  const ground = new Set<number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = tileAt(map, x, y, 0); if (t) ground.add(t); }

  const hasPassability = Array.isArray(flags) && flags.length > 0;
  let walkableTiles = 0, regions = 0;
  let walkableMask: boolean[] | null = null;
  if (hasPassability) {
    const wk = walkability(map, flags!);
    walkableTiles = wk.count; regions = wk.regions; walkableMask = wk.walkable;
  }

  const denom = walkableTiles || totalTiles;
  const eventsPer100 = denom > 0 ? round((events.length / denom) * 100, 2) : 0;
  const decorationPct = denom > 0 ? round((decorationTiles / denom) * 100) : 0;
  const walkablePct = totalTiles > 0 ? round((walkableTiles / totalTiles) * 100) : 0;

  // Quadrant distribution of events over the playable bounding box.
  const emptyQuadrants: string[] = [];
  if (hasPassability && walkableMask && walkableTiles > 0) {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < walkableMask.length; i++) {
      if (!walkableMask[i]) continue;
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const quadName = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const evCount = [0, 0, 0, 0];
    const walkCount = [0, 0, 0, 0];
    const idx = (x: number, y: number) => (x <= midX ? 0 : 1) + (y <= midY ? 0 : 2);
    for (let i = 0; i < walkableMask.length; i++) {
      if (!walkableMask[i]) continue;
      const x = i % w, y = (i - x) / w;
      walkCount[idx(x, y)]++;
    }
    for (const e of events) if (e.x >= minX && e.x <= maxX && e.y >= minY && e.y <= maxY) evCount[idx(e.x, e.y)]++;
    for (let q = 0; q < 4; q++) if (walkCount[q] > totalTiles * 0.06 && evCount[q] === 0) emptyQuadrants.push(quadName[q]);
  }

  // ─── Findings (each justified + actionable) ───
  if (!hasPassability) {
    findings.push({ kind: "info", category: "passability", message: "No Tilesets.json passage data available, so walkability/dead-space metrics are skipped — only decoration, event and tile-variety checks ran." });
  } else {
    if (walkablePct < 25) findings.push({ kind: "suggestion", category: "dead-space", message: `Only ${walkablePct}% of the map is walkable — most of it is wall or void the player never touches. Trim the map or open up the blocked areas so its size is justified.` });
    if (regions > 1) findings.push({ kind: "info", category: "fragmentation", message: `The walkable area is split into ${regions} disconnected regions. Confirm each is reached by a transfer/door, or merge them — isolated pockets read as bugs.` });
    if (walkablePct > 85 && decorationPct < 3 && walkableTiles >= 60) findings.push({ kind: "suggestion", category: "empty", message: `Large open walkable area (${walkablePct}%) with almost no decoration (${decorationPct}%). It will feel empty — add landmarks, props or elevation to break up the space and guide the eye.` });
    for (const q of emptyQuadrants) findings.push({ kind: "suggestion", category: "pacing", message: `The ${q} has plenty of walkable space but no events. A point of interest (NPC, chest, sign, decoration cluster) there would improve exploration pacing and reward the player for going off the main path.` });
  }

  if (events.length === 0) findings.push({ kind: "suggestion", category: "interactivity", message: "The map has no events at all — nothing to interact with. Add at least an NPC, sign or exit so the space has purpose." });
  else if (denom > 200 && eventsPer100 < 0.5) findings.push({ kind: "suggestion", category: "interactivity", message: `Interactivity is sparse for the map size (${events.length} events over ${denom} tiles). Consider more NPCs / chests / triggers so exploration pays off.` });
  else if (eventsPer100 > 10) findings.push({ kind: "info", category: "density", message: `Very high event density (${eventsPer100} per 100 tiles). Make sure it doesn't feel cluttered or overwhelm the player.` });

  if (ground.size <= 1 && totalTiles > 25) findings.push({ kind: "suggestion", category: "monotony", message: "The floor is painted with a single ground tile — visually monotonous. Vary ground tiles (paths, patches, edges) to add texture and direction." });

  if (findings.every((f) => f.kind !== "suggestion")) {
    findings.push({ kind: "praise", category: "overall", message: "Balanced layout — reasonable walkable space, decoration and event distribution with no obvious dead zones." });
  }

  // Rough score: penalise suggestions, lightly penalise info.
  let score = 100;
  for (const f of findings) score -= f.kind === "suggestion" ? 12 : f.kind === "info" ? 3 : 0;
  score = Math.max(0, Math.min(100, score));

  return {
    mapId,
    hasPassability,
    metrics: {
      width: w, height: h, totalTiles,
      walkableTiles, walkablePct,
      decorationTiles, decorationPctOfWalkable: decorationPct,
      eventCount: events.length, eventsPer100Walkable: eventsPer100,
      distinctGroundTiles: ground.size,
      standableRegions: regions,
      emptyQuadrants,
    },
    findings,
    score,
  };
}
