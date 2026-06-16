# Changelog

## [5.3.0] - 2026-06-16

Grounded the MCP in the actual RPG Maker MV engine (a dev script distills
`rpg_core.js`/`rpg_objects.js` + the default project into `src/data/engineDefaults.ts`,
with a runtime fallback that reads the active project's own `js/rpg_core.js`), and
fixed the "enemies don't work" report end-to-end (verified by playing the game).

### Fixed
- **Enemies were invisible in battle.** Created enemies kept `battlerName: ""`. `create_enemy`/`create_boss_enemy` now assign a real battler sprite that exists in the project (front-view `img/enemies` or side-view `img/sv_enemies` per System.json), varied per enemy, and validate any provided name.
- **No random encounters.** Generated maps shipped `encounterList: []` and there was no way to set encounters, so dungeons/caves had no battles. Added `set_map_encounters` (and `edit_map` action `"set_encounters"`); combat-theme generation (dungeon/cave/world/fortress/sewer/volcano) now auto-populates encounters from the project's troops.
- **`cmd.changeLevel` used command 317 (Change Parameter) instead of 316 (Change Level)** — verified against the engine's `command###` definitions.
- **Autotiling now classifies tiles exactly as the engine does** (`isFloorTypeAutotile`/`isWallTypeAutotile`/wall-top vs wall-side from `rpg_core.js`). A4 interior walls jumped from a ~70% heuristic to wall-top 95% / wall-side 87% (A1 98 / A2 99 / A3 93 unchanged); the A4 zone heuristic is gone.
- **Generalized asset validation**: every map write funnels through one sanitizer that validates event sprites, Show Text face graphics, parallax/battleback images and bgm/bgs against the project, blanking anything missing so no resource can trigger MV's fatal Loading Error.

### Added
- `create_database_entry` fills any missing fields from the engine's canonical default templates, so every created entry is structurally battle/menu-complete.
- `scripts/extract-engine.mjs`, `src/data/engineDefaults.ts`, `src/utils/engine.ts`.

### Note
- Existing projects whose **class `params` are a flat 8-value array** (written by a pre-4.1.1 MCP) give actors null max-HP and crash any battle (`createLinearGradient` non-finite). The current MCP always expands class params to MV's 8×100 curves on create/update; re-saving each class through `update_database_entry` repairs old data.

## [5.2.4] - 2026-06-16

### Fixed
- **The MCP could write events referencing character sprites that don't exist, which fatally halts the game** with RPG Maker MV's full-screen "Loading Error: Failed to load img/characters/X.png" (this was the real cause behind reports of the project "throwing a data error" / maps "breaking everything"). Root cause found by replaying the actual agent session: the agent hand-authored chest events via `manage_map_event` with `characterName: "Chest"`, but the project ships `!Chest.png` — so the tool faithfully wrote a sprite the game can't load. Every map write now sanitizes event sprites against the project's `img/characters/`: it auto-corrects the RPG Maker object prefixes agents commonly miss (`Chest` → `!Chest`, etc.) and blanks (renders invisible — never crashes) anything it still can't resolve. Verified in-game: a generated cave with chests that previously froze on the Loading Error now loads and plays with visible chests
- **The procedural generator's own chest sprite was wrong too** (`makeChestEvent` used `'Chest'`); fixed to `'!Chest'`. Generated NPCs, bosses and house doors — previously invisible (`characterName: ''`) — now use real sprites (`People1`, `Monster`, `!Door1`)

## [5.2.3] - 2026-06-15

### Fixed
- **Generated maps used the wrong tileset, rendering as garbage.** `generate_map` defaulted `tilesetId` to 1 (Overworld) regardless of theme, so a `town` (whose tiles are Outside-tileset tiles) was painted with the Overworld tileset. The tileset is now auto-selected from the theme (Outside=2, Inside=3, Dungeon=4, Overworld=1) unless you pass one explicitly
- **Interior furniture (and several decorations) were blank/non-existent tiles.** Furniture was placed from A5 ids 1537-1547, but in the Inside tileset A5 is floor patterns — real furniture lives in the B/C object pages. Decorations across the Outside and Inside tilesets are now real object tile ids confirmed used by the ProjectR reference maps (so they always exist). Exact object semantics are best-effort (derived from default-tileset usage); multi-tile objects like trees are still placed as single decorative tiles

## [5.2.2] - 2026-06-15

### Fixed
- **Town/village roads (and other outdoor ground) rendered as water.** In the `outside`, `sf_outside` and `magic_exterior` tilesets, ground types (`dirt`, `stone`, `sand`, `darkGrass`, `concrete`, `metal`, `asphalt`) used autotile kinds below 16, which resolve to the A1 *animated-water* sheet — so dirt roads, pavement and sand all rendered as water. They now use real A2 ground kinds, verified against the ProjectR reference tileset (id 2): k16 grass, k18 dirt/road, k17/24/32/34/40 for the rest. (Water/oasis/beach features that are intentionally A1 are unchanged.)

## [5.2.1] - 2026-06-15

### Fixed
- **Procedurally-generated maps wrote a 0-indexed event array** (first event had `id` 0). RPG Maker MV event arrays are 1-indexed with `index 0 = null`, and — crucially — its Control Self Switch command is guarded by `if (this._eventId > 0)`, so an event with id 0 silently never sets its self switch. The first generated chest/boss/NPC on every procedural map therefore reopened/respawned/repeated even after the 5.2.0 self-switch fix. Generated event arrays now start at `[null]` with ids beginning at 1, matching MV

### Notes
- Reviewed A4 interior wall rendering: the 5.2.0 zone-based shaper already produces structurally correct walls for generated maps (verified on thick dungeon masses and thin interior rooms — top cap / face / side edges / corners / fill all placed correctly). The ~70% figure reflects stylistic variance against hand-drawn reference maps, not defects in generated output, so the larger structural wall rebuild was intentionally not pursued

## [5.2.0] - 2026-06-15

### Fixed
- **Procedurally-generated chests reopened and bosses respawned.** The internal `makeChestEvent`/`makeBossEvent` in the map generator wrote Self Switch A with value `1` (= OFF in MV, where `command123` sets `value = params[1] === 0`), so the page-2 "already opened/defeated" state never activated. The 4.1.1 self-switch fix corrected the manual preset tools but missed these two generator-internal makers. Both now write `['A', 0]` (ON)
- **The inn's gold check never worked.** `create_inn` used Conditional Branch type `11` (Button pressed) with a script string, so the "can you afford it?" check evaluated a key-press, not gold. Now uses type `12` (Script)
- **`cmd.conditionalVariable` produced a malformed Conditional Branch.** Parameters were `[1, varId, operator, 0, val]`; MV expects `[1, varId, operandType, operandValue, comparisonOp]`, so it compared the variable against variable #0 and used the value as the operator. Corrected to `[1, varId, 0, val, operator]`

### Added
- **A4 interior walls are now shaped (tall-wall autotiling).** The autotiler previously skipped A4 (left walls flat at shape 0, ~25% correct). A4 walls now render as a pseudo-3D vertical structure — top cap / body / bottom face — via a zone-based heuristic derived from the bundled maps (~70%; the high-traffic fills, edges and corners are 86-91% confident). A1/A2/A3 remain near-exact (97/99/93%)
- **`door` event preset** on `manage_map_event`: an action-button warp into another map (e.g. a house entrance), with an optional sprite and an optional `lockedSwitchId` that shows a "locked" message until a game switch is ON
- **Enterable house interiors.** Procedural `town`/`village` generation now creates an interior map for every house and wires a two-way warp: an action-button door on the house entrance leads inside, and a walk-on exit mat returns the player to the street below the door. The new interior map IDs are returned in `interiorMapIds`; opt out with `enterableHouses: false`

## [5.1.0] - 2026-06-15

### Fixed
- **Procedural map generator produced maps made of water.** `makeAutotileId(kind, shape, sheetBase)` silently dropped its 3rd argument and always computed `2048 + kind*48 + shape`, so every tile resolved from the A1 (animated water) sheet. Floors and walls in the `inside`, `dungeon`, `sf_inside`, `space_interior`, `sf_outside` themes — plus the walls of `outside`/`magic_exterior` — rendered as water. Only `overworld` was unaffected (it used global autotile kinds). The base offset is now honored, so A2 floors, A3 roofs/walls and A4 walls resolve correctly. `validate_map` never caught this because the wrong tiles were still valid IDs

### Added
- **Autotiling: generated maps now border their tiles.** Generators painted every autotile at shape 0 (flat blocks with hard square edges and no shorelines). A new `src/utils/autotile.ts` recomputes the MV autotile shape (0-47) for each cell from its 8 neighbours and runs as a post-pass in `generateTileLayoutV3` (opt out with `autotile: false`). The shape lookup tables were derived empirically from the 106 bundled reference maps and validated to reproduce them: **A1 water 97%, A2 ground/floors 99%, A3 roofs/exterior walls 93%** (generated maps that follow the rule are exact). A4 interior walls are left as solid blocks — their pseudo-3D tall-wall shapes depend on vertical run length, which an 8-neighbour model can't recover (only ~55%), so they are deliberately not auto-shaped to avoid visible seams

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
