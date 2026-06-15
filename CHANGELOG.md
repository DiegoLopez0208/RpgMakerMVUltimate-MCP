# Changelog

## [5.0.0] - 2026-06-12

### Changed
- **BREAKING (advertised surface only): 101 tools consolidated into 12.** The new tools select their operation via a discriminator argument: `query_database`, `create_database_entry`, `update_database_entry`, `delete_database_entry` (entity), `query_map` (view), `generate_map` (mode), `edit_map`, `manage_map_event`, `manage_system` (action), `get_project_context` (detail), `set_project_path`, `analyze_image` (mode). All v4 tool names keep working as call aliases; set `RPGMV_LEGACY_TOOLS=1` to re-advertise them in `tools/list`
- Tool responses now include `structuredContent` alongside the JSON text
- The JSON-RPC numeric-id-to-string coercion on responses (a spec violation shipped since v3) is now opt-in via `RPGMV_STRING_IDS=1`
- `main()` no longer auto-runs on module import; `dist/index.js` remains the entry point

### Added
- `generate_map` mode `template` + `get_project_context` detail `templates`: the 106 bundled reference maps (`knowledge/`) are finally reachable (they shipped unused since 4.0.0)
- Integration test suite (32 tests) exercising every v5 tool against a fixture project, including regression tests for every 4.1.1 bug (Zod key drops, Self Switch inversion, shop 302, class curves, displayName)

### Fixed
- The postbuild step copied the template data to `dist/knowledge/knowledge/`, so the template index never loaded even in built servers (latent since 4.0.0)

## [4.1.1] - 2026-06-11

### Fixed
- **Zod validation key mismatch** that silently broke 6 tools: schemas used snake_case (`map_id`, `mp_cost`) while tools send camelCase, and Zod strips unknown keys. `create_npc` always failed with "map_id: Required"; `create_damage_skill`/`create_healing_skill`/`create_buff_skill`/`create_state_skill` dropped `mpCost`/`formula`/`paramId`/`stateId` and produced corrupt skills; `create_map` ignored `tilesetId`/`bgmName`/`displayName`. Schemas rewritten in camelCase with `z.coerce.number()` (numeric strings are now coerced before hitting the data files); each skill helper has its own schema
- **Self Switch commands inverted** (MV treats `parameters[1] === 0` as ON): `create_npc` page 2 never activated, bosses from `create_boss_event` reappeared after defeat, the `create_puzzle_switch` door re-locked itself. All now write ON correctly; `validate_map`'s self-switch check had the same inversion and flagged correct events
- **`create_shop` always sold item #1**: the Shop Processing command (302) carries the first good in its own parameters and it was hardcoded `[0, 1]`; custom prices (`priceType`/`price`) were also discarded. Goods are now passed through intact, first good in the 302, rest as 605
- **`create_puzzle_switch` argument mix-up**: `switchName` was passed as a sprite filename and `doorName` was ignored; both now set the event names as documented
- **`create_class` produced engine-crashing classes**: `params` was written as one flat 8-value array, but MV expects 8 curves of 100 per-level values (`params[paramId][level]`). Flat seed input now expands to full 1-99 curves (seed at level 1 growing to 10x at 99); 8x100 arrays are passed through. `expParams` default corrected to the editor's [30, 20, 30, 30]
- **`set_map_display_names` edited the wrong field**: it renamed the editor map-tree entry (MapInfos `name`) instead of the player-visible `displayName` inside each map file
- **`analyze_screenshot` only worked over plain HTTP**: rewritten with `fetch`, so `https://` Vision endpoints (OpenAI, NVIDIA) now work; `VISION_API_PATH` defaults to `/v1/chat/completions` instead of posting to `/`
- `create_skill` no longer overwrites legitimate falsy values (`iconIndex: 0` became 64, `successRate: 0` became 100, `scope: 0` became 1) — `??` instead of `||`
- `update_skill` can no longer desync an entry by passing `id` inside `fields`
- `create_chest` default sprite corrected from `'Chest'` (missing in default projects) to `'!Chest'`
- **Concurrent tool calls corrupted project files**: the MCP SDK dispatches requests concurrently, so parallel calls writing the same data file interleaved their writes (found by integration testing — Map001.json ended up with trailing garbage). Tool executions are now serialized through a single-flight queue

## [4.1.0] - 2026-06-11

### Changed
- **Complete rewrite of all tool descriptions** for MCP tool-definition quality: every tool now documents its behavior (which data file it reads/writes, immediate disk writes, no undo), return value, error conditions, and when to use it vs. related tools
- All parameter descriptions rewritten with semantic meaning (value ranges, defaults, default-database ID references, validation caveats) instead of restating the schema
- Tool definitions extracted from `server.ts` into `src/toolDefinitions.ts`

### Added
- **MCP behavior annotations** (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on all 101 tools so clients can reason about safety; `analyze_screenshot` is flagged `openWorldHint: true` for its external Vision API call

### Removed
- `get_all_skills` removed from the advertised tool list (exact duplicate of `get_skills`); calls to it still work for backward compatibility

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
