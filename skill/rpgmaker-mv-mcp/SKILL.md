---
name: rpgmaker-mv-mcp
description: "Use when building, editing or reasoning about an RPG Maker MV game through the RpgMakerMVUltimate MCP server (tools prefixed rpgmaker_* / the 13 consolidated tools: query_database, create_database_entry, generate_map, manage_map_event, analyze_project, etc.). Covers the correct workflow so maps, NPCs, chests, shops, doors, enemies and battles actually work in-engine, plus analyze_project to understand/validate/critique a project. Trigger: RPG Maker MV, RPGMV, generate map, town/dungeon, troops/encounters, events, tilesets, validate project, why doesn't this work, ProjectR."
---

# Driving the RPG Maker MV MCP correctly

This MCP edits a real RPG Maker MV project on disk (`data/*.json`, validated against the actual engine). It is powerful but the engine is unforgiving: a wrong tile ID, a sprite that doesn't exist, or a missing field crashes the game. Follow this workflow and you produce coherent, playable content; ignore it and you produce "random tiles everywhere" and Loading-Error crashes.

## The one rule that prevents 90% of bad output

**Do NOT hand-paint tiles or place objects one tile at a time, and never invent IDs.** Build maps with `generate_map` and add content with the `manage_map_event` presets. `generate_map` is knowledge-driven: for most themes it **clones a real hand-authored reference map** from the 106 bundled templates (real multi-tile houses, walls, furniture) instead of painting tiles procedurally, so the output looks like a real RPG Maker map and only uses IDs that exist. When you do need an ID (tile, sprite, troop, skill, item), get it from `get_project_context` — never guess.

## Standard workflow

1. **`get_project_context`** (detail `full`) — ALWAYS first. Returns every database id+name, switch/variable names, starting position, and the sprite filenames available per `img/` folder. This is your source of truth; read it before creating anything.
2. **Build the world** with `generate_map` (default `mode:"procedural"`, which is knowledge-driven):
   - Pick a `theme` (town, village, forest, dungeon, cave, world, interior, castle, beach, desert, snow, …) and omit `tilesetId` — it auto-selects the right tileset. For themes with a bundled reference map (town, village, dungeon, interior, castle, world, …) it **clones a real hand-authored map** from the knowledge base, adapted to your tilesets; for themes without one (beach, swamp, desert) it generates procedurally. Combat themes auto-wire random encounters from existing troops.
   - Want a specific reference map? List them with `get_project_context detail:"templates"`, then `generate_map mode:"template" templateId:<id>` (or pass `templateId` in procedural mode to force that one). Force pure procedural generation with `useTemplate:false`. Same `seed` + params → the same map.
   - `town`/`village` auto-create enterable house interiors with two-way warps (returned in `interiorMapIds`); opt out with `enterableHouses:false`.
   - To connect maps, use `edit_map action:"connect"` (bidirectional) or `manage_map_event preset:"door"` / `"teleport"`.
3. **Populate** with `manage_map_event` presets (each builds a complete, working event):
   - `npc` `{dialogues[], characterName?, characterIndex?}` — characterName must be a real sprite from `get_project_context` (e.g. `People1`); omit for invisible.
   - `chest` `{items:[{type:item|weapon|armor,id,amount}]}` — IDs must exist (check first).
   - `shop` `{goods:[[type,id,priceType,price]]}`, `inn` `{cost}`, `boss` `{troopId}`, `teleport`/`door` `{destMapId,destX,destY}`, `puzzle_switch`.
4. **Database** via `create_database_entry` / `update_database_entry` / `query_database` (entity = actors/classes/skills/items/weapons/armors/enemies/states/troops/common_events). Presets exist for skills (`damage_skill`, `healing_skill`, …), `boss_enemy`, `encounter_troop`.
5. **System**: `manage_system` for title, switch/variable names, and `set_starting_position` (validate the map exists first).

## Making enemies actually appear and work

Three things are required — generation does them for you, but if you do it by hand:
1. **Enemies exist and are visible**: `create_database_entry entity:"enemies"` (or preset `boss_enemy`). The MCP assigns a real battler sprite automatically.
2. **A troop with members**: `create_database_entry preset:"encounter_troop" {enemyIds:[…]}`.
3. **Random encounters on the map**: `edit_map action:"set_encounters" {mapId, encounters:[{troopId, weight?}]}`. Without this, walking triggers no battles. `generate_map` does this automatically for dungeon/cave/world/fortress/sewer/volcano.

## Things that crash the game (the MCP guards these, don't fight it)

- **Sprites that don't exist** → fatal "Loading Error". Chest sprite is `!Chest` (with the `!`), doors `!Door1`, etc. Use names from `get_project_context`; the MCP auto-corrects/blanks unknown ones, so prefer letting presets/generation choose.
- **Guessed tile IDs** → glitched/water maps. Only use tile IDs from `get_project_context detail:"tileset"`/`"assets"`, and prefer `generate_map`/`edit_map fill_layer` over manual placement.
- **Class params** must be 8 stat curves; pass 8 seed values and the MCP expands them — never write a flat array.

## Worked examples

**A starting town with enterable houses, a shop and a guide NPC:**
```
get_project_context
generate_map { mode:"procedural", theme:"town", name:"Riverbend", width:40, height:30 }   // returns mapId + interiorMapIds
manage_map_event { action:"create", preset:"shop", mapId:<id>, x:12, y:10, goods:[[0,1,0,0]] }
manage_map_event { action:"create", preset:"npc", mapId:<id>, x:15, y:12, name:"Guide", dialogues:["Welcome!"], characterName:"People1", characterIndex:0 }
manage_system { action:"set_starting_position", mapId:<id>, x:20, y:20 }
```

**A dungeon with real battles and loot:**
```
create_database_entry { entity:"enemies", data:{ name:"Cave Bat", params:[80,0,12,8,8,8,12,10] } }      // id 1, gets a battler
create_database_entry { preset:"encounter_troop", data:{ name:"Bats", enemyIds:[1,1] } }                  // troop id
generate_map { mode:"procedural", theme:"dungeon", name:"Shadow Depths", width:40, height:30 }            // auto-wires encounters
manage_map_event { action:"create", preset:"chest", mapId:<id>, x:8, y:8, items:[{type:"item",id:1,amount:2}] }
manage_map_event { action:"create", preset:"boss", mapId:<id>, x:30, y:6, troopId:<troopId> }
```

## Verify your work

- `query_map { view:"ascii", mapId }` renders the map offline as a character grid — the cheapest way to "see" a layout.
- `query_map { view:"validate", mapId }` lints for broken tiles / transfers.
- For a real visual check, run the game from the project root with a static server (`python3 -m http.server`) and open `index.html` in a browser; move with arrow keys, confirm/cancel with `z`/`x`.
