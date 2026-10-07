import { readFile, stat } from 'fs/promises';
import { basename, dirname, resolve, sep } from 'path';

/** Largest PNG attached to a tool result; bigger ones stay a path only. */
export const MAX_INLINE_IMAGE_BYTES = 1_500_000;

export interface InlineImage {
  type: 'image';
  data: string;
  mimeType: 'image/png';
}

function isCachePng(file: string): boolean {
  if (!file.toLowerCase().endsWith('.png')) return false;
  const full = resolve(file);
  // Only files this server wrote: <project>/.mcp-cache/<renders|screenshots>/<name>.png
  const dir = basename(dirname(full));
  return full.split(sep).includes('.mcp-cache') && (dir === 'renders' || dir === 'screenshots');
}

/**
 * Pick the PNG paths a tool result points at (`path`, or `screenshots[]`/`frames[]` entries
 * that are strings or {path}) and return them as MCP image content, so the client model
 * can look at the picture instead of only reading its path. Never throws: on any problem
 * the result simply carries no image.
 */
export async function imagesFromResult(result: unknown, max = 4): Promise<InlineImage[]> {
  if (process.env.RPGMV_INLINE_IMAGES === '0') return [];
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') candidates.push(value);
    else if (typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string') {
      candidates.push((value as { path: string }).path);
    }
  };
  add(record.path);
  for (const key of ['screenshots', 'frames']) {
    if (Array.isArray(record[key])) for (const entry of record[key] as unknown[]) add(entry);
  }
  const images: InlineImage[] = [];
  for (const file of candidates) {
    if (images.length >= max) break;
    try {
      if (!isCachePng(file)) continue;
      if ((await stat(file)).size > MAX_INLINE_IMAGE_BYTES) continue;
      images.push({ type: 'image', data: (await readFile(file)).toString('base64'), mimeType: 'image/png' });
    } catch {
      // unreadable or vanished: leave it as a path
    }
  }
  return images;
}
