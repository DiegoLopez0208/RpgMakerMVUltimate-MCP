#!/usr/bin/env node
import path from "path";
import { readFile, access, readdir } from 'fs/promises';

/**
 * server.ts — RPG Maker MV MCP Server
 *
 * Main entry point for the Model Context Protocol server.
 * Tool definitions (descriptions, schemas, annotations) live in
 * toolDefinitions.ts; this file wires them to their implementations
 * in tools/ and handles transport, validation, and error reporting.
 *
 * Run: RPGMAKER_PROJECT_PATH=/path/to/project node dist/index.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';

import { validateProjectPath } from './utils/fileHandler.js';
import type { RpgMakerDbEntry, MapEvent, RpgMakerMap, VisionApiResponse, AsciiMapResult } from './types/rpgmaker.js';
import * as logger from './utils/logger.js';
import * as actorTools from './tools/actorTools.js';
import * as itemTools from './tools/itemTools.js';
import * as skillTools from './tools/skillTools.js';
import * as mapTools from './tools/mapTools.js';
import { resolveSafePath } from './utils/security.js';
import { AnalyzeScreenshotSchema, CreateMapSchema, RenderMapAsciiSchema, CreateNpcSchema, CreateDamageSkillSchema, CreateHealingSkillSchema, CreateBuffSkillSchema, CreateStateSkillSchema } from './utils/validation.js';
import * as systemTools from './tools/systemTools.js';
import * as classTools from './tools/classTools.js';
import * as enemyTools from './tools/enemyTools.js';
import * as stateTools from './tools/stateTools.js';
import * as tilesetTools from './tools/tilesetTools.js';
import * as commonEventTools from './tools/commonEventTools.js';
import * as troopTools from './tools/troopTools.js';
import * as animationTools from './tools/animationTools.js';
import * as projectTools from './tools/projectTools.js';
import * as assetTools from './tools/assetTools.js';
import { TOOL_DEFINITIONS } from './toolDefinitions.js';
import { TOOL_DEFINITIONS_V5 } from './toolDefinitionsV5.js';
import { routeV5Tool, V5_TOOL_NAMES } from './v5Router.js';

const PROJECT_PATH = process.env.RPGMAKER_PROJECT_PATH || '';

// Single-flight queue for tool executions (see CallTool handler)
let toolCallQueue: Promise<void> = Promise.resolve();

// Zod validation applied before dispatch, keyed by (legacy) tool name.
// v5 tools route through these same legacy names, so validation applies to both.
const SCHEMA_MAP: Record<string, { safeParse: (a: unknown) => { success: boolean; data?: unknown; error?: unknown } }> = {
  analyze_screenshot: AnalyzeScreenshotSchema,
  create_map: CreateMapSchema,
  render_map_ascii: RenderMapAsciiSchema,
  create_npc: CreateNpcSchema,
  create_damage_skill: CreateDamageSkillSchema,
  create_healing_skill: CreateHealingSkillSchema,
  create_buff_skill: CreateBuffSkillSchema,
  create_state_skill: CreateStateSkillSchema,
};

/**
 * Validate (when a schema exists) and dispatch one legacy-named tool call.
 * This is the single entry point used by the MCP CallTool handler and by the
 * v5 router; it is NOT serialized itself — serialization happens once at the
 * request level so nested v5→legacy calls don't deadlock.
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const schema = SCHEMA_MAP[name];
  if (schema) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const error = parsed.error as { issues: { path: (string | number)[]; message: string }[] };
      throw new Error('Validation error: ' + error.issues.map(function(i) { return i.path.join('.') + ': ' + i.message; }).join('; '));
    }
    args = parsed.data as Record<string, unknown>;
  }
  return handleToolCall(name, args);
}

/** Dispatch one tool call, v5 or legacy. Exported for integration tests. */
export async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (V5_TOOL_NAMES.includes(name)) {
    const p = projectTools.getProjectPath() || PROJECT_PATH;
    return routeV5Tool(executeTool, p, name, args);
  }
  return executeTool(name, args);
}

// ─── Project Context & Validation Functions ───

function asEntry(obj: unknown): RpgMakerDbEntry & Record<string, unknown> {
  return obj as RpgMakerDbEntry & Record<string, unknown>;
}

async function getProjectContext(projectPath: string) {
  const dataDir = path.join(projectPath, 'data');
  const imgDir = path.join(projectPath, 'img');

  async function readJson(filename: string) {
    const fp = path.join(dataDir, filename);
    try {
      const content = await readFile(fp, 'utf-8');
      return JSON.parse(content.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }

  async function listPngs(dir: string) {
    const fullDir = path.join(imgDir, dir);
    try {
      await access(fullDir);
      const files = await readdir(fullDir);
      return files.filter(function(f) { return f.endsWith('.png'); }).map(function(f) { return f.replace('.png', ''); });
    } catch {
      return [];
    }
  }

  async function listAudio(dir: string) {
    const fullDir = path.join(projectPath, 'audio', dir);
    try {
      await access(fullDir);
      const files = await readdir(fullDir);
      const names = files
        .filter(function(f) { return f.endsWith('.ogg') || f.endsWith('.m4a'); })
        .map(function(f) { return f.replace(/\.(ogg|m4a)$/, ''); });
      // Deduplicate when both .ogg and .m4a variants exist
      return [...new Set(names)];
    } catch {
      return [];
    }
  }

  const [
    systemRaw, mapInfosRaw, actorsRaw, itemsRaw, weaponsRaw, armorsRaw,
    skillsRaw, enemiesRaw, troopsRaw, statesRaw, tilesetsRaw, commonEventsRaw
  ] = await Promise.all([
    readJson('System.json'), readJson('MapInfos.json'), readJson('Actors.json'), readJson('Items.json'),
    readJson('Weapons.json'), readJson('Armors.json'), readJson('Skills.json'), readJson('Enemies.json'),
    readJson('Troops.json'), readJson('States.json'), readJson('Tilesets.json'), readJson('CommonEvents.json')
  ]);

  const system = systemRaw || {};
  const mapInfos = mapInfosRaw || [];
  const actors = actorsRaw || [];
  const items = itemsRaw || [];
  const weapons = weaponsRaw || [];
  const armors = armorsRaw || [];
  const skills = skillsRaw || [];
  const enemies = enemiesRaw || [];
  const troops = troopsRaw || [];
  const states = statesRaw || [];
  const tilesets = tilesetsRaw || [];
  const commonEvents = commonEventsRaw || [];

  const maps = (mapInfos as unknown[]).filter(function(m: unknown) { return m !== null; }).map(function(m: unknown) { const r = asEntry(m); return { id: r.id, name: r.name, parentId: r.parentId as number }; });
  const actorList = (actors as unknown[]).filter(function(a: unknown) { return a !== null; }).map(function(a: unknown) { const r = asEntry(a); return { id: r.id, name: r.name, classId: r.classId as number, initialLevel: r.initialLevel as number }; });
  const itemList = (items as unknown[]).filter(function(i: unknown) { return i !== null; }).map(function(i: unknown) { const r = asEntry(i); return { id: r.id, name: r.name, iconIndex: r.iconIndex as number, price: r.price as number, itypeId: r.itypeId as number }; });
  const weaponList = (weapons as unknown[]).filter(function(w: unknown) { return w !== null; }).map(function(w: unknown) { const r = asEntry(w); return { id: r.id, name: r.name, iconIndex: r.iconIndex as number, price: r.price as number, wtypeId: r.wtypeId as number }; });
  const armorList = (armors as unknown[]).filter(function(a: unknown) { return a !== null; }).map(function(a: unknown) { const r = asEntry(a); return { id: r.id, name: r.name, iconIndex: r.iconIndex as number, price: r.price as number, atypeId: r.atypeId as number }; });
  const skillList = (skills as unknown[]).filter(function(s: unknown) { return s !== null; }).map(function(s: unknown) { const r = asEntry(s); return { id: r.id, name: r.name, mpCost: r.mpCost as number, scope: r.scope as number, stypeId: r.stypeId as number }; });
  const enemyList = (enemies as unknown[]).filter(function(e: unknown) { return e !== null; }).map(function(e: unknown) { const r = asEntry(e); return { id: r.id, name: r.name, battlerName: r.battlerName as string }; });
  const troopList = (troops as unknown[]).filter(function(t: unknown) { return t !== null; }).map(function(t: unknown) { const r = asEntry(t); return { id: r.id, name: r.name, members: (r.members as unknown[] || []).map(function(m: unknown) { const rm = asEntry(m); return { enemyId: rm.enemyId as number, x: rm.x as number, y: rm.y as number }; }) }; });
  const stateList = (states as unknown[]).filter(function(s: unknown) { return s !== null; }).map(function(s: unknown) { const r = asEntry(s); return { id: r.id, name: r.name, iconIndex: r.iconIndex as number, restriction: r.restriction as number }; });
  const tilesetList = (tilesets as unknown[]).filter(function(t: unknown) { return t !== null; }).map(function(t: unknown) { const r = asEntry(t); return { id: r.id, name: r.name, mode: r.mode as number, tilesetNames: r.tilesetNames as string[] }; });
  const ceList = (commonEvents as unknown[]).filter(function(c: unknown) { return c !== null; }).map(function(c: unknown) { const r = asEntry(c); return { id: r.id, name: r.name, trigger: r.trigger as number, switchId: r.switchId as number }; });

  const [characters, faces, enemySprites, battlers, pictures, bgm, bgs, se, me] = await Promise.all([
    listPngs('characters'), listPngs('faces'), listPngs('enemies'), listPngs('battlers'), listPngs('pictures'),
    listAudio('bgm'), listAudio('bgs'), listAudio('se'), listAudio('me')
  ]);

  return {
    gameTitle: system.gameTitle || 'Untitled',
    startMapId: system.startMapId,
    startX: system.startX,
    startY: system.startY,
    partyMembers: system.partyMembers || [],
    switches: system.switches || [],
    variables: system.variables || [],
    maps: maps,
    actors: actorList,
    items: itemList,
    weapons: weaponList,
    armors: armorList,
    skills: skillList,
    enemies: enemyList,
    troops: troopList,
    states: stateList,
    tilesets: tilesetList,
    commonEvents: ceList,
    sprites: {
      characters: characters,
      faces: faces,
      enemies: enemySprites,
      battlers: battlers,
      pictures: pictures
    },
    audio: {
      bgm: bgm,
      bgs: bgs,
      se: se,
      me: me
    }
  };
}

async function validateMap(projectPath: string, mapId: number) {
  const map = await mapTools.getMap(projectPath, mapId) as RpgMakerMap;
  const issues = [];
  const w = map.width;
  const h = map.height;

  // Check tile IDs
  if (map.data) {
    for (let i = 0; i < map.data.length; i++) {
      const layer = Math.floor(i / (w * h));
      const tileId = map.data[i];
      if (layer < 4 && tileId > 8191) {
        issues.push({ type: 'invalid_tile', layer: layer, tileId: tileId, index: i, message: 'Tile ID ' + tileId + ' exceeds max (8191) on layer ' + layer });
      }
      if (layer === 4 && (tileId < 0 || tileId > 15)) {
        issues.push({ type: 'invalid_shadow', tileId: tileId, index: i, message: 'Shadow bits ' + tileId + ' out of range 0-15' });
      }
      if (layer === 5 && (tileId < 0 || tileId > 255)) {
        issues.push({ type: 'invalid_region', tileId: tileId, index: i, message: 'Region ID ' + tileId + ' out of range 0-255' });
      }
    }
  }

  // Check events
  const events = map.events || [];
  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev === null) continue;
    for (let pi = 0; pi < (ev.pages || []).length; pi++) {
      const page = ev.pages[pi];
      const list = page.list || [];
      let hasTerminator = false;
      for (let ci = 0; ci < list.length; ci++) {
        const cmd = list[ci];
        if (cmd.code === 0 && cmd.indent === 0 && ci === list.length - 1) {
          hasTerminator = true;
        }
        // Check for common bad commands
        if (cmd.code === 126 && cmd.parameters && cmd.parameters.length >= 1 && cmd.parameters[0] === 0) {
          issues.push({ type: 'null_item_ref', event: ev.id, eventName: ev.name, page: pi, cmdIndex: ci, message: 'Change Item with itemId=0 (null) in event "' + ev.name + '"' });
        }
        // MV's Game_Interpreter.command123 treats parameters[1] === 0 as ON, 1 as OFF
        if (cmd.code === 123 && cmd.parameters && cmd.parameters[1] === 1) {
          issues.push({ type: 'self_switch_off', event: ev.id, eventName: ev.name, page: pi, cmdIndex: ci, message: 'Self Switch set to OFF (value 1) in event "' + ev.name + '" - if this page should lock the event, use ON (value 0)' });
        }
        if (cmd.code === 201 && cmd.parameters && cmd.parameters.length >= 2 && cmd.parameters[1] === 0) {
          issues.push({ type: 'null_transfer', event: ev.id, eventName: ev.name, page: pi, cmdIndex: ci, message: 'Transfer Player to mapId=0 (nonexistent) in event "' + ev.name + '"' });
        }
      }
      if (!hasTerminator) {
        issues.push({ type: 'missing_terminator', event: ev.id, eventName: ev.name, page: pi, message: 'Page ' + pi + ' of event "' + ev.name + '" missing code 0 terminator' });
      }
    }
  }

  return {
    mapId: mapId,
    mapName: map.displayName || '',
    width: w,
    height: h,
    eventCount: (events as unknown[]).filter(function(e: unknown) { return e !== null; }).length,
    issueCount: issues.length,
    issues: issues
  };
}


// ─── Tool Execution Handler ───
// Dispatches tool calls to the appropriate tool module function

async function handleToolCall(name: string, args: Record<string, any>) {
  const p = projectTools.getProjectPath() || PROJECT_PATH;

  switch (name) {
    // ── Actor Tools ──
    case 'get_actors':
      return await actorTools.getActors(p);
    case 'get_actor':
      return await actorTools.getActor(p, args.id);
    case 'create_actor':
      return await actorTools.createActor(p, args);
    case 'update_actor':
      return await actorTools.updateActor(p, args.id, args.fields);
    case 'search_actors':
      return await actorTools.searchActors(p, args.query);

    // ── Item Tools ──
    case 'get_items':
      return await itemTools.getItems(p);
    case 'get_weapons':
      return await itemTools.getWeapons(p);
    case 'get_armors':
      return await itemTools.getArmors(p);
    case 'get_skills':
      return await skillTools.getSkillsList(p);
    case 'create_item':
      return await itemTools.createItem(p, args);
    case 'create_weapon':
      return await itemTools.createWeapon(p, args);
    case 'create_armor':
      return await itemTools.createArmor(p, args);
    case 'update_item':
      return await itemTools.updateItem(p, args.id, args.type, args.fields);
    case 'search_items':
      return await itemTools.searchItems(p, args.query, args.type);

    // ── Skill Tools ──
    case 'get_skill':
      return await skillTools.getSkill(p, args.id);
    case 'get_all_skills':
      return await skillTools.getSkills(p);
    case 'create_skill':
      return await skillTools.createSkill(p, args);
    case 'create_damage_skill':
      return await skillTools.createDamageSkill(p, args.name, args.mpCost, args.scope, args.formula, args.element, args.animationId);
    case 'create_healing_skill':
      return await skillTools.createHealingSkill(p, args.name, args.mpCost, args.scope, args.formula, args.animationId);
    case 'create_buff_skill':
      return await skillTools.createBuffSkill(p, args.name, args.mpCost, args.scope, args.paramId, args.turns);
    case 'create_state_skill':
      return await skillTools.createStateSkill(p, args.name, args.mpCost, args.scope, args.stateId, args.chance);
    case 'update_skill':
      return await skillTools.updateSkill(p, args.id, args.fields);
    case 'search_skills':
      return await skillTools.searchSkills(p, args.query);

    // ── Map Tools ──
    case 'get_map_infos':
      return await mapTools.getMapInfos(p);
    case 'get_map':
      return await mapTools.getMap(p, args.mapId);
    case 'get_map_events':
      return await mapTools.getMapEvents(p, args.mapId);
    case 'get_map_event':
      return await mapTools.getMapEvent(p, args.mapId, args.eventId);
    case 'create_map':
      return await mapTools.createMap(p, args);
    case 'fill_map_layer':
      return await mapTools.fillMapLayer(p, args.mapId, args.layer, args.tileId);
    case 'fill_map_rect':
      return await mapTools.fillMapRect(p, args.mapId, args.layer, args.x1, args.y1, args.x2, args.y2, args.tileId);
    case 'set_map_tile':
      return await mapTools.setMapTile(p, args.mapId, args.layer, args.x, args.y, args.tileId);
    case 'replace_map_tile':
      return await mapTools.replaceMapTile(p, args.mapId, args.layer, args.oldTileId, args.newTileId);
    case 'create_map_event':
      return await mapTools.createMapEvent(p, args.mapId, args.x, args.y, args.name, args.trigger, args.pages);
    case 'update_map_event':
      return await mapTools.updateMapEvent(p, args.mapId, args.eventId, args.fields);
    case 'add_event_command':
      return await mapTools.addEventCommand(p, args.mapId, args.eventId, args.pageIndex, args.command);
    case 'create_npc':
      return await mapTools.createNpc(p, args.mapId, args.x, args.y, args.name, args.dialogues, args.characterName, args.characterIndex);
    case 'create_chest':
      return await mapTools.createChest(p, args.mapId, args.x, args.y, args.items, args.characterName, args.characterIndex);
    case 'create_teleport_event':
      return await mapTools.createTeleportEvent(p, args.mapId, args.x, args.y, args.destMapId, args.destX, args.destY, args.trigger);
    case 'create_door':
      return await mapTools.createDoor(p, args.mapId, args.x, args.y, args.destMapId, args.destX, args.destY, args);
case 'search_map_events':
        return await mapTools.searchMapEvents(p, args.mapId, args.query);
      case 'generate_map_v3':
        return await mapTools.createMapV3(p, args);
      case 'generate_map_batch':
        return await mapTools.createMapBatch(p, args.batch);
      case 'connect_maps':
        return await mapTools.connectMaps(p, args.mapIdA, args.mapIdB, args.posA, args.posB);
      case 'populate_map_events':
        return await mapTools.populateMapEvents(p, args.mapId, args.eventType, args.count, args.opts);
      case 'set_map_encounters':
        return await mapTools.setMapEncounters(p, args.mapId, args.encounters, args.encounterStep);
      case 'set_map_display_names':
        return await mapTools.setMapDisplayNames(p, args.names);
      case 'organize_map_tree':
        return await mapTools.organizeMapTree(p, args.folders);

      // ── System Tools ──
    case 'get_system':
      return await systemTools.getSystem(p);
    case 'get_switches':
      return await systemTools.getSwitches(p);
    case 'get_variables':
      return await systemTools.getVariables(p);
    case 'set_switch_name':
      return await systemTools.setSwitchName(p, args.id, args.name);
    case 'set_variable_name':
      return await systemTools.setVariableName(p, args.id, args.name);
    case 'get_game_title':
      return await systemTools.getGameTitle(p);
    case 'update_game_title':
      return await systemTools.updateGameTitle(p, args.title);
case 'update_starting_position':
  return await systemTools.updateStartingPosition(p, args.mapId, args.x, args.y);
case 'list_plugins':
  return await systemTools.listPlugins(p);
case 'get_plugin_status':
  return await systemTools.getPluginStatus(p);
case 'toggle_plugin':
  return await systemTools.togglePlugin(p, args.pluginName, args.enabled);

// ── Class Tools ──
case 'get_classes':
  return await classTools.getClasses(p);
case 'get_class':
  return await classTools.getClass(p, args.id);
case 'create_class':
  return await classTools.createClass(p, args);
case 'update_class':
  return await classTools.updateClass(p, args.id, args.fields);
case 'search_classes':
  return await classTools.searchClasses(p, args.query);
case 'delete_class':
  return await classTools.deleteClass(p, args.id);

// ── Enemy Tools ──
case 'get_enemies':
  return await enemyTools.getEnemies(p);
case 'get_enemy':
  return await enemyTools.getEnemy(p, args.id);
case 'create_enemy':
  return await enemyTools.createEnemy(p, args);
case 'create_boss_enemy':
  return await enemyTools.createBossEnemy(p, args);
case 'update_enemy':
  return await enemyTools.updateEnemy(p, args.id, args.fields);
case 'search_enemies':
  return await enemyTools.searchEnemies(p, args.query);
case 'delete_enemy':
  return await enemyTools.deleteEnemy(p, args.id);

// ── State Tools ──
case 'get_states':
  return await stateTools.getStates(p);
case 'get_state':
  return await stateTools.getState(p, args.id);
case 'create_state':
  return await stateTools.createState(p, args);
case 'update_state':
  return await stateTools.updateState(p, args.id, args.fields);
case 'search_states':
  return await stateTools.searchStates(p, args.query);
case 'delete_state':
  return await stateTools.deleteState(p, args.id);

// ── Tileset Tools ──
case 'get_tilesets':
  return await tilesetTools.getTilesets(p);
case 'get_tileset':
  return await tilesetTools.getTileset(p, args.id);
case 'update_tileset':
  return await tilesetTools.updateTileset(p, args.id, args.fields);

// ── Common Event Tools ──
case 'get_common_events':
  return await commonEventTools.getCommonEvents(p);
case 'create_common_event':
  return await commonEventTools.createCommonEvent(p, args);
case 'update_common_event':
  return await commonEventTools.updateCommonEvent(p, args.id, args.fields);
case 'add_common_event_command':
  return await commonEventTools.addCommonEventCommand(p, args.id, args.command);

// ── Troop Tools ──
case 'get_troops':
  return await troopTools.getTroops(p);
case 'get_troop':
  return await troopTools.getTroop(p, args.id);
case 'create_troop':
  return await troopTools.createTroop(p, args);
            case 'add_enemy_to_troop':
                return await troopTools.addEnemyToTroop(p, args.troopId, args.enemyId);
            case 'create_random_encounter_troop':
                return await troopTools.createRandomEncounterTroop(p, { name: args.name, enemyIds: args.enemyIds });

// ── Animation Tools ──
case 'get_animations':
  return await animationTools.getAnimations(p);
case 'get_animation':
  return await animationTools.getAnimation(p, args.id);

// ── Delete Tools ──
case 'delete_actor':
  return await actorTools.deleteActor(p, args.id);
case 'delete_item':
  return await itemTools.deleteItem(p, args.id, args.type);
case 'delete_skill':
  return await skillTools.deleteSkill(p, args.id);

// ── New Map Helper Tools ──
case 'delete_map_event':
  return await mapTools.deleteMapEvent(p, args.mapId, args.eventId);
            case 'duplicate_map':
                return await mapTools.duplicateMap(p, args.sourceMapId, args);
            case 'create_shop':
                return await mapTools.createShop(p, args.mapId, args.x, args.y, args.name, args.goods, args.characterName, args.characterIndex);
            case 'create_inn':
                return await mapTools.createInn(p, args.mapId, args.x, args.y, args.name, args.cost, args.characterName, args.characterIndex);
            case 'create_boss_event':
                return await mapTools.createBossEvent(p, args.mapId, args.x, args.y, args.name, args.troopId, args.characterName, args.characterIndex);
            case 'create_puzzle_switch':
                return await mapTools.createPuzzleSwitch(p, args.mapId, args.switchX, args.switchY, args.doorX, args.doorY, args.gameSwitchId, args.switchName, args.doorName);

// ── Project Tools ──
case 'get_project_summary':
  return await projectTools.getProjectSummary(p);
case 'get_project_context':
  return await getProjectContext(p);
case 'validate_map':
  return await validateMap(p, args.mapId);
case 'set_project_path':
  var setResult = await projectTools.setProjectPath(args.path);
  return setResult;

    // ── Vision / Image Tools ──
    case 'analyze_tileset_image':
      return await analyzeTilesetImage(args.base64PNG);
    case 'read_screenshot':
      return await readScreenshot(args.base64PNG);

    // ── Asset Tools ──
    case 'scan_project_assets':
      return await assetTools.scanProjectAssets(p);
    case 'get_tile_ids_for_tileset':
      return await assetTools.getTileIdsForTileset(p, args.tilesetId);

    // ── Vision AI Tools ──
    case 'analyze_screenshot':
      return await analyzeScreenshot(p, args.image_path, args.prompt, args.resize_max);
    case 'render_map_ascii':
      return await renderMapAscii(p, args.map_id, args.layer, args.show_events, args.show_regions);

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ─── Vision Tool Implementations ───

/**
 * Analyze a tileset image to determine grid dimensions.
 * Assumes standard RPG Maker MV 48x48 tile size.
 * @param {string} base64PNG - Base64-encoded PNG image
 */
async function analyzeTilesetImage(base64PNG: string) {
  const buffer = Buffer.from(base64PNG, 'base64');
  const metadata = await sharp(buffer).metadata();

  const imageWidth = metadata.width!;
  const imageHeight = metadata.height!;
  const tileSize = 48; // Standard MV tile size
  const cols = Math.floor(imageWidth! / tileSize);
  const rows = Math.floor(imageHeight! / tileSize);
  const totalTiles = cols * rows;

  return {
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    tileSize: tileSize,
    cols: cols,
    rows: rows,
    totalTiles: totalTiles
  };
}

/**
 * Analyze a screenshot by splitting into 4 quadrants
 * and returning the dominant color (average RGB) of each.
 * @param {string} base64PNG - Base64-encoded PNG screenshot
 */
async function readScreenshot(base64PNG: string) {
  const buffer = Buffer.from(base64PNG, 'base64');
  const metadata = await sharp(buffer).metadata();
  const imageWidth = metadata.width!;
  const imageHeight = metadata.height!;

  const halfW = Math.floor(imageWidth! / 2);
  const halfH = Math.floor(imageHeight! / 2);

  // Extract each quadrant and compute average RGB
  const quadrants = [
    { name: 'top-left', x: 0, y: 0, w: halfW, h: halfH },
    { name: 'top-right', x: halfW, y: 0, w: imageWidth! - halfW, h: halfH },
    { name: 'bottom-left', x: 0, y: halfH, w: halfW, h: imageHeight! - halfH },
    { name: 'bottom-right', x: halfW, y: halfH, w: imageWidth! - halfW, h: imageHeight! - halfH }
  ];

  const results: Record<string, { r: number; g: number; b: number }> = {};
  for (let i = 0; i < quadrants.length; i++) {
    const q = quadrants[i];
    // Extract quadrant, resize to 1x1 to get average color, get raw pixel data
    const pixelData = await sharp(buffer)
      .extract({ left: q.x, top: q.y, width: q.w, height: q.h })
      .resize(1, 1)
      .raw()
      .toBuffer();

    results[q.name] = {
      r: pixelData[0],
      g: pixelData[1],
      b: pixelData[2]
    };
  }

  return {
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    quadrants: results
  };
}

// ─── Vision AI Tool Implementations ───

const VISION_API_URL: string = process.env.VISION_API_URL || 'http://127.0.0.1:9999';
const VISION_API_PATH: string = process.env.VISION_API_PATH || '/v1/chat/completions';

const VISION_DEFAULT_PROMPT = [
  'Analiza esta imagen de un proyecto RPG Maker MV. Describe detalladamente:',
  '1. Tipo de contenido (tileset, sprite de personaje, battler, screenshot de mapa, face, etc.)',
  '2. Si es tileset: número de filas/columnas, categorías de tiles (terreno, agua, muros, techos, decoraciones), colores dominantes',
  '3. Si es sprite de personaje: direcciones, poses, estilo artístico, colores',
  '4. Si es screenshot de mapa: layout, tipos de terreno, eventos visibles, caminos, edificios, agua',
  '5. Si es battler: estilo, tamaño relativo, elementos visuales',
  '6. Problemas visuales potenciales (overlaps, gaps, inconsistencias de color, misaligned tiles)',
].join('\n');

async function analyzeScreenshot(projectPath: string, imagePath: string, customPrompt: string | undefined, resizeMax: number | undefined) {
      
  const fullPath = resolveSafePath(projectPath, imagePath);
  try {
    await access(fullPath);
  } catch {
    throw new Error('Image not found: ' + imagePath + ' (resolved: ' + fullPath + ')');
  }

  const maxWidth = resizeMax || 1024;
  const prompt = customPrompt || VISION_DEFAULT_PROMPT;

  const imageBuffer = await sharp(fullPath)
    .resize(maxWidth, null, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const base64Image = imageBuffer.toString('base64');
  const dataUrl = 'data:image/jpeg;base64,' + base64Image;

  const requestBody = JSON.stringify({
    model: process.env.VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt }
        ]
      }
    ],
    max_tokens: 500,
    temperature: 0.1,
    stream: false
  });

  const endpoint = VISION_API_URL.replace(/\/+$/, '') + VISION_API_PATH;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.VISION_API_KEY || 'sk-proxy')
      },
      body: requestBody,
      signal: AbortSignal.timeout(120000)
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Vision API timeout (120s) at ' + endpoint);
    }
    throw new Error('Vision API request failed: ' + msg + '. Is the endpoint at ' + endpoint + ' reachable?');
  }

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (e: unknown) {
    throw new Error('Failed to parse vision API response (HTTP ' + response.status + '): ' + body.slice(0, 500));
  }
  if (data.error) {
    throw new Error('Vision API error: ' + JSON.stringify(data.error));
  }
  let content = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    content = data.choices[0].message.content || '';
  }
  const usage = data.usage || {};
  return {
    image_path: imagePath,
    analysis: content,
    model: data.model || 'unknown',
    tokens_used: {
      prompt: usage.prompt_tokens || 0,
      completion: usage.completion_tokens || 0,
      total: usage.total_tokens || 0
    }
  };
}

async function renderMapAscii(projectPath: string, mapId: number, layer: number, showEvents: boolean, showRegions: boolean) {
    
  const map = await mapTools.getMap(projectPath, mapId) as RpgMakerMap;
  const tileLayer = layer !== undefined ? layer : 0;
  const showEv = showEvents !== false;
  const showReg = showRegions === true;

  const w = map.width;
  const h = map.height;
  const data = map.data;
  if (!data || data.length === 0) {
    return { mapId: mapId, error: 'Map has no tile data' };
  }

  let tilesetList = [];
  try {
    const tilesetContent = await readFile(path.join(projectPath, 'data', 'Tilesets.json'), 'utf-8');
    tilesetList = JSON.parse(tilesetContent.replace(/^\uFEFF/, ''));
  } catch(e: unknown) {}

  const tileset = tilesetList[map.tilesetId] || null;
  const tileCharMap: Record<number, string> = {};
  tileCharMap[0] = '.';

  if (tileset && tileset.flags) {
    for (let tid = 1; tid <= 8191; tid++) {
      if (tid >= data.length) break;
      const flag = tileset.flags[tid] || 0;
      const isWall = (flag & 0x10) !== 0;
      const isTerrain = (flag & 0x40) !== 0;
      const isLadder = (flag & 0x02) !== 0;
      const isBush = (flag & 0x04) !== 0;
      const isWater = (flag & 0x80) !== 0;
      const isDamage = (flag & 0x20) !== 0;

      if (isWater) tileCharMap[tid] = '~';
      else if (isWall) tileCharMap[tid] = '#';
      else if (isLadder) tileCharMap[tid] = 'H';
      else if (isBush) tileCharMap[tid] = '"';
      else if (isDamage) tileCharMap[tid] = 'x';
      else if (isTerrain) tileCharMap[tid] = ',';
    }
  }

  const autotileChars = 'GTFDRBSCWMLKPAEINU';
  function getTileChar(tileId: number) {
    if (tileId === 0) return '.';
    if (tileCharMap[Number(tileId)]) return tileCharMap[Number(tileId)];
    if (tileId < 2048) {
      const kindIdx = Math.floor(tileId / 48);
      return autotileChars[kindIdx % autotileChars.length] || 'A';
    }
    if (tileId >= 2048 && tileId < 2816) return 'A';
    if (tileId >= 2816 && tileId < 4352) return 'T';
    if (tileId >= 4352 && tileId < 5888) return 'W';
    if (tileId >= 5888) return 'D';
    return '?';
  }

  const layerSize = w * h;
  const layerOffset = tileLayer * layerSize;
  const grid = [];
  for (var y = 0; y < h; y++) {
    var row = '';
    for (var x = 0; x < w; x++) {
      var idx = layerOffset + y * w + x;
      const tileId = idx < data.length ? data[idx] : 0;
      row += getTileChar(tileId);
    }
    grid.push(row);
  }

  const eventMarkers = [];
  if (showEv && map.events) {
    for (let ei = 0; ei < map.events.length; ei++) {
      const ev = map.events[ei];
      if (!ev) continue;
      if (ev.x < w && ev.y < h) {
        const marker = ev.name ? ev.name.charAt(0).toUpperCase() : 'E';
        const rowChars: string[] = grid[ev.y].split('');
        rowChars[ev.x] = marker;
        grid[ev.y] = rowChars.join('');
        eventMarkers.push({ id: ev.id, name: ev.name, x: ev.x, y: ev.y, marker: marker });
      }
    }
  }

  let regionGrid = null;
  if (showReg && data.length >= 6 * layerSize) {
    regionGrid = [];
    const regOffset = 5 * layerSize;
    for (var y = 0; y < h; y++) {
      var row = '';
      for (var x = 0; x < w; x++) {
        var idx = regOffset + y * w + x;
        const rid = idx < data.length ? data[idx] : 0;
        row += rid === 0 ? '.' : (rid < 10 ? String(rid) : String.fromCharCode(55 + rid));
      }
      regionGrid.push(row);
    }
  }

  const legend = [
    'Legend: . = empty, ~ = water, # = wall, H = ladder,',
    '  " = bush, x = damage, , = terrain, T = tree, W = water tile,',
    '  D = decoration, A = autotile, G/F/R/B/S/C = autotile kinds',
    '  Uppercase letters on map = event markers (first char of name)'
  ];

  const result: AsciiMapResult = {
    mapId: mapId,
    mapName: map.displayName || '',
    width: w,
    height: h,
    tilesetId: map.tilesetId,
    layer: tileLayer,
    ascii: grid.join('\n'),
    legend: legend,
    events: eventMarkers
  };
  if (regionGrid) {
    result.regionAscii = regionGrid.join('\n');
  }
  return result;
}

// ─── Server Setup ───

export async function main() {
  logger.info('Starting RPG Maker MV MCP Server...');

  // Never exit on a bad/missing project path: that would make the whole MCP
  // unusable in the client if the project is later moved/renamed. Start anyway;
  // tools that need a project return a clear "set_project_path" error, and
  // set_project_path can point the server at a valid project at runtime.
  if (!PROJECT_PATH) {
    logger.warn('RPGMAKER_PROJECT_PATH not set — server starting; call set_project_path before other tools.');
  } else if (!(await validateProjectPath(PROJECT_PATH))) {
    logger.warn('RPGMAKER_PROJECT_PATH "' + PROJECT_PATH + '" is not a valid project (no data/System.json) — it may have been moved/renamed. Server starting; fix the path or call set_project_path.');
  } else {
    projectTools.initProjectPath(PROJECT_PATH);
    logger.info('Project path: ' + PROJECT_PATH);
  }

  const server = new Server(
    { name: 'rpgmaker-mv-mcp', version: '5.0.0' },
    { capabilities: { tools: {} } }
  );

  // Default: the 12 consolidated v5 tools. RPGMV_LEGACY_TOOLS=1 additionally
  // advertises the v4 names (calls to v4 names always work either way).
  const legacyMode = process.env.RPGMV_LEGACY_TOOLS === '1';
  const advertisedTools = legacyMode
    ? TOOL_DEFINITIONS_V5.concat(TOOL_DEFINITIONS.filter(function(t) { return !V5_TOOL_NAMES.includes(t.name); }) as typeof TOOL_DEFINITIONS_V5)
    : TOOL_DEFINITIONS_V5;

  server.setRequestHandler(ListToolsRequestSchema, async function() {
    return { tools: advertisedTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async function(request) {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    logger.info('Tool call: ' + toolName);

    try {
      const currentPath = projectTools.getProjectPath();
      if (!currentPath) {
        throw new Error('No project path set. Use set_project_path or set RPGMAKER_PROJECT_PATH.');
      }

      // Serialize tool executions: the SDK dispatches requests concurrently, and
      // two tools writing the same data file in parallel interleave their writes
      // and corrupt the project JSON. Reads are cheap, so everything goes
      // through one queue for safety.
      const queuedCall = toolCallQueue.then(function() { return dispatchTool(toolName, args); });
      toolCallQueue = queuedCall.then(function() { return undefined; }, function() { return undefined; });
      const result = await queuedCall;

      logger.info('Tool call succeeded: ' + toolName);
      const structured = (typeof result === 'object' && result !== null && !Array.isArray(result))
        ? result as Record<string, unknown>
        : { result: result };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: structured
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Tool call failed: ' + toolName + ' - ' + errorMessage);
      return {
        content: [
          {
            type: 'text',
            text: 'Error: ' + errorMessage
          }
        ],
        isError: true
      };
    }
  });

  server.onerror = function(error) {
    logger.error('MCP Error: ' + (error instanceof Error ? error.message : String(error)));
  };

  process.on('SIGINT', async function() {
    logger.info('Shutting down...');
    await server.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  if (process.env.RPGMV_STRING_IDS === '1') {
    // Legacy quirk (default in <=4.x): coerce numeric JSON-RPC response ids to
    // strings. Violates JSON-RPC (the id must echo the request's type), so it
    // is now opt-in for any client that happened to depend on it.
    const originalSend = transport.send.bind(transport);
    transport.send = function(message) {
      const msg = message as Record<string, unknown>;
      if (msg.id !== undefined && msg.id !== null && typeof msg.id === 'number') {
        return originalSend(Object.assign({}, message, { id: String(msg.id) }) as typeof message);
      }
      return originalSend(message);
    };
  }
  await server.connect(transport);
  logger.info('RPG Maker MV MCP server v5.0.0 running on stdio (' + advertisedTools.length + ' tools' + (legacyMode ? ', legacy mode' : '') + ')');
}
