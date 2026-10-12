import { readJson } from '../utils/fileHandler.js';
import { SecurityError } from '../utils/security.js';

export interface ReadDiagnostics {
  complete: boolean;
  indexedFiles: string[];
  skippedFiles: string[];
  warnings: { file: string; message: string }[];
}

/** Partial projects remain usable, but must not be reported as complete. */
export function diagnosticReader(projectPath: string) {
  const diagnostics: ReadDiagnostics = { complete: true, indexedFiles: [], skippedFiles: [], warnings: [] };
  const values = new Map<string, unknown>();
  const read = async (file: string): Promise<unknown> => {
    if (values.has(file)) return values.get(file);
    try {
      const data = await readJson(projectPath, file);
      const expectsObject = file === 'System.json' || /^Map\d+\.json$/.test(file);
      if (expectsObject ? (!data || typeof data !== 'object' || Array.isArray(data)) : !Array.isArray(data)) {
        throw new Error('Expected a JSON ' + (expectsObject ? 'object' : 'array'));
      }
      diagnostics.indexedFiles.push(file);
      values.set(file, data);
      return data;
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      diagnostics.complete = false;
      diagnostics.skippedFiles.push(file);
      diagnostics.warnings.push({ file, message: error instanceof Error ? error.message : String(error) });
      values.set(file, null);
      return null;
    }
  };
  return { read, diagnostics };
}
