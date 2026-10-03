import { readFile, stat } from 'fs/promises';
import { join } from 'path';

import { TextMetrics, parseTextMetrics } from '../validation/textMetrics.js';

/**
 * Optional per-project server config: `<project>/.rpgmaker-mcp.json`.
 *
 * Currently one section, `text`, which replaces the built-in character-count estimate
 * for Show Text line width with the project's real numbers. See
 * `validation/textMetrics.ts` for why a character count cannot be made correct for a
 * font that isn't the RTP default.
 *
 * ```json
 * {
 *   "text": {
 *     "lineBudget": { "noFace": 784, "withFace": 616 },
 *     "nameBudgetChars": 8,
 *     "charWidths": { "_default": 13, "a": 11.38, ".": 4.88, " ": 8.12 }
 *   }
 * }
 * ```
 *
 * Everything fails soft: no file, unreadable file, bad JSON or a malformed `text`
 * section all leave the built-in defaults in place. A broken config must never be
 * worse than no config — the failure mode this whole feature exists to fix is a
 * validator producing warnings nobody can trust.
 */

/** Cache entry keyed by project path, invalidated by the config file's mtime. */
interface CacheEntry {
  mtimeMs: number | null;
  metrics: TextMetrics | null;
}

const cache = new Map<string, CacheEntry>();

/** Reset the config cache. Exposed for tests. */
export function clearProjectConfigCache(): void {
  cache.clear();
}

export const PROJECT_CONFIG_FILE = '.rpgmaker-mcp.json';

function configPath(projectPath: string): string {
  return join(projectPath, PROJECT_CONFIG_FILE);
}

/**
 * Load the project's text metrics, or `null` if it supplies none.
 *
 * Cached by the config file's mtime, so the common case (no config at all) costs one
 * `stat` per tool call and a hit thereafter.
 */
export async function loadProjectTextMetrics(projectPath: string): Promise<TextMetrics | null> {
  if (!projectPath) return null;
  const file = configPath(projectPath);

  let mtimeMs: number | null;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    // No config file is the normal case, not an error. Cache the absence so we don't
    // re-stat on every single tool call.
    mtimeMs = null;
  }

  const hit = cache.get(projectPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.metrics;

  let metrics: TextMetrics | null = null;
  if (mtimeMs !== null) {
    try {
      metrics = parseTextMetrics(JSON.parse(await readFile(file, 'utf-8')));
    } catch {
      metrics = null;
    }
  }

  cache.set(projectPath, { mtimeMs, metrics });
  return metrics;
}
