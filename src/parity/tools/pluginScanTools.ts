import { z } from 'zod';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { ToolDefinition } from '../registry.js';
import { PluginRegistry, PLUGIN_COMMAND_REGISTRY } from '../validation/pluginCommands.js';
import {
  parsePluginAnnotations,
  parsePluginsJs,
  mergePluginRegistries,
} from '../validation/pluginManifest.js';

/**
 * Project-scoped plugin scanning: read `js/plugins/*.js` for the `@command`/`@arg`
 * annotations each plugin declares, and `js/plugins.js` for which are enabled.
 *
 * This is the plugin-side twin of the project tile-catalog overlay (Phase 4a): the
 * built-in {@link PLUGIN_COMMAND_REGISTRY} is a narrow hand-maintained allowlist,
 * and a project's own plugin sources are the real source of truth. Merging the scan
 * over the allowlist turns plugin-command validation from "the 1 plugin we hardcoded"
 * into actual per-project coverage.
 *
 * Everything here fails soft: a project with no `js/plugins` dir, an unreadable
 * file, or a plugin with no annotation block simply contributes nothing.
 */

/** Cache entry keyed by project path, invalidated by the plugins dir's mtime. */
interface CacheEntry {
  mtimeMs: number;
  registry: PluginRegistry;
}

const cache = new Map<string, CacheEntry>();

/** Reset the scan cache. Exposed for tests. */
export function clearPluginScanCache(): void {
  cache.clear();
}

function pluginsDir(projectPath: string): string {
  return join(projectPath, 'js', 'plugins');
}

/**
 * Scan a project's installed plugins into a {@link PluginRegistry}.
 *
 * Cached by the `js/plugins` directory mtime, so repeated tool calls in a session
 * don't re-read every plugin (mirrors the tile-sheet alpha cache). Note the mtime
 * only changes when files are added/removed — an *edited* plugin needs a fresh
 * session, which is fine: plugin annotations don't change mid-authoring.
 */
export async function scanPlugins(projectPath: string): Promise<PluginRegistry> {
  const dir = pluginsDir(projectPath);

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch {
    return {}; // No js/plugins dir — not every project has plugins.
  }

  const cached = cache.get(projectPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.registry;

  // Which plugins the editor has installed/enabled. Absent or unparseable →
  // enabled stays unknown rather than being reported as disabled.
  let manifest: Map<string, boolean> | null = null;
  try {
    const source = await readFile(join(projectPath, 'js', 'plugins.js'), 'utf-8');
    const entries = parsePluginsJs(source);
    manifest = new Map(entries.map((e) => [e.name, e.status]));
  } catch {
    manifest = null;
  }

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  } catch {
    return {};
  }

  const registry: PluginRegistry = {};
  for (const file of files.sort()) {
    const name = file.replace(/\.js$/, '');
    let source: string;
    try {
      source = await readFile(join(dir, file), 'utf-8');
    } catch {
      continue;
    }

    const spec = parsePluginAnnotations(source);
    if (!spec) continue;

    registry[name] = {
      ...spec,
      // A plugin file present on disk but absent from plugins.js isn't installed
      // in the editor, so it won't run either — same as being switched off.
      ...(manifest ? { enabled: manifest.get(name) === true } : {}),
    };
  }

  cache.set(projectPath, { mtimeMs, registry });
  return registry;
}

/**
 * The registry the plugin tools validate against: everything scanned from the
 * project merged over the built-in allowlist. See {@link mergePluginRegistries} —
 * the scan wins on structure, but a curated `required` flag survives, since the
 * annotations it came from can't express one.
 */
export async function projectPluginRegistry(projectPath: string): Promise<PluginRegistry> {
  return mergePluginRegistries(PLUGIN_COMMAND_REGISTRY, await scanPlugins(projectPath));
}

export const pluginScanToolDefinitions: ToolDefinition[] = [
  {
    name: 'scan_plugins',
    description:
      "Read optional @command/@arg documentation in js/plugins/*.js together with enabled state from js/plugins.js. Classic MV plugins often define commands only in @help; use analyze_project view plugins for their help text. Metadata does not establish an MV argument order or runtime registration. create_plugin_command requires exact command text. Filter by pluginName or enabledOnly. Read-only.",
    inputSchema: {
      pluginName: z
        .string()
        .optional()
        .describe('Optional: restrict to one plugin (its filename without .js)'),
      enabledOnly: z
        .boolean()
        .optional()
        .describe('Only report plugins enabled in js/plugins.js (default false)'),
    },
    handler: async (ctx, args) => {
      const scanned = await scanPlugins(ctx.projectPath);

      let plugins = Object.entries(scanned);
      if (args.pluginName !== undefined) {
        plugins = plugins.filter(([name]) => name === args.pluginName);
        if (plugins.length === 0) {
          throw new Error(
            `Plugin "${args.pluginName}" was not found in js/plugins (or declares no annotation block)`,
          );
        }
      }
      if (args.enabledOnly === true) {
        plugins = plugins.filter(([, spec]) => spec.enabled !== false);
      }

      const commandCount = plugins.reduce(
        (total, [, spec]) => total + Object.keys(spec.commands).length,
        0,
      );
      return {
        pluginCount: plugins.length,
        commandCount,
        plugins: Object.fromEntries(plugins),
      };
    },
  },
];
