import { PluginArgSpec, PluginCommandSpec, PluginRegistry, PluginSpec } from './pluginCommands.js';

/**
 * Parsers for what an RPG Maker MV project already tells us about its plugins —
 * the annotation comment block every plugin carries, and the `js/plugins.js`
 * manifest the editor generates. Pure (no I/O) so they can be unit-tested against
 * real plugin sources; the file reading lives in `tools/pluginScanTools.ts`.
 *
 * This is what turns plugin validation from a hand-maintained allowlist into real
 * per-project coverage: the plugin sources ARE the source of truth for which
 * commands exist and what args they take.
 */

/** One entry of the `$plugins` array in `js/plugins.js`. */
export interface PluginManifestEntry {
  name: string;
  status: boolean;
  description?: string;
}

/**
 * Parse `js/plugins.js` — the editor-generated manifest listing which plugins are
 * installed and whether each is **enabled** (`status`). The file is JS
 * (`var $plugins = [ ... ];`) but the array literal itself is JSON, so it's
 * extracted and parsed directly. Fails soft: anything unparseable yields `[]`.
 */
export function parsePluginsJs(source: string): PluginManifestEntry[] {
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  try {
    const parsed: unknown = JSON.parse(source.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name as string,
        status: entry.status === true,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Extract the body of a plugin's **default-locale** annotation block.
 *
 * A plugin's metadata lives in a `/*:` comment. Localized copies of the same block
 * are tagged (`/*:ja`) and must be skipped — otherwise a Japanese `@text` would win
 * on the official sample plugins, which ship both. Struct definitions
 * (`/*~struct~Name:`) are a different construct and are never matched here.
 *
 * Returns the block's inner text (comment markers still attached), or `null`.
 */
export function defaultAnnotationBlock(source: string): string | null {
  // Block opener + an optional locale tag + newline, up to the comment terminator.
  const re = /\/\*:([A-Za-z_-]*)[ \t]*\r?\n([\s\S]*?)\*\//g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1] === '') return match[2];
  }
  return null;
}

/** Strip the leading ` * ` comment gutter from an annotation-block line. */
function stripGutter(line: string): string {
  return line.replace(/^[ \t]*\*[ \t]?/, '');
}

/** Which annotation the parser is currently attaching `@text`/`@desc` to. */
type Context =
  | { kind: 'plugin' }
  | { kind: 'command'; command: PluginCommandSpec }
  | { kind: 'arg'; arg: PluginArgSpec }
  // A plugin `@param` or `@help` body — annotations here belong to neither a
  // command nor an arg, so they must not leak onto the previous one.
  | { kind: 'other' };

/**
 * Parse a plugin's source into the same {@link PluginSpec} shape the built-in
 * allowlist uses, reading its `@plugindesc`, `@command`s and their `@arg`s.
 *
 * Annotation grammar (from the official MZ sample plugins): `@command <key>` opens
 * a command; `@arg <name>` opens an argument **of the command above it**; `@text`
 * and `@desc` describe whichever of those is currently open. `@param` (a plugin
 * *parameter*, not a command arg) and `@help` close that scope so their own
 * `@text`/`@desc` don't attach to the last command.
 *
 * **No `required` is ever set:** MZ has no "required argument" annotation, so
 * inferring it (e.g. from a missing `@default`) would only produce false "missing
 * required argument" warnings. Scanned args are validated for *unknown* names only.
 *
 * Returns `null` when the source has no default-locale annotation block.
 */
export function parsePluginAnnotations(source: string): PluginSpec | null {
  const block = defaultAnnotationBlock(source);
  if (block === null) return null;

  const spec: PluginSpec = { commands: {} };
  let context: Context = { kind: 'plugin' };

  for (const raw of block.split(/\r?\n/)) {
    const line = stripGutter(raw);
    const match = /^@(\w+)[ \t]*(.*)$/.exec(line);
    if (!match) continue;

    const [, tag, value] = match;
    const trimmed = value.trim();

    switch (tag) {
      case 'plugindesc':
        if (trimmed) spec.description = trimmed;
        context = { kind: 'plugin' };
        break;

      case 'command': {
        if (!trimmed) break;
        const command: PluginCommandSpec = {};
        spec.commands[trimmed] = command;
        context = { kind: 'command', command };
        break;
      }

      case 'arg': {
        if (!trimmed || context.kind === 'plugin' || context.kind === 'other') break;
        // An `@arg` belongs to the command above it — which, when the previous
        // context was itself an arg, is still the same command.
        const command = context.kind === 'command' ? context.command : lastCommand(spec);
        if (!command) break;
        const arg: PluginArgSpec = { name: trimmed };
        command.args = [...(command.args ?? []), arg];
        context = { kind: 'arg', arg };
        break;
      }

      case 'text':
        if (context.kind === 'command') context.command.label = trimmed || undefined;
        else if (context.kind === 'arg') context.arg.text = trimmed || undefined;
        break;

      case 'desc':
        if (context.kind === 'command') context.command.description = trimmed || undefined;
        else if (context.kind === 'arg') context.arg.description = trimmed || undefined;
        break;

      case 'type':
        if (context.kind === 'arg') context.arg.type = trimmed || undefined;
        break;

      case 'default':
        if (context.kind === 'arg') context.arg.default = trimmed;
        break;

      case 'param':
      case 'help':
        context = { kind: 'other' };
        break;

      default:
        // Any other annotation (@target, @author, @url, @min, @max, @require, …)
        // leaves the current scope open — @min/@max sit inside an @arg.
        break;
    }
  }

  return spec;
}

/** The most recently declared command, so a run of `@arg`s keeps attaching to it. */
function lastCommand(spec: PluginSpec): PluginCommandSpec | undefined {
  const keys = Object.keys(spec.commands);
  return keys.length > 0 ? spec.commands[keys[keys.length - 1]] : undefined;
}

/**
 * Merge a project scan over the curated allowlist.
 *
 * The two registries know different things and neither is a superset:
 * - the **scan** is authoritative on *structure* — which plugins/commands/args
 *   actually exist in this project, and each arg's `@type`/`@default`;
 * - the **allowlist** carries knowledge the annotations can't express, above all
 *   `required` (MZ has no required-arg annotation).
 *
 * So the scan wins on structure while a curated `required`/`description` is carried
 * across onto the matching arg by name, rather than a whole-plugin overwrite that
 * would silently drop it.
 */
export function mergePluginRegistries(
  builtin: PluginRegistry,
  scanned: PluginRegistry,
): PluginRegistry {
  const merged: PluginRegistry = { ...builtin };

  for (const [name, scan] of Object.entries(scanned)) {
    const base = builtin[name];
    if (!base) {
      merged[name] = scan;
      continue;
    }

    const commands: Record<string, PluginCommandSpec> = { ...base.commands };
    for (const [key, scanCommand] of Object.entries(scan.commands)) {
      const baseCommand = base.commands[key];
      commands[key] = baseCommand ? mergeCommand(baseCommand, scanCommand) : scanCommand;
    }

    merged[name] = {
      ...base,
      ...scan,
      commands,
    };
  }

  return merged;
}

function mergeCommand(base: PluginCommandSpec, scan: PluginCommandSpec): PluginCommandSpec {
  return {
    label: scan.label ?? base.label,
    description: scan.description ?? base.description,
    // A scan that found no args at all tells us nothing about them, so the
    // curated list survives; otherwise the scanned list is the real one.
    args: scan.args ? scan.args.map((arg) => mergeArg(base.args ?? [], arg)) : base.args,
  };
}

function mergeArg(baseArgs: PluginArgSpec[], scan: PluginArgSpec): PluginArgSpec {
  const base = baseArgs.find((a) => a.name === scan.name);
  if (!base) return scan;
  return {
    ...scan,
    ...(base.required !== undefined ? { required: base.required } : {}),
    description: scan.description ?? base.description,
  };
}
