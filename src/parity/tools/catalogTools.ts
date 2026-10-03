import { join } from 'path';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getDataPath, readJsonFile, listFiles, fileExists } from '../utils/fileHandler.js';
import { Tileset } from '../utils/types.js';
import {
  catalogForTileset,
  findTiles,
  hasCatalog,
  validSheetName,
  parseTileSidecar,
  mergeSheetOverlay,
  CatalogOverlay,
  OverlayTile,
} from '../tiles/catalog/index.js';
import { MV_TILE_CATALOGS } from '../tiles/catalog/mv.js';
import { annotateTransparency } from './tileTransparency.js';

/** Load one tileset from the project's data/Tilesets.json (1-indexed, slot 0 null). */
async function getTileset(projectPath: string, tilesetId: number): Promise<Tileset> {
  const tilesets = await readJsonFile<(Tileset | null)[]>(
    getDataPath(projectPath, 'Tilesets.json'),
  );
  const tileset = tilesets[tilesetId];
  if (!tileset) {
    throw new Error(`Tileset ${tilesetId} not found`);
  }
  return tileset;
}

/** The on-disk shape of a project catalog file (written by the custom-catalog bootstrap skill). */
interface ProjectCatalogFile {
  sheet: string;
  entries: Record<
    string,
    { name: string; description?: string; confidence?: string; manual?: boolean }
  >;
}

/**
 * Load project-scoped tile catalogs from `data/tilecatalog/*.json` (written by the
 * custom-catalog vision-bootstrap skill) into an overlay keyed by sheet filename. Each file's
 * `entries` (local index → { name, description?, confidence?, manual? }) becomes a
 * tiles-by-index array, carrying through the draft metadata so the tools can
 * surface it. A missing directory or an unreadable file yields no overlay for that
 * sheet — the catalog gracefully falls back to built-in names. Returns `undefined`
 * when there are no project catalogs at all (so callers pass nothing to the pure
 * resolver).
 */
async function loadProjectCatalogs(projectPath: string): Promise<CatalogOverlay | undefined> {
  const dir = join(projectPath, 'data', 'tilecatalog');
  if (!(await fileExists(dir))) return undefined;
  let files: string[];
  try {
    files = await listFiles(dir, '.json');
  } catch {
    return undefined;
  }
  const overlay: CatalogOverlay = {};
  for (const file of files) {
    try {
      const data = await readJsonFile<ProjectCatalogFile>(join(dir, file));
      if (typeof data.sheet !== 'string' || !validSheetName(data.sheet) || !data.entries) continue;
      // Sparse array keyed by local index — forEach in the resolver skips the
      // holes, so gaps don't need filling and index alignment is preserved.
      const tiles: (OverlayTile | undefined)[] = [];
      for (const [idx, entry] of Object.entries(data.entries)) {
        const i = Number(idx);
        if (Number.isInteger(i) && i >= 0 && i < 256 && typeof entry?.name === 'string' && entry.name) {
          tiles[i] = {
            name: entry.name,
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            ...(typeof entry.confidence === 'string' && ['high', 'medium', 'low'].includes(entry.confidence) ? { confidence: entry.confidence } : {}),
            ...(typeof entry.manual === 'boolean' ? { manual: entry.manual } : {}),
          };
        }
      }
      overlay[data.sheet] = tiles;
    } catch {
      // Skip a malformed catalog file rather than failing the whole lookup.
      continue;
    }
  }
  return Object.keys(overlay).length ? overlay : undefined;
}

/**
 * Read a sheet's `img/tilesets/<Sheet>.txt` name sidecar, if present. RPG Maker
 * ships one per default sheet (the built-in catalogs were generated from them)
 * and commercial DLC packs ship the same format next to their own sheets, so a
 * renamed/DLC sheet can be named authoritatively without the vision skill.
 * Missing/unreadable → `undefined`.
 */
async function loadSidecar(
  projectPath: string,
  sheet: string,
): Promise<(string | undefined)[] | undefined> {
  try {
    const text = await readFile(join(projectPath, 'img', 'tilesets', `${sheet}.txt`), 'utf-8');
    const names = parseTileSidecar(text);
    return names.length ? names : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve project metadata, DLC sidecars and verified MV defaults per tile.
 * Human-verified project labels outrank sidecars/defaults, which outrank drafts.
 * A built-in catalog requires a matching PNG SHA256, including renamed sheets;
 * a familiar filename alone never labels a custom or MZ sheet as an MV default.
 */
export async function loadCatalogOverlay(
  projectPath: string,
  tilesetNames: string[],
): Promise<CatalogOverlay | undefined> {
  const project = await loadProjectCatalogs(projectPath);
  const overlay: CatalogOverlay = {};
  const sheets = [...new Set(tilesetNames.filter(Boolean))];
  for (const sheet of sheets) {
    // An explicit empty overlay suppresses a built-in whose identity cannot be
    // verified. Reused filenames alone never establish an MV asset's identity.
    overlay[sheet] = [];
    if (!validSheetName(sheet)) continue;
    const sidecar = await loadSidecar(projectPath, sheet);
    if (sidecar) {
      overlay[sheet] = mergeSheetOverlay(sidecar, project?.[sheet]);
      continue;
    }
    let builtin: string[] | undefined;
    try {
      const bytes = await readFile(join(projectPath, 'img', 'tilesets', `${sheet}.png`));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      builtin = Object.values(MV_TILE_CATALOGS).find(catalog => catalog.sha256 === sha256)?.names;
    } catch { /* Missing/unreadable/custom image: only explicit project names apply. */ }
    overlay[sheet] = mergeSheetOverlay(builtin, project?.[sheet]).map(tile =>
      tile?.source === 'sidecar' ? { ...tile, source: 'builtin' } : tile,
    );
  }
  return Object.keys(overlay).length ? overlay : undefined;
}

export const catalogToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_tile_catalog',
    description:
      "Get the semantic tile catalog for a tileset: the named tiles (e.g. 'Grassland A', 'Forest', 'Sea') in each of its image sheets, each with its representative tile id and a `source` ('builtin' = verified MV default labels (PNG SHA256 match); 'sidecar' = authoritative names from an img/tilesets/<Sheet>.txt file shipped next to a sheet, as DLC packs do; 'project' = a data/tilecatalog/ entry — a vision-bootstrap draft, or a human-verified `manual` one, which outranks a sidecar name). Project (custom-sheet) entries also carry the skill's `description`, `confidence` ('high'/'medium'/'low'), and `manual` (true = a human verified it) so you can gauge how trustworthy a draft name is. Autotile entries (A1–A4) return the kind's base tile id — feed it to a paint command, which recomputes the shape from neighbours. Covers verified default RPG Maker MV tilesets, any non-default sheet with a .txt name sidecar in img/tilesets/ (loaded automatically), plus custom sheets cataloged into data/tilecatalog/ (via the tileset-catalog skill); still-uncovered sheets are omitted. **Called WITHOUT `sheet` it returns only a per-sheet index (name + entry count) to stay within the tool-output limit — a full tileset can hold thousands of named tiles. Pass `sheet` (filename 'World_A2' or slot role 'A2') to list one sheet's actual tile entries.** Sheet-filtered entries also carry `transparent` (true = the tile is see-through and needs an opaque base tile on a lower layer — painting it on layer 0 alone shows the map void; e.g. trees/objects/overlays). Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      sheet: z
        .string()
        .optional()
        .describe(
          "Restrict to one sheet by filename ('World_A2') or role ('A2'). Omit to get a per-sheet summary (counts only) instead of every entry.",
        ),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const overlay = await loadCatalogOverlay(ctx.projectPath, tileset.tilesetNames);
      const cataloged = hasCatalog(tileset.tilesetNames, overlay);
      const entries = catalogForTileset(tileset.tilesetNames, args.sheet, overlay);

      // Without a `sheet` filter, the full entry list can blow past the tool-output
      // token limit (a default tileset holds thousands of named tiles). Return a
      // per-sheet index instead, so the caller can pick a sheet to expand.
      if (!args.sheet) {
        const bySheet = new Map<
          string,
          { sheet: string; role: string; source: string; count: number }
        >();
        for (const e of entries) {
          const summary = bySheet.get(e.sheet);
          if (summary) {
            summary.count++;
            // A sidecar sheet with manual project overrides mixes sources.
            if (summary.source !== e.source) summary.source = 'mixed';
          } else bySheet.set(e.sheet, { sheet: e.sheet, role: e.role, source: e.source, count: 1 });
        }
        return {
          tilesetId: args.tilesetId,
          tilesetName: tileset.name,
          cataloged,
          summary: true,
          totalEntries: entries.length,
          sheets: [...bySheet.values()],
          hint: "Per-sheet index only. Call again with `sheet` (filename or role, e.g. 'A2') to list that sheet's tile entries.",
        };
      }

      // A single sheet's entries are bounded — annotate each with its
      // transparency (needs-a-base) flag by reading the sheet PNG.
      await annotateTransparency(ctx.projectPath, tileset, entries);

      return {
        tilesetId: args.tilesetId,
        tilesetName: tileset.name,
        cataloged,
        sheet: args.sheet,
        count: entries.length,
        entries,
      };
    },
  },
  {
    name: 'find_tile',
    description:
      "Find tiles in a tileset by a case-insensitive SUBSTRING match on their catalog name — a quick bridge from a name fragment like 'grass' or 'forest' to a paintable tile id. This is a literal substring match, NOT synonym/semantic search: 'water' matches 'Endless Waterfall' but not 'Sea' or 'Pond' (their names lack the substring). To browse the actual tile names first, use get_tile_catalog with a `sheet` filter, then search a fragment you see. Set `searchDescriptions: true` to also match the free-text description a project catalog carries (custom sheets named by the tileset-catalog skill — their names are terse, the descriptions say what the tile looks like); built-in RPG Maker entries have no description, so this only widens the search over custom sheets. Returns matching catalog entries (name, sheet, tile id, autotile kind, `source`, `matchedIn` [which fields matched], `transparent` [true = needs an opaque base on a lower layer], plus `description`/`confidence`/`manual` for project catalog drafts). Covers the default RPG Maker tilesets, non-default sheets with a .txt name sidecar in img/tilesets/ (DLC packs ship these; loaded automatically, `source: 'sidecar'`), plus custom sheets cataloged into data/tilecatalog/ (via the tileset-catalog skill). Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      query: z
        .string()
        .describe("Substring to match, e.g. 'grass' or 'forest' (literal substring, no synonyms)"),
      searchDescriptions: z
        .boolean()
        .optional()
        .describe(
          'Also match project-catalog tile descriptions, not just names (default false — names only)',
        ),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const overlay = await loadCatalogOverlay(ctx.projectPath, tileset.tilesetNames);
      const matches = findTiles(tileset.tilesetNames, args.query, overlay, {
        searchDescriptions: args.searchDescriptions === true,
      });
      await annotateTransparency(ctx.projectPath, tileset, matches);
      return {
        tilesetId: args.tilesetId,
        query: args.query,
        searchedDescriptions: args.searchDescriptions === true,
        count: matches.length,
        matches,
      };
    },
  },
];
