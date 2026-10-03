import { EventCommand } from '../utils/types.js';
import { ValidationWarning } from './eventCommands.js';

/**
 * MV stores one exact command string in parameters[0]. Annotation metadata is
 * useful documentation, but cannot determine a plugin's positional syntax.
 */
export const PLUGIN_COMMAND_CODE = 356;

/** Spec for a single plugin-command argument. */
export interface PluginArgSpec {
  name: string;
  required?: boolean;
  description?: string;
  /** The editor's display label (`@text`), when scanned from a plugin source. */
  text?: string;
  /** The arg's declared `@type` (number, common_event, struct<X>, …), when scanned. */
  type?: string;
  /** The arg's `@default`, when scanned. */
  default?: string;
}

/** Spec for one registered plugin command. */
export interface PluginCommandSpec {
  /** Display label the editor shows (parameters[2]); defaults to the command key. */
  label?: string;
  description?: string;
  args?: PluginArgSpec[];
}

/** A plugin's registry entry: a description plus its known commands. */
export interface PluginSpec {
  description?: string;
  commands: Record<string, PluginCommandSpec>;
  /**
   * Whether `js/plugins.js` has the plugin turned on. Only set by the project
   * scanner — a built-in allowlist entry leaves it undefined (unknown), so only an
   * explicit `false` is ever reported.
   */
  enabled?: boolean;
}

/** A plugin registry: plugin filename (no `.js`) → its spec. */
export type PluginRegistry = Record<string, PluginSpec>;

/**
 * Curated allowlist of known community/official plugin commands, keyed by plugin
 * filename → command key. Deliberately **not** exhaustive — it is a starter set
 * meant to grow. Its only job is to turn a specific plugin command from opaque
 * params into something `create_plugin_command` can validate (required args
 * present, no stray args) and label the way the editor would. A plugin command
 * that isn't listed here is still built fine — it just passes through with a soft
 * "not in the allowlist" warning (warn-by-default, mirroring unknown event codes).
 */
export const PLUGIN_COMMAND_REGISTRY: PluginRegistry = {};

/**
 * Look up a plugin command spec, or `undefined` if the plugin/command is unlisted.
 * `registry` defaults to the built-in allowlist; the tools pass a project-scanned
 * registry merged over it (see `tools/pluginScanTools.ts`).
 */
export function lookupPluginCommand(
  pluginName: string,
  commandName: string,
  registry: PluginRegistry = PLUGIN_COMMAND_REGISTRY,
): PluginCommandSpec | undefined {
  return registry[pluginName]?.commands[commandName];
}

/**
 * Normalize a plugin-command args object into the exact on-disk shape the editor
 * writes: every value is a string. Scalars are stringified; objects/arrays (plugin
 * "struct" params) are JSON-stringified into a single string. `null`/`undefined`
 * values are dropped. A value that is already a string is left untouched (so a
 * caller may pre-stringify a struct if they prefer).
 */
export function normalizePluginArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

/**
 * Validate a plugin command against the allowlist. Warn-by-default: an unlisted
 * plugin or command yields a single soft warning (its args pass through
 * unchecked); a listed command additionally flags missing required args and stray
 * unknown args. Nothing throws.
 */
export function validatePluginCommand(
  pluginName: string,
  commandName: string,
  args: Record<string, unknown>,
  path = `plugin command ${pluginName}: ${commandName}`,
  registry: PluginRegistry = PLUGIN_COMMAND_REGISTRY,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  const plugin = registry[pluginName];
  if (!plugin) {
    warnings.push({
      path,
      code: PLUGIN_COMMAND_CODE,
      message: `plugin "${pluginName}" is not installed in this project and is not in the known-plugin allowlist (args passed through unchecked)`,
    });
    return warnings;
  }

  // A command on a plugin the editor has switched off never runs at all — a
  // silent no-op that's easy to miss. Only the project scanner sets `enabled`.
  if (plugin.enabled === false) {
    warnings.push({
      path,
      code: PLUGIN_COMMAND_CODE,
      message: `plugin "${pluginName}" is installed but disabled in js/plugins.js — this command will not run until it is enabled in the editor's Plugin Manager`,
    });
  }

  const spec = plugin.commands[commandName];
  if (!spec) {
    warnings.push({
      path,
      code: PLUGIN_COMMAND_CODE,
      message: `command "${commandName}" is not a known command of plugin "${pluginName}" (args passed through unchecked)`,
    });
    return warnings;
  }

  const known = spec.args ?? [];
  const knownNames = new Set(known.map((a) => a.name));

  for (const arg of known) {
    if (arg.required && !(arg.name in args)) {
      warnings.push({
        path,
        code: PLUGIN_COMMAND_CODE,
        message: `missing required argument "${arg.name}"`,
      });
    }
  }

  for (const name of Object.keys(args)) {
    if (!knownNames.has(name)) {
      warnings.push({
        path,
        code: PLUGIN_COMMAND_CODE,
        message: `unknown argument "${name}" for ${pluginName}: ${commandName}`,
      });
    }
  }

  return warnings;
}

/**
 * Build an MV code 356 command. Retained metadata arguments are never converted
 * into guessed positional arguments; callers must provide the complete text.
 */
export function buildPluginCommand(
  pluginName: string,
  commandName: string,
  args: Record<string, unknown> = {},
  indent = 0,
  label?: string,
  registry: PluginRegistry = PLUGIN_COMMAND_REGISTRY,
): EventCommand {
  void pluginName; void label; void registry;
  if (Object.keys(args).length) throw new Error('MV plugin commands require exact text; named argument order cannot be inferred from MZ annotations');
  return {
    code: PLUGIN_COMMAND_CODE,
    indent,
    parameters: [commandName],
  };
}
