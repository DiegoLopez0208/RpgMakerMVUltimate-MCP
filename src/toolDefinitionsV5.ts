/**
 * toolDefinitionsV5.ts — the 12 consolidated v5 tools.
 *
 * v5 replaces the 101 fine-grained v4 tools with 12 verb-oriented tools whose
 * first argument selects the operation (entity / action / mode / view). The
 * v4 names still work as call aliases and can be re-advertised with
 * RPGMV_LEGACY_TOOLS=1. Routing lives in v5Router.ts; implementations are the
 * same audited code paths v4 used.
 *
 * Conventions shared by every tool: data files are written to disk immediately
 * (no undo; close the RPG Maker editor while editing or it may overwrite
 * changes); create operations assign the next free ID and return the created
 * object including its id; numeric arguments accept numbers or numeric strings.
 */

const ID_TYPE = { type: ['number', 'string'] as string[] };

const DB_ENTITY_ENUM = ['actors', 'classes', 'skills', 'items', 'weapons', 'armors', 'enemies', 'states', 'troops', 'tilesets', 'common_events', 'animations'];

export const TOOL_DEFINITIONS_V5 = [
  {
    name: 'query_database',
    description: 'Read-only: query any RPG Maker MV database (data/*.json). Three forms depending on arguments: no id/query lists every non-null entry of the entity; `id` fetches one entry (returns null, not an error, if it does not exist); `query` does a case-insensitive name search (items/weapons/armors/skills also match descriptions). Returns an array (list/search) or a single object/null (id). Use this to discover valid IDs before create/update/delete or before wiring references (class learnings, troop members, chest loot). For maps use query_map; for a digest of everything at once use get_project_context.',
    annotations: { title: 'Query database', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: DB_ENTITY_ENUM, description: 'Which database to read: actors, classes, skills, items (consumables), weapons, armors, enemies, states (status conditions), troops (enemy formations), tilesets, common_events, animations' },
        id: { ...ID_TYPE, description: 'Fetch a single entry by its database ID (1-based). Omit to list or search' },
        query: { type: 'string', description: 'Case-insensitive substring to match against entry names (and descriptions for items/weapons/armors/skills). Ignored when id is given' }
      },
      required: ['entity']
    }
  },
  {
    name: 'create_database_entry',
    description: 'Create a new entry in an RPG Maker MV database with the next free ID; the data file is written immediately. Returns the complete created object including its new id. Two forms: with `entity` + `data` it creates a raw entry (omitted fields get engine defaults; data.name is expected); with `preset` it builds a ready-to-use entry from a recipe — damage_skill {name, mpCost, scope, formula, element?, animationId?}, healing_skill {name, mpCost, scope, formula}, buff_skill {name, mpCost, scope, paramId 0-7, turns}, state_skill {name, mpCost, scope, stateId, chance 0-1}, boss_enemy {name, battlerName?, specialSkillId?, params?}, encounter_troop {name, enemyIds[]}. Presets validate their required fields and fail with a validation error when missing. Class entries: data.params accepts 8 stat seeds [HP,MP,ATK,DEF,MAT,MDF,AGI,LUK] expanded to full level 1-99 curves automatically. Not supported for tilesets/animations (author those in the editor). Referenced IDs (classId, stateId, enemyIds...) are NOT validated — confirm them with query_database first.',
    annotations: { title: 'Create database entry', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['actors', 'classes', 'skills', 'items', 'weapons', 'armors', 'enemies', 'states', 'troops', 'common_events'], description: 'Which database receives the new entry. Optional when preset is given (the preset implies it)' },
        preset: { type: 'string', enum: ['damage_skill', 'healing_skill', 'buff_skill', 'state_skill', 'boss_enemy', 'encounter_troop'], description: 'Recipe for common content; see the tool description for each preset\'s required data fields. Omit for a raw entry' },
        data: { type: 'object', description: 'Entry fields. Raw entries: same properties as the RPG Maker database (name, note, traits, params...; effects for items/skills, members [{enemyId,x,y}] for troops, trigger/switchId/list for common_events). Presets: the recipe fields listed in the description' }
      },
      required: ['data']
    }
  },
  {
    name: 'update_database_entry',
    description: 'Partially update an existing database entry: only the keys in `fields` are overwritten (arrays like traits/learnings/actions are replaced wholesale, not merged); the data file is written immediately and there is no undo, so fetch current values with query_database first if you may revert. Returns the full entry after the update. Fails with an error if the ID does not exist. Special append forms that do not need `fields`: common_events + `appendCommand` inserts one event command before the list terminator; troops + `addEnemyId` adds a member at an auto-computed battle position. Plain troop updates and animations are not supported. Class params in fields accept 8 seeds (expanded to full curves) or 8 arrays of 100 per-level values. Editing tilesets affects every map using them; malformed flags break passability project-wide.',
    annotations: { title: 'Update database entry', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['actors', 'classes', 'skills', 'items', 'weapons', 'armors', 'enemies', 'states', 'tilesets', 'common_events', 'troops'], description: 'Which database contains the entry' },
        id: { ...ID_TYPE, description: 'ID of the entry to modify (must exist; find it with query_database)' },
        fields: { type: 'object', description: 'Subset of properties to overwrite, e.g. {"name": "Hero", "price": 250}. Not needed when using appendCommand/addEnemyId' },
        appendCommand: { type: 'object', description: 'common_events only: one event command {code, indent, parameters} appended before the terminator. Common codes: 101+401=Show Text, 121=Control Switches, 122=Control Variables' },
        addEnemyId: { ...ID_TYPE, description: 'troops only: enemy ID to append as a new member at an auto-computed screen position' }
      },
      required: ['entity', 'id']
    }
  },
  {
    name: 'delete_database_entry',
    description: 'DESTRUCTIVE: delete a database entry by nulling it out in its data file (written immediately; not undoable — re-create it if needed; IDs are never reused). References elsewhere are NOT cleaned up and will break at runtime: actors in the starting party, classes assigned to actors, skills in class learnings/enemy actions, items in chests/shops, enemies in troops, states in skill effects — check and update those first with query_database/update_database_entry. NEVER delete skill 1 (Attack), skill 2 (Guard) or state 1 (KO); the engine uses them directly. Supported entities: actors, classes, skills, items, weapons, armors, enemies, states. Returns the deleted object for reference; fails with an error if the ID does not exist.',
    annotations: { title: 'Delete database entry', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['actors', 'classes', 'skills', 'items', 'weapons', 'armors', 'enemies', 'states'], description: 'Which database contains the entry to delete' },
        id: { ...ID_TYPE, description: 'ID of the entry to delete (never skill 1/2 or state 1)' }
      },
      required: ['entity', 'id']
    }
  },
  {
    name: 'query_map',
    description: 'Read-only: inspect maps. `view` selects what you get: "infos" lists the map tree from MapInfos.json (ids, names, folder parentIds — no mapId needed); "full" returns one complete MapNNN.json (dimensions, 6-layer tile data, events — can be large); "events" lists a map\'s events (with `query`, filters by name, case-insensitive); "event" returns one event by eventId (null if absent); "validate" lints a map (invalid tile IDs per layer, missing page terminators, transfers to map 0, Self Switch OFF where ON was likely meant) returning {issueCount, issues[]}; "ascii" renders the map as a character grid with event markers and a legend — the cheapest way to "see" a layout and pick coordinates, entirely offline. Fails with an error if the map file does not exist. For player-visible images use analyze_image instead.',
    annotations: { title: 'Query map', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['infos', 'full', 'events', 'event', 'validate', 'ascii'], description: 'What to read; see the tool description for each view' },
        mapId: { ...ID_TYPE, description: 'Map ID (required for every view except "infos"); map 1 is Map001.json' },
        eventId: { ...ID_TYPE, description: 'Event ID within the map (required for view "event")' },
        query: { type: 'string', description: 'view "events" only: case-insensitive substring filter on event names' },
        layer: { ...ID_TYPE, description: 'view "ascii" only: tile layer to draw, 0=ground (default) or 2=upper decorations' },
        showEvents: { type: 'boolean', description: 'view "ascii" only: overlay event markers (default true)' },
        showRegions: { type: 'boolean', description: 'view "ascii" only: also return the region-ID layer as a second grid (default false)' }
      },
      required: ['view']
    }
  },
  {
    name: 'generate_map',
    description: 'Create a new map file (next free map ID, registered in MapInfos.json; both files written immediately). `mode` selects the generator: "blank" makes an empty map you paint later (edit_map fill_layer); "themed" generates a simple tile layout for a theme using the tileset\'s real tiles; "procedural" is the full generator (Perlin noise terrain, BSP dungeons, cellular caves, themed events auto-placed; same seed + params = same map; 21 themes incl. snow, volcano, sewer, space_interior); "batch" generates several procedural maps in one call from `batch` specs; "duplicate" copies an existing map (transfer events still point at their ORIGINAL destinations — review them); "template" instantiates one of the 106 bundled reference maps by templateId (list them with get_project_context detail "templates"). Returns {mapId, ...} — procedural also returns the seed; batch returns all mapIds keyed for edit_map "connect". Fails with an error on unknown theme/template or unwritable files.',
    annotations: { title: 'Generate map', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['blank', 'themed', 'procedural', 'batch', 'duplicate', 'template'], description: 'Which generator to use; see the tool description. Default "procedural"' },
        name: { type: 'string', description: 'Internal map name for the editor tree (required for mode "duplicate")' },
        displayName: { type: 'string', description: 'Location name briefly shown to the player on entry' },
        width: { ...ID_TYPE, description: 'Map width in tiles (defaults: blank/themed 17, procedural 30; template uses the template\'s size)' },
        height: { ...ID_TYPE, description: 'Map height in tiles (defaults: blank/themed 13, procedural 25)' },
        tilesetId: { ...ID_TYPE, description: 'Tileset to render with (default 1); match it to the theme (default project: 1=Overworld, 2=Outside, 3=Inside, 4=Dungeon)' },
        theme: { type: 'string', description: 'Required for themed/procedural. themed: forest, dungeon, town, castle, cave, village, swamp, desert, ruins, interior, beach. procedural adds: snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world' },
        seed: { ...ID_TYPE, description: 'procedural/batch: random seed for reproducible output (omit for random; returned in the result)' },
        addEvents: { type: 'boolean', description: 'procedural: also place themed NPCs/chests/bosses/transfers (default true)' },
        parentId: { ...ID_TYPE, description: 'Map tree folder to nest the new map under (0 = root)' },
        bgmName: { type: 'string', description: 'Audio file from audio/bgm/ to autoplay on entry' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        batch: { type: 'array', description: 'mode "batch" only: one spec per map [{key, name, theme, width, height, tilesetId, seed, parentId}]; key is echoed back to match returned mapIds', items: { type: 'object' } },
        sourceMapId: { ...ID_TYPE, description: 'mode "duplicate" only: existing map ID to copy (unchanged by the operation)' },
        templateId: { ...ID_TYPE, description: 'mode "template" only: bundled template ID from get_project_context detail "templates"' },
        keepEvents: { type: 'boolean', description: 'mode "template" only: also copy the template\'s events (default true)' }
      },
      required: []
    }
  },
  {
    name: 'edit_map',
    description: 'Modify existing maps; the affected map files / MapInfos.json are written immediately. `action` selects the edit: "fill_layer" overwrites an ENTIRE tile layer with one tile ID (destructive, not undoable; layers: 0-1 ground, 2-3 upper, 4 shadow bits 0-15, 5 region IDs 0-255; tileId 0 clears; find valid IDs with get_project_context detail "tileset"); "set_display_names" sets the player-visible displayName of several maps at once (entries whose map file is missing are reported in `skipped`, not errors); "organize_tree" re-parents maps in the editor tree (purely organizational, gameplay unaffected); "connect" creates a bidirectional pair of transfer events between two maps so the player can walk both ways. Returns a per-action summary. Fails with an error if a referenced map does not exist (except set_display_names, which skips). For event-level work use manage_map_event.',
    annotations: { title: 'Edit map', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fill_layer', 'set_display_names', 'organize_tree', 'connect'], description: 'Which edit to perform; see the tool description' },
        mapId: { ...ID_TYPE, description: 'action "fill_layer": map to modify' },
        layer: { ...ID_TYPE, description: 'action "fill_layer": layer index 0-5' },
        tileId: { ...ID_TYPE, description: 'action "fill_layer": tile ID to write into every cell (0 = clear)' },
        names: { type: 'array', description: 'action "set_display_names": [{mapId, name}] — name is what the player sees on map entry', items: { type: 'object' } },
        folders: { type: 'array', description: 'action "organize_tree": [{mapId, parentId}] — parentId 0 means root level', items: { type: 'object' } },
        mapIdA: { ...ID_TYPE, description: 'action "connect": first map ID' },
        mapIdB: { ...ID_TYPE, description: 'action "connect": second map ID' },
        posA: { type: 'object', description: 'action "connect": transfer event position on map A {x, y, trigger} (trigger 1=walk-on default, 0=action button for doors)' },
        posB: { type: 'object', description: 'action "connect": transfer event position on map B {x, y, trigger}' }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_map_event',
    description: 'Create, modify or remove events on a map; the map file is written immediately. action "create" without preset makes a low-level event at x/y (empty page unless `pages` given; add behavior later with add_command). action "create" WITH preset builds a complete, ready-to-play event: "npc" (2-page dialogue NPC: {name, dialogues[], characterName?, characterIndex?}), "chest" (one-time loot: {items: [{type: item|weapon|armor, id, amount}]} — IDs not validated, confirm with query_database), "teleport" (one-way transfer: {destMapId, destX, destY, trigger?} — destination not validated), "shop" ({goods: [[type 0=item/1=weapon/2=armor, id, priceType 0=standard/1=custom, price]]}), "inn" ({cost?} full-recovery flow with gold check), "boss" ({troopId} one-time battle, game over on loss), "puzzle_switch" ({switchX, switchY, doorX, doorY, gameSwitchId, switchName?, doorName?} creates TWO linked events). action "update" overwrites only `fields` on an event; "delete" removes it permanently (DESTRUCTIVE); "add_command" appends one command before a page\'s terminator; "populate" scatters N events of a kind (npc/chest/boss) at random positions (walkability not checked — validate with query_map "ascii"). Returns the created/updated event(s) with ids. Fails with an error if the map (or event, for update/delete) does not exist.',
    annotations: { title: 'Manage map events', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'add_command', 'populate'], description: 'What to do; see the tool description. Default "create"' },
        preset: { type: 'string', enum: ['npc', 'chest', 'teleport', 'shop', 'inn', 'boss', 'puzzle_switch'], description: 'action "create" only: ready-made event recipe; omit for a low-level empty event' },
        mapId: { ...ID_TYPE, description: 'Map the event lives on (always required)' },
        x: { ...ID_TYPE, description: 'Tile X position (0-based; create/presets except puzzle_switch)' },
        y: { ...ID_TYPE, description: 'Tile Y position (0-based)' },
        name: { type: 'string', description: 'Event name shown in the editor' },
        eventId: { ...ID_TYPE, description: 'Existing event ID (update/delete/add_command); find it with query_map view "events"' },
        fields: { type: 'object', description: 'action "update": properties to overwrite, e.g. {"x": 5, "y": 9} or {"pages": [...]} (replaces all pages)' },
        trigger: { ...ID_TYPE, description: 'How the event activates: 0=action button, 1=player touch, 2=event touch, 3=autorun, 4=parallel' },
        pages: { type: 'array', description: 'action "create" without preset: full event page objects (optional)' },
        command: { type: 'object', description: 'action "add_command": event command {code, indent, parameters}; e.g. 201=Transfer Player [0, mapId, x, y, dir, fade]' },
        pageIndex: { ...ID_TYPE, description: 'action "add_command": which page receives the command (0-based, default 0)' },
        dialogues: { type: 'array', description: 'preset "npc": dialogue lines, each becomes one text box', items: { type: 'string' } },
        items: { type: 'array', description: 'preset "chest": loot [{type: "item"|"weapon"|"armor", id, amount}]', items: { type: 'object' } },
        goods: { type: 'array', description: 'preset "shop": wares [[type, id, priceType, price]] — priceType 1 uses the custom price, 0 the database price', items: { type: 'array' } },
        destMapId: { ...ID_TYPE, description: 'preset "teleport": destination map ID' },
        destX: { ...ID_TYPE, description: 'preset "teleport": destination tile X (should be walkable)' },
        destY: { ...ID_TYPE, description: 'preset "teleport": destination tile Y' },
        cost: { ...ID_TYPE, description: 'preset "inn": gold charged for a full recovery (default 50)' },
        troopId: { ...ID_TYPE, description: 'preset "boss" / populate boss: troop to battle (create it first via create_database_entry preset encounter_troop)' },
        characterName: { type: 'string', description: 'Sprite sheet from img/characters/ without extension; list options with get_project_context' },
        characterIndex: { ...ID_TYPE, description: 'Which of the 8 characters in the sheet (0-7)' },
        switchX: { ...ID_TYPE, description: 'preset "puzzle_switch": floor-switch tile X' },
        switchY: { ...ID_TYPE, description: 'preset "puzzle_switch": floor-switch tile Y' },
        doorX: { ...ID_TYPE, description: 'preset "puzzle_switch": door tile X' },
        doorY: { ...ID_TYPE, description: 'preset "puzzle_switch": door tile Y' },
        gameSwitchId: { ...ID_TYPE, description: 'preset "puzzle_switch": game switch linking switch and door — pick an unused ID via manage_system get switches' },
        switchName: { type: 'string', description: 'preset "puzzle_switch": editor name for the switch event (default "Switch")' },
        doorName: { type: 'string', description: 'preset "puzzle_switch": editor name for the door event (default "Door")' },
        eventType: { type: 'string', description: 'action "populate": kind of events to scatter — "npc", "chest" or "boss"' },
        count: { ...ID_TYPE, description: 'action "populate": how many events (default 3)' },
        opts: { type: 'object', description: 'action "populate": overrides {name, troopId, x, y}' }
      },
      required: ['action', 'mapId']
    }
  },
  {
    name: 'manage_system',
    description: 'Read or edit project-wide settings in data/System.json (writes are immediate). action "get" returns the requested `section`: "full" (everything — large), "switches" or "variables" (name arrays indexed by ID; unnamed entries are empty strings — use these to find free IDs), or "title". action "set_title" changes the game title shown on the title screen. "name_switch"/"name_variable" label a switch/variable by ID — documentation only, runtime values are untouched, but good names keep event logic readable. "set_starting_position" sets where new games begin {mapId, x, y} — NOT validated against existing maps, verify with query_map "infos" first; does not affect saved games. Returns the read section or the updated values.',
    annotations: { title: 'Manage system settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set_title', 'name_switch', 'name_variable', 'set_starting_position'], description: 'What to do; see the tool description. Default "get"' },
        section: { type: 'string', enum: ['full', 'switches', 'variables', 'title'], description: 'action "get": which part of System.json to return (default "full")' },
        title: { type: 'string', description: 'action "set_title": new game title' },
        id: { ...ID_TYPE, description: 'name_switch/name_variable: switch or variable ID to label (1-based)' },
        name: { type: 'string', description: 'name_switch/name_variable: descriptive label, e.g. "BridgeRepaired"' },
        mapId: { ...ID_TYPE, description: 'set_starting_position: map where new games start (must exist)' },
        x: { ...ID_TYPE, description: 'set_starting_position: starting tile X (should be walkable)' },
        y: { ...ID_TYPE, description: 'set_starting_position: starting tile Y' }
      },
      required: ['action']
    }
  },
  {
    name: 'get_project_context',
    description: 'Read-only: pre-digested project knowledge — CALL THIS FIRST in a session. `detail` selects the depth: "full" (default) returns id+name lists for every database, switch/variable names, starting position, and available sprite filenames per img/ folder — everything needed to create content without inventing broken references; "summary" is a cheap health check (entry counts per data file); "assets" scans img/ and Tilesets.json into a complete index (sheet dimensions, autotile kinds, categorized usable tiles, all PNG names); "tileset" returns the categorized usable tile IDs of ONE tileset (ground/water/walls/roof/decoration) for edit_map "fill_layer" — guessing tile IDs produces glitched maps; "templates" lists the 106 bundled reference maps (id, category, theme) usable with generate_map mode "template", optionally filtered by category/theme. Returns one structured object (or array for templates).',
    annotations: { title: 'Get project context', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['full', 'summary', 'assets', 'tileset', 'templates'], description: 'How much and what kind of context; see the tool description. Default "full"' },
        tilesetId: { ...ID_TYPE, description: 'detail "tileset": which tileset to categorize' },
        category: { type: 'string', description: 'detail "templates": filter by template category' },
        theme: { type: 'string', description: 'detail "templates": filter by template theme' }
      },
      required: []
    }
  },
  {
    name: 'set_project_path',
    description: 'Switch this server to a DIFFERENT RPG Maker MV project directory for all subsequent tool calls (session-wide side effect; persists until changed again or the server restarts). Validates that the path contains data/System.json and fails with an error otherwise, leaving the previous project active. Returns the new active path. Without this tool, the RPGMAKER_PROJECT_PATH environment variable set at startup applies.',
    annotations: { title: 'Switch project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to an RPG Maker MV project root (the folder containing data/System.json and img/)' }
      },
      required: ['path']
    }
  },
  {
    name: 'analyze_image',
    description: 'Analyze images related to the project. mode "ai" sends a project image file (tileset, character sheet, map screenshot, battler) to an external OpenAI-compatible Vision API and returns {analysis, model, tokens_used} — NETWORK SIDE EFFECT: the resized JPEG leaves your machine to the endpoint configured via VISION_API_URL / VISION_API_KEY / VISION_MODEL env vars; fails if the path escapes the project, the file is missing, or the API is unreachable/times out (120 s). mode "grid" measures a base64 PNG tileset offline and returns its 48px grid {cols, rows, totalTiles}. mode "colors" returns the average RGB of a base64 PNG\'s four quadrants offline (a crude what-is-on-screen check). For precise offline map layout, query_map view "ascii" is usually better than any image analysis.',
    annotations: { title: 'Analyze image', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ai', 'grid', 'colors'], description: 'ai = Vision API on a project file; grid/colors = offline analysis of a provided base64 PNG. Default "ai"' },
        imagePath: { type: 'string', description: 'mode "ai": image path RELATIVE to the project root, e.g. "img/tilesets/Outside.png"; paths outside the project are rejected' },
        prompt: { type: 'string', description: 'mode "ai": custom analysis question (default: thorough RPG-Maker-specific analysis)' },
        resizeMax: { ...ID_TYPE, description: 'mode "ai": max width in px before upload (default 1024; lower = fewer tokens)' },
        base64PNG: { type: 'string', description: 'modes "grid"/"colors": raw base64 PNG data (no data: URL prefix)' }
      },
      required: []
    }
  }
];
