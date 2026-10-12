import path from "path";
import fs from "fs";
import * as logger from "./logger.js";

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export function resolveSafePath(basePath: string, ...segments: string[]): string {
  const resolved = path.resolve(basePath, ...segments);
  const normalizedBase = path.resolve(basePath);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    logger.warn("Path traversal attempt blocked", { base: basePath, segments, resolved });
    throw new SecurityError(
      "Path traversal detected: cannot access '" + resolved + "' outside project directory"
    );
  }
  // Resolve the nearest existing ancestor as well as the target. New files and
  // directories must not bypass confinement through a linked parent directory.
  const actualBase = canonicalPath(normalizedBase);
  const actualTarget = canonicalPath(resolved);
  const relative = path.relative(actualBase, actualTarget);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new SecurityError("Symlink/junction escapes project directory: " + resolved);
  }
  return resolved;
}

function canonicalPath(target: string): string {
  let ancestor = target;
  const pending: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      pending.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    // A dangling link is an error, rather than a missing parent to skip.
    return path.resolve(fs.realpathSync.native(ancestor), ...pending);
  }
}

export function validateProjectExists(projectPath: string): void {
  if (!fs.existsSync(projectPath)) {
    throw new Error("Project path does not exist: " + projectPath);
  }
  const dataPath = resolveSafePath(projectPath, "data");
  if (!fs.existsSync(dataPath)) {
    throw new Error("Project path is not a valid RPG Maker MV project (no data/ folder): " + projectPath);
  }
}
