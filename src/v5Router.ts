/**
 * v5Router.ts — routes the 12 consolidated v5 tools onto the existing
 * per-operation implementations (the same code paths the 101 legacy tools use).
 *
 * Most branches translate (toolName, args) into a legacy tool invocation via
 * the injected `executeTool` callback so legacy Zod validation still applies.
 * Only the few operations with no legacy equivalent (single-item get for
 * items/weapons/armors/common events, generic search, template generation,
 * template listing) call the implementation modules directly.
 */

import * as mapTools from './tools/mapTools.js';
import { searchTemplates } from './utils/mapGenerator.js';

type ExecuteTool = (name: string, args: Record<string, any>) => Promise<unknown>;

const DB_ENTITIES = [
  'actors', 'classes', 'skills', 'items', 'weapons', 'armors',
  'enemies', 'states', 'troops', 'tilesets', 'common_events', 'animations'
] as const;
type DbEntity = typeof DB_ENTITIES[number];

function assertEntity(entity: unknown): DbEntity {
  if (typeof entity !== 'string' || !(DB_ENTITIES as readonly string[]).includes(entity)) {
    throw new Error('Unknown entity "' + String(entity) + '". Valid entities: ' + DB_ENTITIES.join(', '));
  }
  return entity as DbEntity;
}

function requireArg(args: Record<string, any>, key: string, context: string): any {
  if (args[key] === undefined || args[key] === null) {
    throw new Error('Missing required argument "' + key + '" for ' + context);
  }
  return args[key];
}

// Legacy tool names per entity for each CRUD verb ('' = no legacy tool, handled inline)
const LIST_TOOL: Record<DbEntity, string> = {
  actors: 'get_actors', classes: 'get_classes', skills: 'get_skills', items: 'get_items',
  weapons: 'get_weapons', armors: 'get_armors', enemies: 'get_enemies', states: 'get_states',
  troops: 'get_troops', tilesets: 'get_tilesets', common_events: 'get_common_events', animations: 'get_animations'
};
const GET_TOOL: Partial<Record<DbEntity, string>> = {
  actors: 'get_actor', classes: 'get_class', skills: 'get_skill', enemies: 'get_enemy',
  states: 'get_state', troops: 'get_troop', tilesets: 'get_tileset', animations: 'get_animation'
};
const SEARCH_TOOL: Partial<Record<DbEntity, string>> = {
  actors: 'search_actors', classes: 'search_classes', skills: 'search_skills',
  enemies: 'search_enemies', states: 'search_states'
};
const CREATE_TOOL: Partial<Record<DbEntity, string>> = {
  actors: 'create_actor', classes: 'create_class', skills: 'create_skill', items: 'create_item',
  weapons: 'create_weapon', armors: 'create_armor', enemies: 'create_enemy', states: 'create_state',
  troops: 'create_troop', common_events: 'create_common_event'
};
const UPDATE_TOOL: Partial<Record<DbEntity, string>> = {
  actors: 'update_actor', classes: 'update_class', skills: 'update_skill', enemies: 'update_enemy',
  states: 'update_state', tilesets: 'update_tileset', common_events: 'update_common_event'
};
const DELETE_TOOL: Partial<Record<DbEntity, string>> = {
  actors: 'delete_actor', classes: 'delete_class', skills: 'delete_skill',
  enemies: 'delete_enemy', states: 'delete_state'
};
const ITEMISH_TYPE: Partial<Record<DbEntity, string>> = { items: 'item', weapons: 'weapon', armors: 'armor' };

const CREATE_PRESETS: Record<string, { tool: string; entity: DbEntity }> = {
  damage_skill: { tool: 'create_damage_skill', entity: 'skills' },
  healing_skill: { tool: 'create_healing_skill', entity: 'skills' },
  buff_skill: { tool: 'create_buff_skill', entity: 'skills' },
  state_skill: { tool: 'create_state_skill', entity: 'skills' },
  boss_enemy: { tool: 'create_boss_enemy', entity: 'enemies' },
  encounter_troop: { tool: 'create_random_encounter_troop', entity: 'troops' }
};

const EVENT_PRESETS: Record<string, string> = {
  npc: 'create_npc',
  chest: 'create_chest',
  teleport: 'create_teleport_event',
  shop: 'create_shop',
  inn: 'create_inn',
  boss: 'create_boss_event',
  puzzle_switch: 'create_puzzle_switch'
};

async function queryDatabase(executeTool: ExecuteTool, projectPath: string, args: Record<string, any>) {
  const entity = assertEntity(args.entity);

  if (args.id !== undefined && args.id !== null) {
    const getTool = GET_TOOL[entity];
    if (getTool) return executeTool(getTool, { id: args.id });
    // items/weapons/armors/common_events have no legacy single-get: list and find
    const all = await listEntity(executeTool, projectPath, entity) as Array<Record<string, unknown>>;
    return all.find(function(e) { return e && Number(e.id) === Number(args.id); }) ?? null;
  }

  if (args.query !== undefined && args.query !== null && args.query !== '') {
    const searchTool = SEARCH_TOOL[entity];
    if (searchTool) return executeTool(searchTool, { query: args.query });
    if (ITEMISH_TYPE[entity]) return executeTool('search_items', { query: args.query, type: ITEMISH_TYPE[entity] });
    // Generic fallback: case-insensitive name filter
    const all = await listEntity(executeTool, projectPath, entity) as Array<Record<string, unknown>>;
    const q = String(args.query).toLowerCase();
    return all.filter(function(e) { return e && typeof e.name === 'string' && e.name.toLowerCase().includes(q); });
  }

  return listEntity(executeTool, projectPath, entity);
}

async function listEntity(executeTool: ExecuteTool, _projectPath: string, entity: DbEntity) {
  return executeTool(LIST_TOOL[entity], {});
}

async function createDatabaseEntry(executeTool: ExecuteTool, args: Record<string, any>) {
  const data = (args.data || {}) as Record<string, any>;

  if (args.preset) {
    const preset = CREATE_PRESETS[args.preset as string];
    if (!preset) {
      throw new Error('Unknown preset "' + args.preset + '". Valid presets: ' + Object.keys(CREATE_PRESETS).join(', '));
    }
    if (args.entity !== undefined && assertEntity(args.entity) !== preset.entity) {
      throw new Error('Preset "' + args.preset + '" creates a ' + preset.entity + ' entry; entity "' + args.entity + '" does not match');
    }
    return executeTool(preset.tool, data);
  }

  const entity = assertEntity(args.entity);
  const createTool = CREATE_TOOL[entity];
  if (!createTool) {
    throw new Error('Creating ' + entity + ' is not supported (RPG Maker MV ' + entity + ' must be authored in the editor)');
  }
  return executeTool(createTool, data);
}

async function updateDatabaseEntry(executeTool: ExecuteTool, args: Record<string, any>) {
  const entity = assertEntity(args.entity);
  const id = requireArg(args, 'id', 'update_database_entry');

  if (entity === 'common_events' && args.appendCommand) {
    return executeTool('add_common_event_command', { id: id, command: args.appendCommand });
  }
  if (entity === 'troops' && args.addEnemyId !== undefined) {
    return executeTool('add_enemy_to_troop', { troopId: id, enemyId: args.addEnemyId });
  }

  const fields = requireArg(args, 'fields', 'update_database_entry');
  if (ITEMISH_TYPE[entity]) {
    return executeTool('update_item', { id: id, type: ITEMISH_TYPE[entity], fields: fields });
  }
  const updateTool = UPDATE_TOOL[entity];
  if (!updateTool) {
    if (entity === 'troops') throw new Error('Troops only support addEnemyId (add a member); recreate the troop for other changes');
    throw new Error('Updating ' + entity + ' is not supported');
  }
  return executeTool(updateTool, { id: id, fields: fields });
}

async function deleteDatabaseEntry(executeTool: ExecuteTool, args: Record<string, any>) {
  const entity = assertEntity(args.entity);
  const id = requireArg(args, 'id', 'delete_database_entry');
  if (ITEMISH_TYPE[entity]) {
    return executeTool('delete_item', { id: id, type: ITEMISH_TYPE[entity] });
  }
  const deleteTool = DELETE_TOOL[entity];
  if (!deleteTool) {
    throw new Error('Deleting ' + entity + ' is not supported');
  }
  return executeTool(deleteTool, { id: id });
}

async function queryMap(executeTool: ExecuteTool, args: Record<string, any>) {
  const view = (args.view as string) || 'infos';
  switch (view) {
    case 'infos':
      return executeTool('get_map_infos', {});
    case 'full':
      return executeTool('get_map', { mapId: requireArg(args, 'mapId', 'query_map view "full"') });
    case 'events': {
      const mapId = requireArg(args, 'mapId', 'query_map view "events"');
      if (args.query) return executeTool('search_map_events', { mapId: mapId, query: args.query });
      return executeTool('get_map_events', { mapId: mapId });
    }
    case 'event':
      return executeTool('get_map_event', {
        mapId: requireArg(args, 'mapId', 'query_map view "event"'),
        eventId: requireArg(args, 'eventId', 'query_map view "event"')
      });
    case 'validate':
      return executeTool('validate_map', { mapId: requireArg(args, 'mapId', 'query_map view "validate"') });
    case 'ascii':
      return executeTool('render_map_ascii', {
        map_id: requireArg(args, 'mapId', 'query_map view "ascii"'),
        layer: args.layer,
        show_events: args.showEvents,
        show_regions: args.showRegions
      });
    default:
      throw new Error('Unknown view "' + view + '". Valid views: infos, full, events, event, validate, ascii');
  }
}

async function generateMap(executeTool: ExecuteTool, projectPath: string, args: Record<string, any>) {
  const mode = (args.mode as string) || 'procedural';
  switch (mode) {
    case 'blank': {
      const blankArgs = Object.assign({}, args);
      delete blankArgs.mode;
      delete blankArgs.theme;
      return executeTool('create_map', blankArgs);
    }
    case 'themed': {
      requireArg(args, 'theme', 'generate_map mode "themed"');
      const themedArgs = Object.assign({}, args);
      delete themedArgs.mode;
      return executeTool('create_map', themedArgs);
    }
    case 'procedural': {
      requireArg(args, 'theme', 'generate_map mode "procedural"');
      const procArgs = Object.assign({}, args);
      delete procArgs.mode;
      return executeTool('generate_map_v3', procArgs);
    }
    case 'batch':
      return executeTool('generate_map_batch', { batch: requireArg(args, 'batch', 'generate_map mode "batch"') });
    case 'duplicate':
      return executeTool('duplicate_map', {
        sourceMapId: requireArg(args, 'sourceMapId', 'generate_map mode "duplicate"'),
        name: requireArg(args, 'name', 'generate_map mode "duplicate"'),
        displayName: args.displayName
      });
    case 'template':
      requireArg(args, 'templateId', 'generate_map mode "template"');
      return mapTools.createMapFromTemplate(projectPath, args);
    default:
      throw new Error('Unknown mode "' + mode + '". Valid modes: blank, themed, procedural, batch, duplicate, template');
  }
}

async function editMap(executeTool: ExecuteTool, args: Record<string, any>) {
  const action = args.action as string;
  switch (action) {
    case 'fill_layer':
      return executeTool('fill_map_layer', {
        mapId: requireArg(args, 'mapId', 'edit_map action "fill_layer"'),
        layer: requireArg(args, 'layer', 'edit_map action "fill_layer"'),
        tileId: requireArg(args, 'tileId', 'edit_map action "fill_layer"')
      });
    case 'set_display_names':
      return executeTool('set_map_display_names', { names: requireArg(args, 'names', 'edit_map action "set_display_names"') });
    case 'organize_tree':
      return executeTool('organize_map_tree', { folders: requireArg(args, 'folders', 'edit_map action "organize_tree"') });
    case 'connect':
      return executeTool('connect_maps', {
        mapIdA: requireArg(args, 'mapIdA', 'edit_map action "connect"'),
        mapIdB: requireArg(args, 'mapIdB', 'edit_map action "connect"'),
        posA: requireArg(args, 'posA', 'edit_map action "connect"'),
        posB: requireArg(args, 'posB', 'edit_map action "connect"')
      });
    default:
      throw new Error('Unknown action "' + action + '". Valid actions: fill_layer, set_display_names, organize_tree, connect');
  }
}

async function manageMapEvent(executeTool: ExecuteTool, args: Record<string, any>) {
  const action = (args.action as string) || 'create';
  switch (action) {
    case 'create': {
      const rest = Object.assign({}, args);
      delete rest.action;
      delete rest.preset;
      if (args.preset) {
        const presetTool = EVENT_PRESETS[args.preset as string];
        if (!presetTool) {
          throw new Error('Unknown preset "' + args.preset + '". Valid presets: ' + Object.keys(EVENT_PRESETS).join(', '));
        }
        return executeTool(presetTool, rest);
      }
      return executeTool('create_map_event', rest);
    }
    case 'update':
      return executeTool('update_map_event', {
        mapId: requireArg(args, 'mapId', 'manage_map_event action "update"'),
        eventId: requireArg(args, 'eventId', 'manage_map_event action "update"'),
        fields: requireArg(args, 'fields', 'manage_map_event action "update"')
      });
    case 'delete':
      return executeTool('delete_map_event', {
        mapId: requireArg(args, 'mapId', 'manage_map_event action "delete"'),
        eventId: requireArg(args, 'eventId', 'manage_map_event action "delete"')
      });
    case 'add_command':
      return executeTool('add_event_command', {
        mapId: requireArg(args, 'mapId', 'manage_map_event action "add_command"'),
        eventId: requireArg(args, 'eventId', 'manage_map_event action "add_command"'),
        pageIndex: args.pageIndex,
        command: requireArg(args, 'command', 'manage_map_event action "add_command"')
      });
    case 'populate':
      return executeTool('populate_map_events', {
        mapId: requireArg(args, 'mapId', 'manage_map_event action "populate"'),
        eventType: requireArg(args, 'eventType', 'manage_map_event action "populate"'),
        count: args.count,
        opts: args.opts
      });
    default:
      throw new Error('Unknown action "' + action + '". Valid actions: create, update, delete, add_command, populate');
  }
}

async function manageSystem(executeTool: ExecuteTool, args: Record<string, any>) {
  const action = (args.action as string) || 'get';
  switch (action) {
    case 'get': {
      const section = (args.section as string) || 'full';
      if (section === 'switches') return executeTool('get_switches', {});
      if (section === 'variables') return executeTool('get_variables', {});
      if (section === 'title') return executeTool('get_game_title', {});
      if (section === 'full') return executeTool('get_system', {});
      throw new Error('Unknown section "' + section + '". Valid sections: full, switches, variables, title');
    }
    case 'set_title':
      return executeTool('update_game_title', { title: requireArg(args, 'title', 'manage_system action "set_title"') });
    case 'name_switch':
      return executeTool('set_switch_name', {
        id: requireArg(args, 'id', 'manage_system action "name_switch"'),
        name: requireArg(args, 'name', 'manage_system action "name_switch"')
      });
    case 'name_variable':
      return executeTool('set_variable_name', {
        id: requireArg(args, 'id', 'manage_system action "name_variable"'),
        name: requireArg(args, 'name', 'manage_system action "name_variable"')
      });
    case 'set_starting_position':
      return executeTool('update_starting_position', {
        mapId: requireArg(args, 'mapId', 'manage_system action "set_starting_position"'),
        x: requireArg(args, 'x', 'manage_system action "set_starting_position"'),
        y: requireArg(args, 'y', 'manage_system action "set_starting_position"')
      });
    default:
      throw new Error('Unknown action "' + action + '". Valid actions: get, set_title, name_switch, name_variable, set_starting_position');
  }
}

async function getProjectContextV5(executeTool: ExecuteTool, args: Record<string, any>) {
  const detail = (args.detail as string) || 'full';
  switch (detail) {
    case 'summary':
      return executeTool('get_project_summary', {});
    case 'full':
      return executeTool('get_project_context', {});
    case 'assets':
      return executeTool('scan_project_assets', {});
    case 'tileset':
      return executeTool('get_tile_ids_for_tileset', { tilesetId: requireArg(args, 'tilesetId', 'get_project_context detail "tileset"') });
    case 'templates':
      return searchTemplates((args.category as string) || '', (args.theme as string) || '');
    default:
      throw new Error('Unknown detail "' + detail + '". Valid details: summary, full, assets, tileset, templates');
  }
}

async function analyzeImage(executeTool: ExecuteTool, args: Record<string, any>) {
  const mode = (args.mode as string) || 'ai';
  switch (mode) {
    case 'ai':
      return executeTool('analyze_screenshot', {
        image_path: requireArg(args, 'imagePath', 'analyze_image mode "ai"'),
        prompt: args.prompt,
        resize_max: args.resizeMax
      });
    case 'grid':
      return executeTool('analyze_tileset_image', { base64PNG: requireArg(args, 'base64PNG', 'analyze_image mode "grid"') });
    case 'colors':
      return executeTool('read_screenshot', { base64PNG: requireArg(args, 'base64PNG', 'analyze_image mode "colors"') });
    default:
      throw new Error('Unknown mode "' + mode + '". Valid modes: ai, grid, colors');
  }
}

export const V5_TOOL_NAMES = [
  'query_database', 'create_database_entry', 'update_database_entry', 'delete_database_entry',
  'query_map', 'generate_map', 'edit_map', 'manage_map_event',
  'manage_system', 'get_project_context', 'set_project_path', 'analyze_image'
];

export async function routeV5Tool(executeTool: ExecuteTool, projectPath: string, name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'query_database': return queryDatabase(executeTool, projectPath, args);
    case 'create_database_entry': return createDatabaseEntry(executeTool, args);
    case 'update_database_entry': return updateDatabaseEntry(executeTool, args);
    case 'delete_database_entry': return deleteDatabaseEntry(executeTool, args);
    case 'query_map': return queryMap(executeTool, args);
    case 'generate_map': return generateMap(executeTool, projectPath, args);
    case 'edit_map': return editMap(executeTool, args);
    case 'manage_map_event': return manageMapEvent(executeTool, args);
    case 'manage_system': return manageSystem(executeTool, args);
    case 'get_project_context': return getProjectContextV5(executeTool, args);
    case 'set_project_path': return executeTool('set_project_path', { path: requireArg(args, 'path', 'set_project_path') });
    case 'analyze_image': return analyzeImage(executeTool, args);
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
