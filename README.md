# RPG Maker MV Ultimate MCP Server

[![npm](https://img.shields.io/npm/v/rpgmaker-mv-mcp)](https://www.npmjs.com/package/rpgmaker-mv-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI agent edit a real **RPG Maker MV** project on disk — database, maps, events, system — through **13 consolidated tools**, validated against the actual engine so the output is coherent and playable — and it can **reason about** the project (validate references, explain why an event never fires, critique a map) via `analyze_project`.

Its headline feature is **knowledge-driven map generation**: instead of painting tiles procedurally, `generate_map` **clones hand-authored reference maps** from 106 bundled RTP templates (real multi-tile buildings, walls, furniture) and adapts them to your project's tilesets — falling back to procedural generation only for themes without a template.

The 101 fine-grained v4 tool names still work as call aliases (set `RPGMV_LEGACY_TOOLS=1` to also advertise them).

## Install

The package ships an executable, so no clone is required. Add it to your MCP client:

```json
{
  "mcpServers": {
    "rpgmaker-mv": {
      "command": "npx",
      "args": ["-y", "rpgmaker-mv-mcp"],
      "env": {
        "RPGMAKER_PROJECT_PATH": "/path/to/your/RPGMakerMV/project"
      }
    }
  }
}
```

Works with Claude Desktop, Claude Code, opencode, and any MCP-compatible client. The server starts even without `RPGMAKER_PROJECT_PATH` — call `set_project_path` at runtime if you didn't set it.

### From source

```bash
git clone https://github.com/DiegoLopez0208/RpgMakerMVUltimate-MCP
cd RpgMakerMVUltimate-MCP
npm install
npm run build
RPGMAKER_PROJECT_PATH=/path/to/your/project npm start
```

## The 13 tools

| Tool | Purpose |
|---|---|
| `query_database` | List / get by ID / search any database (actors, classes, skills, items, weapons, armors, enemies, states, troops, tilesets, common events, animations) |
| `create_database_entry` | Create entries, with presets: `damage_skill`, `healing_skill`, `buff_skill`, `state_skill`, `boss_enemy`, `encounter_troop` |
| `update_database_entry` | Partial updates (incl. troops & animations); append commands to common events; add enemies to troops |
| `delete_database_entry` | Delete entries incl. troops & animations (with reference-breakage warnings) |
| `query_map` | Map tree, full map data, events, single event, lint (`validate`), offline ASCII render |
| `generate_map` | Knowledge-driven generation: clones a real reference map per theme (or pure procedural / blank / themed / a specific template / batch / duplicate) |
| `edit_map` | Fill tile layers, set display names, organize the map tree, connect two maps, set encounters |
| `manage_map_event` | Create (presets: npc, chest, teleport, door, shop, inn, boss, puzzle_switch), update, **convert** an existing event into a merchant/inn/sign, delete, add commands, bulk-populate |
| `manage_system` | Game title, switch/variable names, starting position; **author a plugin** (`create_plugin`), **scaffold a new project** (`scaffold_project`), and **run the game** (`playtest`) / open it in the editor (`open_editor`) |
| `analyze_project` | Read-only project intelligence — `overview`, `index`, `validate`, `graph`, `usage`, `explain`, `ast`, `plugins`, `critique`, `refactor`, `search` (see below) |
| `get_project_context` | Project digest, asset index, per-tileset tile IDs, bundled-template catalog |
| `set_project_path` | Switch projects at runtime |
| `analyze_image` | Optional Vision-AI image analysis, plus offline tileset grid measurement and quadrant colors |

## Scaffold, run & write safety

- **Write safety.** Every project write is atomic (temp file + rename, so an interrupted call can't leave half-written JSON) and keeps rotated timestamped backups under `.mcp-backups/` (last N, `RPGMV_BACKUP_KEEP`, default 10). Pass `dryRun: true` to any mutating tool to preview the change without touching disk.
- **Scaffold a new project.** `manage_system { action: "scaffold_project", destPath, title? }` clones the engine's blank template (NewData) into a new directory — the same thing the editor's *New Project* does — refusing to overwrite an existing project.
- **Run it.** `manage_system { action: "playtest" }` launches the active project through the engine's bundled nwjs runtime (like the editor's *Playtest* button), so an agent can actually see a change running; `open_editor` opens it in RPGMV.exe. The install is found via `install` / the `RPGMAKER_MV_INSTALL` env var / the default Steam path (Windows).
- **Author plugins.** `manage_system { action: "create_plugin", name, ... }` writes `js/plugins/<name>.js` with a correct `@plugindesc`/`@param`/`@help` header and registers it in `js/plugins.js`.

## Map generation (knowledge-driven)

`generate_map` defaults to `mode: "procedural"`, which is smarter than the name suggests:

- For themes with a matching RTP reference template — **town, village, dungeon, interior, castle, world**, and more — it **clones a hand-authored map from the 106 bundled templates**, picking the closest size, so you get real 3D-looking buildings, walls and furniture instead of flat tile noise.
- For themes without a template (**beach, swamp, desert, …**) it generates procedurally (Perlin terrain, BSP dungeons, cellular caves).
- Same `seed` + params → the same map. Pass `templateId` to force a specific template, or `useTemplate: false` to force pure procedural.

Other modes: `"blank"` (empty canvas you paint with `edit_map`), `"themed"` (simple tile layout), `"template"` (instantiate one specific bundled map by `templateId`), `"batch"` (many maps at once), `"duplicate"` (copy an existing map).

```json
{
  "tool": "generate_map",
  "arguments": { "mode": "procedural", "theme": "town", "name": "Riverbend", "width": 40, "height": 30 }
}
```

Combat themes (dungeon/cave/world/fortress/sewer/volcano) auto-wire random encounters from your existing troops, and town/village auto-create enterable house interiors with two-way warps. List available templates with `get_project_context { detail: "templates" }`.

**Themes:** `forest` `town` `village` `castle` `dungeon` `cave` `beach` `desert` `swamp` `ruins` `interior` `snow` `harbor` `volcano` `sewer` `fortress` `magic_forest` `magic_interior` `space_interior` `space_exterior` `world`

## Offline map inspection

No API needed:

- `query_map { view: "ascii", mapId }` — render a map as a character grid with event markers (the cheapest way to "see" a layout and pick coordinates).
- `query_map { view: "validate", mapId }` — lint for invalid tile IDs, broken transfers, and missing event terminators.

## Project intelligence (`analyze_project`)

Read-only — it understands the whole project instead of re-reading files, so an agent can reason about a game it didn't build. All offline.

- `{ view: "overview" }` — **call this first** on an unfamiliar project: counts, a health summary, and maps unreachable from the start.
- `{ view: "validate" }` — every consistency problem at once: broken transfers, missing map files, dangling common-event/item/troop references, duplicate IDs, unused switches/variables, unreachable maps.
- `{ view: "explain", target: "switch", id }` — why something never happens, e.g. *"Switch 12 is read/gated in 3 places but is **never set ON**"* (the usual cause of a door that never opens). `target: "map"` reports what a deletion would strand.
- `{ view: "usage", kind: "variable", id }` — every event/common-event/troop that touches it (with read/write roles).
- `{ view: "graph" }` — the map transfer network and reachability.
- `{ view: "ast", mapId, eventId }` — an event's logic as a readable tree.
- `{ view: "plugins" }` — what plugins the project uses, their parameters and commands.
- `{ view: "critique", mapId }` — a designer-style review of one map (dead space, empty/cluttered, event spread, monotony) with justified suggestions.
- `{ view: "refactor" }` — duplicated event logic worth extracting into a Common Event.
- `{ view: "search", query: "the blacksmith" }` — find things by meaning across names, dialogue and descriptions.

## Vision AI (optional)

`analyze_image { mode: "ai" }` sends a project image (tileset, sprite, screenshot, battler) to **any OpenAI-compatible vision endpoint**. It is **disabled by default** — nothing is sent anywhere unless you configure it. The other modes (`"grid"`, `"colors"`) and all other tools work fully offline.

| Variable | Required | Description |
|---|---|---|
| `VISION_API_URL` | to enable | Base URL of the vision API (e.g. `https://api.openai.com`, `http://localhost:11434`). Unset = vision disabled. |
| `VISION_API_KEY` | optional | Bearer token; only sent when set. |
| `VISION_MODEL` | optional | Model name (default `meta/llama-3.2-90b-vision-instruct`). |
| `VISION_API_PATH` | optional | Endpoint path (default `/v1/chat/completions`). |

```bash
# OpenAI
VISION_API_URL=https://api.openai.com VISION_API_KEY=sk-... VISION_MODEL=gpt-4o npm start
# Ollama (local, no key)
VISION_API_URL=http://localhost:11434 VISION_MODEL=llava npm start
```

Supported backends: OpenAI, Ollama, LocalAI, NVIDIA NIM, vLLM, LiteLLM, or any OpenAI-compatible proxy.

## Agent Skill (recommended for any AI agent)

A portable [Agent Skill](https://agentskills.io) teaches any model (Claude, DeepSeek, …) the correct, crash-free workflow — building maps with `generate_map` and adding content with `manage_map_event` presets instead of hand-painting tiles or guessing IDs. It lives at [`skill/rpgmaker-mv-mcp/SKILL.md`](skill/rpgmaker-mv-mcp/SKILL.md).

```bash
# Claude Code / Claude.ai
npx degit DiegoLopez0208/RpgMakerMVUltimate-MCP/skill/rpgmaker-mv-mcp ~/.claude/skills/rpgmaker-mv-mcp
# opencode
npx degit DiegoLopez0208/RpgMakerMVUltimate-MCP/skill/rpgmaker-mv-mcp ~/.opencode/skills/rpgmaker-mv-mcp
```

The skill is also listed in [awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills).

## Knowledge base

Static JSON reference data in `knowledge/`, extracted from the RPG Maker MV corescript and the bundled maps:

| File | Content |
|---|---|
| `tile-ids.json` | Tile ID ranges, autotile formula, sheet descriptions |
| `passage-flags.json` | Flag bits, common flags, passage check logic |
| `event-commands.json` | ~140 event command codes with parameter schemas |
| `enums.json` | Scope, occasion, hitType, damageType, restriction, etc. |
| `trait-effect-codes.json` | Trait codes 11-64, effect codes 11-45 |
| `database-schemas.json` | Full schemas for all MV data types |
| `image-paths.json` | img/ directories, tileset slots, naming conventions |
| `map-templates.json` | Index of the 106 bundled reference maps |
| `stamps.json` | Mined multi-tile object stamps (trees, props) per tileset |
| `maps/` | 106 RTP reference map JSONs used for template cloning |

## Feedback & contributing

This server is actively developed and **feedback is very welcome** — bug reports, weird maps, missing tools, or ideas. Please open a [GitHub Issue](https://github.com/DiegoLopez0208/RpgMakerMVUltimate-MCP/issues) with what you asked the agent to do and what you got (an exported map JSON or a screenshot helps a lot).

### Known limitations & roadmap

- Decoration/object semantics are best-effort; rare multi-tile objects may be placed as single tiles.
- Town and dungeon layouts keep improving — planned: central plaza/well landmark, houses in rows facing roads, fences/yards, richer road networks, more dungeon-room variety.
- Vision AI is optional and requires your own endpoint.

## Development

```bash
npm install
npm run build      # tsc compile (+ copies knowledge/ into dist/)
npm test           # vitest
npm run dev        # tsx watch mode
```

Source: `src/server.ts` (tool handlers), `src/toolDefinitions.ts` + `src/router.ts` (the 13-tool surface), `src/tools/*` (per-domain CRUD), `src/utils/mapGenerator.ts` (template cloning + procedural generation), `src/intel/*` (the read-only project-intelligence layer behind `analyze_project`), `knowledge/` (static reference data + bundled maps).

[![DiegoLopez0208/RpgMakerMVUltimate-MCP MCP server](https://glama.ai/mcp/servers/DiegoLopez0208/RpgMakerMVUltimate-MCP/badges/score.svg)](https://glama.ai/mcp/servers/DiegoLopez0208/RpgMakerMVUltimate-MCP)

## License

MIT
