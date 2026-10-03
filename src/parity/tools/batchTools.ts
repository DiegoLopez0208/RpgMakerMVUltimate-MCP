import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { commitChange } from '../utils/commit.js';
import { getDataPath } from '../utils/fileHandler.js';
import { ValidationWarning } from '../validation/eventCommands.js';
import { Actor, Armor, Enemy, Item, State, Weapon } from '../utils/types.js';

import { getActors, buildActorRecord, actorToolDefinitions, assertActorRefs } from './actorTools.js';
import {
  itemToolDefinitions,
  getItems,
  getWeapons,
  getArmors,
  buildItemRecord,
  buildWeaponRecord,
  buildArmorRecord,
  assertItemEffectRefs,
} from './itemTools.js';
import {
  getSkills,
  buildSkillRecord,
  assertSkillEffectRefs,
  SkillInput,
  skillToolDefinitions,
} from './skillTools.js';
import {
  battleToolDefinitions,
  getEnemies,
  buildEnemyRecord,
  assertEnemyRefs,
  battlerNameWarnings,
} from './battleTools.js';
import { getStates, buildStateRecord, stateToolDefinitions } from './stateTools.js';
import {
  getClasses,
  buildClassRecord,
  summarizeClass,
  ClassInput,
  classToolDefinitions,
  assertClassRefs,
} from './classTools.js';

/**
 * Entity types `batch_create` can append to. Each maps to one 1-indexed database
 * array (slot 0 null) that the matching single `create_*` tool already owns.
 */
const BATCH_TYPES = [
  'actor',
  'item',
  'weapon',
  'armor',
  'skill',
  'enemy',
  'state',
  'class',
] as const;

type BatchType = (typeof BATCH_TYPES)[number];

/** The single create_* tool whose fields each batch type accepts. */
const CREATE_TOOL: Record<BatchType, string> = {
  actor: 'create_actor',
  item: 'create_item',
  weapon: 'create_weapon',
  armor: 'create_armor',
  skill: 'create_skill',
  enemy: 'create_enemy',
  state: 'create_state',
  class: 'create_class',
};

/**
 * The field names each batch type accepts, read off its create_* tool's input
 * schema so the two can never drift. Resolved lazily — the definition arrays
 * belong to sibling modules.
 */
function createDefinition(type: BatchType): ToolDefinition {
  const defs = [
    ...actorToolDefinitions,
    ...itemToolDefinitions,
    ...skillToolDefinitions,
    ...battleToolDefinitions,
    ...stateToolDefinitions,
    ...classToolDefinitions,
  ];
  const def = defs.find((d) => d.name === CREATE_TOOL[type]);
  if (!def) throw new Error(`No create schema for ${type}`);
  return def;
}

function knownFields(type: BatchType): Set<string> {
  return new Set(Object.keys(createDefinition(type).inputSchema));
}

/**
 * Flag keys a record carries that its create_* tool doesn't accept. A single
 * create_* call has these stripped by schema validation; batch records are a
 * free-form map, so without this a typo or an unsupported field vanished (or was
 * written verbatim) with no hint. Advisory only — never blocks the batch.
 */
function unknownFieldWarnings(
  type: BatchType,
  records: Record<string, unknown>[],
): ValidationWarning[] {
  const known = knownFields(type);
  const warnings: ValidationWarning[] = [];
  for (const [index, record] of records.entries()) {
    const unknown = Object.keys(record).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      warnings.push({
        path: `records[${index}]`,
        message: `Unrecognized field(s) ${unknown.map((k) => `"${k}"`).join(', ')} — not accepted by ${CREATE_TOOL[type]} (check the spelling); they may be ignored or written verbatim.`,
      });
    }
  }
  return warnings;
}

/**
 * How one entity type is batched. Mirrors what its single `create_*` tool does,
 * reusing the same per-record builder / reference check / summarizer so there is
 * exactly one source of truth per type — the only difference is that the whole
 * batch lands in a single write.
 */
interface BatchSpec<T> {
  /** Target database file, e.g. `Actors.json`. */
  file: string;
  load(projectPath: string): Promise<(T | null)[]>;
  /** Build one record against the array as grown so far (allocates the next id). */
  build(existing: (T | null)[], input: Record<string, unknown>): T;
  /** Create-time reference check; throws to reject the whole batch. */
  assertRefs?(projectPath: string, record: T, existing: (T | null)[]): Promise<void>;
  /** Warn-by-default asset checks (never block). */
  warn?(projectPath: string, record: T): Promise<ValidationWarning[]>;
  /** Trim a large record for the response (e.g. a class's param matrix). */
  summarize?(record: T): unknown;
}

interface BatchResult {
  type: BatchType;
  count: number;
  created: unknown[];
  warnings?: ValidationWarning[];
}

/**
 * Append every record in one pass, then write once.
 *
 * Records are pushed onto the in-memory array as they are built, so each record's
 * id allocation (max existing + 1) sees the previous ones — ids come out
 * sequential — and a reference check can resolve a sibling created earlier in the
 * same batch (e.g. a skill whose Learn Skill effect points at the skill before it).
 *
 * A failing record throws with its index and **nothing is written**: the single
 * `commitChange` runs only after every record is built and checked.
 */
async function runBatch<T extends { id: number }>(
  projectPath: string,
  type: BatchType,
  spec: BatchSpec<T>,
  records: Record<string, unknown>[],
): Promise<BatchResult> {
  const existing = await spec.load(projectPath);
  const created: T[] = [];
  // Validate known fields while preserving extension metadata and its warnings.
  const recordSchema = z.object(createDefinition(type).inputSchema).passthrough();
  const warnings: ValidationWarning[] = [];

  for (const [index, input] of records.entries()) {
    let record: T;
    try {
      record = spec.build(existing, recordSchema.parse(input));
      if (spec.assertRefs) {
        await spec.assertRefs(projectPath, record, existing);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`records[${index}]: ${message}`);
    }

    existing[record.id] = record;
    created.push(record);

    if (spec.warn) {
      // Tag each warning with the record that produced it — a batch can emit
      // several and `path` alone ("battlerName") wouldn't say which.
      const recordWarnings = await spec.warn(projectPath, record);
      warnings.push(...recordWarnings.map((w) => ({ ...w, path: `records[${index}].${w.path}` })));
    }
  }

  await commitChange(getDataPath(projectPath, spec.file), existing);

  const out = created.map((record) => (spec.summarize ? spec.summarize(record) : record));
  const result: BatchResult = { type, count: out.length, created: out };
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/** Dispatch a batch to its per-type spec. */
async function batchCreate(
  projectPath: string,
  type: BatchType,
  records: Record<string, unknown>[],
): Promise<BatchResult> {
  switch (type) {
    case 'actor':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Actors.json',
          load: getActors,
          build: (existing, input) =>
            buildActorRecord(existing, input as Partial<Omit<Actor, 'id'>>),
          assertRefs: (path, record) => assertActorRefs(path, record),
        },
        records,
      );

    case 'item':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Items.json',
          load: getItems,
          build: (existing, input) => buildItemRecord(existing, input as Partial<Omit<Item, 'id'>>),
          assertRefs: (path, record) => assertItemEffectRefs(path, record),
        },
        records,
      );

    case 'weapon':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Weapons.json',
          load: getWeapons,
          build: (existing, input) =>
            buildWeaponRecord(existing, input as Partial<Omit<Weapon, 'id'>>),
        },
        records,
      );

    case 'armor':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Armors.json',
          load: getArmors,
          build: (existing, input) =>
            buildArmorRecord(existing, input as Partial<Omit<Armor, 'id'>>),
        },
        records,
      );

    case 'skill':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Skills.json',
          load: getSkills,
          build: (existing, input) => buildSkillRecord(existing, input as unknown as SkillInput),
          assertRefs: (path, record, existing) => assertSkillEffectRefs(path, record, existing),
        },
        records,
      );

    case 'enemy':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Enemies.json',
          load: getEnemies,
          build: (existing, input) =>
            buildEnemyRecord(existing, input as Partial<Omit<Enemy, 'id'>>),
          assertRefs: (path, record) => assertEnemyRefs(path, record),
          warn: (path, record) => battlerNameWarnings(path, record.battlerName),
        },
        records,
      );

    case 'state':
      return runBatch(
        projectPath,
        type,
        {
          file: 'States.json',
          load: getStates,
          build: (existing, input) =>
            buildStateRecord(existing, input as Partial<Omit<State, 'id'>>),
        },
        records,
      );

    case 'class':
      return runBatch(
        projectPath,
        type,
        {
          file: 'Classes.json',
          load: getClasses,
          build: (existing, input) => buildClassRecord(existing, input as unknown as ClassInput),
          assertRefs: (path, record) => assertClassRefs(path, record),
          summarize: summarizeClass,
        },
        records,
      );
  }
}

export const batchToolDefinitions: ToolDefinition[] = [
  {
    name: 'batch_create',
    mutates: true,
    description:
      "Create many database records of one type in a single call and a single file write — the batch sibling of create_actor/create_item/create_weapon/create_armor/create_skill/create_enemy/create_state/create_class. Each entry in `records` takes the same fields its single create_* tool accepts (only `name` is required for most; omitted fields use the editor's defaults). Ids are allocated sequentially from the current max, so a record can reference a sibling created earlier in the same batch. Use this instead of N sequential create_* calls when authoring a cast, a loot table, or a skill list. Returns `{ type, count, created, warnings? }` (classes are summarized like create_class; enemy battlerName misses and record fields the create_* tool doesn't accept are warnings, never blocked). Throws — writing nothing at all — if any record references a database id that does not exist, naming the offending records[i].",
    inputSchema: {
      type: z.enum(BATCH_TYPES).describe('Which database the records are appended to'),
      records: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'The records to create, each shaped like the matching create_* tool\'s arguments (e.g. for type "actor": { name, classId?, ... })',
        ),
    },
    handler: async (ctx, args) => {
      const type = args.type as BatchType;
      const records = args.records as Record<string, unknown>[];
      const result = await batchCreate(ctx.projectPath, type, records);
      const unknown = unknownFieldWarnings(type, records);
      if (unknown.length === 0) return result;
      return { ...result, warnings: [...unknown, ...(result.warnings ?? [])] };
    },
  },
];
