import { realpath, lstat } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';

/** Resolve a fixed project path without allowing existing symlinks to escape the project. */
export async function projectFile(project: string, ...parts: string[]): Promise<string> {
  const root = await realpath(project);
  const target = resolve(root, ...parts);
  const inside = (candidate: string) => {
    const rel = relative(root, candidate);
    if (
      rel === '..' ||
      rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(rel)
    ) {
      throw new Error('Runtime path escapes the active project.');
    }
  };
  inside(target);
  let existing = target;
  for (;;) {
    try {
      await lstat(existing);
      inside(await realpath(existing));
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = dirname(existing);
    }
  }
}
