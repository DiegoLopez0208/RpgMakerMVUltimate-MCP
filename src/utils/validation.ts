import { z } from "zod";

export const CreateActorSchema = z.object({
  name: z.string().min(1).max(100),
  nickname: z.string().optional(),
  class_id: z.number().int().min(1),
  initial_level: z.number().int().min(1).max(99).default(1),
  max_level: z.number().int().min(1).max(99).default(99),
  character_name: z.string().default(""),
  character_index: z.number().int().min(0).max(7).default(0),
  face_name: z.string().default(""),
  face_index: z.number().int().min(0).max(7).default(0),
});

export const CreateMapSchema = z.object({
  name: z.string().min(1).max(100),
  width: z.number().int().min(5).max(200).default(25),
  height: z.number().int().min(5).max(200).default(20),
  tileset_id: z.number().int().min(1).default(1),
  theme: z.string().optional(),
  template_id: z.number().int().min(1).optional(),
  display_name: z.string().max(100).optional(),
  seed: z.number().int().optional(),
  scroll_type: z.number().int().min(0).max(3).default(0),
});

export const CreateNpcSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  name: z.string().min(1).max(100),
  dialogues: z.array(z.string()).default([]),
  character_name: z.string().default(""),
  character_index: z.number().int().min(0).max(7).default(0),
  trigger: z.number().int().min(0).max(4).default(0),
});

export const CreateChestSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  items: z.array(z.object({
    type: z.enum(["item", "weapon", "armor"]),
    id: z.number().int().min(1),
    quantity: z.number().int().min(1).default(1),
  })).default([]),
  character_name: z.string().default("Chest"),
  character_index: z.number().int().min(0).max(7).default(0),
});

export const CreateShopSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  name: z.string().min(1).max(100),
  item_ids: z.array(z.number().int().min(1)).default([]),
  weapon_ids: z.array(z.number().int().min(1)).default([]),
  armor_ids: z.array(z.number().int().min(1)).default([]),
  character_name: z.string().default(""),
  character_index: z.number().int().min(0).max(7).default(0),
});

export const CreateInnSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  name: z.string().min(1).max(100),
  cost: z.number().int().min(0).default(10),
  character_name: z.string().default(""),
  character_index: z.number().int().min(0).max(7).default(0),
});

export const CreateBossSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  troop_id: z.number().int().min(1).default(1),
  trigger: z.number().int().min(0).max(4).default(0),
});

export const CreatePuzzleSwitchSchema = z.object({
  map_id: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  switch_id: z.number().int().min(1),
  name: z.string().min(1).max(100).optional(),
  trigger: z.number().int().min(0).max(4).default(0),
});

export const CreateSkillSchema = z.object({
  name: z.string().min(1).max(100),
  mp_cost: z.number().int().min(0).default(0),
  tp_cost: z.number().int().min(0).default(0),
  scope: z.number().int().min(0).max(11).default(1),
  occasion: z.number().int().min(0).max(3).default(0),
  damage_type: z.number().int().min(0).max(6).default(0),
  damage_element: z.number().int().min(-1).default(0),
  damage_formula: z.string().default("a.atk * 4 - b.def * 2"),
  damage_variance: z.number().int().min(0).max(100).default(20),
  animation_id: z.number().int().min(0).default(0),
  description: z.string().default(""),
  note: z.string().default(""),
});

export const TilesetScanSchema = z.object({
  tileset_id: z.number().int().min(1),
});

export const AnalyzeScreenshotSchema = z.object({
  image_path: z.string().min(1).refine(
    (p: string) => !p.includes(".."),
    { message: "Path traversal not allowed" }
  ),
  prompt: z.string().optional(),
  resize_max: z.number().int().min(64).max(2048).default(1024),
});

export const RenderMapAsciiSchema = z.object({
  map_id: z.number().int().min(1),
  layer: z.number().int().min(0).max(4).default(0),
  show_events: z.boolean().default(true),
  show_regions: z.boolean().default(false),
});

export const GetByIdSchema = z.object({
  id: z.number().int().min(1),
});

export const UpdateByIdSchema = z.object({
  id: z.number().int().min(1),
  fields: z.record(z.unknown()),
});

export const SearchSchema = z.object({
  query: z.string().min(1),
});

export const CreateTransferSchema = z.object({
  source_map_id: z.number().int().min(1),
  source_x: z.number().int().min(0),
  source_y: z.number().int().min(0),
  dest_map_id: z.number().int().min(1),
  dest_x: z.number().int().min(0),
  dest_y: z.number().int().min(0),
  trigger: z.number().int().min(0).max(4).default(1),
});
