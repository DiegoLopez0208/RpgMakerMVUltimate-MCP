# Changelog

## [4.0.0] - 2026-06-02

### Changed
- **BREAKING**: Migrated entire codebase from CommonJS to TypeScript ESM
- Unified 3 map generator versions (v1, v2, v3) into single `src/utils/mapGenerator.ts`
- Entry point changed from `server.js` to `dist/index.js`
- Package type changed to `"module"` (ESM)
- All source files moved from root to `src/` directory structure
- Build step required: `npm run build` before `npm start`
- **Full TypeScript typing**: All 22 source files fully typed with zero `@ts-nocheck`. 383 `any` occurrences replaced with proper types
- **AI-agnostic Vision API**: Replaced hardcoded NVIDIA Llama 3.2 90B with configurable model via `VISION_MODEL` env var. Works with any OpenAI-compatible vision endpoint (OpenAI, Ollama, LocalAI, NVIDIA, etc.)
- `PROXY_VISION_URL` renamed to `VISION_API_URL`; added `VISION_API_KEY`, `VISION_API_PATH` env vars
- `PerlinNoise`, `PRNG`, `BSPNode` converted from prototype-based to ES6 classes

### Added
- `src/knowledge/mapTemplates.ts` - Template-based map generation using ProjectR reference maps
- `src/types/rpgmaker.ts` - 30+ shared TypeScript interfaces (EventCommand, MapEvent, ActorParams, SkillParams, SheetInfo, etc.)
- `knowledge/maps/` - 106 reference map JSONs from ProjectR for template-based generation
- `knowledge/map-templates.json` - Index of all 106 templates with category/theme metadata
- New `generateMap()` unified API supporting both procedural and template-based generation
- New `searchTemplates()` and `generateFromTemplate()` functions
- 21 procedural generation themes (forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world)
- `npm run dev` script using tsx for development
- `makeNpcEvent`, `makeChestEvent`, `makeBossEvent`, `makeTransferEvent` event builder functions

### Removed
- `utils/mapGenerator.js` (v1 - merged into unified generator)
- `utils/mapGeneratorV2.js` (v2 - merged into unified generator)
- `utils/mapGeneratorV3.js` (v3 - base for unified generator)
- Root-level JS source files (all moved to `src/`)
- `@ts-nocheck` directives from all files (fully typed)

### Technical Details
- 22 TypeScript source files across `src/tools/`, `src/utils/`, `src/knowledge/`, `src/types/`
- 102 MCP tools functional
- Module resolution: node16
- Target: ES2022
- Typed interfaces for all RPG Maker MV data structures
- Vision AI tool compatible with any OpenAI-compatible API
