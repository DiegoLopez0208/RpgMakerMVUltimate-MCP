import { readFile, stat } from 'fs/promises';

export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 8;

/** Keep file artifacts available even when their inline delivery exceeds a response budget. */
export async function collectInlineImages(
  files: string[],
  limits = { maxBytes: MAX_INLINE_IMAGE_BYTES, maxImages: MAX_INLINE_IMAGES },
) {
  const images: Array<{ type: 'image'; mimeType: 'image/png'; data: string }> = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let bytes = 0;
  for (const file of files) {
    if (images.length >= limits.maxImages) {
      omitted.push({ path: file, reason: 'image_count_limit' });
      continue;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      if (info.size > limits.maxBytes - bytes) {
        omitted.push({ path: file, reason: 'aggregate_byte_limit' });
        continue;
      }
      const image = await readFile(file);
      // A concurrent writer may have enlarged the file after stat.
      if (image.length > limits.maxBytes - bytes) {
        omitted.push({ path: file, reason: 'aggregate_byte_limit' });
        continue;
      }
      bytes += image.length;
      images.push({ type: 'image', mimeType: 'image/png', data: image.toString('base64') });
    } catch (error) {
      omitted.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    images,
    metadata: { attached: images.length, bytes, truncated: omitted.length > 0, omitted, ...limits },
  };
}
