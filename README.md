# RPG Maker MV Ultimate MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for RPG Maker MV project management. Provides **12 consolidated tools** covering actors, classes, skills, items, weapons, armors, enemies, states, troops, common events, maps, events, tilesets, animations, system settings, project management, **AI vision analysis**, **offline ASCII map rendering**, and **knowledge-driven map generation**. The 101 fine-grained v4 tool names keep working as call aliases (`RPGMV_LEGACY_TOOLS=1` re-advertises them).

## Features

- **12 consolidated MCP tools** covering every aspect of RPG Maker MV project data (the v4 names remain callable for backward compatibility)
- **TypeScript ESM** — fully typed codebase with strict compilation.
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

## Agent Skill (recommended for any AI agent)

A portable agent skill teaches any model (Claude, DeepSeek, …) the correct,
crash-free workflow — building maps with `generate_map` (which stamps real
houses/trees and wires encounters) instead of hand-painting tiles or guessing
IDs. It lives at [`skill/rpgmaker-mv-mcp/SKILL.md`](skill/rpgmaker-mv-mcp/SKILL.md)
and works with the [Agent Skills](https://agentskills.io) standard.

### Install the skill

**One-liner (no clone needed)** — pull just the skill folder into your agent's
skills directory with [`degit`](https://github.com/Rich-Harris/degit):

```bash
# Claude Code / Claude.ai (custom skills)
npx degit DiegoLopez0208/RpgMakerMVUltimate-MCP/skill/rpgmaker-mv-mcp ~/.claude/skills/rpgmaker-mv-mcp

# opencode
npx degit DiegoLopez0208/RpgMakerMVUltimate-MCP/skill/rpgmaker-mv-mcp ~/.opencode/skills/rpgmaker-mv-mcp

# generic agents
npx degit DiegoLopez0208/RpgMakerMVUltimate-MCP/skill/rpgmaker-mv-mcp ~/.agents/skills/rpgmaker-mv-mcp
```

**From a clone** (if you already have the repo):

```bash
cp -r skill/rpgmaker-mv-mcp ~/.claude/skills/      # or ~/.opencode/skills/ , ~/.agents/skills/
```

The skill is also listed in
[awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills).

## Tools (v5)

| Tool | Purpose |
|---|---|
| `query_database` | List / get by ID / search any database (actors, classes, skills, items, weapons, armors, enemies, states, troops, tilesets, common events, animations) |
| `create_database_entry` | Create entries, with presets: `damage_skill`, `healing_skill`, `buff_skill`, `state_skill`, `boss_enemy`, `encounter_troop` |
| `update_database_entry` | Partial updates; append commands to common events; add enemies to troops |
| `delete_database_entry` | Delete entries (with reference-breakage warnings) |
| `query_map` | Map tree, full map data, events, single event, lint (`validate`), offline ASCII render |
| `generate_map` | Blank / themed / procedural (21 themes, seeded) / batch / duplicate / from one of 106 bundled templates |
| `edit_map` | Fill tile layers, set player-visible display names, organize the map tree, connect two maps |
| `manage_map_event` | Create (presets: npc, chest, teleport, shop, inn, boss, puzzle_switch), update, delete, add commands, bulk-populate |
| `manage_system` | Game title, switch/variable names, starting position |
| `get_project_context` | Project digest, asset index, per-tileset tile IDs, template catalog |
| `set_project_path` | Switch projects at runtime |
| `analyze_image` | Vision AI analysis, offline tileset grid measurement, quadrant colors |

Set `RPGMV_LEGACY_TOOLS=1` to also advertise the 101 v4 tool names; calls to v4 names work regardless of the flag.

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

Generate maps from 106 Rpg maker MV reference templates:

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
[

![DiegoLopez0208/RpgMakerMVUltimate-MCP MCP server](https://glama.ai/mcp/servers/DiegoLopez0208/RpgMakerMVUltimate-MCP/badges/score.svg)

](https://glama.ai/mcp/servers/DiegoLopez0208/RpgMakerMVUltimate-MCP)
## License

MIT
