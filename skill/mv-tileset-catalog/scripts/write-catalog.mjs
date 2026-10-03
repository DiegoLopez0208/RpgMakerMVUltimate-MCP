#!/usr/bin/env node
// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * Merge a vision-naming pass into a versioned, project-scoped tile catalog, WITHOUT
 * clobbering human corrections.
 *
 * Reads a naming JSON (Claude's per-sample names) and merges it into
 *   <projectPath>/data/tilecatalog/<Sheet>.json
 *
 * Rules:
 *   • First run  → writes every named entry (version 1, manual:false).
 *   • Re-run     → for each index: an existing entry with `manual:true` is kept
 *                  verbatim (a human corrected it); non-manual entries are updated
 *                  to the new naming; brand-new indices are added. Passability and
 *                  terrainTag are always left null — those are design decisions.
 *   • --dry-run  → reports the proposed adds/updates/kept and writes nothing.
 *
 * Usage: node write-catalog.mjs <naming.json> <projectPath> [--dry-run]
 *
 * Naming JSON shape:
 *   { "sheet":"Custom_A2", "role":"A2", "autotile":true,
 *     "entries": { "0": { "name":"Grass", "confidence":"high",
 *                         "description":"…", "duplicateOf": null }, … } }
 */
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [namingPath, projectPath] = args.filter((a) => !a.startsWith('--'));
  if (!namingPath || !projectPath) {
    console.error('usage: node write-catalog.mjs <naming.json> <projectPath> [--dry-run]');
    process.exit(1);
  }

  const naming = JSON.parse(fs.readFileSync(namingPath, 'utf8'));
  if (!naming.sheet || !naming.entries) {
    console.error('naming JSON needs { sheet, entries }');
    process.exit(1);
  }

  if (typeof naming.sheet !== 'string' || !naming.sheet || /[\\/:\0]/.test(naming.sheet) || naming.sheet === '.' || naming.sheet === '..') throw new Error('Sheet must be a basename');
  if (typeof naming.entries !== 'object' || Array.isArray(naming.entries)) throw new Error('entries must be an object');
  for (const [index, entry] of Object.entries(naming.entries)) {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !entry || typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('Invalid catalog index or name');
  }
  const catalogDir = path.join(projectPath, 'data', 'tilecatalog');
  const catalogPath = path.join(catalogDir, `${naming.sheet}.json`);
  const existing = fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    : null;

  const merged = {
    sheet: naming.sheet,
    role: naming.role ?? existing?.role,
    autotile: naming.autotile ?? existing?.autotile ?? false,
    schemaVersion: SCHEMA_VERSION,
    version: existing ? existing.version + 1 : 1,
    updatedAt: new Date().toISOString(),
    entries: { ...(existing?.entries ?? {}) },
  };

  const report = { added: [], updated: [], keptManual: [], unchanged: [] };

  for (const [idx, incoming] of Object.entries(naming.entries)) {
    const prev = merged.entries[idx];
    if (prev && prev.manual) {
      report.keptManual.push(idx);
      continue;
    }
    const next = {
      name: incoming.name,
      confidence: incoming.confidence ?? 'medium',
      description: incoming.description ?? '',
      duplicateOf: incoming.duplicateOf ?? null,
      // Design decisions — never inferred by vision.
      passability: prev?.passability ?? null,
      terrainTag: prev?.terrainTag ?? null,
      manual: false,
      source: 'vision-bootstrap',
    };
    if (!prev) {
      report.added.push(idx);
    } else if (prev.name !== next.name || prev.description !== next.description) {
      report.updated.push(`${idx}: "${prev.name}" → "${next.name}"`);
    } else {
      report.unchanged.push(idx);
    }
    merged.entries[idx] = next;
  }

  const summary =
    `${naming.sheet}: +${report.added.length} added, ` +
    `~${report.updated.length} updated, ` +
    `${report.keptManual.length} kept (manual), ` +
    `${report.unchanged.length} unchanged` +
    (existing ? ` (v${existing.version} → v${merged.version})` : ' (new catalog v1)');

  if (dryRun) {
    console.log('[dry-run] ' + summary);
    if (report.updated.length) console.log('  updates:\n    ' + report.updated.join('\n    '));
    if (report.keptManual.length)
      console.log('  kept (manual, not overwritten): ' + report.keptManual.join(', '));
    if (report.added.length) console.log('  added indices: ' + report.added.join(', '));
    return;
  }

  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(merged, null, 2) + '\n');
  console.log(summary);
  console.log(`  → ${catalogPath}`);
}

main();
