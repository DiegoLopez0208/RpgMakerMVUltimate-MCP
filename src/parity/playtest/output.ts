import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, extname, isAbsolute, join, resolve } from 'path';

/**
 * Where rendered PNGs go. Never inside the project by default — a screenshot is
 * a verification artifact, not game content, and dropping files into the
 * project would dirty the user's repo.
 */
export function defaultOutputDir(): string {
  return join(tmpdir(), 'rpgmaker-mv-mcp', 'renders');
}

/** A filesystem-safe, sortable timestamp: 20260923-141502-123. */
export function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * Resolve the PNG path for a render: `out` if given (a `.png` file path, or a
 * directory to put `fallbackName` in), else the temp render dir. Creates the
 * parent directory.
 */
export async function resolvePngPath(
  out: string | undefined,
  fallbackName: string,
): Promise<string> {
  let file: string;
  if (!out) file = join(defaultOutputDir(), fallbackName);
  else {
    const abs = isAbsolute(out) ? out : resolve(out);
    file = extname(abs).toLowerCase() === '.png' ? abs : join(abs, fallbackName);
  }
  await mkdir(dirname(file), { recursive: true });
  return file;
}

/** Make a caller-supplied screenshot name safe as a file basename. */
export function safeName(name: string): string {
  const cleaned = name.replace(/\.png$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned.replace(/^[._]+/, '') || 'shot';
}
