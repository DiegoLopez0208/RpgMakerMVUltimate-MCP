import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { commitChange, commitStore } from '../utils/commit.js';
import { getDataPath, readJsonFile } from '../utils/fileHandler.js';
import {
  checkReferences,
  ProjectData,
  ReferenceWarning,
  refExists,
} from '../validation/references.js';
import { loadProjectData } from './validationTools.js';

/**
 * The database tables a record can be deleted from, keyed by the singular type
 * name `batch_create` uses. Each is a 1-indexed array (slot 0 `null`, index ===
 * id); `key` is its slice of the {@link ProjectData} snapshot the reference
 * linter reads.
 */
const RECORD_TABLES = {
  actor: { file: 'Actors.json', key: 'actors' },
  class: { file: 'Classes.json', key: 'classes' },
  skill: { file: 'Skills.json', key: 'skills' },
  item: { file: 'Items.json', key: 'items' },
  weapon: { file: 'Weapons.json', key: 'weapons' },
  armor: { file: 'Armors.json', key: 'armors' },
  enemy: { file: 'Enemies.json', key: 'enemies' },
  troop: { file: 'Troops.json', key: 'troops' },
  state: { file: 'States.json', key: 'states' },
  common_event: { file: 'CommonEvents.json', key: 'commonEvents' },
} as const satisfies Record<string, { file: string; key: keyof ProjectData }>;

export type RecordType = keyof typeof RECORD_TABLES;

const RECORD_TYPES = Object.keys(RECORD_TABLES) as [RecordType, ...RecordType[]];

/**
 * Ids the engine itself hard-codes, so removing them breaks the game even when
 * no data file names them: every battler's plain Attack is skill 1
 * (`Game_BattlerBase.attackSkillId`), Guard is skill 2 (`guardSkillId`), and
 * state 1 is the Knockout state (`deathStateId`).
 */
const ENGINE_RESERVED: Partial<Record<RecordType, Record<number, string>>> = {
  skill: {
    1: "the engine uses skill 1 as every battler's Attack command (attackSkillId)",
    2: 'the engine uses skill 2 as the Guard command (guardSkillId)',
  },
  state: { 1: 'the engine uses state 1 as the Knockout/death state (deathStateId)' },
};

/** What the dangling-reference report sees — stated in every response, like list_allocated_ids' coverage. */
const COVERAGE =
  'References are what validate_references would newly report after the removal: actor classes, class learnings, enemy actions and drops, troop members, map random encounters, the starting party, skill/item effects, and the event commands Common Event, Change Items/Weapons/Armors, Change Party Member, Battle Processing, Shop Processing and Change State/Skill; plus the engine-reserved skills 1-2 and state 1. Not scanned: traits, actor starting equipment, event page conditions, Conditional Branch operands, Script/plugin commands and note tags.';

/** How many references a refusal error spells out before summarizing the rest. */
const ERROR_SAMPLE = 10;
/** How many references / removed records a response lists in full. */
const RESPONSE_SAMPLE = 100;

const keyOf = (w: ReferenceWarning): string => `${w.category}|${w.path}|${w.message}`;

/**
 * The references that removing `ids` from `type`'s table would leave dangling.
 *
 * Pure. Rather than keep a second map of "who points at what", it runs the same
 * {@link checkReferences} audit `validate_references` uses twice — on the
 * snapshot as-is and with the slots nulled — and returns only the findings the
 * removal introduces, so references that were already broken aren't blamed on
 * this deletion and the removed records' own outgoing references drop out.
 * Engine-reserved ids ({@link ENGINE_RESERVED}) are appended as `engine`
 * findings.
 */
export function danglingAfterRemoval(
  data: ProjectData,
  type: RecordType,
  ids: readonly number[],
): ReferenceWarning[] {
  const { key } = RECORD_TABLES[type];
  const before = new Set(checkReferences(data).map(keyOf));

  const table = (data[key] as readonly unknown[]).slice();
  for (const id of ids) table[id] = null;
  const after = checkReferences({ ...data, [key]: table } as ProjectData);

  const introduced = after.filter((w) => !before.has(keyOf(w)));
  const reserved = ENGINE_RESERVED[type] ?? {};
  for (const id of ids) {
    const why = reserved[id];
    if (why) introduced.push({ category: 'engine', path: `${type} ${id}`, message: why });
  }
  return introduced;
}

/** Whether the current tool call is a dry-run preview (see `commitStore`). */
function isDryRun(): boolean {
  return commitStore.getStore()?.dryRun === true;
}

/**
 * Throw when a removal would leave references dangling and the caller didn't
 * pass `force`. A dry-run never throws here: previewing what a forced removal
 * would break is the point of the preview, so it reports `requiresForce`
 * instead.
 */
function assertNoDangling(
  what: string,
  references: ReferenceWarning[],
  force: boolean | undefined,
): void {
  if (references.length === 0 || force || isDryRun()) return;
  const listed = references
    .slice(0, ERROR_SAMPLE)
    .map((w) => `  - ${w.path}: ${w.message}`)
    .join('\n');
  const more =
    references.length > ERROR_SAMPLE ? `\n  …and ${references.length - ERROR_SAMPLE} more` : '';
  throw new Error(
    `Refusing to ${what}: ${references.length} reference(s) would be left dangling:\n${listed}${more}\n` +
      'Pass force: true to remove anyway (the references will point at nothing), or dryRun: true to preview.',
  );
}

interface NamedRecord {
  id: number;
  name?: string;
}

/** Read a table strictly — unlike the fail-soft audit load, a missing target file is an error. */
async function readTable(projectPath: string, type: RecordType): Promise<(NamedRecord | null)[]> {
  const table = await readJsonFile<(NamedRecord | null)[]>(
    getDataPath(projectPath, RECORD_TABLES[type].file),
  );
  if (!Array.isArray(table)) {
    throw new Error(`${RECORD_TABLES[type].file} is not a database array`);
  }
  return table;
}

/** Load the audit snapshot with the (strictly read) target table swapped in. */
async function snapshotWith(
  projectPath: string,
  type: RecordType,
  table: (NamedRecord | null)[],
): Promise<ProjectData> {
  const data = await loadProjectData(projectPath);
  return { ...data, [RECORD_TABLES[type].key]: table } as ProjectData;
}

/** The reference half of a response: a capped list plus the true count. */
function referenceReport(references: ReferenceWarning[], force: boolean | undefined) {
  return {
    referenceCount: references.length,
    references: references.slice(0, RESPONSE_SAMPLE),
    ...(references.length > RESPONSE_SAMPLE ? { referencesTruncated: true } : {}),
    ...(references.length > 0 && !force ? { requiresForce: true } : {}),
    coverage: COVERAGE,
  };
}

export interface DeleteRecordResult {
  type: RecordType;
  deleted: { id: number; name: string };
  referenceCount: number;
  references: ReferenceWarning[];
  referencesTruncated?: boolean;
  /** Set when references exist and `force` wasn't passed — only reachable in a dry-run. */
  requiresForce?: boolean;
  coverage: string;
}

/**
 * Delete one database record by nulling its slot. The arrays are index === id,
 * so splicing would renumber every later record and silently repoint every
 * reference to them; a `null` slot is what the engine and the create_* tools
 * already treat as "no record" (new ids still allocate from the highest live id).
 *
 * Refuses (throws, writing nothing) when the deletion would leave references
 * dangling, unless `force` is set.
 */
export async function deleteRecord(
  projectPath: string,
  type: RecordType,
  id: number,
  force?: boolean,
): Promise<DeleteRecordResult> {
  const table = await readTable(projectPath, type);
  if (!refExists(table, id)) {
    throw new Error(`${type} ${id} does not exist in ${RECORD_TABLES[type].file}`);
  }
  const name = table[id]?.name ?? '';

  const references = danglingAfterRemoval(await snapshotWith(projectPath, type, table), type, [id]);
  assertNoDangling(`delete ${type} ${id} (${name})`, references, force);

  const next = table.slice();
  next[id] = null;
  await commitChange(getDataPath(projectPath, RECORD_TABLES[type].file), next);

  return { type, deleted: { id, name }, ...referenceReport(references, force) };
}

export interface ResetTableResult {
  type: RecordType;
  kept: Array<{ id: number; name: string }>;
  removedCount: number;
  removed: Array<{ id: number; name: string }>;
  removedTruncated?: boolean;
  referenceCount: number;
  references: ReferenceWarning[];
  referencesTruncated?: boolean;
  requiresForce?: boolean;
  coverage: string;
}

/**
 * Clear a whole database table down to the `keep`ed ids — the "wipe the RTP
 * rows, then author my own" step. Kept records stay at their own index (ids
 * never move), everything else becomes `null`, and trailing empty slots are
 * trimmed so the file ends at the highest kept id (`[null]` when nothing is
 * kept). Refuses when the removal would leave references dangling, unless
 * `force` is set; a dry-run lists what would disappear and what would break.
 */
export async function resetTable(
  projectPath: string,
  type: RecordType,
  keep: readonly number[] = [],
  force?: boolean,
): Promise<ResetTableResult> {
  const table = await readTable(projectPath, type);
  const keepSet = new Set(keep);
  const missing = [...keepSet].filter((id) => !refExists(table, id));
  if (missing.length > 0) {
    throw new Error(
      `keep names ${type} id(s) ${missing.join(', ')}, which do not exist in ${RECORD_TABLES[type].file}`,
    );
  }

  const label = (record: NamedRecord) => ({ id: record.id, name: record.name ?? '' });
  const live = table
    .map((record, index) => (record != null && index > 0 ? { index, record } : null))
    .filter((entry): entry is { index: number; record: NamedRecord } => entry != null);
  const removed = live.filter(({ index }) => !keepSet.has(index));
  const kept = live.filter(({ index }) => keepSet.has(index));

  const references = danglingAfterRemoval(
    await snapshotWith(projectPath, type, table),
    type,
    removed.map(({ index }) => index),
  );
  assertNoDangling(
    `reset ${RECORD_TABLES[type].file} (${removed.length} record(s) removed)`,
    references,
    force,
  );

  const highestKept = kept.reduce((max, { index }) => Math.max(max, index), 0);
  const next: (NamedRecord | null)[] = new Array(highestKept + 1).fill(null);
  for (const { index, record } of kept) next[index] = record;
  await commitChange(getDataPath(projectPath, RECORD_TABLES[type].file), next);

  return {
    type,
    kept: kept.map(({ record }) => label(record)),
    removedCount: removed.length,
    removed: removed.slice(0, RESPONSE_SAMPLE).map(({ record }) => label(record)),
    ...(removed.length > RESPONSE_SAMPLE ? { removedTruncated: true } : {}),
    ...referenceReport(references, force),
  };
}

const typeSchema = z
  .enum(RECORD_TYPES)
  .describe(
    'Which database table: actor, class, skill, item, weapon, armor, enemy, troop, state, or common_event',
  );

export const recordToolDefinitions: ToolDefinition[] = [
  {
    name: 'delete_record',
    mutates: true,
    forceable: true,
    description:
      "Delete one database record (actor, class, skill, item, weapon, armor, enemy, troop, state, or common_event) by nulling its slot — ids never shift, so nothing else is renumbered. Reports every reference the deletion would leave dangling (an actor's class, a troop member, a Change Items / Shop / Battle Processing command, a skill effect, the starting party, …; found with the same audit validate_references runs, see `coverage` in the response) and REFUSES, writing nothing, when there are any — pass force: true to delete anyway, or dryRun: true to preview the references without throwing. Deleting skill 1 (Attack), skill 2 (Guard) or state 1 (Knockout) is always reported, since the engine hard-codes them. Returns { type, deleted: { id, name }, referenceCount, references[], coverage }.",
    inputSchema: {
      type: typeSchema,
      id: z.number().int().positive().describe('The id of the record to delete'),
    },
    handler: (ctx, args) => deleteRecord(ctx.projectPath, args.type, args.id, args.force),
  },
  {
    name: 'reset_table',
    mutates: true,
    forceable: true,
    description:
      "Clear a whole database table (actor, class, skill, item, weapon, armor, enemy, troop, state, or common_event) except the ids in `keep` — e.g. reset_table('skill', { keep: [1, 2] }) wipes the RTP skills but keeps Attack/Guard, the usual first step before authoring your own database with batch_create. Kept records stay at their own id; the rest become null and trailing empty slots are trimmed (the table is [null] when nothing is kept). Like delete_record it REFUSES, writing nothing, when the removal would leave references dangling (map events giving removed items, troops of removed enemies, …) unless force: true; use dryRun: true first to see what disappears and what would break. Returns { type, kept[], removedCount, removed[], referenceCount, references[], coverage } (lists are capped at 100).",
    inputSchema: {
      type: typeSchema,
      keep: z
        .array(z.number().int().positive())
        .optional()
        .describe('Ids to keep (each must exist); omitted = remove every record'),
    },
    handler: (ctx, args) => resetTable(ctx.projectPath, args.type, args.keep, args.force),
  },
];
