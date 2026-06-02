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
  return resolved;
}

export function validateProjectExists(projectPath: string): void {
  if (!fs.existsSync(projectPath)) {
    throw new Error("Project path does not exist: " + projectPath);
  }
  const dataPath = path.join(projectPath, "data");
  if (!fs.existsSync(dataPath)) {
    throw new Error("Project path is not a valid RPG Maker MV project (no data/ folder): " + projectPath);
  }
}
