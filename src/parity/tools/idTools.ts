import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { loadProjectData } from './validationTools.js';
import { ProjectData } from '../validation/references.js';
import {
  IdNamespace,
  IdReference,
  scanIdUsage,
  scannedCommandCodes,
} from '../validation/idUsage.js';

const ID_NAMESPACES = ['switch', 'variable', 'common_event'] as const;

/** How many reference sites are listed per id in a whole-namespace listing. */
const REFERENCE_SAMPLE = 3;
/** …and when the caller asked about one specific id, where the detail is the point. */
const REFERENCE_SAMPLE_SINGLE = 50;

/** Ceiling on ids handed out, so a corrupt project can't produce an absurd suggestion. */
const MAX_ID = 5000;

/** One id that is spoken for, and why. */
export interface AllocatedId {
  id: number;
  /** The System.json label (switch/variable) or record name (common_event); `''` when unnamed. */
  name: string;
  /**
   * Whether the id is *declared*: a non-empty System.json label, or a live
   * CommonEvents row. An id that is referenced but not declared is still
   * allocated — someone is using it — but nothing names it.
   */
  declared: boolean;
  referenceCount: number;
  /** A sample of reference sites; `referenceCount` is the true total. */
  referencedBy: Array<{ path: string; via: string }>;
}

export interface AllocationReport {
  type: IdNamespace;
  count: number;
  /** Highest allocated id, or 0 when nothing is allocated. */
  highest: number;
  /** Unallocated ids below `highest` — holes left by deletions or sparse picking. */
  gaps: number[];
  /**
   * switch/variable only: how many ids System.json declares slots for. Ids above
   * this are ignored by MV's runtime setters until the array grows
   * (`set_switch_name`/`set_variable_name` grow it).
   */
  declaredCapacity?: number;
  allocated: AllocatedId[];
  /** What this scan does and doesn't see. */
  coverage: string;
}

/** Group raw reference hits by id. */
function byId(refs: IdReference[]): Map<number, IdReference[]> {
  const grouped = new Map<number, IdReference[]>();
  for (const ref of refs) {
    const existing = grouped.get(ref.id);
    if (existing) existing.push(ref);
    else grouped.set(ref.id, [ref]);
  }
  return grouped;
}

/**
 * The declared label for every id of a namespace: the System.json `switches` /
 * `variables` arrays, or common-event record names. Only non-empty labels count
 * — RPG Maker pads both arrays with `''` for every unused slot, so an empty
 * string means "slot exists, nobody claimed it".
 */
function declaredNames(data: ProjectData, ns: IdNamespace): Map<number, string> {
  const names = new Map<number, string>();

  if (ns === 'common_event') {
    for (const commonEvent of data.commonEvents) {
      if (commonEvent) names.set(commonEvent.id, commonEvent.name ?? '');
    }
    return names;
  }

  const labels = ns === 'switch' ? data.system?.switches : data.system?.variables;
  if (Array.isArray(labels)) {
    labels.forEach((label, id) => {
      if (id > 0 && typeof label === 'string' && label !== '') names.set(id, label);
    });
  }
  return names;
}

/** How many ids System.json declares slots for (`undefined` for common events). */
function declaredCapacity(data: ProjectData, ns: IdNamespace): number | undefined {
  if (ns === 'common_event') return undefined;
  const labels = ns === 'switch' ? data.system?.switches : data.system?.variables;
  return Array.isArray(labels) ? Math.max(labels.length - 1, 0) : undefined;
}

function coverageNote(ns: IdNamespace): string {
  const codes = scannedCommandCodes(ns).join(', ');
  return (
    `Derived from the project's own JSON — event pages (conditions + commands), common events, and troop pages. ` +
    `Command codes scanned for ${ns} ids: ${codes}. Like the command validator this table is curated, not exhaustive: ` +
    `an id used only from a Script (355) or a plugin command (356) will read as free.`
  );
}

/**
 * Every id of one namespace that is spoken for, derived from the project files.
 *
 * "Allocated" means declared (a System.json label / a CommonEvents row) **or**
 * referenced anywhere. Both halves matter: a named-but-unused switch is a claim
 * a previous session staked, and a used-but-unnamed one is a claim nobody wrote
 * down. Handing either out again produces the failure this exists to prevent —
 * silent, no crash, surfacing hours into a playtest as a door that's already
 * open.
 *
 * With `id`, reports just that one id (including `allocated: false` if it's
 * free) with a fuller list of reference sites — "where is switch 23 used?".
 */
export async function listAllocatedIds(
  projectPath: string,
  type: IdNamespace,
  id?: number,
): Promise<AllocationReport | (AllocatedId & { type: IdNamespace; allocated: boolean })> {
  const data = await loadProjectData(projectPath);
  const refs = byId(scanIdUsage(data, type));
  const names = declaredNames(data, type);
  // The general scanner bounds expansion. Allocation must still account for
  // every member of a large write range, without iterating billions of IDs.
  const ranges: Array<{ start: number; end: number; path: string }> = [];
  const scan = (list: unknown, path: string) => {
    if (!Array.isArray(list) || type === 'common_event') return;
    list.forEach((command, index) => {
      const p = command?.parameters;
      if (command?.code !== (type === 'switch' ? 121 : 122) || !Array.isArray(p)) return;
      if (Number.isSafeInteger(p[0]) && Number.isSafeInteger(p[1]) && p[0] > 0 && p[1] >= p[0]) ranges.push({ start: p[0], end: p[1], path: `${path} / command ${index}` });
    });
  };
  for (const map of data.maps) for (const event of map.events ?? []) event?.pages?.forEach((page, pi) => scan(page.list, `map ${map.id} / event ${event.id} / page ${pi}`));
  for (const event of data.commonEvents) if (event) scan(event.list, `common event ${event.id}`);
  for (const troop of data.troops) troop?.pages?.forEach((page, pi) => scan(page.list, `troop ${troop.id} / page ${pi}`));
  const add = (target: number, path: string) => {
    const hits = refs.get(target) ?? [];
    if (!hits.some(hit => hit.path === path)) hits.push({ id: target, path, via: type === 'switch' ? 'Control Switches' : 'Control Variables' });
    refs.set(target, hits);
  };
  for (const range of ranges) {
    if (id !== undefined) { if (id >= range.start && id <= range.end) add(id, range.path); }
    else {
      for (let candidate = range.start; candidate <= Math.min(range.end, MAX_ID); candidate++) add(candidate, range.path);
      add(range.end, range.path);
    }
  }

  const build = (target: number, sample: number): AllocatedId => {
    const hits = refs.get(target) ?? [];
    return {
      id: target,
      name: names.get(target) ?? '',
      declared: names.has(target),
      referenceCount: hits.length,
      referencedBy: hits.slice(0, sample).map(({ path, via }) => ({ path, via })),
    };
  };

  if (id !== undefined) {
    const entry = build(id, REFERENCE_SAMPLE_SINGLE);
    return { type, allocated: entry.declared || entry.referenceCount > 0, ...entry };
  }

  const ids = [...new Set([...names.keys(), ...refs.keys()])].sort((a, b) => a - b);
  const allocated = ids.map((each) => build(each, REFERENCE_SAMPLE));
  const highest = ids.length > 0 ? ids[ids.length - 1] : 0;

  const claimed = new Set(ids);
  const gaps: number[] = [];
  for (let candidate = 1; candidate < highest && candidate <= MAX_ID; candidate++) {
    if (!claimed.has(candidate)) gaps.push(candidate);
  }

  return {
    type,
    count: allocated.length,
    highest,
    gaps,
    declaredCapacity: declaredCapacity(data, type),
    allocated,
    coverage: `${coverageNote(type)} Range membership is checked directly for single-ID queries. Whole ranges are enumerated only up to ${MAX_ID}, retaining their final ID for safe allocation; gap suggestions are bounded to ${MAX_ID}.`,
  };
}

export interface NextFreeIdResult {
  type: IdNamespace;
  ids: number[];
  /** `append` = above every allocated id; `gap-fill` = holes first, then append. */
  strategy: 'append' | 'gap-fill';
  highest: number;
  declaredCapacity?: number;
  warnings: string[];
}

/**
 * Hand back the next unallocated id(s) so a session never picks one by hand.
 *
 * Defaults to **append** — strictly above every id already spoken for. Holes are
 * left alone by default on purpose: a gap is usually an id a *concurrent or
 * recent* session has claimed in its notes but not yet written into the project,
 * and reusing it is exactly the collision this tool exists to prevent. Pass
 * `reuseGaps` when compacting a project deliberately.
 */
export async function nextFreeId(
  projectPath: string,
  type: IdNamespace,
  count = 1,
  reuseGaps = false,
): Promise<NextFreeIdResult> {
  const report = (await listAllocatedIds(projectPath, type)) as AllocationReport;
  const warnings: string[] = [];

  const ids: number[] = [];
  if (reuseGaps) ids.push(...report.gaps.slice(0, count));
  for (let next = report.highest + 1; ids.length < count; next++) {
    if (next > MAX_ID) {
      warnings.push(
        `Stopped at id ${MAX_ID}: the project already allocates ids that high, which usually means corrupt data rather than a real need.`,
      );
      break;
    }
    ids.push(next);
  }

  const capacity = report.declaredCapacity;
  if (capacity !== undefined && ids.some((each) => each > capacity)) {
    const plural = type === 'switch' ? 'switches' : 'variables';
    warnings.push(
      `System.json declares ${capacity} ${plural}. MV ignores writes to IDs beyond that capacity; ` +
        `use set_${type}_name to grow the array before using these IDs in events or runtime commands.`,
    );
  }

  return {
    type,
    ids,
    strategy: reuseGaps ? 'gap-fill' : 'append',
    highest: report.highest,
    declaredCapacity: capacity,
    warnings,
  };
}

const TYPE_DESCRIPTION =
  'Which id namespace: switch, variable, or common_event. Database rows (actors, items, …) are not here — create_*/batch_create assign those ids, and list_names shows what exists.';

export const idToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_allocated_ids',
    description:
      'Show which switch / variable / common-event IDs are already spoken for, derived from the project\'s own JSON (never a hand-maintained list, which would drift the moment someone edited in the RPG Maker editor). An id counts as allocated if it is declared (a System.json label, a CommonEvents row) OR referenced anywhere — event page conditions and command lists, common events, troop pages, and Common Event skill/item effects. Use this before reusing an id, and pass `id` to answer "where is switch 23 actually used?" before touching it. Returns { count, highest, gaps, declaredCapacity, allocated[], coverage }. Read-only. To claim a fresh id instead, use next_free_id.',
    inputSchema: {
      type: z.enum(ID_NAMESPACES).describe(TYPE_DESCRIPTION),
      id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Report just this id — whether it is allocated, its label, and every place it is referenced. Omitted = the whole namespace.',
        ),
    },
    handler: (ctx, args) => listAllocatedIds(ctx.projectPath, args.type, args.id),
  },
  {
    name: 'next_free_id',
    description:
      'Reserve the next unallocated switch / variable / common-event ID(s) instead of picking one by hand. Ids are handed out strictly above every id already declared or referenced, so two sessions editing the same project over time cannot silently claim the same switch — a collision that never crashes and only surfaces hours into a playtest as a door that is inexplicably already open. Pass `reuseGaps: true` to fill holes below the highest id first (off by default: a hole is often an id claimed in notes but not yet written). Read-only — it suggests ids, it does not write them; name what you take with set_switch_name / set_variable_name so the next session sees the claim.',
    inputSchema: {
      type: z.enum(ID_NAMESPACES).describe(TYPE_DESCRIPTION),
      count: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('How many consecutive free ids to return (default 1)'),
      reuseGaps: z
        .boolean()
        .optional()
        .describe('Fill unallocated holes below the highest id first (default false)'),
    },
    handler: (ctx, args) => nextFreeId(ctx.projectPath, args.type, args.count, args.reuseGaps),
  },
];
