/**
 * Semantic tile catalog resolution. Turns "what does this tileset
 * contain, by meaning" into concrete tile ids — the layer that lets a caller
 * ask for "Grassland A" instead of the opaque integer 2816. Data comes from
 * the MV catalog generated from licensed sheet-name sidecars; this module maps a sheet's local index to a real tile id using the
 * sheet's *slot* in a tileset, and searches by name.
 *
 * Pure (no I/O): callers pass a tileset's `tilesetNames` (from Tilesets.json).
 * A sheet whose filename isn't in the catalog is simply skipped unless the
 * caller supplies an overlay for it — from a project catalog (the custom-catalog
 * vision-bootstrap skill) or a `.txt` name sidecar shipped next to the sheet
 * (DLC packs do this; see {@link parseTileSidecar} / {@link mergeSheetOverlay}).
 */
import { TILE_ID, makeAutotileId } from '../tileCodec.js';
import { MV_TILE_CATALOGS } from './mv.js';

/**
 * The catalog registry: sheet filename → the sheet's tile names (indexed by
 * local index within the sheet). Covers the default RPG Maker MV tilesets
 * (World, Outside, Inside, Dungeon, SF); extended per tileset as catalogs
 * are authored. Keyed by sheet filename, so a sheet shared across tilesets is
 * cataloged once.
 */
const CATALOG: Record<string, string[]> = Object.fromEntries(
  Object.entries(MV_TILE_CATALOGS).map(([sheet, catalog]) => [sheet, catalog.names]),
);

/** A sheet is a basename, never a path outside img/tilesets. */
export function validSheetName(sheet: string): boolean {
  return !!sheet && !/[\\/:\0]/.test(sheet) && sheet !== '.' && sheet !== '..';
}

/** The 9 `tilesetNames` slots, positional. Slots 0–3 are autotiles, 4–8 flat. */
const SLOT_ROLES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'] as const;
type SlotRole = (typeof SLOT_ROLES)[number];

/** First autotile *kind* on each A-sheet: A1=0, A2=16, A3=48, A4=80. */
const AUTOTILE_BASE_KIND: Record<string, number> = { A1: 0, A2: 16, A3: 48, A4: 80 };

/** Base tile id for each flat sheet (from the engine's TILE_ID constants). */
const FLAT_BASE: Record<string, number> = {
  A5: TILE_ID.A5,
  B: TILE_ID.B,
  C: TILE_ID.C,
  D: TILE_ID.D,
  E: TILE_ID.E,
};

/**
 * How many local indices each slot role can address: A1 16 kinds, A2 32, A3 32,
 * A4 48; A5 128 flat tiles; B–E 256. An index past this would resolve to a
 * tile id belonging to the next sheet, so the resolver drops it (sidecars in
 * particular can run long — trailing lines past the sheet's real capacity).
 */
const SLOT_CAPACITY: Record<SlotRole, number> = {
  A1: 16,
  A2: 32,
  A3: 32,
  A4: 48,
  A5: 128,
  B: 256,
  C: 256,
  D: 256,
  E: 256,
};

function isAutotileSlot(role: SlotRole): boolean {
  return role === 'A1' || role === 'A2' || role === 'A3' || role === 'A4';
}

/**
 * The representative tile id for a sheet's local index. For autotile sheets this
 * is the kind's shape-0 tile (a paint command recomputes the real shape from
 * neighbours); for flat sheets it's the tile id itself.
 */
export function tileIdForSlotIndex(slot: number, localIndex: number): number {
  const role = SLOT_ROLES[slot];
  if (isAutotileSlot(role)) {
    return makeAutotileId(AUTOTILE_BASE_KIND[role] + localIndex, 0);
  }
  return FLAT_BASE[role] + localIndex;
}

/** One catalog hit: a named tile in a specific tileset sheet. */
export interface CatalogEntry {
  /** Official tile name, e.g. "Grassland A". */
  name: string;
  /** The tileset image sheet filename, e.g. "World_A2". */
  sheet: string;
  /** The sheet's slot role: A1–A5, B–E. */
  role: SlotRole;
  /** The representative tile id (autotile shape-0 base, or the flat tile id). */
  tileId: number;
  /** True for A1–A4 sheets (shape is neighbour-driven; feed tileId to a paint command). */
  autotile: boolean;
  /** Global autotile kind (autotiles only). */
  kind?: number;
  /**
   * Where the name came from: `builtin` = RPG Maker's own labels (authoritative);
   * `sidecar` = the `img/tilesets/<Sheet>.txt` name file shipped next to a
   * non-default sheet (DLC packs ship these — authoritative, same format the
   * built-in catalogs were generated from); `project` = a project-scoped catalog
   * in `data/tilecatalog/` (a vision draft, or a human-verified `manual` entry).
   */
  source: CatalogSource;
  /**
   * True when the tile's representative sample is significantly transparent, so
   * it needs an opaque base tile on a lower layer (painting it on layer 0 alone
   * shows the map's void). Omitted when the sheet PNG couldn't be inspected.
   * Filled in by the tools layer (`annotateTransparency`), not the pure resolver.
   */
  transparent?: boolean;
  /** Free-text tile description — carried through from a `project` catalog only. */
  description?: string;
  /** Vision-naming confidence ('high'/'medium'/'low') — `project` catalog only. */
  confidence?: string;
  /** True when a human has verified/corrected this `project` catalog entry. */
  manual?: boolean;
}

/** Where a catalog entry's name came from — see {@link CatalogEntry.source}. */
export type CatalogSource = 'builtin' | 'sidecar' | 'project';

/**
 * One tile in a project-scoped overlay. A bare `string` is shorthand for a
 * name-only tile (`{ name }`); the object form additionally carries the draft
 * metadata the custom-catalog skill records (description/confidence/manual) so the tools can
 * surface it.
 */
export interface OverlayTile {
  name: string;
  description?: string;
  confidence?: string;
  manual?: boolean;
  /** Where the tile came from; defaults to `project` for an overlay tile. */
  source?: CatalogSource;
}

/**
 * A project-scoped name overlay: sheet filename → tiles by local index. Produced
 * by loading the custom-catalog skill's `data/tilecatalog/*.json` files and any `.txt`
 * sidecars for non-default sheets (the loader lives in the tools layer since it
 * does I/O). An overlay entry for a sheet **replaces**
 * the built-in names for that sheet (a project's own labels win for its sheets).
 */
export type CatalogOverlay = Record<string, (string | OverlayTile | undefined)[]>;

/**
 * Every cataloged entry for a tileset, given its `tilesetNames`. Walks each slot,
 * looks the sheet filename up in the catalog (built-in names, plus any `overlay`
 * from project catalogs), and emits an entry per named tile. Optionally restrict
 * to one sheet by filename ("World_A2") or slot role ("A2").
 */
export function catalogForTileset(
  tilesetNames: string[],
  sheetFilter?: string,
  overlay?: CatalogOverlay,
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let slot = 0; slot < SLOT_ROLES.length; slot++) {
    const file = tilesetNames[slot];
    if (!file) continue;
    const role = SLOT_ROLES[slot];
    if (sheetFilter && sheetFilter !== file && sheetFilter !== role) continue;
    // A project overlay for a sheet replaces the built-in names wholesale.
    const overlayTiles = overlay?.[file];
    const tiles: (string | OverlayTile | undefined)[] | undefined = overlayTiles ?? CATALOG[file];
    if (!tiles) continue;
    const sheetSource: CatalogSource = overlayTiles ? 'project' : 'builtin';
    const autotile = isAutotileSlot(role);
    const capacity = SLOT_CAPACITY[role];
    tiles.forEach((raw, localIndex) => {
      const tile: OverlayTile | undefined = typeof raw === 'string' ? { name: raw } : raw;
      if (!tile || !tile.name || tile.name === 'Transparent') return; // skip blank/transparent slots
      if (localIndex >= capacity) return; // past the sheet — would alias the next sheet's ids
      const tileId = tileIdForSlotIndex(slot, localIndex);
      entries.push({
        name: tile.name,
        sheet: file,
        role,
        tileId,
        autotile,
        ...(autotile ? { kind: AUTOTILE_BASE_KIND[role] + localIndex } : {}),
        source: tile.source ?? sheetSource,
        ...(tile.description ? { description: tile.description } : {}),
        ...(tile.confidence ? { confidence: tile.confidence } : {}),
        ...(tile.manual !== undefined ? { manual: tile.manual } : {}),
      });
    });
  }
  return entries;
}

/** Which catalog fields a {@link findTiles} query matched. */
export type MatchField = 'name' | 'description';

/** A {@link findTiles} hit: a catalog entry plus the fields the query matched. */
export interface CatalogMatch extends CatalogEntry {
  /** The fields `query` matched, in name-then-description order. */
  matchedIn: MatchField[];
}

/** Options for {@link findTiles}. */
export interface FindTilesOptions {
  /**
   * Also match a tile's free-text `description`. Descriptions only exist on
   * `project` catalog entries (the custom-catalog vision-bootstrap skill records what a tile
   * *looks like*), so this widens the search exactly where names are terse and
   * machine-drafted. Off by default — the name-only match surface is tight and
   * predictable, and a description search returns entries whose name says
   * nothing about the query.
   */
  searchDescriptions?: boolean;
}

/**
 * Catalog entries for a tileset matching `query` (case-insensitive substring).
 * The bridge for "give me a grass tile" → a paintable tile id. Matches names
 * only unless `searchDescriptions` is set, in which case a project entry also
 * matches on its description text; each hit reports which fields matched.
 */
export function findTiles(
  tilesetNames: string[],
  query: string,
  overlay?: CatalogOverlay,
  options: FindTilesOptions = {},
): CatalogMatch[] {
  const q = query.toLowerCase();
  const matches: CatalogMatch[] = [];
  for (const entry of catalogForTileset(tilesetNames, undefined, overlay)) {
    const matchedIn: MatchField[] = [];
    if (entry.name.toLowerCase().includes(q)) matchedIn.push('name');
    if (options.searchDescriptions && entry.description?.toLowerCase().includes(q)) {
      matchedIn.push('description');
    }
    if (matchedIn.length > 0) matches.push({ ...entry, matchedIn });
  }
  return matches;
}

/** Whether a sheet filename has a compiled-in (RPG Maker default) catalog. */
export function hasBuiltinCatalog(sheet: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, sheet);
}

/**
 * Parse an RPG Maker tileset name sidecar (`img/tilesets/<Sheet>.txt`): one
 * `EnglishName|日本語名` line per local index — line *i* names local index *i*.
 * The default sheets ship these (the built-in catalogs were generated from
 * them) and so do commercial DLC packs. Tolerates a UTF-8 BOM, CRLF line ends,
 * a line with no `|`, and trailing blank lines (a blank line mid-file leaves a
 * hole so later indices stay aligned). `Transparent` lines are kept as-is —
 * the resolver skips them, but they still mark the slot as authoritatively
 * named so a vision draft can't paper over it.
 */
export function parseTileSidecar(text: string): (string | undefined)[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n|\r/);
  const names: (string | undefined)[] = lines.map((line) => {
    const name = line.split('|')[0].trim();
    return name || undefined;
  });
  while (names.length && names[names.length - 1] === undefined) names.pop();
  return names;
}

/**
 * Combine a sheet's sidecar names with its project catalog (`data/tilecatalog`)
 * entries, per local index, by precedence: a human-verified project entry
 * (`manual: true`) > the sidecar > a vision draft (non-manual project entry).
 * A draft only fills indices the sidecar leaves unnamed. Each tile is tagged
 * with its `source`.
 */
export function mergeSheetOverlay(
  sidecar: (string | undefined)[] | undefined,
  project: (string | OverlayTile | undefined)[] | undefined,
): (OverlayTile | undefined)[] {
  const merged: (OverlayTile | undefined)[] = [];
  const len = Math.max(sidecar?.length ?? 0, project?.length ?? 0);
  for (let i = 0; i < len; i++) {
    const rawProject = project?.[i];
    const proj: OverlayTile | undefined =
      typeof rawProject === 'string' ? { name: rawProject } : rawProject;
    const side = sidecar?.[i];
    if (proj?.name && proj.manual === true) merged[i] = { ...proj, source: 'project' };
    else if (side) merged[i] = { name: side, source: 'sidecar' };
    else if (proj?.name) merged[i] = { ...proj, source: 'project' };
  }
  return merged;
}

/** Whether any sheet of a tileset is covered by the catalog (built-in or overlay). */
export function hasCatalog(tilesetNames: string[], overlay?: CatalogOverlay): boolean {
  return catalogForTileset(tilesetNames, undefined, overlay).length > 0;
}

/**
 * Resolve a catalog tile name to exactly one tile id, for tools that accept a
 * name wherever a tile id goes (e.g. `paint_blueprint`'s legend). An exact
 * (case-insensitive) name match wins; failing that, a unique substring match
 * (the {@link findTiles} rule). Throws when nothing matches or when the match is
 * ambiguous (several distinct tile ids), listing the candidates so the caller
 * can pick a longer name or pass the id.
 */
export function resolveTileName(
  tilesetNames: string[],
  name: string,
  overlay?: CatalogOverlay,
): number {
  const q = name.toLowerCase();
  const matches = findTiles(tilesetNames, name, overlay);
  const exact = matches.filter((m) => m.name.toLowerCase() === q);
  const pool = exact.length > 0 ? exact : matches;
  const ids = [...new Set(pool.map((m) => m.tileId))];
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new Error(
      `no catalog tile matches "${name}" in this tileset — check get_tile_catalog / find_tile, or pass a tile id`,
    );
  }
  const shown = pool
    .slice(0, 8)
    .map((m) => `"${m.name}" (${m.sheet}, ${m.tileId})`)
    .join(', ');
  const more = pool.length > 8 ? `, … ${pool.length - 8} more` : '';
  throw new Error(
    `"${name}" is ambiguous — it matches ${pool.length} catalog tiles: ${shown}${more}. Use a more specific name or a tile id`,
  );
}
