/**
 * toolDefinitionsLegacy.ts — the 101 fine-grained legacy MCP tool definitions.
 *
 * Opt-in surface, advertised only with RPGMV_LEGACY_TOOLS=1. The default 12-tool
 * surface lives in toolDefinitions.ts.
 *
 * Every tool declares:
 *  - description: behavior, side effects, return value, error handling,
 *    and guidance on when to use it vs. related tools.
 *  - inputSchema: JSON Schema for arguments with semantic descriptions.
 *  - annotations: MCP behavior hints (readOnlyHint, destructiveHint,
 *    idempotentHint, openWorldHint) so clients can reason about safety.
 *
 * Convention: read-only tools never touch disk; create_* tools append a new
 * entry with the next free ID and write the data file immediately; update_*
 * tools overwrite only the provided fields; delete_* tools null out the entry
 * (IDs are never reused, references elsewhere are NOT cleaned up).
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const TOOL_DEFINITIONS_LEGACY = [
  // ──────── ACTOR TOOLS ────────
  {
    name: 'get_actors',
    description: 'Read-only: list every actor (playable character) defined in the project\'s data/Actors.json. Returns an array of full actor objects (null placeholder entries are filtered out); returns an empty array if no actors exist. Use this to discover actor IDs before calling get_actor, update_actor, or delete_actor; use search_actors if you only know part of a name.',
    annotations: { title: 'List actors', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_actor',
    description: 'Read-only: fetch a single actor object from data/Actors.json by its numeric ID. Returns the full actor (name, classId, equips, traits, etc.) or null if the ID is out of range or was deleted. Prefer this over get_actors when you already know the ID, to keep responses small.',
    annotations: { title: 'Get actor by ID', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Actor ID as shown in the RPG Maker database (1-based; ID 0 is always null)' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_actor',
    description: 'Create a new playable actor and persist it to data/Actors.json immediately (the file on disk is rewritten; close the RPG Maker editor or it may overwrite the change). The actor is assigned the next free ID automatically. Omitted fields get sensible engine defaults (level 1, class 1, max level 99). Returns the complete created actor object including its new id, which you need for update_actor or party setup. Fails with an error if the project path is invalid or Actors.json cannot be written.',
    annotations: { title: 'Create actor', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Actor display name shown in menus and battle' },
        nickname: { type: 'string', description: 'Secondary title shown in the status screen (e.g. "the Brave")' },
        classId: { type: ['number', 'string'], description: 'ID of an existing class in Classes.json; determines stat growth and learnable skills (default 1)' },
        initialLevel: { type: ['number', 'string'], description: 'Level the actor starts at when added to the party (default 1)' },
        maxLevel: { type: ['number', 'string'], description: 'Level cap for this actor (default 99)' },
        characterName: { type: 'string', description: 'Walking sprite sheet filename in img/characters/ without extension (e.g. "Actor1"); check available names with get_project_context' },
        characterIndex: { type: ['number', 'string'], description: 'Which of the 8 characters in the sprite sheet to use (0-7, left-to-right then top-to-bottom)' },
        faceName: { type: 'string', description: 'Face graphic filename in img/faces/ without extension' },
        faceIndex: { type: ['number', 'string'], description: 'Which of the 8 faces in the face sheet to use (0-7)' },
        battlerName: { type: 'string', description: 'Side-view battle sprite filename in img/sv_actors/ without extension' },
        profile: { type: 'string', description: 'Two-line biography text shown in the status screen' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value} granting passive properties (e.g. code 22 = ex-param like hit rate); applied on top of class traits' },
        equips: { type: 'array', description: 'Initial equipment as item IDs per slot [weapon, shield, head, body, accessory]; 0 = empty slot' },
        note: { type: 'string', description: 'Free-form note field, commonly parsed by plugins for metadata tags like <tag:value>' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_actor',
    description: 'Partially update an existing actor in data/Actors.json: only the keys present in `fields` are overwritten, all other properties are preserved. The file is written to disk immediately and there is no undo, so read the actor first (get_actor) if you need to restore values later. Returns the full actor object after the update. Fails with an error if no actor exists with the given ID.',
    annotations: { title: 'Update actor', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'ID of the actor to modify (must already exist)' },
        fields: { type: 'object', description: 'Subset of actor properties to overwrite, e.g. {"name": "Hero", "initialLevel": 5}; keys not listed remain untouched' }
      },
      required: ['id', 'fields']
    }
  },
  {
    name: 'search_actors',
    description: 'Read-only: case-insensitive substring search over actor names and nicknames in data/Actors.json. Returns an array of matching actor objects (empty array if nothing matches — not an error). Use this when you know a name fragment but not the ID; use get_actors to list everything.',
    annotations: { title: 'Search actors', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to look for in actor name or nickname, e.g. "har" matches "Harold"' }
      },
      required: ['query']
    }
  },

  // ──────── ITEM TOOLS ────────
  {
    name: 'get_items',
    description: 'Read-only: list all consumable items from data/Items.json (potions, keys, quest items — not weapons or armors). Returns an array of full item objects; empty array if none. Use get_weapons / get_armors for equipment, or search_items to filter by name.',
    annotations: { title: 'List items', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_weapons',
    description: 'Read-only: list all weapons from data/Weapons.json. Returns an array of full weapon objects including params (stat bonuses) and traits; empty array if none. Use search_items with type "weapon" to filter by name instead of listing everything.',
    annotations: { title: 'List weapons', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_armors',
    description: 'Read-only: list all armors from data/Armors.json (shields, headgear, body armor, accessories). Returns an array of full armor objects; empty array if none. Use search_items with type "armor" to filter by name instead of listing everything.',
    annotations: { title: 'List armors', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_skills',
    description: 'Read-only: list all skills from data/Skills.json (attack skills, magic, abilities usable by actors and enemies). Returns an array of full skill objects; empty array if none. Use get_skill when you already know the ID, or search_skills to filter by name or description.',
    annotations: { title: 'List skills', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_item',
    description: 'Create a new consumable item (potion, scroll, key item) and persist it to data/Items.json immediately with the next free ID. Omitted fields get engine defaults (consumable, usable from menu, scope = one ally). Returns the complete created item object including its new id — use that ID in create_chest, create_shop, or event commands. Fails with an error if Items.json cannot be read or written. Use create_weapon / create_armor for equipment instead.',
    annotations: { title: 'Create item', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name shown in inventory and shops' },
        description: { type: 'string', description: 'Help text shown when the item is highlighted in a menu' },
        price: { type: ['number', 'string'], description: 'Default buy price in shops (sell price is half); 0 makes it unsellable' },
        consumable: { type: 'boolean', description: 'true = removed from inventory on use (potions); false = reusable (key items, tools). Default true' },
        scope: { type: ['number', 'string'], description: 'Who the item targets when used: 0=none, 1=one enemy, 2=all enemies, 7=one ally, 8=all allies, 11=the user' },
        occasion: { type: ['number', 'string'], description: 'When the item can be used: 0=always, 1=battle only, 2=menu only, 3=never (e.g. quest items)' },
        animationId: { type: ['number', 'string'], description: 'ID from Animations.json played on the target when used; 0 = no animation' },
        effects: { type: 'array', description: 'Effect objects {code, dataId, value1, value2}; e.g. {code:11, dataId:0, value1:0, value2:500} recovers 500 HP. Common codes: 11=recover HP, 12=recover MP, 21=add state, 22=remove state' },
        note: { type: 'string', description: 'Free-form note field, commonly parsed by plugins for metadata tags' },
        iconIndex: { type: ['number', 'string'], description: 'Index into img/system/IconSet.png (16 icons per row); e.g. 176 is the default potion icon' },
        itypeId: { type: ['number', 'string'], description: 'Item category: 1=regular item, 2=key item, 3=hidden item A, 4=hidden item B (default 1)' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value} (rarely used on items; mainly for plugins)' }
      },
      required: ['name']
    }
  },
  {
    name: 'create_weapon',
    description: 'Create a new weapon and persist it to data/Weapons.json immediately with the next free ID. Returns the complete created weapon object including its new id — use that ID in actor equips, create_chest, or create_shop. Fails with an error if Weapons.json cannot be read or written. Use create_item for consumables and create_armor for defensive gear.',
    annotations: { title: 'Create weapon', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Weapon name shown in inventory and equip menus' },
        description: { type: 'string', description: 'Help text shown when the weapon is highlighted' },
        wtypeId: { type: ['number', 'string'], description: 'Weapon type ID from the Types tab (default database: 1=dagger, 2=sword, 3=flail, 4=axe, 5=whip, 6=staff, 7=bow, 8=crossbow, 9=gun, 10=claw, 11=glove, 12=spear); actors can only equip types their class/traits allow' },
        price: { type: ['number', 'string'], description: 'Default shop buy price; 0 makes it unsellable' },
        params: {
          type: 'array',
          description: 'Flat stat bonuses while equipped, in order [Max HP, Max MP, ATK, DEF, MAT, MDF, AGI, LUK]; e.g. [0,0,15,0,0,0,0,0] adds 15 ATK',
          items: { type: ['number', 'string'] }
        },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value}; e.g. element of attack, state on hit, extra attack speed' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        iconIndex: { type: ['number', 'string'], description: 'Index into img/system/IconSet.png; weapon icons start around 96' },
        etypeId: { type: ['number', 'string'], description: 'Equip slot, normally 1 (weapon); only change for dual-wield setups' },
        animationId: { type: ['number', 'string'], description: 'Attack animation ID from Animations.json shown when attacking with this weapon' }
      },
      required: ['name']
    }
  },
  {
    name: 'create_armor',
    description: 'Create a new armor piece and persist it to data/Armors.json immediately with the next free ID. Returns the complete created armor object including its new id — use that ID in actor equips, create_chest, or create_shop. Fails with an error if Armors.json cannot be read or written. Use create_weapon for weapons and create_item for consumables.',
    annotations: { title: 'Create armor', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Armor name shown in inventory and equip menus' },
        description: { type: 'string', description: 'Help text shown when the armor is highlighted' },
        atypeId: { type: ['number', 'string'], description: 'Armor type ID from the Types tab (default database: 1=general, 2=magic, 3=light, 4=heavy, 5=small shield, 6=large shield); actors can only equip types their class/traits allow' },
        price: { type: ['number', 'string'], description: 'Default shop buy price; 0 makes it unsellable' },
        params: {
          type: 'array',
          description: 'Flat stat bonuses while equipped, in order [Max HP, Max MP, ATK, DEF, MAT, MDF, AGI, LUK]; e.g. [0,0,0,10,0,5,0,0] adds 10 DEF and 5 MDF',
          items: { type: ['number', 'string'] }
        },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value}; e.g. element resistance, state immunity' },
        etypeId: { type: ['number', 'string'], description: 'Equip slot this armor occupies: 2=shield, 3=head, 4=body, 5=accessory' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        iconIndex: { type: ['number', 'string'], description: 'Index into img/system/IconSet.png; armor icons start around 128' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_item',
    description: 'Partially update an existing item, weapon, or armor: only the keys present in `fields` are overwritten. Writes the corresponding data file (Items.json, Weapons.json, or Armors.json) to disk immediately; there is no undo. Returns the full object after the update. Fails with an error if no entry exists with the given ID and type. The `type` argument selects which database file is modified — passing the wrong type updates the wrong entry or fails.',
    annotations: { title: 'Update item/weapon/armor', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'ID of the entry to modify within the chosen type\'s database' },
        type: { type: 'string', description: 'Which database to modify: "item" (Items.json), "weapon" (Weapons.json), or "armor" (Armors.json)', enum: ['item', 'weapon', 'armor'] },
        fields: { type: 'object', description: 'Subset of properties to overwrite, e.g. {"price": 250}; keys not listed remain untouched' }
      },
      required: ['id', 'type', 'fields']
    }
  },
  {
    name: 'search_items',
    description: 'Read-only: case-insensitive substring search over names and descriptions in one equipment database (items, weapons, or armors — chosen by `type`, default "item"). Returns an array of matching objects; empty array if nothing matches. Use this to find IDs by name; use the get_items / get_weapons / get_armors tools to list a full database.',
    annotations: { title: 'Search items/weapons/armors', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to look for in name or description, e.g. "potion"' },
        type: { type: 'string', description: 'Which database to search: "item" (default), "weapon", or "armor". Only one is searched per call', enum: ['item', 'weapon', 'armor'] }
      },
      required: ['query']
    }
  },

  // ──────── SKILL TOOLS ────────
  {
    name: 'get_skill',
    description: 'Read-only: fetch one skill object from data/Skills.json by its numeric ID, including damage formula, MP/TP cost, scope, and effects. Returns null (not an error) if the ID is out of range or the skill was deleted, so check the result before using it. Prefer this over get_skills when you know the ID; use search_skills to find an ID by name.',
    annotations: { title: 'Get skill by ID', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Skill ID as shown in the RPG Maker database (1-based; 1=Attack, 2=Guard in a default project)' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_skill',
    description: 'Create a new skill with full control over every property (damage formula, costs, scope, effects, traits) and persist it to data/Skills.json immediately with the next free ID. Returns the complete created skill object including its new id — link it to classes via create_class/update_class learnings or to enemies via action patterns. Fails with an error if Skills.json cannot be read or written. For common cases prefer the simpler helpers: create_damage_skill (attacks), create_healing_skill (heals), create_buff_skill (stat buffs), create_state_skill (poison/sleep/etc.).',
    annotations: { title: 'Create skill (full control)', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name shown in battle and menus' },
        description: { type: 'string', description: 'Help text shown when the skill is highlighted' },
        mpCost: { type: ['number', 'string'], description: 'MP consumed each use (default 0)' },
        tpCost: { type: ['number', 'string'], description: 'TP consumed each use (default 0)' },
        scope: { type: ['number', 'string'], description: 'Targeting: 0=none, 1=one enemy, 2=all enemies, 3-6=random enemies, 7=one ally, 8=all allies, 9=one dead ally (revives), 11=the user' },
        occasion: { type: ['number', 'string'], description: 'When usable: 0=always, 1=battle only (default), 2=menu only, 3=never' },
        animationId: { type: ['number', 'string'], description: 'Animation from Animations.json played on the target; 0=none, -1=use weapon animation' },
        damage: {
          type: 'object',
          description: 'Damage/recovery configuration; omit for pure-effect skills (buffs, states)',
          properties: {
            type: { type: ['number', 'string'], description: 'What the formula does: 0=none, 1=HP damage, 2=MP damage, 3=HP recover, 4=MP recover, 5=HP drain, 6=MP drain' },
            elementId: { type: ['number', 'string'], description: 'Element ID from the Types tab (-1=normal attack element, 0=none; default database: 2=fire, 3=ice, 4=thunder)' },
            formula: { type: 'string', description: 'JavaScript damage formula where a=user, b=target, v=game variables; e.g. "a.atk * 4 - b.def * 2"' },
            variance: { type: ['number', 'string'], description: 'Random damage spread in percent (0-100, default 20); 0 = always exact formula result' },
            critical: { type: 'boolean', description: 'Whether the skill can critically hit for 3x damage (default false)' }
          }
        },
        effects: { type: 'array', description: 'Extra effect objects {code, dataId, value1, value2} applied on hit. Common codes: 11=recover HP, 21=add state (value1=chance 0-1), 22=remove state, 31=add buff (value1=turns), 33=add debuff' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        iconIndex: { type: ['number', 'string'], description: 'Index into img/system/IconSet.png (default 64, a sword icon)' },
        stypeId: { type: ['number', 'string'], description: 'Skill type from the Types tab (default database: 1=Magic, 2=Special); actors need a matching "Add Skill Type" trait to use it' },
        hitType: { type: ['number', 'string'], description: 'Accuracy/evasion handling: 0=certain hit (ignores evasion), 1=physical (uses hit rate/evasion), 2=magical (uses magic evasion)' },
        speed: { type: ['number', 'string'], description: 'Turn-order speed correction; positive acts earlier (e.g. Guard is +2000), default 0' },
        successRate: { type: ['number', 'string'], description: 'Base success percentage 0-100 before hit/evasion (default 100)' },
        repeats: { type: ['number', 'string'], description: 'How many times the effect is applied per use, e.g. 3 = triple hit (default 1)' },
        tpGain: { type: ['number', 'string'], description: 'TP the user gains when the skill lands (default 0)' },
        message1: { type: 'string', description: 'Battle log line 1; %1 is replaced with the user name, e.g. "%1 casts Fireball!"' },
        message2: { type: 'string', description: 'Battle log line 2 (optional second line)' },
        requiredWtypeId1: { type: ['number', 'string'], description: 'Weapon type that must be equipped to use the skill (0 = no requirement)' },
        requiredWtypeId2: { type: ['number', 'string'], description: 'Alternative required weapon type; either requirement satisfies (0 = none)' },
        messageType: { type: ['number', 'string'], description: 'Which message template the battle log uses (1 = standard)' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value} (rarely used on skills; mainly for plugins)' }
      },
      required: ['name']
    }
  },
  {
    name: 'create_damage_skill',
    description: 'Convenience wrapper around create_skill for offensive skills: creates an HP-damage, physical-hit, can-crit skill in data/Skills.json (written immediately) with the next free ID. Returns the complete created skill object including its new id. Fails with a validation error if required arguments are missing or malformed. Use create_skill instead when you need TP costs, multi-hit, drain, custom messages, or extra effects.',
    annotations: { title: 'Create damage skill', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name shown in battle and menus' },
        mpCost: { type: ['number', 'string'], description: 'MP consumed each use' },
        scope: { type: ['number', 'string'], description: 'Targeting: 1=one enemy, 2=all enemies' },
        formula: { type: 'string', description: 'JavaScript damage formula where a=user, b=target; e.g. "a.mat * 4 - b.mdf * 2" for magic or "a.atk * 3 - b.def" for physical' },
        element: { type: ['number', 'string'], description: 'Element ID from the Types tab (default database: 2=fire, 3=ice, 4=thunder); 0=non-elemental (default)' },
        animationId: { type: ['number', 'string'], description: 'Animation from Animations.json played on the target (default 1, a basic hit flash)' }
      },
      required: ['name', 'mpCost', 'scope', 'formula']
    }
  },
  {
    name: 'create_healing_skill',
    description: 'Convenience wrapper around create_skill for restorative skills: creates an HP-recover skill usable in battle and menu, persisted to data/Skills.json immediately with the next free ID. Returns the complete created skill object including its new id. Fails with a validation error if required arguments are missing or malformed. Use create_skill instead for MP restoration, revival, or heal-plus-status combos.',
    annotations: { title: 'Create healing skill', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name shown in battle and menus' },
        mpCost: { type: ['number', 'string'], description: 'MP consumed each use' },
        scope: { type: ['number', 'string'], description: 'Targeting: 7=one ally, 8=all allies, 11=the user' },
        formula: { type: 'string', description: 'JavaScript healing formula where a=user; e.g. "a.mat * 3 + 100" heals more with higher magic attack' },
        animationId: { type: ['number', 'string'], description: 'Animation from Animations.json played on the target (default 47, the standard heal sparkle)' }
      },
      required: ['name', 'mpCost', 'scope', 'formula']
    }
  },
  {
    name: 'create_buff_skill',
    description: 'Convenience wrapper around create_skill for stat buffs: creates a skill that raises one parameter on the target for a set number of turns (engine buff system, stacks to 2 levels of +25% each). Persisted to data/Skills.json immediately with the next free ID. Returns the complete created skill object including its new id. Fails with a validation error if required arguments are missing. Use create_skill with effect code 33 for debuffs, or create_state_skill for status ailments.',
    annotations: { title: 'Create buff skill', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name shown in battle and menus' },
        mpCost: { type: ['number', 'string'], description: 'MP consumed each use' },
        scope: { type: ['number', 'string'], description: 'Targeting: 7=one ally, 8=all allies, 11=the user' },
        paramId: { type: ['number', 'string'], description: 'Which stat to buff: 0=Max HP, 1=Max MP, 2=ATK, 3=DEF, 4=MAT, 5=MDF, 6=AGI, 7=LUK' },
        turns: { type: ['number', 'string'], description: 'How many turns the buff lasts before wearing off, e.g. 5' }
      },
      required: ['name', 'mpCost', 'scope', 'paramId', 'turns']
    }
  },
  {
    name: 'create_state_skill',
    description: 'Convenience wrapper around create_skill for status-infliction skills (poison, sleep, paralysis): creates a magical-hit skill whose only effect is adding one state with a given chance. Persisted to data/Skills.json immediately with the next free ID. Returns the complete created skill object including its new id. Fails with a validation error if required arguments are missing. The state itself must already exist — create it first with create_state if needed. Use create_skill to combine damage and status in one skill.',
    annotations: { title: 'Create status skill', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name shown in battle and menus' },
        mpCost: { type: ['number', 'string'], description: 'MP consumed each use' },
        scope: { type: ['number', 'string'], description: 'Targeting: 1=one enemy, 2=all enemies' },
        stateId: { type: ['number', 'string'], description: 'ID of the state to inflict, from States.json (default database: 4=poison, 5=blind, 6=silence, 8=confusion, 9=sleep). Verify with get_states' },
        chance: { type: ['number', 'string'], description: 'Probability the state is applied, from 0.0 to 1.0 (e.g. 0.8 = 80%); target state resistance applies on top' }
      },
      required: ['name', 'mpCost', 'scope', 'stateId', 'chance']
    }
  },
  {
    name: 'update_skill',
    description: 'Partially update an existing skill in data/Skills.json: only the keys present in `fields` are overwritten, everything else is preserved. The file is written to disk immediately; there is no undo, so fetch the current values with get_skill first if you may need to revert. Returns the full skill object after the update. Fails with an error ("Skill with ID N not found") if the ID does not exist or was deleted.',
    annotations: { title: 'Update skill', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'ID of the skill to modify (must already exist)' },
        fields: { type: 'object', description: 'Subset of skill properties to overwrite, e.g. {"mpCost": 12, "damage": {...}}; keys not listed remain untouched' }
      },
      required: ['id', 'fields']
    }
  },
  {
    name: 'search_skills',
    description: 'Read-only: case-insensitive substring search over skill names and descriptions in data/Skills.json. Returns an array of matching skill objects; empty array if nothing matches. Use this to find a skill ID by name; use get_skills for the full list or get_skill when you know the ID.',
    annotations: { title: 'Search skills', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to look for in skill name or description, e.g. "fire"' }
      },
      required: ['query']
    }
  },

  // ──────── MAP TOOLS ────────
  {
    name: 'get_map_infos',
    description: 'Read-only: list the project\'s map tree from data/MapInfos.json — every map\'s id, name, parentId (folder structure), and editor ordering, but NOT tile or event data. Returns an array of map info objects. Use this to discover map IDs; then call get_map for a specific map\'s full contents.',
    annotations: { title: 'List map tree', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_map',
    description: 'Read-only: load a complete map file (data/MapNNN.json) by ID: dimensions, tileset, the full tile data array (width × height × 6 layers), all events, encounter lists, and BGM settings. Returns the full map object — this can be large for big maps; if you only need events use get_map_events, and for a visual overview use render_map_ascii. Fails with an error if the map file does not exist.',
    annotations: { title: 'Get full map data', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID from MapInfos (map 1 is stored as Map001.json)' }
      },
      required: ['mapId']
    }
  },
  {
    name: 'get_map_events',
    description: 'Read-only: list all events on one map (NPCs, chests, doors, triggers) without the tile data, keeping the response small. Returns an array of event objects with id, name, x, y, and pages. Fails with an error if the map file does not exist. Use get_map_event for a single event, or search_map_events to find events by name.',
    annotations: { title: 'List map events', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID whose events to list' }
      },
      required: ['mapId']
    }
  },
  {
    name: 'get_map_event',
    description: 'Read-only: fetch a single event from a map by event ID, including all its pages, conditions, graphics, and command lists. Returns the event object, or null if the event ID does not exist on that map. Fails with an error if the map file itself does not exist. Use get_map_events to discover event IDs first.',
    annotations: { title: 'Get map event by ID', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID containing the event' },
        eventId: { type: ['number', 'string'], description: 'Event ID within that map (1-based, as shown in the editor)' }
      },
      required: ['mapId', 'eventId']
    }
  },
  {
    name: 'create_map',
    description: 'Create a new map file (data/MapNNN.json) with the next free map ID and register it in MapInfos.json — both files are written to disk immediately. With a `theme`, also generates a tile layout; when `tilesetId` is provided with a theme, reads the tileset\'s real tile IDs for a coherent layout including shadow/region layers. Returns the new map\'s id, name, and dimensions — keep the id for create_npc, connect_maps, etc. Fails with an error if MapInfos.json cannot be written. Prefer generate_map_v3 for richer procedural generation (noise-based terrain, auto-placed events); use this for blank or simple themed maps.',
    annotations: { title: 'Create map', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Internal map name shown in the editor map tree (not visible to players)' },
        width: { type: ['number', 'string'], description: 'Map width in tiles (default 17, the size of one screen)' },
        height: { type: ['number', 'string'], description: 'Map height in tiles (default 13, the size of one screen)' },
        tilesetId: { type: ['number', 'string'], description: 'Tileset from Tilesets.json the map will render with (default 1). List options with get_tilesets' },
        bgmName: { type: 'string', description: 'Audio filename from audio/bgm/ to autoplay when the player enters' },
        displayName: { type: 'string', description: 'Location name briefly shown on screen when the player enters (player-visible, unlike `name`)' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        theme: {
          type: 'string',
          description: 'Optional auto-generated tile layout style. Omit for an empty map you will paint manually with fill_map_layer',
          enum: ['forest', 'dungeon', 'town', 'castle', 'cave', 'village', 'swamp', 'desert', 'ruins', 'interior', 'beach']
        }
      },
      required: []
    }
  },
  {
    name: 'fill_map_layer',
    description: 'Overwrite an ENTIRE tile layer of a map with one tile ID, replacing whatever was painted there before — destructive and not undoable, the map file is written immediately. Returns a confirmation with the map ID and layer filled. Fails with an error if the map does not exist or the layer index is out of range. Useful for laying base terrain before placing details; use tileId 0 to clear a layer. To inspect the result, call render_map_ascii.',
    annotations: { title: 'Fill map layer', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to modify' },
        layer: { type: ['number', 'string'], description: 'Which of the 6 layers to fill: 0-1=ground tiles, 2-3=upper/decoration tiles, 4=shadow bits (0-15), 5=region IDs (0-255)' },
        tileId: { type: ['number', 'string'], description: 'Tile ID to write into every cell of the layer; 0 clears it. Find valid IDs for a tileset with get_tile_ids_for_tileset' }
      },
      required: ['mapId', 'layer', 'tileId']
    }
  },
  {
    name: 'create_map_event',
    description: 'Create a new low-level event on a map at the given position and persist the map file immediately; the event gets the next free event ID. If you pass no `pages`, the event is created with one empty page that does nothing until you add commands with add_event_command. Returns the created event object including its new id. Fails with an error if the map does not exist. For common patterns prefer the high-level helpers, which build correct multi-page events for you: create_npc, create_chest, create_teleport_event, create_shop, create_inn, create_boss_event.',
    annotations: { title: 'Create map event (low-level)', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the event on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based, left to right)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based, top to bottom)' },
        name: { type: 'string', description: 'Event name shown in the editor (also used by search_map_events)' },
        trigger: { type: ['number', 'string'], description: 'How the first page activates: 0=action button (player presses OK facing it), 1=player touch, 2=event touch, 3=autorun (blocks gameplay until done), 4=parallel (runs in background)' },
        pages: { type: 'array', description: 'Optional full event page objects ({conditions, image, list, trigger, ...}); omit to start with a blank page' }
      },
      required: ['mapId', 'x', 'y', 'name']
    }
  },
  {
    name: 'generate_map_v3',
    description: 'Procedurally generate a complete map (terrain via Perlin noise / BSP dungeons / cellular-automata caves depending on theme) and write it to a new data/MapNNN.json plus MapInfos.json immediately. By default also places themed events (NPCs, chests, bosses, transfers). Returns {mapId, seed, width, height, eventCount}; save the seed to regenerate the identical map later. Fails with an error if the theme is unknown or files cannot be written. This is the most capable map generator — prefer it over create_map for playable content; use generate_map_batch to create several connected maps in one call.',
    annotations: { title: 'Generate map (procedural v3)', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Internal map name for the editor map tree' },
        displayName: { type: 'string', description: 'Location name briefly shown to the player on map entry' },
        width: { type: ['number', 'string'], description: 'Map width in tiles (default 30)' },
        height: { type: ['number', 'string'], description: 'Map height in tiles (default 25)' },
        tilesetId: { type: ['number', 'string'], description: 'Tileset to render with — match it to the theme (default project: 1=Overworld, 2=Outside, 3=Inside, 4=Dungeon, 5=SF Outside, 6=SF Inside, 7=Magic Exterior, 8=Space Interior)' },
        theme: { type: 'string', description: 'Generation style: forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world' },
        seed: { type: ['number', 'string'], description: 'Random seed for reproducible output; the same seed + parameters always produce the same map. Omit for a random seed (returned in the result)' },
        addEvents: { type: 'boolean', description: 'Also generate themed events: NPCs, chests, bosses, map transfers (default true). Set false for terrain only' },
        parentId: { type: ['number', 'string'], description: 'Map tree folder to nest this map under (0 = root level)' }
      },
      required: ['theme']
    }
  },
  {
    name: 'generate_map_batch',
    description: 'Generate several procedural maps in one call (same engine as generate_map_v3); each spec creates a new map file written to disk immediately. Returns an array of results with each map\'s key, mapId, and seed — use those mapIds with connect_maps to link them into a world. Fails with an error if any spec has an unknown theme; maps generated before the failure remain on disk. Prefer this over repeated generate_map_v3 calls when building a multi-map area.',
    annotations: { title: 'Generate maps in batch', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        batch: {
          type: 'array',
          description: 'One spec object per map to create',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Your own reference label echoed back in the result, handy for matching mapIds when calling connect_maps' },
              name: { type: 'string', description: 'Internal map name for the editor map tree' },
              theme: { type: 'string', description: 'Generation style (same options as generate_map_v3, e.g. forest, town, dungeon)' },
              width: { type: ['number', 'string'], description: 'Map width in tiles (default 30)' },
              height: { type: ['number', 'string'], description: 'Map height in tiles (default 25)' },
              tilesetId: { type: ['number', 'string'], description: 'Tileset to render with; match it to the theme' },
              seed: { type: ['number', 'string'], description: 'Random seed for reproducible output (omit for random)' },
              parentId: { type: ['number', 'string'], description: 'Map tree folder to nest under (0 = root)' }
            }
          }
        }
      },
      required: ['batch']
    }
  },
  {
    name: 'connect_maps',
    description: 'Create a pair of transfer events so the player can walk between two maps in both directions: one event on map A teleporting to B\'s position, and one on map B teleporting back. Both map files are written to disk immediately. Returns the two created event IDs. Fails with an error if either map does not exist. Use create_teleport_event instead when you only need a one-way transfer.',
    annotations: { title: 'Connect two maps', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapIdA: { type: ['number', 'string'], description: 'First map ID' },
        mapIdB: { type: ['number', 'string'], description: 'Second map ID' },
        posA: { type: 'object', description: 'Where the transfer event sits on map A (the player arrives next to it when coming from B): {x, y, trigger} — trigger 1=walk-on (default), 0=action button (doors)', properties: { x: { type: ['number', 'string'] }, y: { type: ['number', 'string'] }, trigger: { type: ['number', 'string'] } } },
        posB: { type: 'object', description: 'Where the transfer event sits on map B: {x, y, trigger}', properties: { x: { type: ['number', 'string'] }, y: { type: ['number', 'string'] }, trigger: { type: ['number', 'string'] } } }
      },
      required: ['mapIdA', 'mapIdB', 'posA', 'posB']
    }
  },
  {
    name: 'populate_map_events',
    description: 'Bulk-add several events of one kind (npc, chest, or boss) to an existing map at automatically chosen walkable positions; the map file is written to disk immediately. Returns the list of created events with their IDs and positions. Fails with an error if the map does not exist or the eventType is unknown. Use the individual helpers (create_npc, create_chest, create_boss_event) when you need exact positions and contents.',
    annotations: { title: 'Populate map with events', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to add events to' },
        eventType: { type: 'string', description: 'Kind of event to scatter: "npc" (generic villagers with dialogue), "chest" (random loot), or "boss" (battle trigger)' },
        count: { type: ['number', 'string'], description: 'How many events to create (default 3)' },
        opts: { type: 'object', description: 'Optional overrides: {name, troopId (for boss), x, y (fixed position instead of random)}' }
      },
      required: ['mapId', 'eventType']
    }
  },
  {
    name: 'set_map_display_names',
    description: 'Set the player-visible display name of several maps in one call (the name briefly shown on screen when entering a map). Each affected map file is written to disk immediately. Returns a summary of updated maps. Maps that do not exist are reported as errors in the result. Use update_map_event/organize_map_tree for other map metadata; this only touches displayName.',
    annotations: { title: 'Set map display names', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', description: 'One entry per map to rename', items: { type: 'object', properties: { mapId: { type: ['number', 'string'], description: 'Map ID to update' }, name: { type: 'string', description: 'Display name shown to the player on entry' } } } }
      },
      required: ['names']
    }
  },
  {
    name: 'organize_map_tree',
    description: 'Re-parent maps in the editor\'s map tree by setting each map\'s parentId in MapInfos.json (written to disk immediately). Purely organizational — gameplay, transfers, and tile data are unaffected. Returns the updated tree entries. Map IDs that do not exist are skipped and reported. Tip: a map used as a folder is just a normal map; create one with create_map first if needed.',
    annotations: { title: 'Organize map tree', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        folders: { type: 'array', description: 'One entry per map to move', items: { type: 'object', properties: { mapId: { type: ['number', 'string'], description: 'Map ID to move' }, parentId: { type: ['number', 'string'], description: 'New parent map ID, or 0 for root level' } } } }
      },
      required: ['folders']
    }
  },
  {
    name: 'update_map_event',
    description: 'Partially update an existing map event: only the keys present in `fields` are overwritten (e.g. move it by setting x/y, rename it, or replace its pages). The map file is written to disk immediately; replacing `pages` discards the old pages entirely, so fetch them first with get_map_event if you need to merge. Returns the full event object after the update. Fails with an error if the map or event does not exist.',
    annotations: { title: 'Update map event', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID containing the event' },
        eventId: { type: ['number', 'string'], description: 'Event ID to modify (find it with get_map_events or search_map_events)' },
        fields: { type: 'object', description: 'Subset of event properties to overwrite, e.g. {"x": 5, "y": 9} to move it, or {"pages": [...]} to replace behavior' }
      },
      required: ['mapId', 'eventId', 'fields']
    }
  },
  {
    name: 'add_event_command',
    description: 'Append one event command (Show Text, Transfer Player, Control Switches, etc.) to a page of an existing map event, inserted just before the page\'s terminator so the page stays valid. The map file is written to disk immediately. Returns the updated command list length. Fails with an error if the map, event, or page index does not exist. Commands run in list order — call this repeatedly to build a sequence. For common events use add_common_event_command instead.',
    annotations: { title: 'Add event command', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID containing the event' },
        eventId: { type: ['number', 'string'], description: 'Event ID to extend' },
        pageIndex: { type: ['number', 'string'], description: 'Which page receives the command (0-based; default 0, the first page)' },
        command: {
          type: 'object',
          description: 'RPG Maker MV event command. Common codes: 101+401=Show Text, 201=Transfer Player, 121=Control Switches, 122=Control Variables, 125=Change Gold, 126=Change Items, 301=Battle Processing',
          properties: {
            code: { type: ['number', 'string'], description: 'MV event command code (see description for common ones)' },
            indent: { type: ['number', 'string'], description: 'Nesting depth inside conditional branches/loops (default 0 = top level)' },
            parameters: { type: 'array', description: 'Code-specific parameter array; e.g. for 201 (Transfer): [0, mapId, x, y, direction, fadeType]' }
          },
          required: ['code', 'parameters']
        }
      },
      required: ['mapId', 'eventId', 'command']
    }
  },
  {
    name: 'create_npc',
    description: 'High-level helper: create a talking NPC on a map as a ready-to-play 2-page event — page 1 shows the dialogue on action button and turns on Self Switch A; page 2 (active once A is on) shows the last dialogue line for repeat talks. The map file is written to disk immediately. Returns the created event including its id. Fails with a validation error if arguments are malformed or the map does not exist. Use create_map_event + add_event_command instead when you need custom triggers, conditions, or branching dialogue.',
    annotations: { title: 'Create NPC', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the NPC on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based)' },
        name: { type: 'string', description: 'Event name in the editor (not shown to the player)' },
        dialogues: {
          type: 'array',
          description: 'Dialogue lines; each string becomes one Show Text box, displayed in order when the player talks to the NPC',
          items: { type: 'string' }
        },
        characterName: { type: 'string', description: 'Sprite sheet from img/characters/ without extension (e.g. "People1"); list options with get_project_context' },
        characterIndex: { type: ['number', 'string'], description: 'Which of the 8 characters in the sheet to use (0-7)' }
      },
      required: ['mapId', 'x', 'y', 'name', 'dialogues']
    }
  },
  {
    name: 'create_chest',
    description: 'High-level helper: create a treasure chest on a map as a ready-to-play 2-page event — page 1 plays the open animation, gives the listed items, and turns on Self Switch A; page 2 shows the chest already opened so it cannot be looted twice. The map file is written to disk immediately. Returns the created event including its id. Fails with an error if the map does not exist; item IDs are NOT validated, so confirm them first with get_items/get_weapons/get_armors to avoid giving null items.',
    annotations: { title: 'Create chest', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the chest on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based)' },
        items: {
          type: 'array',
          description: 'Loot granted when opened; one entry per stack',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Which database the ID refers to: "item", "weapon", or "armor"' },
              id: { type: ['number', 'string'], description: 'ID of an EXISTING item/weapon/armor (verify with get_items etc.)' },
              amount: { type: ['number', 'string'], description: 'How many copies to give (default 1)' }
            }
          }
        },
        characterName: { type: 'string', description: 'Chest sprite sheet from img/characters/ (default "!Chest", the standard chest graphics)' },
        characterIndex: { type: ['number', 'string'], description: 'Which chest design in the sheet to use (default 0)' }
      },
      required: ['mapId', 'x', 'y', 'items']
    }
  },
  {
    name: 'create_teleport_event',
    description: 'High-level helper: create a one-way transfer event (door, stairs, cave entrance) that moves the player to a position on another map. The source map file is written to disk immediately. Returns the created event including its id. Fails with an error if the source map does not exist; the DESTINATION is not validated, so double-check destMapId/destX/destY or the player will teleport into a void — validate_map can catch transfers to map 0. For two-way passages between maps, connect_maps creates both directions in one call.',
    annotations: { title: 'Create teleport event', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID where the teleport trigger is placed' },
        x: { type: ['number', 'string'], description: 'Trigger tile X position on the source map' },
        y: { type: ['number', 'string'], description: 'Trigger tile Y position on the source map' },
        destMapId: { type: ['number', 'string'], description: 'Map ID the player is transferred to (must exist — not validated here)' },
        destX: { type: ['number', 'string'], description: 'Arrival tile X on the destination map (should be walkable)' },
        destY: { type: ['number', 'string'], description: 'Arrival tile Y on the destination map (should be walkable)' },
        trigger: { type: ['number', 'string'], description: '1=player touch / walk-on (default, for cave mouths and stairs), 0=action button (for doors the player must "open")' }
      },
      required: ['mapId', 'x', 'y', 'destMapId', 'destX', 'destY']
    }
  },
  {
    name: 'search_map_events',
    description: 'Read-only: case-insensitive substring search over event names on one map. Returns an array of matching event objects with their IDs and positions; empty array if nothing matches. Fails with an error if the map does not exist. Use this to locate an event for update_map_event or delete_map_event without dumping the whole map.',
    annotations: { title: 'Search map events', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID whose events to search' },
        query: { type: 'string', description: 'Substring to look for in event names, e.g. "chest"' }
      },
      required: ['mapId', 'query']
    }
  },

  // ──────── SYSTEM TOOLS ────────
  {
    name: 'get_system',
    description: 'Read-only: return the entire data/System.json — game title, starting party and position, switch/variable name lists, vehicle settings, terms, sounds, and more. The response can be large; prefer the focused tools (get_switches, get_variables, get_game_title) when you need just one piece. Returns the full system object.',
    annotations: { title: 'Get system data', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_switches',
    description: 'Read-only: list all game switch names from System.json as an array indexed by switch ID (index 0 is unused; unnamed switches are empty strings). Switches are the project\'s global boolean flags used in event conditions. Use this to find a free or existing switch ID before set_switch_name, create_common_event, or create_puzzle_switch.',
    annotations: { title: 'List switches', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_variables',
    description: 'Read-only: list all game variable names from System.json as an array indexed by variable ID (index 0 is unused; unnamed variables are empty strings). Variables are the project\'s global numeric values used in event logic. Use this to find a free or existing variable ID before set_variable_name or event commands that reference variables.',
    annotations: { title: 'List variables', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'set_switch_name',
    description: 'Rename a game switch in System.json (written to disk immediately). This is documentation only — it does not change any event logic or the switch\'s runtime value, but good names keep event conditions understandable. Returns the updated switch list entry. Fails with an error if the ID is out of the switch array\'s range.',
    annotations: { title: 'Name a switch', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Switch ID to rename (1-based; check current names with get_switches)' },
        name: { type: 'string', description: 'Descriptive label, e.g. "BridgeRepaired" or "MetTheKing"' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'set_variable_name',
    description: 'Rename a game variable in System.json (written to disk immediately). This is documentation only — it does not change any event logic or the variable\'s runtime value. Returns the updated variable list entry. Fails with an error if the ID is out of the variable array\'s range.',
    annotations: { title: 'Name a variable', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Variable ID to rename (1-based; check current names with get_variables)' },
        name: { type: 'string', description: 'Descriptive label, e.g. "QuestProgress" or "GoldDonated"' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'get_game_title',
    description: 'Read-only: return just the game title string from System.json (the name shown on the title screen and window bar). Lighter than get_system when the title is all you need.',
    annotations: { title: 'Get game title', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'update_game_title',
    description: 'Change the game title in System.json (written to disk immediately); this is what appears on the title screen and the game window. Returns the new title. Other System.json fields are untouched — use update_starting_position for the start location.',
    annotations: { title: 'Update game title', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'New game title shown on the title screen' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_starting_position',
    description: 'Set where a new game begins: the player\'s starting map and tile coordinates in System.json (written to disk immediately). Returns the new starting position. The map ID and coordinates are NOT validated against existing maps, so verify with get_map_infos first — a bad value makes new games start in a void. Does not affect saved games.',
    annotations: { title: 'Set starting position', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID where new games start (must exist; check with get_map_infos)' },
        x: { type: ['number', 'string'], description: 'Starting tile X (should be a walkable tile)' },
        y: { type: ['number', 'string'], description: 'Starting tile Y (should be a walkable tile)' }
      },
      required: ['mapId', 'x', 'y']
    }
  },

  // ──────── CLASS TOOLS ────────
  {
    name: 'get_classes',
    description: 'Read-only: list every class from data/Classes.json (stat growth curves, learnable skills, traits). Returns an array of full class objects; empty array if none. Use get_class for one entry or search_classes to find an ID by name.',
    annotations: { title: 'List classes', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_class',
    description: 'Read-only: fetch one class from data/Classes.json by ID, including its parameter curves, EXP formula, skill learnings, and traits. Returns the class object, or null if the ID is out of range or deleted. Prefer this over get_classes when you know the ID.',
    annotations: { title: 'Get class by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Class ID as shown in the RPG Maker database (1-based)' } }, required: ['id'] }
  },
  {
    name: 'create_class',
    description: 'Create a new actor class (defines stat growth, EXP curve, learnable skills, and traits) and persist it to data/Classes.json immediately with the next free ID. Returns the complete created class object including its new id — assign it to actors via create_actor/update_actor classId. Fails with an error if Classes.json cannot be read or written.',
    annotations: { title: 'Create class', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Class name shown in menus (e.g. "Paladin")' },
        params: { type: 'array', description: 'Stat seeds in order [Max HP, Max MP, ATK, DEF, MAT, MDF, AGI, LUK]: full level 1-99 curves are generated automatically (seed value at level 1 growing to 10x at 99). Alternatively pass 8 arrays of 100 per-level values for exact control', items: { type: ['number', 'string'] } },
        expParams: { type: 'array', description: 'EXP curve shape [base, extra, acceleration A, acceleration B] (engine defaults: [30, 20, 30, 30]); higher base = slower leveling', items: { type: ['number', 'string'] } },
        learnings: { type: 'array', description: 'Skills gained on level-up: [{level, skillId, note}]; skillId must exist in Skills.json (verify with get_skills)' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value} every member of this class gets, e.g. weapon proficiencies (code 51) and skill types (code 41)' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_class',
    description: 'Partially update an existing class in data/Classes.json: only the keys present in `fields` are overwritten (note: passing `learnings` or `traits` replaces the whole array, it does not merge). The file is written to disk immediately; no undo. Returns the full class object after the update. Fails with an error if the class ID does not exist.',
    annotations: { title: 'Update class', ...UPDATE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'ID of the class to modify (must already exist)' }, fields: { type: 'object', description: 'Subset of class properties to overwrite; array fields like learnings are replaced wholesale' } }, required: ['id', 'fields'] }
  },
  {
    name: 'search_classes',
    description: 'Read-only: case-insensitive substring search over class names in data/Classes.json. Returns an array of matching class objects; empty array if nothing matches. Use this to find a class ID by name; use get_classes for the full list.',
    annotations: { title: 'Search classes', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Substring to look for in class names, e.g. "mage"' } }, required: ['query'] }
  },
  {
    name: 'delete_class',
    description: 'DESTRUCTIVE: delete a class by setting its entry in data/Classes.json to null (written to disk immediately; not undoable — re-create it if needed). Actors still referencing this classId will break at runtime; reassign them with update_actor first. The ID is never reused by create_class. Returns the deleted class object for reference. Fails with an error if the ID does not exist.',
    annotations: { title: 'Delete class', ...DESTRUCTIVE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Class ID to delete; check actors using it first (get_actors)' } }, required: ['id'] }
  },

  // ──────── ENEMY TOOLS ────────
  {
    name: 'get_enemies',
    description: 'Read-only: list every enemy from data/Enemies.json (stats, drops, action patterns, traits). Returns an array of full enemy objects; empty array if none. Use get_enemy for one entry or search_enemies to find an ID by name. Note: enemies appear in battle only through troops (see get_troops).',
    annotations: { title: 'List enemies', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_enemy',
    description: 'Read-only: fetch one enemy from data/Enemies.json by ID, including stats, EXP/gold rewards, drop items, and action patterns. Returns the enemy object, or null if the ID is out of range or deleted. Prefer this over get_enemies when you know the ID.',
    annotations: { title: 'Get enemy by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Enemy ID as shown in the RPG Maker database (1-based)' } }, required: ['id'] }
  },
  {
    name: 'create_enemy',
    description: 'Create a new enemy and persist it to data/Enemies.json immediately with the next free ID. Returns the complete created enemy object including its new id. To make it appear in battle, add it to a troop afterwards (create_troop, add_enemy_to_troop, or create_random_encounter_troop). Fails with an error if Enemies.json cannot be read or written. For boss-tier enemies with a preset action pattern, create_boss_enemy is quicker.',
    annotations: { title: 'Create enemy', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Enemy name shown in battle messages' },
        battlerName: { type: 'string', description: 'Battle sprite filename from img/enemies/ without extension (e.g. "Slime"); list options with get_project_context' },
        battlerHue: { type: ['number', 'string'], description: 'Color rotation applied to the battler sprite (0-360 degrees); reuse one sprite for palette-swap variants' },
        exp: { type: ['number', 'string'], description: 'EXP awarded to the party when this enemy is defeated' },
        gold: { type: ['number', 'string'], description: 'Gold awarded when defeated' },
        params: { type: 'array', description: 'Fixed combat stats in order [Max HP, Max MP, ATK, DEF, MAT, MDF, AGI, LUK]; unlike actors, enemies do not level', items: { type: ['number', 'string'] } },
        dropItems: { type: 'array', description: 'Up to 3 loot entries [{kind, dataId, denominator}]; kind: 1=item, 2=weapon, 3=armor; denominator N = 1-in-N drop chance' },
        actions: { type: 'array', description: 'AI action patterns [{skillId, conditionType, conditionParam1, conditionParam2, rating}]; rating 1-9 weights how often the skill is picked (conditionType 0 = always)' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value}, e.g. element weaknesses (code 11) or state immunities (code 14)' }
      },
      required: ['name']
    }
  },
  {
    name: 'create_boss_enemy',
    description: 'Convenience wrapper around create_enemy for boss fights: creates an enemy with boosted default stats/rewards and a two-phase action pattern (normal attack plus a special skill used more as HP drops). Persisted to data/Enemies.json immediately with the next free ID. Returns the complete created enemy object including its new id — pair it with create_troop and create_boss_event to stage the fight. Fails with an error if Enemies.json cannot be written. Use create_enemy for full manual control.',
    annotations: { title: 'Create boss enemy', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Boss name shown in battle messages' },
        battlerName: { type: 'string', description: 'Battle sprite filename from img/enemies/ without extension' },
        exp: { type: ['number', 'string'], description: 'EXP awarded on defeat (default 500, boss-tier)' },
        gold: { type: ['number', 'string'], description: 'Gold awarded on defeat (default 200)' },
        params: { type: 'array', description: 'Combat stats [Max HP, Max MP, ATK, DEF, MAT, MDF, AGI, LUK]; omit for boss-tier defaults', items: { type: ['number', 'string'] } },
        specialSkillId: { type: ['number', 'string'], description: 'Skill from Skills.json used as the boss\'s signature attack in its action pattern (verify with get_skill)' },
        actions: { type: 'array', description: 'Custom action patterns replacing the default boss pattern [{skillId, conditionType, conditionParam1, conditionParam2, rating}]' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_enemy',
    description: 'Partially update an existing enemy in data/Enemies.json: only the keys present in `fields` are overwritten (array fields like actions and dropItems are replaced wholesale, not merged). Written to disk immediately; no undo. Returns the full enemy object after the update. Fails with an error if the enemy ID does not exist.',
    annotations: { title: 'Update enemy', ...UPDATE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'ID of the enemy to modify (must already exist)' }, fields: { type: 'object', description: 'Subset of enemy properties to overwrite, e.g. {"exp": 120, "gold": 80}' } }, required: ['id', 'fields'] }
  },
  {
    name: 'search_enemies',
    description: 'Read-only: case-insensitive substring search over enemy names in data/Enemies.json. Returns an array of matching enemy objects; empty array if nothing matches. Use this to find an enemy ID by name; use get_enemies for the full list.',
    annotations: { title: 'Search enemies', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Substring to look for in enemy names, e.g. "slime"' } }, required: ['query'] }
  },
  {
    name: 'delete_enemy',
    description: 'DESTRUCTIVE: delete an enemy by setting its entry in data/Enemies.json to null (written immediately; not undoable). Troops that still include this enemy will reference a null entry and may break battles — check get_troops and update affected troops first. The ID is never reused. Returns the deleted enemy object for reference. Fails with an error if the ID does not exist.',
    annotations: { title: 'Delete enemy', ...DESTRUCTIVE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Enemy ID to delete; check troops using it first (get_troops)' } }, required: ['id'] }
  },

  // ──────── STATE TOOLS ────────
  {
    name: 'get_states',
    description: 'Read-only: list every state (status condition: poison, sleep, KO, buffs) from data/States.json. Returns an array of full state objects; empty array if none. Use get_state for one entry or search_states to find an ID by name. State IDs are referenced by skills (effect code 21) and traits.',
    annotations: { title: 'List states', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_state',
    description: 'Read-only: fetch one state from data/States.json by ID, including restriction, duration, removal conditions, and traits. Returns the state object, or null if the ID is out of range or deleted. Note: state 1 is the engine\'s KO/Death state — avoid repurposing it.',
    annotations: { title: 'Get state by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'State ID as shown in the RPG Maker database (1-based; 1=KO, 4=poison in a default project)' } }, required: ['id'] }
  },
  {
    name: 'create_state',
    description: 'Create a new status condition (ailment or buff) and persist it to data/States.json immediately with the next free ID. The state\'s gameplay impact comes from its `traits` (e.g. a poison state needs an HP-regen trait with a negative value: {code: 22, dataId: 7, value: -0.1} for -10% HP per turn) and `restriction`. Returns the complete created state object including its new id — inflict it via create_state_skill or skill effect code 21. Fails with an error if States.json cannot be written.',
    annotations: { title: 'Create state', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'State name shown in battle messages and status screens' },
        iconIndex: { type: ['number', 'string'], description: 'Icon from img/system/IconSet.png shown next to afflicted battlers (status icons start at index 16)' },
        restriction: { type: ['number', 'string'], description: 'Action restriction while afflicted: 0=none (poison-like), 1=attack an enemy randomly, 2=attack anyone randomly (confusion), 3=attack an ally randomly, 4=cannot act (sleep/paralysis)' },
        priority: { type: ['number', 'string'], description: 'Display priority 0-100 deciding which state\'s overlay/icon shows when several are active (default 50)' },
        removeAtBattleEnd: { type: 'boolean', description: 'true = state is cleared automatically when battle ends (typical for buffs); false = persists on the map like poison (default false)' },
        removeByDamage: { type: 'boolean', description: 'true = taking damage can wake/remove the state, as with sleep (default false)' },
        autoRemovalTiming: { type: ['number', 'string'], description: 'When the turn counter is checked: 0=never auto-remove, 1=at action end, 2=at turn end' },
        minTurns: { type: ['number', 'string'], description: 'Minimum turns before auto-removal (actual duration is random between min and max; default 1)' },
        maxTurns: { type: ['number', 'string'], description: 'Maximum turns before auto-removal (default 5)' },
        traits: { type: 'array', description: 'Trait objects {code, dataId, value} defining what the state DOES — without traits (and restriction 0) the state is purely cosmetic. E.g. poison: {code:22, dataId:7, value:-0.1}' },
        message1: { type: 'string', description: 'Battle log when an actor gains the state, e.g. " is poisoned!" (subject name is prepended)' },
        message2: { type: 'string', description: 'Battle log when an enemy gains the state' },
        message3: { type: 'string', description: 'Battle log shown each turn while the state persists' },
        message4: { type: 'string', description: 'Battle log when the state is removed, e.g. " recovered!"' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' },
        removeByRestriction: { type: 'boolean', description: 'true = removed when another restriction-state is applied (default false)' },
        stepsToRemove: { type: ['number', 'string'], description: 'Steps walked on the map before removal, used when "remove by walking" is enabled (default 100)' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_state',
    description: 'Partially update an existing state in data/States.json: only the keys present in `fields` are overwritten (the traits array is replaced wholesale). Written to disk immediately; no undo. Returns the full state object after the update. Fails with an error if the state ID does not exist. Be careful editing state 1 (KO) — the engine depends on it.',
    annotations: { title: 'Update state', ...UPDATE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'ID of the state to modify (must already exist)' }, fields: { type: 'object', description: 'Subset of state properties to overwrite, e.g. {"maxTurns": 8}' } }, required: ['id', 'fields'] }
  },
  {
    name: 'search_states',
    description: 'Read-only: case-insensitive substring search over state names in data/States.json. Returns an array of matching state objects; empty array if nothing matches. Use this to find a state ID by name before create_state_skill or skill effects.',
    annotations: { title: 'Search states', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Substring to look for in state names, e.g. "poison"' } }, required: ['query'] }
  },
  {
    name: 'delete_state',
    description: 'DESTRUCTIVE: delete a state by setting its entry in data/States.json to null (written immediately; not undoable). Skills, items, and traits referencing this state ID will silently stop working or error — search for references first. NEVER delete state 1 (KO); the battle engine requires it. The ID is never reused. Returns the deleted state object. Fails with an error if the ID does not exist.',
    annotations: { title: 'Delete state', ...DESTRUCTIVE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'State ID to delete (never 1, the KO state)' } }, required: ['id'] }
  },

  // ──────── TILESET TOOLS ────────
  {
    name: 'get_tilesets',
    description: 'Read-only: list every tileset configuration from data/Tilesets.json (which image sheets each map style uses, plus per-tile passability/terrain flags). Returns an array of full tileset objects; empty array if none. Use get_tileset for one entry, or scan_project_assets / get_tile_ids_for_tileset for a digested view of usable tile IDs.',
    annotations: { title: 'List tilesets', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_tileset',
    description: 'Read-only: fetch one tileset from data/Tilesets.json by ID, including its tilesetNames (image files from img/tilesets/), mode, and the flags array encoding passability per tile. Returns the tileset object, or null if the ID is out of range. For categorized, ready-to-use tile IDs prefer get_tile_ids_for_tileset.',
    annotations: { title: 'Get tileset by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Tileset ID as shown in the RPG Maker database (1-based)' } }, required: ['id'] }
  },
  {
    name: 'update_tileset',
    description: 'Partially update a tileset in data/Tilesets.json: only the keys present in `fields` are overwritten (e.g. swap an image in tilesetNames or adjust flags). Written to disk immediately; no undo. CAUTION: every map using this tileset is visually affected, and malformed flags break passability project-wide — read the current object with get_tileset first. Returns the full tileset object after the update. Fails with an error if the tileset ID does not exist.',
    annotations: { title: 'Update tileset', ...UPDATE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'ID of the tileset to modify (must already exist)' }, fields: { type: 'object', description: 'Subset of tileset properties to overwrite, e.g. {"name": "Dungeon B", "tilesetNames": [...]} — arrays are replaced wholesale' } }, required: ['id', 'fields'] }
  },

  // ──────── COMMON EVENT TOOLS ────────
  {
    name: 'get_common_events',
    description: 'Read-only: list every common event from data/CommonEvents.json (reusable command sequences callable from any event, or auto-running via a switch). Returns an array of full common event objects including their command lists; empty array if none. Use this to find IDs before update_common_event or add_common_event_command.',
    annotations: { title: 'List common events', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'create_common_event',
    description: 'Create a new common event and persist it to data/CommonEvents.json immediately with the next free ID. With trigger 0 it only runs when called from another event (command code 117); with trigger 1 (autorun, blocks the player) or 2 (parallel, background) it runs whenever its switchId is ON — so always pair trigger>0 with a real switch or it will loop forever from game start. Returns the complete created common event including its new id. Fails with an error if CommonEvents.json cannot be written.',
    annotations: { title: 'Create common event', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Common event name shown in the editor' },
        trigger: { type: ['number', 'string'], description: '0=none (run only when called via event command 117; default), 1=autorun while switch is ON (freezes gameplay until done), 2=parallel while switch is ON (runs in background each frame)' },
        switchId: { type: ['number', 'string'], description: 'Game switch that activates the event — REQUIRED in practice when trigger is 1 or 2; pick an ID with get_switches' },
        list: { type: 'array', description: 'Event commands {code, indent, parameters} to run; a terminator (code 0) is appended automatically if missing. You can also add commands later with add_common_event_command' },
        note: { type: 'string', description: 'Free-form note field for plugin metadata' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_common_event',
    description: 'Partially update an existing common event in data/CommonEvents.json: only the keys present in `fields` are overwritten (passing `list` replaces the whole command list). Written to disk immediately; no undo. Returns the full common event after the update. Fails with an error if the ID does not exist. To append a single command instead of replacing the list, use add_common_event_command.',
    annotations: { title: 'Update common event', ...UPDATE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'ID of the common event to modify (must already exist)' }, fields: { type: 'object', description: 'Subset of properties to overwrite, e.g. {"trigger": 2, "switchId": 5}; `list` replaces all commands' } }, required: ['id', 'fields'] }
  },
  {
    name: 'add_common_event_command',
    description: 'Append one event command to an existing common event\'s command list, inserted before the terminator so the list stays valid; data/CommonEvents.json is written immediately. Returns the updated common event. Fails with an error if the common event ID does not exist. Commands run in list order — call repeatedly to build a sequence. This is the common-event counterpart of add_event_command (which targets map events).',
    annotations: { title: 'Add common event command', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Common event ID to extend (find with get_common_events)' },
        command: { type: 'object', description: 'RPG Maker MV event command {code, indent, parameters}. Common codes: 101+401=Show Text, 121=Control Switches, 122=Control Variables, 117=Call Common Event' }
      },
      required: ['id', 'command']
    }
  },

  // ──────── TROOP TOOLS ────────
  {
    name: 'get_troops',
    description: 'Read-only: list every troop (enemy formation used in battles) from data/Troops.json, including member enemy IDs/positions and battle event pages. Returns an array of full troop objects; empty array if none. Troop IDs are what battle commands and create_boss_event reference — enemies alone never appear in battle.',
    annotations: { title: 'List troops', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_troop',
    description: 'Read-only: fetch one troop from data/Troops.json by ID, including its enemy members with screen positions and any battle event pages. Returns the troop object, or null if the ID is out of range or deleted. Prefer this over get_troops when you know the ID.',
    annotations: { title: 'Get troop by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Troop ID as shown in the RPG Maker database (1-based)' } }, required: ['id'] }
  },
  {
    name: 'create_troop',
    description: 'Create a new troop (enemy formation) with explicit member positions and persist it to data/Troops.json immediately with the next free ID. Returns the complete created troop object including its new id — use that ID in create_boss_event, map encounter lists, or Battle Processing commands. Enemy IDs in members are NOT validated; confirm them with get_enemies first. For auto-positioned members, create_random_encounter_troop is simpler; to extend an existing troop use add_enemy_to_troop.',
    annotations: { title: 'Create troop', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Troop name shown in the editor and at battle start (e.g. "Slime x2")' },
        members: { type: 'array', description: 'Enemies in the formation: [{enemyId, x, y, hidden}]; x/y are battle-screen pixel positions (x typically 100-700, y 300-450)' }
      },
      required: ['name']
    }
  },
  {
    name: 'add_enemy_to_troop',
    description: 'Append one enemy to an existing troop at an automatically computed battle position (spread across the screen); data/Troops.json is written immediately. Returns the updated troop object. Fails with an error if the troop does not exist; the enemy ID is not validated, so confirm it with get_enemy. Use create_troop to build a formation from scratch.',
    annotations: { title: 'Add enemy to troop', ...UPDATE },
    inputSchema: {
      type: 'object',
      properties: {
        troopId: { type: ['number', 'string'], description: 'Existing troop ID to extend (find with get_troops)' },
        enemyId: { type: ['number', 'string'], description: 'Enemy from Enemies.json to add (verify with get_enemy)' }
      },
      required: ['troopId', 'enemyId']
    }
  },
  {
    name: 'create_random_encounter_troop',
    description: 'Convenience wrapper around create_troop: creates a troop from a list of enemy IDs with battle positions computed automatically (evenly spread). Persisted to data/Troops.json immediately with the next free ID. Returns the complete created troop including its new id — add it to a map\'s encounter list or use it in events. Enemy IDs are not validated; confirm them with get_enemies first. Use create_troop when you need exact positioning or hidden members.',
    annotations: { title: 'Create encounter troop', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Troop name (e.g. "Forest Pack")' },
        enemyIds: { type: 'array', description: 'Enemy IDs to include, in order; duplicates allowed for multiples of the same enemy (e.g. [1, 1, 4])', items: { type: ['number', 'string'] } }
      },
      required: ['name', 'enemyIds']
    }
  },

  // ──────── ANIMATION TOOLS ────────
  {
    name: 'get_animations',
    description: 'Read-only: list every battle/skill animation from data/Animations.json (id, name, source image, frames, timings). Returns an array of animation objects; empty array if none. Use this to pick valid animationId values for skills, items, and events — this server cannot create new animations, so choose from the existing ones.',
    annotations: { title: 'List animations', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_animation',
    description: 'Read-only: fetch one animation from data/Animations.json by ID, including its frame and timing data. Returns the animation object, or null if the ID is out of range. Prefer this over get_animations when you know the ID and want details like frame count.',
    annotations: { title: 'Get animation by ID', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Animation ID as shown in the RPG Maker database (1-based; 1 is a basic hit in a default project)' } }, required: ['id'] }
  },

  // ──────── DELETE TOOLS (Actors/Items/Skills) ────────
  {
    name: 'delete_actor',
    description: 'DESTRUCTIVE: delete an actor by setting its entry in data/Actors.json to null (written immediately; not undoable — re-create it if needed). If the actor is in the starting party (System.json partyMembers) or referenced by events, those references break — update them first. The ID is never reused. Returns the deleted actor object for reference. Fails with an error if the ID does not exist.',
    annotations: { title: 'Delete actor', ...DESTRUCTIVE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Actor ID to delete; check the starting party (get_system) first' } }, required: ['id'] }
  },
  {
    name: 'delete_item',
    description: 'DESTRUCTIVE: delete an item, weapon, or armor by setting its entry to null in the database chosen by `type` (Items.json, Weapons.json, or Armors.json; written immediately; not undoable). Chests, shops, actor equips, and events referencing the ID will give/sell nothing or break — update them first. The ID is never reused. Returns the deleted object for reference. Fails with an error if the ID does not exist in that database.',
    annotations: { title: 'Delete item/weapon/armor', ...DESTRUCTIVE },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'ID of the entry to delete within the chosen type\'s database' },
        type: { type: 'string', description: 'Which database to delete from: "item" (Items.json), "weapon" (Weapons.json), or "armor" (Armors.json)', enum: ['item', 'weapon', 'armor'] }
      },
      required: ['id', 'type']
    }
  },
  {
    name: 'delete_skill',
    description: 'DESTRUCTIVE: delete a skill by setting its entry in data/Skills.json to null (written immediately; not undoable). Class learnings, enemy action patterns, and actors who already know the skill will reference a null entry — clean those up first (get_classes, get_enemies). Never delete skills 1 (Attack) or 2 (Guard); the engine uses them directly. The ID is never reused. Returns {deleted: <skill>} for reference. Fails with an error if the ID does not exist.',
    annotations: { title: 'Delete skill', ...DESTRUCTIVE },
    inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Skill ID to delete (never 1=Attack or 2=Guard)' } }, required: ['id'] }
  },

  // ──────── MAP HELPER TOOLS ────────
  {
    name: 'delete_map_event',
    description: 'DESTRUCTIVE: remove an event from a map (written to disk immediately; not undoable — fetch it first with get_map_event if you may want it back). Other events that target it by ID (e.g. Set Event Location) will break. Returns the deleted event object for reference. Fails with an error if the map or event does not exist.',
    annotations: { title: 'Delete map event', ...DESTRUCTIVE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID containing the event' },
        eventId: { type: ['number', 'string'], description: 'Event ID to remove (find with get_map_events or search_map_events)' }
      },
      required: ['mapId', 'eventId']
    }
  },
  {
    name: 'duplicate_map',
    description: 'Copy an existing map — tiles, events, and settings — into a brand-new map file with the next free map ID, registered in MapInfos.json (both files written immediately). The source map is not modified. Returns the new map\'s id and name; transfer events in the copy still point to their ORIGINAL destinations, so review them with get_map_events and fix with update_map_event. Fails with an error if the source map does not exist. Useful for map variants (day/night, before/after-story versions).',
    annotations: { title: 'Duplicate map', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        sourceMapId: { type: ['number', 'string'], description: 'Existing map ID to copy from (unchanged by this operation)' },
        name: { type: 'string', description: 'Internal editor name for the new copy' },
        displayName: { type: 'string', description: 'Player-visible location name for the new copy (defaults to the source\'s)' }
      },
      required: ['sourceMapId', 'name']
    }
  },
  {
    name: 'create_shop',
    description: 'High-level helper: create a shopkeeper event that opens the buy/sell screen (Shop Processing) with the given goods when the player talks to it. The map file is written to disk immediately. Returns the created event including its id. Fails with an error if the map does not exist; item IDs in goods are NOT validated — confirm them with get_items/get_weapons/get_armors or the shop will sell null entries. For an innkeeper use create_inn; for a plain dialogue NPC use create_npc.',
    annotations: { title: 'Create shop', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the shopkeeper on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based)' },
        name: { type: 'string', description: 'Event name in the editor (e.g. "Weapon Shop")' },
        goods: { type: 'array', description: 'Wares as arrays [type, itemId, priceType, price]: type 0=item, 1=weapon, 2=armor; priceType 0=use the database price (price arg ignored), 1=custom price. E.g. [[0, 1, 0, 0], [1, 2, 1, 150]]', items: { type: 'array' } },
        characterName: { type: 'string', description: 'Shopkeeper sprite sheet from img/characters/ without extension' },
        characterIndex: { type: ['number', 'string'], description: 'Which of the 8 characters in the sheet to use (0-7)' }
      },
      required: ['mapId', 'x', 'y', 'name', 'goods']
    }
  },
  {
    name: 'create_inn',
    description: 'High-level helper: create an innkeeper event with the classic inn flow — asks the player (Yes/No choice), checks gold, deducts the cost, fades out, fully recovers the party, and fades back in; refuses if the player cannot pay. The map file is written to disk immediately. Returns the created event including its id. Fails with an error if the map does not exist. For a general store use create_shop.',
    annotations: { title: 'Create inn', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the innkeeper on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based)' },
        name: { type: 'string', description: 'Event name in the editor (e.g. "Innkeeper")' },
        cost: { type: ['number', 'string'], description: 'Gold charged for one night\'s full recovery (default 50)' },
        characterName: { type: 'string', description: 'Innkeeper sprite sheet from img/characters/ without extension' },
        characterIndex: { type: ['number', 'string'], description: 'Which of the 8 characters in the sheet to use (0-7)' }
      },
      required: ['mapId', 'x', 'y', 'name']
    }
  },
  {
    name: 'create_boss_event',
    description: 'High-level helper: create a boss-fight trigger on a map as a 2-page event — page 1 starts Battle Processing against the given troop (losing means game over) and turns on Self Switch A on victory; page 2 (after A) is empty so the boss is gone for good. The map file is written to disk immediately. Returns the created event including its id. Fails with an error if the map does not exist; the troopId is not validated — create the troop first (create_troop or create_random_encounter_troop) and pass its real ID.',
    annotations: { title: 'Create boss event', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to place the boss on' },
        x: { type: ['number', 'string'], description: 'Tile X position (0-based)' },
        y: { type: ['number', 'string'], description: 'Tile Y position (0-based)' },
        name: { type: 'string', description: 'Event name in the editor (e.g. "Dragon Boss")' },
        troopId: { type: ['number', 'string'], description: 'Troop from Troops.json to battle (must exist; verify with get_troop)' },
        characterName: { type: 'string', description: 'Boss sprite sheet from img/characters/ without extension (e.g. "Monster")' },
        characterIndex: { type: ['number', 'string'], description: 'Which of the 8 characters in the sheet to use (0-7)' }
      },
      required: ['mapId', 'x', 'y', 'name', 'troopId']
    }
  },
  {
    name: 'create_puzzle_switch',
    description: 'High-level helper: create a linked switch-and-door puzzle as TWO events on the same map — a floor switch that turns the given game switch ON when activated, and a door that only opens (becomes passable/teleports) while that switch is ON. The map file is written to disk immediately. Returns both created events with their ids. Fails with an error if the map does not exist. Reserve a dedicated game switch ID (check get_switches) — reusing a story switch will tangle quest logic.',
    annotations: { title: 'Create puzzle switch+door', ...CREATE },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID for both events' },
        switchX: { type: ['number', 'string'], description: 'Floor-switch tile X position' },
        switchY: { type: ['number', 'string'], description: 'Floor-switch tile Y position' },
        doorX: { type: ['number', 'string'], description: 'Door tile X position' },
        doorY: { type: ['number', 'string'], description: 'Door tile Y position' },
        gameSwitchId: { type: ['number', 'string'], description: 'Game switch linking the pair — pick an unused ID via get_switches and label it with set_switch_name' },
        switchName: { type: 'string', description: 'Editor name for the floor-switch event (default "Switch")' },
        doorName: { type: 'string', description: 'Editor name for the door event (default "Door")' }
      },
      required: ['mapId', 'switchX', 'switchY', 'doorX', 'doorY', 'gameSwitchId']
    }
  },

  // ──────── PROJECT TOOLS ────────
  {
    name: 'get_project_summary',
    description: 'Read-only: return lightweight statistics about the current project — game title plus entry counts per database (actors, items, skills, maps, etc.). Returns a small summary object. Use this for a quick health check; use get_project_context when you need actual IDs and names to work with.',
    annotations: { title: 'Project summary', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_project_context',
    description: 'Read-only: return a pre-digested snapshot of the whole project in one call — id+name lists for every database (maps, actors, items, weapons, armors, skills, enemies, troops, states, tilesets, common events), switch/variable names, starting position, and available sprite filenames per img/ folder. Returns one structured object. CALL THIS FIRST in a session before creating content: it gives you every valid ID and asset name, preventing broken references. Slower than get_project_summary but far more useful for planning.',
    annotations: { title: 'Full project context', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'validate_map',
    description: 'Read-only: lint one map for common defects — tile IDs out of range per layer, shadow/region values out of bounds, event pages missing their terminator command, Change Item with null item, Transfer Player to map 0, and Self Switches set OFF where ON was likely intended. Returns {mapId, eventCount, issueCount, issues: [{type, message, ...locators}]}; issueCount 0 means clean. Fails with an error if the map does not exist. Run this after generating or hand-editing maps, before testing in the engine.',
    annotations: { title: 'Validate map', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Map ID to check (find IDs with get_map_infos)' }
      },
      required: ['mapId']
    }
  },
  {
    name: 'set_project_path',
    description: 'Switch this server to operate on a DIFFERENT RPG Maker MV project directory for all subsequent tool calls (session-wide side effect; persists until changed again or the server restarts). Validates that the path contains data/System.json before switching and fails with an error otherwise, leaving the previous project active. Returns the new active path. Use when managing multiple projects; otherwise the RPGMAKER_PROJECT_PATH environment variable set at startup applies.',
    annotations: { title: 'Switch project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to an RPG Maker MV project root (the folder containing data/System.json and img/)' }
      },
      required: ['path']
    }
  },

  // ──────── VISION / IMAGE TOOLS ────────
  {
    name: 'analyze_tileset_image',
    description: 'Read-only utility: measure a tileset image you provide as base64 PNG and compute its grid assuming the standard RPG Maker MV 48×48 px tile size. Returns {imageWidth, imageHeight, tileSize, cols, rows, totalTiles}. Pure local computation — no files are read or written and no network is used. Fails with an error if the data is not a decodable image. For semantic analysis of image CONTENT (what the tiles depict), use analyze_screenshot instead.',
    annotations: { title: 'Measure tileset grid', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        base64PNG: { type: 'string', description: 'Base64-encoded PNG of a tileset sheet (raw base64, no data: URL prefix)' }
      },
      required: ['base64PNG']
    }
  },
  {
    name: 'read_screenshot',
    description: 'Read-only utility: split a screenshot you provide as base64 PNG into 4 quadrants and return each quadrant\'s average RGB color — a cheap, offline way to sanity-check what is roughly on screen (e.g. mostly green = grass, mostly black = unlit). Returns {imageWidth, imageHeight, quadrants: {top-left|top-right|bottom-left|bottom-right: {r, g, b}}}. No files written, no network. For real content understanding use analyze_screenshot (requires a vision API); for precise map layout use render_map_ascii.',
    annotations: { title: 'Screenshot color summary', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        base64PNG: { type: 'string', description: 'Base64-encoded PNG screenshot (raw base64, no data: URL prefix)' }
      },
      required: ['base64PNG']
    }
  },

  // ──────── ASSET TOOLS ────────
  {
    name: 'scan_project_assets',
    description: 'Read-only: scan the project\'s img/ folders and Tilesets.json to build a complete asset index — per-tileset sheet metadata (dimensions, tile counts, autotile kinds) with categorized usable tiles (ground, water, wallSide, wallTop, roof, decoration), plus every PNG filename per img/ subdirectory. Returns one large structured index object. Run it before map creation so create_map/generate_map_v3 themes can pick real tiles; for a single tileset, get_tile_ids_for_tileset is lighter.',
    annotations: { title: 'Scan project assets', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_tile_ids_for_tileset',
    description: 'Read-only: return the usable tile IDs of ONE tileset, organized by category (ground, water, wallSide, wallTop, roof, decoration); each entry has the tileId, autotile kind index, and a short description. Use the returned IDs with fill_map_layer or manual tile edits — guessing tile IDs produces glitched maps. Fails with an error if the tileset ID does not exist. For all tilesets at once plus image listings, use scan_project_assets.',
    annotations: { title: 'Get tileset tile IDs', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        tilesetId: { type: ['number', 'string'], description: 'Tileset from Tilesets.json to categorize (list options with get_tilesets)' }
      },
      required: ['tilesetId']
    }
  },

  // ──────── VISION AI TOOLS ────────
  {
    name: 'analyze_screenshot',
    description: 'Analyze an image file from the project (tileset, character sprite, map screenshot, battler, face) by sending it to an external OpenAI-compatible Vision API and returning the model\'s textual description plus token usage: {image_path, analysis, model, tokens_used}. NETWORK SIDE EFFECT: the (resized, JPEG-compressed) image leaves your machine and goes to the endpoint configured via VISION_API_URL / VISION_API_KEY / VISION_MODEL environment variables. Fails with an error if the image path escapes the project, the file does not exist, the API is unreachable, or it times out (120 s). For offline alternatives: render_map_ascii (map layout), analyze_tileset_image (grid math), read_screenshot (color summary).',
    annotations: { title: 'AI-analyze project image', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path to the image RELATIVE to the project root, e.g. "img/tilesets/Outside.png" or "img/characters/Actor1.png"; paths outside the project are rejected' },
        prompt: { type: 'string', description: 'Custom analysis question for the vision model; omit for a thorough RPG-Maker-specific analysis (in Spanish by default)' },
        resize_max: { type: ['number', 'string'], description: 'Maximum width in pixels the image is downscaled to before upload (default 1024; lower = fewer tokens, less detail)' }
      },
      required: ['image_path']
    }
  },
  {
    name: 'render_map_ascii',
    description: 'Read-only: render a map as an ASCII grid entirely offline — one character per tile (~ water, # wall, " bush, etc., with a legend) plus event positions marked by the first letter of their names. Returns {mapId, width, height, ascii, legend, events[], regionAscii?}. Use this to "see" a map\'s layout, verify generated terrain, or pick coordinates for events without any screenshot or API; it is the precise companion to validate_map. Fails with an error if the map does not exist; returns an error field if the map has no tile data.',
    annotations: { title: 'Render map as ASCII', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: ['number', 'string'], description: 'Map ID to render (find IDs with get_map_infos)' },
        layer: { type: ['number', 'string'], description: 'Which tile layer to draw: 0=ground (default), 2=upper/decoration' },
        show_events: { type: 'boolean', description: 'Overlay event markers on the grid (default true)' },
        show_regions: { type: 'boolean', description: 'Also return the region-ID layer as a second grid (default false)' }
      },
      required: ['map_id']
    }
  }
];
