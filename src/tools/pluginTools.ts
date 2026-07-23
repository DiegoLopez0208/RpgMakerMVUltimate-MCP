/**
 * pluginTools.ts — author RPG Maker MV plugins.
 *
 * Writes a plugin file js/plugins/<Name>.js with the correct `/*:` annotation
 * header (@plugindesc / @author / @param / @help, plus @command docs for MZ-style
 * plugins) and registers it in js/plugins.js — the `var $plugins = [ ... ]`
 * manifest the engine loads, where array order IS load order and every parameter
 * value is a string. Complements analyze_project view "plugins" (which reads this
 * same manifest). Re-authoring the same name is idempotent: the old file is
 * overwritten and its manifest entry replaced in place.
 */
import { readFile, mkdir } from 'fs/promises';
import { safeWrite } from '../utils/fileHandler.js';
import { resolveSafePath } from '../utils/security.js';

export interface PluginParamDef {
  name: string;
  type?: string;    // number, string, boolean, note, file, select, ... (editor @type)
  desc?: string;
  default?: string | number | boolean;
}

export interface CreatePluginParams {
  name: string;
  description?: string;
  author?: string;
  help?: string;
  params?: PluginParamDef[];
  commands?: string[]; // documented @command names (MZ-style; classic MV reads pluginCommand)
  body?: string;       // custom JS body; when omitted a safe skeleton is generated
  status?: boolean;    // enabled in js/plugins.js (default true)
}

interface RawPluginEntry {
  name?: string;
  status?: boolean;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** Pull the `[ ... ]` array literal out of js/plugins.js and JSON-parse it. */
function parsePluginsJs(src: string): RawPluginEntry[] | null {
  const start = src.indexOf('[');
  const end = src.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1)) as RawPluginEntry[];
  } catch {
    return null;
  }
}

/** Build the `/*:` annotation header the RPG Maker editor parses. */
function buildHeader(p: CreatePluginParams): string {
  const lines: string[] = ['/*:'];
  lines.push(' * @plugindesc ' + (p.description || p.name));
  lines.push(' * @author ' + (p.author || ''));
  for (const param of p.params || []) {
    lines.push(' *');
    lines.push(' * @param ' + param.name);
    if (param.type) lines.push(' * @type ' + param.type);
    if (param.desc) lines.push(' * @desc ' + param.desc);
    if (param.default !== undefined) lines.push(' * @default ' + String(param.default));
  }
  for (const cmd of p.commands || []) {
    lines.push(' *');
    lines.push(' * @command ' + cmd);
  }
  lines.push(' *');
  lines.push(' * @help');
  const help = p.help || ('Plugin ' + p.name + '.');
  for (const hl of help.split('\n')) lines.push(' * ' + hl);
  lines.push(' */');
  return lines.join('\n');
}

/** Build a safe plugin body: reads its own params and (if any @command was
 *  declared) wires a classic-MV Game_Interpreter.pluginCommand hook. */
function buildBody(p: CreatePluginParams): string {
  if (p.body) return p.body;
  const lines: string[] = [];
  lines.push('(function() {');
  lines.push("  'use strict';");
  lines.push('  var parameters = PluginManager.parameters(' + JSON.stringify(p.name) + ');');
  if (p.commands && p.commands.length) {
    const known = p.commands.map((c) => JSON.stringify(c)).join(', ');
    lines.push('  var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;');
    lines.push('  Game_Interpreter.prototype.pluginCommand = function(command, args) {');
    lines.push('    _Game_Interpreter_pluginCommand.call(this, command, args);');
    lines.push('    if ([' + known + '].indexOf(command) >= 0) {');
    lines.push('      // TODO: handle "' + p.commands.join('", "') + '" here (args is a string[]).');
    lines.push('    }');
    lines.push('  };');
  } else {
    lines.push('  void parameters; // TODO: implement plugin behaviour');
  }
  lines.push('})();');
  return lines.join('\n');
}

/**
 * Create (or overwrite) a plugin file and register it in js/plugins.js.
 * The plugin name must be a bare filename token (letters/digits/_/-), never a
 * path — this is enforced and further guarded by resolveSafePath.
 */
export async function createPlugin(projectPath: string, params: CreatePluginParams) {
  const name = params.name;
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('Invalid plugin name "' + String(name) + '": use only letters, digits, underscore or hyphen (no path separators or extension).');
  }

  // Write js/plugins/<name>.js (atomic, backed up).
  const pluginsDir = resolveSafePath(projectPath, 'js', 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  const filePath = resolveSafePath(projectPath, 'js', 'plugins', name + '.js');
  const content = buildHeader(params) + '\n\n' + buildBody(params) + '\n';
  await safeWrite(filePath, content);

  // Register in js/plugins.js: replace any existing entry of the same name in
  // place (idempotent), else append (load order = array order).
  const manifestPath = resolveSafePath(projectPath, 'js', 'plugins.js');
  let entries: RawPluginEntry[] = [];
  try {
    const parsed = parsePluginsJs(await readFile(manifestPath, 'utf-8'));
    if (parsed) entries = parsed;
  } catch { /* no manifest yet → start a fresh one */ }

  const parameters: Record<string, string> = {};
  for (const pr of params.params || []) {
    parameters[pr.name] = pr.default !== undefined ? String(pr.default) : '';
  }
  const entry: RawPluginEntry = {
    name,
    status: params.status !== false,
    description: params.description || '',
    parameters,
  };
  const existingIdx = entries.findIndex((e) => e && e.name === name);
  if (existingIdx >= 0) entries[existingIdx] = entry;
  else entries.push(entry);

  const manifest =
    '//=============================================================================\n' +
    '// Generated by RPG Maker MV Ultimate MCP\n' +
    '//=============================================================================\n\n' +
    'var $plugins =\n' + JSON.stringify(entries, null, 4) + ';\n';
  await safeWrite(manifestPath, manifest);

  return {
    name,
    file: 'js/plugins/' + name + '.js',
    registered: true,
    enabled: entry.status,
    pluginCount: entries.length,
    replaced: existingIdx >= 0,
  };
}
