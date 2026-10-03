import { z } from 'zod';
import { basename, join } from 'path';
import { listFiles } from '../utils/fileHandler.js';
import { ToolDefinition } from '../registry.js';
import { ValidationWarning } from '../validation/eventCommands.js';

/**
 * The project asset kinds a caller can enumerate, mapped to their directory
 * (relative to the project root) and the file extensions they use. RPG Maker MV
 * references every asset by **basename without extension** (e.g. an event's
 * `characterName` is `"Actor1"`, not `"Actor1.png"`), so `list_assets` strips the
 * extension — the returned names are exactly what the data files expect.
 *
 * Audio ships as `.ogg` (and sometimes a parallel `.m4a` for other runtimes); we
 * list both and MV encrypted deployment extensions, deduping by basename.
 */
const IMAGE_EXTENSIONS = ['.png', '.rpgmvp'];
const AUDIO_EXTENSIONS = ['.ogg', '.m4a', '.rpgmvo', '.rpgmvm'];
const ASSET_DIRS = {
  characters: { dir: 'img/characters', exts: IMAGE_EXTENSIONS },
  faces: { dir: 'img/faces', exts: IMAGE_EXTENSIONS },
  tilesets: { dir: 'img/tilesets', exts: IMAGE_EXTENSIONS },
  pictures: { dir: 'img/pictures', exts: IMAGE_EXTENSIONS },
  parallaxes: { dir: 'img/parallaxes', exts: IMAGE_EXTENSIONS },
  battlebacks1: { dir: 'img/battlebacks1', exts: IMAGE_EXTENSIONS },
  battlebacks2: { dir: 'img/battlebacks2', exts: IMAGE_EXTENSIONS },
  enemies: { dir: 'img/enemies', exts: IMAGE_EXTENSIONS },
  sv_actors: { dir: 'img/sv_actors', exts: IMAGE_EXTENSIONS },
  sv_enemies: { dir: 'img/sv_enemies', exts: IMAGE_EXTENSIONS },
  titles1: { dir: 'img/titles1', exts: IMAGE_EXTENSIONS },
  titles2: { dir: 'img/titles2', exts: IMAGE_EXTENSIONS },
  system: { dir: 'img/system', exts: IMAGE_EXTENSIONS },
  animations: { dir: 'img/animations', exts: IMAGE_EXTENSIONS },
  bgm: { dir: 'audio/bgm', exts: AUDIO_EXTENSIONS },
  bgs: { dir: 'audio/bgs', exts: AUDIO_EXTENSIONS },
  me: { dir: 'audio/me', exts: AUDIO_EXTENSIONS },
  se: { dir: 'audio/se', exts: AUDIO_EXTENSIONS },
} as const;

export type AssetType = keyof typeof ASSET_DIRS;

export interface AssetIndex {
  type: AssetType;
  count: number;
  names: string[];
}

/**
 * List the available asset basenames (extension stripped) for one asset kind —
 * the exact strings the data files reference (a sprite/face/audio name). Use it to
 * validate a graphic/audio name before wiring it into an event, since a wrong
 * filename is a silent runtime failure in the engine.
 *
 * **Fails soft:** a missing asset directory (an unused kind) yields an empty list
 * rather than an error. Read-only — no writes.
 */
export async function listAssets(projectPath: string, type: AssetType): Promise<AssetIndex> {
  const spec = ASSET_DIRS[type];
  if (!spec) {
    throw new Error(
      `Unknown asset type: ${type}. Valid types: ${Object.keys(ASSET_DIRS).join(', ')}`,
    );
  }

  const dirPath = join(projectPath, ...spec.dir.split('/'));
  const names = new Set<string>();
  for (const ext of spec.exts) {
    let files: string[];
    try {
      files = await listFiles(dirPath, ext);
    } catch {
      files = []; // Missing dir (unused asset kind) → fail soft.
    }
    for (const file of files) names.add(basename(file, ext));
  }

  const sorted = [...names].sort();
  return { type, count: sorted.length, names: sorted };
}

/**
 * Warn (never throw) when an asset `name` isn't among the project's assets of the
 * given type — a wrong filename is a silent runtime failure in the engine. Skips
 * the check when the name is empty (no asset referenced) or the asset dir is
 * empty/missing (nothing to validate against — e.g. a fixture project), so it
 * can't emit false positives. Shared by the audio/character/battler name checks.
 */
export async function assetNameWarning(
  projectPath: string,
  type: AssetType,
  name: string | undefined,
  opts: { path: string; label: string; consequence: string },
): Promise<ValidationWarning[]> {
  if (!projectPath || !name) return [];
  const { names } = await listAssets(projectPath, type);
  if (names.length > 0 && !names.includes(name)) {
    return [
      {
        path: opts.path,
        code: undefined,
        message: `${opts.label} "${name}" is not a known ${type} asset (${opts.consequence})`,
      },
    ];
  }
  return [];
}

export const assetToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_assets',
    description:
      "List the available asset filenames (extension stripped) for one asset kind — the exact names RPG Maker's data references (a sprite/face/tileset/audio name). Use it to validate a graphic or audio name before wiring it into an event; a wrong filename fails silently at runtime. Fails soft: an unused asset directory returns an empty list.",
    inputSchema: {
      type: z
        .enum(Object.keys(ASSET_DIRS) as [AssetType, ...AssetType[]])
        .describe(
          'Asset kind to list. Images: characters, faces, tilesets, pictures, parallaxes, battlebacks1, battlebacks2, enemies, sv_actors, sv_enemies, titles1, titles2, system, animations. Audio: bgm, bgs, me, se. Includes encrypted MV .rpgmvp/.rpgmvo/.rpgmvm files, deduplicated by basename.',
        ),
    },
    handler: (ctx, args) => listAssets(ctx.projectPath, args.type),
  },
];
