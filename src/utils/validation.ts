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

export const RenderMapAsciiSchema = z.object({
  map_id: intCoerce.min(1),
  layer: intCoerce.min(0).max(5).default(0),
  show_events: z.boolean().default(true),
  show_regions: z.boolean().default(false),
});
