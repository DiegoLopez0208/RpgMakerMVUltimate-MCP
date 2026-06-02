# Changelog

## [4.0.0] - 2026-06-02

### Changed
- **BREAKING**: Migrated entire codebase from CommonJS to TypeScript ESM
- Unified 3 map generator versions (v1, v2, v3) into single `src/utils/mapGenerator.ts`
- Entry point changed from `server.js` to `dist/index.js`
- Package type changed to `"module"` (ESM)
- All source files moved from root to `src/` directory structure
- Build step required: `npm run build` before `npm start`

### Added
- `src/knowledge/mapTemplates.ts` - Template-based map generation using ProjectR reference maps
- `knowledge/maps/` - 106 reference map JSONs from ProjectR for template-based generation
- `knowledge/map-templates.json` - Index of all 106 templates with category/theme metadata
- New `generateMap()` unified API supporting both procedural and template-based generation
- New `searchTemplates()` and `generateFromTemplate()` functions
- 21 procedural generation themes (forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world)
- TypeScript strict compilation with `@ts-nocheck` for gradual typing
- `npm run dev` script using tsx for development

### Removed
- `utils/mapGenerator.js` (v1 - merged into unified generator)
- `utils/mapGeneratorV2.js` (v2 - merged into unified generator)
- `utils/mapGeneratorV3.js` (v3 - base for unified generator)
- Root-level JS source files (all moved to `src/`)

### Technical Details
- 22 TypeScript source files across `src/tools/`, `src/utils/`, `src/knowledge/`
- 102 MCP tools functional
- Module resolution: node16
- Target: ES2022
