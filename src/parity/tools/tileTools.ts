import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { decodeTile } from '../tiles/tileCodec.js';
import { getTileset } from './tilesetTools.js';
import { tileTransparencyDetail } from './tileTransparency.js';

/**
 * Read-only tools over the tile-id codec. `describe_tile` turns an opaque raw
 * tile integer into a legible {sheet, kind, shape, autotile geometry} view —
 * the inspection counterpart to the low-level `set_map_tile` primitive, and the
 * foothold for the semantic catalog and paint commands that follow.
 */
export const tileToolDefinitions: ToolDefinition[] = [
  {
    name: 'describe_tile',
    description:
      'Decode a raw RPG Maker MV tile id into its tileset sheet (A1–A5, B–E), and for autotiles its kind + shape slot (0–47) and autotile geometry (floor/wall/waterfall). Read-only inspection helper — raw tile ids are opaque integers, this makes one legible. Returns { tileId, empty, sheet, sheetIndex, autotile, kind?, shape?, autotileType? }. Pass `tilesetId` to also inspect the sheet PNG and report `transparent` (true = the tile is see-through and needs an opaque base tile on a lower layer; painting it on layer 0 alone shows the map void) + `transparentPercent`.',
    inputSchema: {
      tileId: z.number().int().nonnegative().max(8191).describe('The raw tile id to decode'),
      tilesetId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tileset id — when given, also report the tile transparency (needs-a-base) flag'),
    },
    handler: async (ctx, args) => {
      const decoded = decodeTile(args.tileId);
      if (args.tilesetId === undefined) return decoded;
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const detail = await tileTransparencyDetail(ctx.projectPath, tileset, args.tileId);
      return detail ? { ...decoded, ...detail } : decoded;
    },
  },
];
