import { z } from "zod";

/**
 * Zod schemas applied to tool arguments in server.ts (SCHEMA_MAP).
 *
 * IMPORTANT: keys here MUST match the camelCase property names declared in
 * toolDefinitions.ts. Zod strips unknown keys on parse, so a mismatched key
 * silently drops the argument before it reaches the handler (this exact bug
 * shipped in <= 4.1.0 with snake_case keys).
 *
 * Numeric fields use z.coerce.number() because the tool schemas accept both
 * numbers and numeric strings; coercion guarantees real numbers are stored
 * in the project JSON files.
 */

const intCoerce = z.coerce.number().int();
const numCoerce = z.coerce.number();

export const CreateMapSchema = z.object({
  name: z.string().max(100).optional(),
  width: intCoerce.min(5).max(200).default(17),
  height: intCoerce.min(5).max(200).default(13),
  tilesetId: intCoerce.min(1).default(1),
  bgmName: z.string().optional(),
  displayName: z.string().max(100).optional(),
  note: z.string().optional(),
  theme: z.enum(["forest", "dungeon", "town", "castle", "cave", "village", "swamp", "desert", "ruins", "interior", "beach", "snow", "harbor", "volcano", "sewer", "fortress", "magic_forest", "magic_interior", "space_interior", "space_exterior", "world"]).optional(),
});

export const CreateNpcSchema = z.object({
  mapId: intCoerce.min(1),
  x: intCoerce.min(0),
  y: intCoerce.min(0),
  name: z.string().min(1).max(100),
  dialogues: z.array(z.string()),
  characterName: z.string().optional(),
  characterIndex: intCoerce.min(0).max(7).optional(),
});

export const CreateDamageSkillSchema = z.object({
  name: z.string().min(1).max(100),
  mpCost: intCoerce.min(0),
  scope: intCoerce.min(0).max(11),
  formula: z.string().min(1),
  element: intCoerce.min(-1).optional(),
  animationId: intCoerce.min(0).optional(),
});

export const CreateHealingSkillSchema = z.object({
  name: z.string().min(1).max(100),
  mpCost: intCoerce.min(0),
  scope: intCoerce.min(0).max(11),
  formula: z.string().min(1),
  animationId: intCoerce.min(0).optional(),
});

export const CreateBuffSkillSchema = z.object({
  name: z.string().min(1).max(100),
  mpCost: intCoerce.min(0),
  scope: intCoerce.min(0).max(11),
  paramId: intCoerce.min(0).max(7),
  turns: intCoerce.min(1),
});

export const CreateStateSkillSchema = z.object({
  name: z.string().min(1).max(100),
  mpCost: intCoerce.min(0),
  scope: intCoerce.min(0).max(11),
  stateId: intCoerce.min(1),
  chance: numCoerce.min(0).max(1),
});

export const AnalyzeScreenshotSchema = z.object({
  image_path: z.string().min(1).refine(
    (p: string) => !p.includes(".."),
    { message: "Path traversal not allowed" }
  ),
  prompt: z.string().optional(),
  resize_max: intCoerce.min(64).max(2048).default(1024),
});

/**
 * ─── Consolidated-tool input schemas (Phase 1b) ───
 *
 * These validate the 13 verb-oriented tools at the router boundary, BEFORE they
 * expand into legacy calls. Goals:
 *  - reject clearly-malformed structural input early with a readable message
 *    (event commands, damage/effects, params, troop members, encounters);
 *  - never drop or transform data: every object is .passthrough() and the
 *    caller keeps the ORIGINAL args after validation, so downstream handlers
 *    still receive every field and do their own numeric coercion.
 * Only mutating tools are covered; read-only tools already fail safely.
 */

// An ID accepted as a number or a numeric string (handlers coerce later).
const idLike = z.union([z.number(), z.string()]);

// RPG Maker MV effect codes (Game_Action.EFFECT_*), the authoritative fixed set.
const EFFECT_CODES = new Set([11, 12, 13, 21, 22, 31, 32, 33, 34, 41, 42, 43, 44]);
// Trait codes (Game_BattlerBase.TRAIT_*), fixed set shared by actors/classes/enemies/equips/states.
const TRAIT_CODES = new Set([11, 12, 13, 14, 21, 22, 23, 31, 32, 33, 34, 41, 42, 43, 44, 51, 52, 53, 54, 55, 61, 62, 63, 64]);

const eventCommandSchema = z.object({
  code: z.number().int("command code must be an integer"),
  indent: z.number().int().optional(),
  parameters: z.array(z.unknown()).optional(),
}).passthrough();

const effectSchema = z.object({
  code: z.number().int().refine((c) => EFFECT_CODES.has(c), {
    message: "unknown effect code (valid: 11-13,21-22,31-34,41-44)",
  }),
  dataId: z.number().int().optional(),
  value1: z.number().optional(),
  value2: z.number().optional(),
}).passthrough();

const traitSchema = z.object({
  code: z.number().int().refine((c) => TRAIT_CODES.has(c), {
    message: "unknown trait code",
  }),
  dataId: z.number().int().optional(),
  value: z.number().optional(),
}).passthrough();

const damageSchema = z.object({
  type: z.number().int().min(0).max(6), // 0 none,1 HP dmg,2 MP dmg,3 HP rec,4 MP rec,5 HP drain,6 MP drain
  elementId: z.number().int().optional(),
  formula: z.string().optional(),
  variance: z.number().optional(),
  critical: z.boolean().optional(),
}).passthrough();

const dbEntryDataSchema = z.object({
  name: z.string().optional(),
  effects: z.array(effectSchema).optional(),
  traits: z.array(traitSchema).optional(),
  damage: damageSchema.optional(),
  params: z.array(z.unknown()).optional(),
  members: z.array(z.object({ enemyId: idLike }).passthrough()).optional(),
  list: z.array(eventCommandSchema).optional(),
}).passthrough();

// Every real MV database. Which verb supports which entity is the router's job
// (it emits a specific "not supported" message); here we only reject non-databases.
const dbEntityEnum = z.enum([
  "actors", "classes", "skills", "items", "weapons", "armors",
  "enemies", "states", "troops", "tilesets", "common_events", "animations",
]);

const CreateDatabaseEntrySchema = z.object({
  entity: dbEntityEnum.optional(),
  preset: z.enum(["damage_skill", "healing_skill", "buff_skill", "state_skill", "boss_enemy", "encounter_troop"]).optional(),
  data: dbEntryDataSchema.optional(),
}).passthrough().refine((a) => a.preset !== undefined || a.entity !== undefined, {
  message: "create_database_entry needs either `entity` or `preset`",
});

const UpdateDatabaseEntrySchema = z.object({
  entity: dbEntityEnum,
  id: idLike,
  fields: z.record(z.unknown()).optional(),
  appendCommand: eventCommandSchema.optional(),
  addEnemyId: idLike.optional(),
}).passthrough();

const DeleteDatabaseEntrySchema = z.object({
  entity: dbEntityEnum,
  id: idLike,
}).passthrough();

const GenerateMapSchema = z.object({
  mode: z.enum(["blank", "themed", "procedural", "batch", "duplicate", "template"]).optional(),
  width: idLike.optional(),
  height: idLike.optional(),
  tilesetId: idLike.optional(),
  theme: z.string().optional(),
  seed: idLike.optional(),
  batch: z.array(z.record(z.unknown())).optional(),
  sourceMapId: idLike.optional(),
  templateId: idLike.optional(),
}).passthrough();

const encounterSchema = z.object({
  troopId: idLike,
  weight: z.number().optional(),
  regionSet: z.array(z.number().int()).optional(),
}).passthrough();

const EditMapSchema = z.object({
  action: z.enum(["fill_layer", "fill_rect", "set_tile", "replace_tile", "set_display_names", "organize_tree", "connect", "set_encounters"]),
  layer: idLike.optional(),
  tileId: idLike.optional(),
  names: z.array(z.record(z.unknown())).optional(),
  folders: z.array(z.record(z.unknown())).optional(),
  encounters: z.array(encounterSchema).optional(),
  encounterStep: idLike.optional(),
}).passthrough().superRefine((a, ctx) => {
  // fill_layer / fill_rect / set_tile write into a specific layer index 0-5.
  if (a.layer !== undefined && ["fill_layer", "fill_rect", "set_tile"].includes(a.action)) {
    const n = Number(a.layer);
    if (!Number.isInteger(n) || n < 0 || n > 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layer"], message: "layer must be an integer 0-5" });
    }
  }
});

const ManageMapEventSchema = z.object({
  action: z.enum(["create", "update", "convert", "delete", "add_command", "populate"]),
  kind: z.enum(["merchant", "inn", "sign"]).optional(),
  preset: z.enum(["npc", "chest", "teleport", "door", "shop", "inn", "boss", "puzzle_switch"]).optional(),
  mapId: idLike,
  eventId: idLike.optional(),
  fields: z.record(z.unknown()).optional(),
  trigger: idLike.optional(),
  pages: z.array(z.record(z.unknown())).optional(),
  command: eventCommandSchema.optional(),
  dialogues: z.array(z.string()).optional(),
  eventType: z.enum(["npc", "chest", "boss"]).optional(),
}).passthrough().superRefine((a, ctx) => {
  if (a.trigger !== undefined) {
    const n = Number(a.trigger);
    if (!Number.isInteger(n) || n < 0 || n > 4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: "trigger must be 0-4 (0 action,1 player touch,2 event touch,3 autorun,4 parallel)" });
    }
  }
});

const ManageSystemSchema = z.object({
  action: z.enum(["get", "set_title", "name_switch", "name_variable", "set_starting_position", "create_plugin", "scaffold_project", "playtest", "open_editor"]),
  section: z.enum(["full", "switches", "variables", "title"]).optional(),
  title: z.string().optional(),
  id: idLike.optional(),
  name: z.string().optional(),
  mapId: idLike.optional(),
  x: idLike.optional(),
  y: idLike.optional(),
  // create_plugin
  description: z.string().optional(),
  author: z.string().optional(),
  help: z.string().optional(),
  params: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  commands: z.array(z.string()).optional(),
  body: z.string().optional(),
  status: z.boolean().optional(),
  // scaffold_project
  destPath: z.string().optional(),
  sourcePath: z.string().optional(),
  // playtest / open_editor
  install: z.string().optional(),
  test: z.boolean().optional(),
}).passthrough().superRefine((a, ctx) => {
  if (a.action === "create_plugin") {
    if (typeof a.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(a.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "create_plugin needs a `name` of letters/digits/_/- (no path separators or extension)" });
    }
  }
  if (a.action === "scaffold_project" && (typeof a.destPath !== "string" || a.destPath.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destPath"], message: "scaffold_project needs a `destPath` (the new project directory)" });
  }
});

/**
 * Schemas keyed by consolidated tool name. A tool absent here is not validated
 * at this layer (read-only tools, plugin toggles). Values expose Zod's safeParse.
 */
export const CONSOLIDATED_SCHEMAS: Record<string, { safeParse: (a: unknown) => { success: boolean; error?: unknown } }> = {
  create_database_entry: CreateDatabaseEntrySchema,
  update_database_entry: UpdateDatabaseEntrySchema,
  delete_database_entry: DeleteDatabaseEntrySchema,
  generate_map: GenerateMapSchema,
  edit_map: EditMapSchema,
  manage_map_event: ManageMapEventSchema,
  manage_system: ManageSystemSchema,
};

/**
 * Validate consolidated-tool args at the router boundary. Throws a readable
 * "Validation error: ..." on failure; returns nothing on success. The caller
 * keeps its original args (this only checks, it never rewrites them).
 */
export function validateConsolidated(name: string, args: unknown): void {
  const schema = CONSOLIDATED_SCHEMAS[name];
  if (!schema) return;
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const err = parsed.error as { issues: { path: (string | number)[]; message: string }[] };
    throw new Error("Validation error: " + err.issues.map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; "));
  }
}

export const RenderMapAsciiSchema = z.object({
  map_id: intCoerce.min(1),
  layer: intCoerce.min(0).max(5).default(0),
  show_events: z.boolean().default(true),
  show_regions: z.boolean().default(false),
});
