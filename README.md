# RPG Maker MV Ultimate MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for RPG Maker MV project management. Provides **102 tools** for actors, classes, skills, items, weapons, armors, enemies, states, troops, common events, maps, events, tilesets, animations, system settings, project management, **AI vision analysis**, **offline ASCII map rendering**, and **knowledge-driven map generation**.

## Features

- **102 MCP tools** covering every aspect of RPG Maker MV project data
- **TypeScript ESM** — fully typed codebase with strict compilation, zero `@ts-nocheck`
- **Vision AI analysis** — `analyze_screenshot` sends project images to any OpenAI-compatible vision API (OpenAI, Ollama, LocalAI, NVIDIA, etc.) for AI descriptions
- **Offline ASCII map rendering** — `render_map_ascii` generates ASCII maps with event markers and region IDs, no API needed
- **Knowledge-driven map generation** with 21 themes, procedural generation (Perlin noise, BSP, cellular automata), and 106 template maps
- **Template-based map generation** — generates maps from ProjectR reference templates
- **Asset scanning** — indexes your project's img/ folder and Tilesets.json to build categorized tile inventories
- **7 static knowledge files** — tile IDs, passage flags, event commands, enums, trait/effect codes, database schemas, image paths
- **High-level event builders** — NPC with dialogue, chest, teleport, shop, inn, boss battle, puzzle switch, transfer
- **Map validation** — detects invalid tile IDs, broken event commands, null references
- **21 procedural themes** — forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world

## Quick Start

```bash
npm install
npm run build
RPGMAKER_PROJECT_PATH=/path/to/your/project npm start
```

### With Claude Desktop / opencode / any MCP client

Add to your MCP config:

```json
{
  "mcpServers": {
    "rpgmaker-mv": {
      "command": "node",
      "args": ["/path/to/RpgMakerMVUltimate-MCP/dist/index.js"],
      "env": {
        "RPGMAKER_PROJECT_PATH": "/path/to/your/project"
      }
    }
  }
}
```

## Tool Categories

| Category | Tools | Description |
|---|---|---|
| **Actor** | 6 | CRUD, search, delete |
| **Item/Weapon/Armor** | 6 | CRUD, search, delete |
| **Skill** | 9 | Full + simplified builders (damage, healing, buff, state), CRUD |
| **Class** | 6 | CRUD, search, delete |
| **Enemy** | 7 | CRUD, boss builder, search, delete |
| **State** | 6 | CRUD, search, delete |
| **Map** | 15 | CRUD, fill layer, events, search, delete, duplicate |
| **Event Helpers** | 8 | NPC, chest, teleport, shop, inn, boss, puzzle switch, transfer |
| **Tileset** | 3 | Get, update |
| **Common Event** | 4 | CRUD, add command |
| **Troop** | 5 | CRUD, add enemy, random encounter builder |
| **Animation** | 2 | Get, get by ID |
| **System** | 8 | Switches, variables, game title, starting position |
| **Project** | 4 | Summary, context, validate map, set path |
| **Asset** | 2 | Scan project assets, get tile IDs for tileset |
| **Vision AI** | 2 | AI screenshot analysis (OpenAI-compatible), ASCII map render |
| **Image** | 2 | Tileset dimension analysis, screenshot quadrant analysis |

## Vision AI

The `analyze_screenshot` tool sends project images to an OpenAI-compatible vision API for AI-powered analysis. Works with any endpoint that supports the `/v1/chat/completions` API format.

**Supported backends**: OpenAI, Ollama, LocalAI, NVIDIA NIM, vLLM, LiteLLM, or any OpenAI-compatible proxy.

### Configuration

Set these environment variables to enable vision analysis:

| Variable | Default | Description |
|---|---|---|
| `VISION_API_URL` | `http://127.0.0.1:9999` | Base URL of the vision API |
| `VISION_API_KEY` | `sk-proxy` | API key / bearer token |
| `VISION_MODEL` | `meta/llama-3.2-90b-vision-instruct` | Model name to use |
| `VISION_API_PATH` | `/v1/chat/completions` | API endpoint path |

### Usage

```json
{
  "tool": "analyze_screenshot",
  "arguments": {
    "image_path": "img/tilesets/Outside.png",
    "prompt": "Describe the tile categories and colors",
    "resize_max": 1024
  }
}
```

Works with: tilesets, character sprites, map screenshots, battlers, faces, etc.

### OpenAI Example

```bash
VISION_API_URL=https://api.openai.com \
VISION_API_KEY=sk-... \
VISION_MODEL=gpt-4o \
npm start
```

### Ollama Example

```bash
VISION_API_URL=http://localhost:11434 \
VISION_MODEL=llava \
npm start
```

### Without Vision AI

Set no `VISION_API_URL` or leave it unset. All other 100 tools work offline. `render_map_ascii` provides visual map inspection without any API.

### render_map_ascii

Generates an ASCII representation of a map. No API required — works offline.

```json
{
  "tool": "render_map_ascii",
  "arguments": {
    "map_id": 1,
    "layer": 0,
    "show_events": true,
    "show_regions": false
  }
}
```

Output uses tileset flag-based characters: `.` empty, `~` water, `#` wall, `H` ladder, `"` bush, `,` terrain, `T` tree, `D` decoration, `A` autotile. Event positions shown as first-letter markers.

## Map Generation

The unified map generator produces coherent, beautiful maps using your project's actual tilesets:

```json
{
  "tool": "create_map",
  "arguments": {
    "name": "Dark Forest",
    "width": 30,
    "height": 25,
    "tilesetId": 2,
    "theme": "forest",
    "displayName": "The Dark Forest"
  }
}
```

### Themes

`forest` `town` `village` `castle` `dungeon` `cave` `beach` `desert` `swamp` `ruins` `interior` `snow` `harbor` `volcano` `sewer` `fortress` `magic_forest` `magic_interior` `space_interior` `space_exterior` `world`

### Template-Based Generation

Generate maps from 106 ProjectR reference templates:

```json
{
  "tool": "create_map",
  "arguments": {
    "templateId": 1,
    "displayName": "Custom Forest"
  }
}
```

### How It Works

1. `create_map` calls `get_tile_ids_for_tileset` to read the tileset's actual tiles
2. Categories tiles into: ground, water, wallSide, wallTop, roof, decoration
3. Generates a 6-layer map: z=0,1 (ground), z=2,3 (upper), z=4 (shadow bits), z=5 (region ID)
4. Falls back to hardcoded RTP IDs if tileset scan fails (backward compatible)
5. Procedural generators use Perlin noise, BSP tree partitioning, and cellular automata

### Asset Scanning

```json
{ "tool": "scan_project_assets" }
```

Returns tileset sheet metadata (dimensions, tile counts, autotile kinds), categorized available tiles, and all PNG files in img/ subdirectories.

## Knowledge Base

Static JSON files in `knowledge/` provide technical reference data extracted from the RPG Maker MV corescript:

| File | Content |
|---|---|
| `tile-ids.json` | Tile ID ranges, autotile formula, sheet descriptions |
| `passage-flags.json` | Flag bits, common flags, passage check logic |
| `event-commands.json` | ~140 event command codes with parameter schemas |
| `enums.json` | Scope, occasion, hitType, damageType, restriction, etc. |
| `trait-effect-codes.json` | Trait codes 11-64, effect codes 11-45 |
| `database-schemas.json` | Full schemas for all MV data types |
| `image-paths.json` | img/ directories, tileset slots, naming conventions |

See [knowledge/README.md](knowledge/README.md) for details.

## Development

```bash
npm install
npm run build          # tsc compile
npm start              # run built server
npm run dev            # tsx watch mode for development
```

### Project Structure

```
src/
  server.ts              # MCP server entry point (tool dispatch + handlers)
  index.ts               # Re-export entry
  types/
    rpgmaker.ts           # Shared TypeScript interfaces for all MV data structures
  tools/
    actorTools.ts         # Actor CRUD
    animationTools.ts     # Animation get
    assetTools.ts         # Asset scanning + tile ID categorization
    classTools.ts         # Class CRUD
    commonEventTools.ts   # Common event CRUD
    enemyTools.ts         # Enemy CRUD + boss builder
    itemTools.ts          # Item/Weapon/Armor CRUD
    mapTools.ts           # Map CRUD + event builders + generation integration
    projectTools.ts       # Project summary + path switch
    skillTools.ts         # Skill CRUD + simplified builders
    stateTools.ts         # State CRUD
    systemTools.ts        # System switches/variables/title
    tilesetTools.ts       # Tileset get/update
    troopTools.ts         # Troop CRUD + encounter builder
  utils/
    fileHandler.ts        # readJson/writeJson/nextId/getMapPath
    commandBuilder.ts     # Event command factory (35+ commands)
    mapGenerator.ts       # Unified generator (Perlin, BSP, cellular, 21 themes)
    logger.ts             # Logging utility
  knowledge/
    mapTemplates.ts       # Template index loading + search
knowledge/
  maps/                   # 106 ProjectR reference map JSONs
  map-templates.json      # Template index
  tile-ids.json           # Tile ID ranges and formulas
  passage-flags.json      # Passage flag bits
  event-commands.json     # Event command reference
  enums.json              # Enum value reference
  trait-effect-codes.json # Trait and effect codes
  database-schemas.json   # MV data type schemas
  image-paths.json        # Image path conventions
```

## License

MIT
