# Changelog

## v3.1.0 — 2026-05-30

### Added
- **Vision AI analysis**: `analyze_screenshot` tool — sends project images (tilesets, sprites, map screenshots, battlers, faces) to NVIDIA Llama 3.2 90B Vision via the nvidia-glm-proxy for detailed AI-powered analysis. Uses sharp to resize/optimize images before sending. Default prompt in Spanish, RPG Maker MV-optimized.
- **Offline ASCII map rendering**: `render_map_ascii` tool — generates an ASCII representation of any map using tileset flag-based characters (water=~ wall=# ladder=H bush=" terrain=, tree=T decoration=D). Shows event positions as first-letter markers. Optional region ID layer. No API required.
- **`PROXY_VISION_URL` env var**: configurable proxy endpoint for vision API calls (default: `http://127.0.0.1:9999`)
- **`get_project_context` tool**: returns a complete pre-digested project overview (tilesets, maps, actors, items, sprites, etc.) — call this first before creating content
- **`validate_map` tool**: checks maps for invalid tile IDs, broken event commands, null references, missing page terminators

### Fixed (Fase 1 — 8 files)
- `assetTools.js`: `getTileIdsForTileset` now returns `{ availableTiles: categorizeTiles(...) }` wrapper
- `mapTools.js`: shop goods fallback `[0,1,0,0]`, shop code 302 format + code 605, inn gold check uses Script type 11, boss Self Switch A=1 + canEscape=0 + escape handler 602, puzzle door move route fix, NPC page1 activates Self Switch A, BOM handling in `readJsonDirect`
- `commandBuilder.js`: `conditionalVariable` operandType added, `battleProcessing` booleans→integers, `shopProcessing` correct format, `changeHP`/`changeEXP`/`changeLevel` false→0, `changeState` (code 313) builder added
- `fileHandler.js`: BOM stripping `\uFEFF` in `readJson`
- `stateTools.js`: `minTurns`/`maxTurns`/`stepsToRemove` `||` → `!== undefined` for proper 0 handling
- `enemyTools.js`: `exp`/`gold` `||` → `!== undefined` for proper 0 handling
- `mapGeneratorV2.js`: Region ID 0 → valid IDs (1 or 2)
- `server.js`: 7 tool argument unpacking fixes (duplicateMap, createShop, createInn, createBossEvent, createPuzzleSwitch, addEnemyToTroop, createRandomEncounterTroop), 7 inputSchema properties added

### Changed
- Server version: 3.0.0 → 3.1.0
- Tool count: 77+ → 79+

## v3.0.0 — 2026-05-28

### Added
- **Knowledge-driven map generation (V2)** with 11 themes: forest, dungeon, town, castle, cave, village, swamp, desert, ruins, interior, beach
- **Asset scanning tools**: `scan_project_assets`, `get_tile_ids_for_tileset`
- **Knowledge base**: 7 static JSON reference files (tile-ids, passage-flags, event-commands, enums, trait-effect-codes, database-schemas, image-paths)
- `mapGeneratorV2.js` — tileset-aware generator with 6-layer support (ground, upper, shadow bits, region ID)
- `assetTools.js` — scans img/ folders and Tilesets.json, categorizes tiles by type, uses sharp for image dimensions
- Proper shadow layer (z=4) and region layer (z=5) in generated maps
- `create_map` auto-detects tileset and uses V2 when tile data is available, falls back to V1

### Changed
- `create_map` theme enum expanded from 5 → 11 themes
- Map fill rate improved from ~21% (V1) to ~39-42% (V2) with proper layer usage
- Server version bumped to v3.0

### Fixed
- Layer mapping corrected: z=0,1=ground, z=2,3=upper, z=4=shadow bits, z=5=region ID (V1 incorrectly labeled layer 3 as region)

## v2.0.0

### Added
- High-level event builders: NPC, chest, teleport, shop, inn, boss, puzzle switch
- Map event CRUD: create, update, delete, search
- Duplicate map tool
- System tools: switches, variables, game title, starting position
- Vision tools: tileset image analysis, screenshot quadrant analysis
- Enemy boss builder
- Skill simplified builders: damage, healing, buff, state

## v1.0.0

### Added
- Initial MCP server with 75 tools
- Basic map generation with 5 themes and 8 hardcoded RTP tile IDs
- Actor, item, weapon, armor, skill, class, enemy, state CRUD
- Map, event, tileset, common event, troop, animation tools
- Project summary and path switching
