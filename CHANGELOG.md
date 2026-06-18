# Changelog

## [5.9.0] - 2026-06-17

### Fixed
- **Generated events landed inside walls/water.** `generateEvents` placed chests, bosses and NPCs at `rng.nextInt(3,w-4)` with no passability check, so a dungeon chest could sit in a wall and a town NPC in a pond. Events are now walkability-gated: a new `isPlaceableFloor`/`findFloorTile` scans for a region-1 (walkable floor) tile with empty upper layers. The dungeon boss now targets the BSP boss-room centre (region 2) instead of a fixed `(w*0.75, h*0.25)` corner that was often a wall. Verified in-game: chests/bosses/NPCs stand on real floor.
- **`carveDoorPath` plowed through neighbouring buildings.** The door-to-road path carved straight down ≤18 tiles overwriting whatever was in the column, so a house placed below another could be sliced through. It now stops at the road OR at any placed object (non-empty upper layer) instead of carving through it.
- **`makeAutotileId` silently resolved a falsy sheet base to the A1 water sheet.** The `(sheetBase || 2048)` fallback meant passing `0`/`undefined` produced animated-water tiles with no error — the original cause of the "maps made of water" bug. It now throws on a non-positive sheet base; the intentional 2-arg default (2048) still works.
- **Generated NPCs said "...".** Town/village/dungeon/interior NPCs now speak themed dialogue (welcome, warnings, inn/shop flavour) picked per theme, so maps read like a real game.

### Improved
- **Towns are no longer a rigid plus-sign.** The symmetric central cross + square plaza read as a sign-of-the-cross with boxes around it. Roads are now an organic network: a main cross offset off-centre plus 1-2 spur lanes, and the plaza is an irregular blob whose edge is warped by Perlin. Verified: a 34×28 town yields ≥3 distinct road columns and rows (was 1 of each).
- **Houses are no longer identical boxes.** `buildAutotileHouse` now picks from three footprints — plain rectangle, L-shape (notched corner) and wide manor (taller roof) — with an off-centre door and an optional front fence, so a town is a mix of cottages, wings and manors instead of samey little rectangles. Verified in-game (varied 4–6-wide roofs, L-notches, offset doors).
- **Forest clearing is no longer a perfect circle.** The centred round dirt patch read as a bullseye. It is now an irregular blob whose radius is warped by Perlin, with a campfire landmark (well tile + flanking stumps) so the clearing is a focal point.
- **Outdoor decoration clumps into groves.** A new `placeDecoClusters` places trees/props in clumps around seed points (the way real vegetation grows) alongside the even scatter, so forests have dense copses and open grass instead of a uniform sprinkle.
- **Perlin noise is normalized to map size.** Hardcoded frequencies (forest 0.06, world 0.03, …) barely completed one noise period on a small map, producing near-uniform single-biome slabs. A `noiseScale(base,w,h) = base * 30/min(w,h)` is now applied to every Perlin terrain theme, so small procedural maps vary and large ones stay broad.
- **Procedural generation now receives the project's real scanned tiles.** `createMapV3` (the `generate_map mode:"procedural"` path) didn't pass `availableTiles`, so custom tilesets always hit the decoration fallback. It now scans the tileset (like `createMap`) and the forest fallback prefers the project's real decoration tiles; when no stamp library exists, trees are omitted rather than emitted as broken single-tile fragments.

### Added
- Pretty-maps regression suite (6 tests): `makeAutotileId` footgun, `noiseScale` normalization, dungeon chest/boss walkability, themed NPC dialogue, organic town road network, house generation. Helpers `makeAutotileId`, `noiseScale`, `isPlaceableFloor`, `findFloorTile` exported for testing.

## [5.8.0] - 2026-06-17

### Improved
- **Production-quality map detail (informed by RPG Maker mapping tutorials).** Three anti-"flat map" passes:
  - **Floor-texture variation** in dungeons: room floors now get a sparse moss/dark-floor sprinkle so stone no longer reads as one flat slab.
  - **Outdoor ground detail** in towns: small flowers/grass details scattered across open grass break the flat green.
  - **Real dungeon props instead of A5 floor tiles.** Dungeon & cave decoration now uses mined multi-tile **prop stamps** (upright torches/statues/pillars/crates placed against walls and clustered in corners), filtered to fully-filled footprints. This fixes stray **black/flat squares** that came from placing single A5 tiles (which are floor-material, not objects). Verified in-game (no black tiles; coherent props; less flat floors/grass).

## [5.7.0] - 2026-06-17

### Improved
- **Town plaza + dungeon room variety** (informed by RPG Maker town-mapping guides). Towns now open onto a central paved **plaza/marketplace** at the crossroad with landmark props at its corners — a proper town focal point instead of a bare cross. Dungeon rooms now vary per room: a **columned hall** (corner pillars), a small **water pool**, or scattered dungeon objects (torches/crates/bones/chests) — using only known-good A5 objects so no stray/black tiles. Verified in-game.

## [5.6.0] - 2026-06-17

### Added
- **Building types with purpose + smart interiors.** Town/village now generate a mix of **homes, shops and inns**. Each gets a thematic interior: a *smart floor* chosen for the room type (wood for homes, carpet for inns, stone/tile for shops — no more jarring random floors), type-appropriate furniture, and a fitting occupant — a **functional shopkeeper** (opens a real shop with the project's items), an **innkeeper** that fully heals the party, or a resident with dialogue. Interiors are named by type (Shop/Inn/House). Verified in-game.

## [5.5.0] - 2026-06-16

### Improved
- **House & interior variety.** Town/village houses now pick from the two Outside_A3 building sets (10 roof kinds, each with its matching wall) so roofs vary in colour/style instead of all looking the same. Auto-generated house interiors now vary too: per-house room size, a random floor (wood/carpet/tile), an optional rug, and furniture placed as real multi-tile prop stamps — so no two houses feel identical. Verified in-game (varied red/brown/etc. roofs; differently-sized, differently-furnished interiors).

## [5.4.2] - 2026-06-16

### Improved
- **Houses now look like real RPG Maker MV buildings.** The 5.4.0 approach of stamping mined B/C building *fragments* produced incoherent half-buildings and walled enclosures (verified by rendering the stamps in-game). Town/village houses are now constructed the way RTP maps actually build them: a multi-row **A3 roof autotile over an A3 wall strip with a doorway**, so the engine's autotiler shapes the roof eaves/peak and wall edges. Result (verified in-game): coherent red-roofed houses with a visible door, a dirt path to the road, and whole-tree decoration around them. Trees/props still use the mined multi-tile stamps (those render correctly).

## [5.4.1] - 2026-06-16

### Improved
- **Smarter town layout.** Houses no longer float in empty grass disconnected from the streets: every house door is now linked to the nearest road by a carved dirt path, so the town reads as planned and every house is reachable. Decoration (trees/props) is a bit denser to fill the blocks but is kept off roads *and* off the door paths. Verified in-game.

## [5.4.0] - 2026-06-16

### Fixed
- **Maps placed generic houses and "random tiles everywhere".** The generator drew houses as plain autotile rectangles and scattered single decoration tiles, but RTP houses/trees are multi-tile objects — single tiles render as fragments. The generator now stamps **real multi-tile objects** (houses with door anchors, whole trees, props) mined from the reference maps, placed with spacing/collision and off roads. Verified in-game: towns have real buildings, forests have whole trees, no scattered fragments.
- **Bundled knowledge wasn't shipped in built mode.** `postbuild` ran `cp -r knowledge dist/knowledge`, but `tsc` had already created `dist/knowledge/` (from `src/knowledge/`), so the data nested into `dist/knowledge/knowledge/` and never loaded (templates, and now stamps). Fixed to copy the contents into `dist/knowledge/`.

### Added
- **Object-stamp system**: `scripts/extract-stamps.mjs` mines `knowledge/stamps.json` (houses/trees/props per tileset, with door anchors); `src/utils/stamps.ts` loads and stamps them; the generator uses them with a graceful fallback for projects without a stamp library.
- **Portable agent SKILL** at `skill/rpgmaker-mv-mcp/SKILL.md` (better-skills format) teaching any AI the correct, crash-free MCP workflow — installable into `~/.agents/skills` etc. Tool guidance (`get_project_context`) tightened with golden rules so agents stop hand-painting tiles and guessing IDs.

## [5.3.1] - 2026-06-16

### Fixed
- **A moved/renamed/missing project made the whole MCP unusable.** The server called `process.exit(1)` when `RPGMAKER_PROJECT_PATH` was unset or didn't point at a valid project, so the client (e.g. OpenCode) couldn't start the MCP at all. The server now logs a warning and starts anyway: `tools/list` works, and `set_project_path` (or fixing the env var) can point it at a valid project at runtime. Tools that need a project already return a clear actionable error.

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
