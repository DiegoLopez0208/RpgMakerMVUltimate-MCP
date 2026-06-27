/**
 * plugins.ts — understand the plugins a project actually uses.
 *
 * RPG Maker MV configures plugins in js/plugins.js (an array of
 * {name, status, description, parameters}); each plugin file carries a `/*:`
 * annotation header declaring @plugindesc, @author, @param and (for MZ-ports)
 * @command, plus an @help block. This module fuses both so the MCP can adapt
 * generation to the project's own systems instead of emitting vanilla events.
 *
 * Roadmap #4 (Comprensión de plugins).
 */

import { readFile, readdir } from "fs/promises";
import path from "path";

export interface PluginParam {
  name: string;
  desc?: string;
  type?: string;
  default?: string;
}

export interface PluginInfo {
  name: string;
  status: boolean;
  description: string;
  author: string;
  /** Declared @param definitions from the plugin header. */
  params: PluginParam[];
  /** Configured parameter values from js/plugins.js. */
  values: Record<string, unknown>;
  /** Declared @command names (MZ-style; empty for classic MV plugins). */
  commands: string[];
  helpExcerpt: string;
  /** True when js/plugins.js lists it but js/plugins/<name>.js is missing. */
  fileMissing: boolean;
}

export interface PluginReport {
  source: "js/plugins.js" | "System.json" | "none";
  total: number;
  enabled: number;
  plugins: PluginInfo[];
}

interface RawPluginEntry {
  name?: string;
  status?: boolean;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** Pull the `[ ... ]` array literal out of js/plugins.js and JSON-parse it. */
function parsePluginsJs(src: string): RawPluginEntry[] | null {
  const start = src.indexOf("[");
  const end = src.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1)) as RawPluginEntry[];
  } catch {
    return null;
  }
}

/** Extract the first `/*:` annotation header block from a plugin file. */
function headerBlock(src: string): string {
  const open = src.indexOf("/*:");
  if (open === -1) return "";
  const close = src.indexOf("*/", open);
  return close === -1 ? src.slice(open) : src.slice(open, close);
}

function firstMatch(block: string, re: RegExp): string {
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function parseHeader(block: string): Pick<PluginInfo, "author" | "params" | "commands" | "helpExcerpt"> & { plugindesc: string } {
  const plugindesc = firstMatch(block, /@plugindesc\s+(.*)/);
  const author = firstMatch(block, /@author\s+(.*)/);

  const params: PluginParam[] = [];
  const paramRe = /@param\s+([^\n\r]+)\r?\n([\s\S]*?)(?=@param\s|@command\s|@help|\*\/|$)/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(block)) !== null) {
    const body = m[2];
    params.push({
      name: m[1].trim(),
      desc: firstMatch(body, /@desc\s+(.*)/) || undefined,
      type: firstMatch(body, /@type\s+(.*)/) || undefined,
      default: firstMatch(body, /@default\s+(.*)/) || undefined,
    });
  }

  const commands: string[] = [];
  const cmdRe = /@command\s+(\S+)/g;
  while ((m = cmdRe.exec(block)) !== null) commands.push(m[1].trim());

  const helpIdx = block.indexOf("@help");
  let helpExcerpt = "";
  if (helpIdx !== -1) {
    helpExcerpt = block
      .slice(helpIdx + 5)
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
      .filter((l) => !l.startsWith("@"))
      .join("\n")
      .trim()
      .slice(0, 400);
  }
  return { plugindesc, author, params, commands, helpExcerpt };
}

/** Build a fused report of every plugin the project configures. */
export async function analyzePlugins(projectPath: string): Promise<PluginReport> {
  const jsDir = path.join(projectPath, "js");
  const pluginFiles = new Set<string>();
  try {
    for (const f of await readdir(path.join(jsDir, "plugins"))) {
      if (f.endsWith(".js")) pluginFiles.add(f.replace(/\.js$/, ""));
    }
  } catch { /* no plugins dir */ }

  // Resolve the configured list: prefer js/plugins.js, fall back to System.json.
  let entries: RawPluginEntry[] = [];
  let source: PluginReport["source"] = "none";
  try {
    const raw = parsePluginsJs(await readFile(path.join(jsDir, "plugins.js"), "utf-8"));
    if (raw) { entries = raw; source = "js/plugins.js"; }
  } catch { /* fall through */ }
  if (source === "none") {
    try {
      const sys = JSON.parse((await readFile(path.join(projectPath, "data", "System.json"), "utf-8")).replace(/^﻿/, "")) as { plugins?: RawPluginEntry[] };
      if (Array.isArray(sys.plugins)) { entries = sys.plugins; source = "System.json"; }
    } catch { /* none */ }
  }

  const plugins: PluginInfo[] = [];
  for (const e of entries) {
    if (!e || typeof e.name !== "string" || e.name === "") continue;
    let header = { plugindesc: "", author: "", params: [] as PluginParam[], commands: [] as string[], helpExcerpt: "" };
    let fileMissing = !pluginFiles.has(e.name);
    if (!fileMissing) {
      try {
        header = parseHeader(headerBlock(await readFile(path.join(jsDir, "plugins", `${e.name}.js`), "utf-8")));
      } catch { fileMissing = true; }
    }
    plugins.push({
      name: e.name,
      status: e.status === true,
      description: e.description || header.plugindesc || "",
      author: header.author,
      params: header.params,
      values: (e.parameters && typeof e.parameters === "object") ? e.parameters : {},
      commands: header.commands,
      helpExcerpt: header.helpExcerpt,
      fileMissing,
    });
  }

  return { source, total: plugins.length, enabled: plugins.filter((p) => p.status).length, plugins };
}
