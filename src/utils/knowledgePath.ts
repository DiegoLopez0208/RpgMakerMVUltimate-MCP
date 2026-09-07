import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// fileURLToPath rather than import.meta.dirname: package.json declares
// engines.node >=18, and import.meta.dirname only exists from 20.11 (it is
// `undefined` before that, which makes path.join throw a TypeError).
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The two layouts this module can be loaded from:
//   built  — dist/utils  -> ../knowledge     = dist/knowledge   (npm postbuild copies it there)
//   source — src/utils   -> ../../knowledge  = repo-root/knowledge (tsx, vitest)
// Only `dist` ships (package.json "files"), so the built layout must win first.
const CANDIDATES = [
  path.join(HERE, '..', 'knowledge'),
  path.join(HERE, '..', '..', 'knowledge'),
];

// The file every candidate directory is probed for. Present in both layouts.
const SENTINEL = 'map-templates.json';

let cached: string | null = null;

/**
 * Absolute path of the bundled knowledge/ directory, resolved for whichever
 * layout this module was loaded from.
 *
 * Hardcoding a single relative path is what caused issue #15: mapGenerator
 * resolved only the built layout, so every template lookup silently returned
 * null when the code ran from src/ — which is how the whole `mode:"template"`
 * write path shipped with no test ever exercising it.
 */
export function knowledgeDir(): string {
  if (cached) return cached;
  for (const dir of CANDIDATES) {
    if (existsSync(path.join(dir, SENTINEL))) {
      cached = dir;
      return cached;
    }
  }
  // Nothing matched: hand back the built-layout path so the caller fails with a
  // real ENOENT naming the file it wanted, not a silent wrong-directory hit.
  cached = CANDIDATES[0];
  return cached;
}

/** Join segments onto the resolved knowledge/ directory. */
export function knowledgePath(...segments: string[]): string {
  return path.join(knowledgeDir(), ...segments);
}

