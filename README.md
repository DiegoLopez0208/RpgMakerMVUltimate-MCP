# RPG Maker MV Ultimate MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for RPG Maker MV project management. Provides **79+ tools** for actors, classes, skills, items, weapons, armors, enemies, states, troops, common events, maps, events, tilesets, animations, system settings, project management, **AI vision analysis**, **offline ASCII map rendering**, and **knowledge-driven map generation**.

## Features

- **79+ MCP tools** covering every aspect of RPG Maker MV project data
- **Vision AI analysis** — `analyze_screenshot` sends project images to NVIDIA Llama 3.2 90B Vision via proxy for detailed AI descriptions (tilesets, sprites, map screenshots)
- **Offline ASCII map rendering** — `render_map_ascii` generates ASCII maps with event markers and region IDs, no API needed
- **Knowledge-driven map generation (V2)** with 11 themes, shadow/region layers, and tileset-aware tile selection
- **Asset scanning** — indexes your project's img/ folder and Tilesets.json to build categorized tile inventories
- **7 static knowledge files** — tile IDs, passage flags, event commands, enums, trait/effect codes, database schemas, image paths
- **High-level event builders** — NPC with dialogue, chest, teleport, shop, inn, boss battle, puzzle switch
- **Map validation** — detects invalid tile IDs, broken event commands, null references
- **CommonJS, no TypeScript** — pure Node.js, zero build step

## Quick Start

```bash
npm install
RPGMAKER_PROJECT_PATH=/path/to/your/project node server.js
```

### With Claude Desktop / opencode

Add to your MCP config:

```json
{
  "mcpServers": {
    "rpgmaker-mv": {
      "command": "node",
      "args": ["/path/to/RpgMakerMVUltimate-MCP/server.js"],
      "env": {
        "RPGMAKER_PROJECT_PATH": "/path/to/your/project",
        "PROXY_VISION_URL": "http://127.0.0.1:9999"
      }
    }
  }
}
```

> **Vision AI**: Set `PROXY_VISION_URL` to your [nvidia-glm-proxy](https://github.com/DiegoLopez0208/nvidia-glm-proxy) instance to enable `analyze_screenshot`. Without it, only `render_map_ascii` (offline) is available.

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
| **Event Helpers** | 6 | NPC, chest, teleport, shop, inn, boss, puzzle switch |
| **Tileset** | 3 | Get, update |
| **Common Event** | 4 | CRUD, add command |
| **Troop** | 5 | CRUD, add enemy, random encounter builder |
| **Animation** | 2 | Get, get by ID |
| **System** | 8 | Switches, variables, game title, starting position |
| **Project** | 4 | Summary, context, validate map, set path |
| **Asset** | 2 | Scan project assets, get tile IDs for tileset |
| **Vision AI** | 2 | AI screenshot analysis (Llama 3.2 90B Vision), ASCII map render |
| **Image** | 2 | Tileset dimension analysis, screenshot quadrant analysis |

## Vision AI

### analyze_screenshot

Sends a project image to NVIDIA Llama 3.2 90B Vision via the nvidia-glm-proxy for AI-powered analysis. Works with tilesets, character sprites, map screenshots, battlers, faces, etc.

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

**Requirements**: [nvidia-glm-proxy](https://github.com/DiegoLopez0208/nvidia-glm-proxy) v1.1.0+ running with `VISION_MODEL=meta/llama-3.2-90b-vision-instruct`.

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

## Map Generation V2

The enhanced map generator produces coherent, beautiful maps using your project's actual tilesets:

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

### Supported Themes

`forest` `dungeon` `town` `castle` `cave` `village` `swamp` `desert` `ruins` `interior` `beach`

### How It Works

1. `create_map` calls `get_tile_ids_for_tileset` to read the tileset's actual tiles
2. Categories tiles into: ground, water, wallSide, wallTop, roof, decoration
3. Generates a 6-layer map: z=0,1 (ground), z=2,3 (upper), z=4 (shadow bits), z=5 (region ID)
4. Falls back to hardcoded RTP IDs if tileset scan fails (backward compatible)

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

## Project Structure

```
server.js                   # MCP server entry point (77+ tool definitions + dispatch)
tools/
  actorTools.js             # Actor CRUD
  itemTools.js              # Item/Weapon/Armor CRUD
  skillTools.js             # Skill CRUD + simplified builders
  classTools.js             # Class CRUD
  enemyTools.js             # Enemy CRUD + boss builder
  stateTools.js             # State CRUD
  mapTools.js               # Map CRUD + V2 generator integration
  tilesetTools.js           # Tileset get/update
  systemTools.js            # System switches/variables/title
  commonEventTools.js       # Common event CRUD
  troopTools.js             # Troop CRUD + encounter builder
  animationTools.js         # Animation get
  projectTools.js           # Project summary + path switch
  assetTools.js             # Asset scanning + tile ID categorization
utils/
  fileHandler.js            # readJson/writeJson/nextId/getMapPath
  commandBuilder.js         # Event command factory (30+ commands)
  mapGenerator.js           # V1 basic generator (5 themes, 8 hardcoded IDs)
  mapGeneratorV2.js         # V2 knowledge-driven generator (11 themes, tileset-aware)
  logger.js                 # Logging utility
knowledge/
  tile-ids.json             # Tile ID ranges and formulas
  passage-flags.json        # Passage flag bits and values
  event-commands.json       # Event command reference
  enums.json                # Enum value reference
  trait-effect-codes.json   # Trait and effect codes
  database-schemas.json     # MV data type schemas
  image-paths.json          # Image path conventions
```

## License

MIT
