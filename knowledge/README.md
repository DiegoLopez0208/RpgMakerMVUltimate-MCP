# Knowledge Base

Static JSON reference files extracted from the [RPG Maker MV corescript](https://github.com/rpgtkoolmv/corescript). Used by the MCP server's map generator V2, event builders, and tools for validation and tile selection.

## Files

### tile-ids.json
Tile ID ranges for each sheet (A1-A5, B-E), autotile ID formula (`2048 + kind * 48 + shape`), sheet descriptions, and layer mapping rules.

### passage-flags.json
Passage flag bitmask definitions (0x0001=down through 0x0800=airship), common flag values (0=passable, 15=impassable, 1536=star+passable), terrain tag formula (`(flags >> 12) & 0xF`), and passage check logic.

### event-commands.json
~140 RPG Maker MV event command codes (0-356) with parameter schemas. Includes sub-codes 401-655 for Show Text lines, choices, and script blocks. Each entry has: code, name, parameter array with types and descriptions.

### enums.json
Enumeration values used throughout MV data: scope, occasion, hitType, damageType, restriction, trigger, moveType, priority, animation timing, blend modes, and more.

### trait-effect-codes.json
- **Trait codes** (11-64): Parameter bonuses, attack elements, skill types, equip types, action patterns, etc.
- **Effect codes** (11-45): HP/MP recovery, states, buffs, skill learning, common events, etc.
- **Param/xparam/sparam** ID mappings (0-7 each).

### database-schemas.json
Complete object schemas for all MV data types: actor, class, skill, item, weapon, armor, enemy, state, troop, animation, tileset, commonEvent, system, map, event, eventPage, trait, effect, damage, audioFile. Each schema lists every field with type and default value.

### image-paths.json
img/ subdirectory conventions, tileset slot mapping (A1-E), sprite naming prefixes (`!` = object, `$` = big sprite), and file format requirements (48x48px tiles, PNG).

## Usage

These files are loaded at runtime by the server's generators and builders:

```js
const tileIds = require('../knowledge/tile-ids.json');
const passageFlags = require('../knowledge/passage-flags.json');
```

They are **not** modified by the server — they are read-only reference data. The auto-generated `asset-index.json` (from `scan_project_assets`) is gitignored because it's project-specific.

## Source

All data extracted from:
- `rpgtkoolmv/corescript` — `rpg_core.js`, `rpg_objects.js`, `rpg_sprites.js`
- RPG Maker MV editor documentation and reverse engineering
