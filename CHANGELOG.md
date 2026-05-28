# Changelog

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
