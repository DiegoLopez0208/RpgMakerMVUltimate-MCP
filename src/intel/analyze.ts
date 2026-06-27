/**
 * analyze.ts — the request handler behind the consolidated `analyze_project`
 * tool. It ties the intelligence layer (index, graph, reasoning, validation,
 * AST) together behind a single `view` argument so callers get project
 * understanding without thinking about individual modules.
 *
 * Roadmap #1/#2/#3/#8/#10 surfaced as one high-level tool (#6).
 */

import { readJson } from "../utils/fileHandler.js";
import { getMap, loadTilesetFlags } from "../tools/mapTools.js";
import { getProjectIndex } from "./projectIndex.js";
import {
  findUsage, explainSwitch, explainVariable, buildMapGraph,
  reachableMaps, unreachableMaps, whatBreaksIfMapRemoved, type RefKind,
} from "./graph.js";
import { validateProject, type Severity } from "./validate.js";
import { parseEventCommands, astToOutline, type RawCommand } from "./eventAst.js";
import { analyzePlugins } from "./plugins.js";
import { critiqueMap, type CritiqueEvent } from "./critique.js";
import { detectDuplicates, type RefactorSource } from "./refactor.js";
import { gatherDocuments, rankDocuments } from "./search.js";

type Args = Record<string, unknown>;

function num(v: unknown): number {
  return Number(v);
}

/** Map the tool's singular `kind` argument to the internal RefSet key. */
const KIND_MAP: Record<string, RefKind> = {
  switch: "switches", variable: "variables", common_event: "commonEvents",
  item: "items", weapon: "weapons", armor: "armors", troop: "troops",
  animation: "animations", actor: "actors", state: "states", map: "maps",
};

async function eventCommandList(projectPath: string, args: Args): Promise<RawCommand[]> {
  if (args.commonEventId !== undefined) {
    const ces = (await readJson(projectPath, "CommonEvents.json")) as Record<string, unknown>[];
    const ce = Array.isArray(ces) ? ces.find((c) => c && num(c.id) === num(args.commonEventId)) : null;
    if (!ce) throw new Error(`Common event ${args.commonEventId} not found`);
    return (ce.list as RawCommand[]) ?? [];
  }
  const mapId = num(args.mapId);
  if (!mapId) throw new Error('view "ast" requires mapId (+ eventId) or commonEventId');
  const file = `Map${String(mapId).padStart(3, "0")}.json`;
  const map = (await readJson(projectPath, file)) as Record<string, unknown>;
  const events = (map?.events as Record<string, unknown>[]) ?? [];
  const ev = events.find((e) => e && num(e.id) === num(args.eventId));
  if (!ev) throw new Error(`Event ${args.eventId} not found on map ${mapId}`);
  const pages = (ev.pages as Record<string, unknown>[]) ?? [];
  const pageIdx = args.page !== undefined ? num(args.page) : 0;
  const page = pages[pageIdx];
  if (!page) throw new Error(`Page ${pageIdx} not found on event ${args.eventId}`);
  return (page.list as RawCommand[]) ?? [];
}

/** Every event-page and common-event command list, labelled, for refactor analysis. */
async function gatherCommandSources(projectPath: string): Promise<RefactorSource[]> {
  const sources: RefactorSource[] = [];
  const safe = async (f: string) => { try { return await readJson(projectPath, f); } catch { return null; } };

  const commons = await safe("CommonEvents.json");
  if (Array.isArray(commons)) {
    for (const ce of commons) {
      if (!ce || typeof ce !== "object") continue;
      const c = ce as Record<string, unknown>;
      if (Array.isArray(c.list) && c.list.length > 1) sources.push({ label: `Common Event ${num(c.id)} "${String(c.name ?? "")}"`, commands: c.list as RawCommand[] });
    }
  }

  const infos = await safe("MapInfos.json");
  if (Array.isArray(infos)) {
    for (const info of infos) {
      if (!info || typeof info !== "object") continue;
      const id = num((info as Record<string, unknown>).id);
      const map = (await safe(`Map${String(id).padStart(3, "0")}.json`)) as Record<string, unknown> | null;
      if (!map || !Array.isArray(map.events)) continue;
      for (const ev of map.events) {
        if (!ev || typeof ev !== "object") continue;
        const e = ev as Record<string, unknown>;
        const pages = Array.isArray(e.pages) ? e.pages : [];
        for (let pi = 0; pi < pages.length; pi++) {
          const list = (pages[pi] as Record<string, unknown>)?.list;
          if (Array.isArray(list) && list.length > 1) sources.push({ label: `Map ${id} / event ${num(e.id)} "${String(e.name ?? "")}" p${pi}`, commands: list as RawCommand[] });
        }
      }
    }
  }
  return sources;
}

export async function analyzeProject(projectPath: string, args: Args): Promise<unknown> {
  if (!projectPath) throw new Error("No project path set. Use set_project_path or RPGMAKER_PROJECT_PATH first.");
  const view = String(args.view ?? "overview");

  // These views work off specific files and do not need the full index.
  if (view === "ast") {
    const list = await eventCommandList(projectPath, args);
    const ast = parseEventCommands(list);
    return { commandCount: list.length, outline: astToOutline(ast), ast };
  }
  if (view === "plugins") {
    return analyzePlugins(projectPath);
  }
  if (view === "search") {
    const query = String(args.query ?? "");
    if (!query.trim()) throw new Error('view "search" requires a non-empty query');
    const docs = await gatherDocuments(projectPath);
    return { query, results: rankDocuments(docs, query, args.limit ? num(args.limit) : 20) };
  }
  if (view === "refactor") {
    const sources = await gatherCommandSources(projectPath);
    return detectDuplicates(sources, args.minLen ? num(args.minLen) : 4);
  }
  if (view === "critique") {
    const mapId = num(args.mapId);
    if (!mapId) throw new Error('view "critique" requires mapId');
    const map = (await getMap(projectPath, mapId)) as Record<string, unknown>;
    const flags = await loadTilesetFlags(projectPath, num(map.tilesetId)).catch(() => null);
    const events: CritiqueEvent[] = (Array.isArray(map.events) ? map.events : [])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({ id: num(e.id), name: String(e.name ?? ""), x: num(e.x), y: num(e.y) }));
    return critiqueMap(map as unknown as { width: number; height: number; data: number[] }, flags, events, mapId);
  }

  const index = await getProjectIndex(projectPath);

  switch (view) {
    case "overview": {
      const report = validateProject(index);
      return {
        gameTitle: index.gameTitle,
        start: index.start,
        counts: index.counts,
        health: report.bySeverity,
        topIssues: report.issues.slice(0, 15),
        unreachableMaps: unreachableMaps(index),
      };
    }
    case "index":
      return {
        gameTitle: index.gameTitle,
        start: index.start,
        counts: index.counts,
        maps: index.maps.map((m) => ({ id: m.id, name: m.name, displayName: m.displayName, events: m.eventCount, tilesetId: m.tilesetId, missing: m.missing })),
        commonEvents: index.commonEvents.map((c) => ({ id: c.id, name: c.name, trigger: c.trigger })),
        namedSwitches: index.switches.filter((s) => s.name),
        namedVariables: index.variables.filter((v) => v.name),
      };
    case "validate": {
      const report = validateProject(index);
      const filter = args.severity ? String(args.severity) as Severity : undefined;
      const issues = filter ? report.issues.filter((i) => i.severity === filter) : report.issues;
      return { issueCount: issues.length, bySeverity: report.bySeverity, issues };
    }
    case "graph":
      return { ...buildMapGraph(index), reachableFromStart: reachableMaps(index, index.start.mapId), unreachable: unreachableMaps(index) };
    case "usage": {
      const kind = KIND_MAP[String(args.kind)];
      if (!kind) throw new Error(`Unknown kind "${args.kind}". Valid: ${Object.keys(KIND_MAP).join(", ")}`);
      const id = num(args.id);
      if (!id) throw new Error('view "usage" requires a numeric id');
      return { kind: args.kind, id, usedBy: findUsage(index, kind, id) };
    }
    case "explain": {
      const target = String(args.target ?? "switch");
      const id = num(args.id);
      if (!id) throw new Error('view "explain" requires a numeric id');
      if (target === "switch") return explainSwitch(index, id);
      if (target === "variable") return explainVariable(index, id);
      if (target === "map") return { ...whatBreaksIfMapRemoved(index, id), reachableFrom: reachableMaps(index, id) };
      throw new Error(`Unknown target "${target}". Valid: switch, variable, map`);
    }
    default:
      throw new Error(`Unknown view "${view}". Valid: overview, index, validate, graph, usage, explain, ast, plugins, critique, refactor, search`);
  }
}
