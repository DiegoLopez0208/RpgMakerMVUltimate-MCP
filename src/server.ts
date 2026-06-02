#!/usr/bin/env node
// @ts-nocheck
import http from "http";


import fs from "fs";
import path from "path";

/**
 * server.js — RPG Maker MV MCP Server v3.0
 *
 * Main entry point for the Model Context Protocol server.
 * Provides ~75 tools for managing RPG Maker MV project data:
 * actors, classes, skills, items, weapons, armors, enemies, states,
 * troops, common events, maps, events (NPC/chest/teleport/shop/inn/boss/puzzle),
 * tilesets, animations, system settings, project management, and image analysis.
 *
 * Run: RPGMAKER_PROJECT_PATH=/path/to/project node server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';

import { validateProjectPath } from './utils/fileHandler.js';
import * as logger from './utils/logger.js';
import * as actorTools from './tools/actorTools.js';
import * as itemTools from './tools/itemTools.js';
import * as skillTools from './tools/skillTools.js';
import * as mapTools from './tools/mapTools.js';
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

const PROJECT_PATH = process.env.RPGMAKER_PROJECT_PATH || '';

// ─── Project Context & Validation Functions ───

async function getProjectContext(projectPath) {
      const dataDir = path.join(projectPath, 'data');
  const imgDir = path.join(projectPath, 'img');

  function readJsonSync(filename) {
    const fp = path.join(dataDir, filename);
    if (!fs.existsSync(fp)) return null;
    const content = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  }

  function listPngs(dir) {
    const fullDir = path.join(imgDir, dir);
    if (!fs.existsSync(fullDir)) return [];
    return fs.readdirSync(fullDir).filter(function(f) { return f.endsWith('.png'); }).map(function(f) { return f.replace('.png', ''); });
  }

  var system = readJsonSync('System.json') || {};
  var mapInfos = readJsonSync('MapInfos.json') || [];
  var actors = readJsonSync('Actors.json') || [];
  var items = readJsonSync('Items.json') || [];
  var weapons = readJsonSync('Weapons.json') || [];
  var armors = readJsonSync('Armors.json') || [];
  var skills = readJsonSync('Skills.json') || [];
  var enemies = readJsonSync('Enemies.json') || [];
  var troops = readJsonSync('Troops.json') || [];
  var states = readJsonSync('States.json') || [];
  var tilesets = readJsonSync('Tilesets.json') || [];
  var commonEvents = readJsonSync('CommonEvents.json') || [];

  var maps = mapInfos.filter(function(m) { return m !== null; }).map(function(m) { return { id: m.id, name: m.name, parentId: m.parentId }; });
  var actorList = actors.filter(function(a) { return a !== null; }).map(function(a) { return { id: a.id, name: a.name, classId: a.classId, initialLevel: a.initialLevel }; });
  var itemList = items.filter(function(i) { return i !== null; }).map(function(i) { return { id: i.id, name: i.name, iconIndex: i.iconIndex, price: i.price, itypeId: i.itypeId }; });
  var weaponList = weapons.filter(function(w) { return w !== null; }).map(function(w) { return { id: w.id, name: w.name, iconIndex: w.iconIndex, price: w.price, wtypeId: w.wtypeId }; });
  var armorList = armors.filter(function(a) { return a !== null; }).map(function(a) { return { id: a.id, name: a.name, iconIndex: a.iconIndex, price: a.price, atypeId: a.atypeId }; });
  var skillList = skills.filter(function(s) { return s !== null; }).map(function(s) { return { id: s.id, name: s.name, mpCost: s.mpCost, scope: s.scope, stypeId: s.stypeId }; });
  var enemyList = enemies.filter(function(e) { return e !== null; }).map(function(e) { return { id: e.id, name: e.name, battlerName: e.battlerName }; });
  var troopList = troops.filter(function(t) { return t !== null; }).map(function(t) { return { id: t.id, name: t.name, members: (t.members || []).map(function(m) { return { enemyId: m.enemyId, x: m.x, y: m.y }; }) }; });
  var stateList = states.filter(function(s) { return s !== null; }).map(function(s) { return { id: s.id, name: s.name, iconIndex: s.iconIndex, restriction: s.restriction }; });
  var tilesetList = tilesets.filter(function(t) { return t !== null; }).map(function(t) { return { id: t.id, name: t.name, mode: t.mode, tilesetNames: t.tilesetNames }; });
  var ceList = commonEvents.filter(function(c) { return c !== null; }).map(function(c) { return { id: c.id, name: c.name, trigger: c.trigger, switchId: c.switchId }; });

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
      characters: listPngs('characters'),
      faces: listPngs('faces'),
      enemies: listPngs('enemies'),
      battlers: listPngs('battlers'),
      pictures: listPngs('pictures')
    }
  };
}

async function validateMap(projectPath, mapId) {
  const map = await mapTools.getMap(projectPath, mapId);
  var issues = [];
  var w = map.width;
  var h = map.height;

  // Check tile IDs
  if (map.data) {
    for (var i = 0; i < map.data.length; i++) {
      var layer = Math.floor(i / (w * h));
      var tileId = map.data[i];
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
  var events = map.events || [];
  for (var ei = 0; ei < events.length; ei++) {
    var ev = events[ei];
    if (ev === null) continue;
    for (var pi = 0; pi < (ev.pages || []).length; pi++) {
      var page = ev.pages[pi];
      var list = page.list || [];
      var hasTerminator = false;
      for (var ci = 0; ci < list.length; ci++) {
        var cmd = list[ci];
        if (cmd.code === 0 && cmd.indent === 0 && ci === list.length - 1) {
          hasTerminator = true;
        }
        // Check for common bad commands
        if (cmd.code === 126 && cmd.parameters && cmd.parameters.length >= 1 && cmd.parameters[0] === 0) {
          issues.push({ type: 'null_item_ref', event: ev.id, eventName: ev.name, page: pi, cmdIndex: ci, message: 'Change Item with itemId=0 (null) in event "' + ev.name + '"' });
        }
        if (cmd.code === 123 && cmd.parameters && cmd.parameters[1] === 0) {
          issues.push({ type: 'self_switch_off', event: ev.id, eventName: ev.name, page: pi, cmdIndex: ci, message: 'Self Switch set to OFF (0) instead of ON (1) in event "' + ev.name + '" - events may not lock properly' });
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
    eventCount: events.filter(function(e) { return e !== null; }).length,
    issueCount: issues.length,
    issues: issues
  };
}

// ─── Tool Definitions ───
// Each tool has: name, description, inputSchema (JSON Schema)

const TOOL_DEFINITIONS = [
  // ──────── ACTOR TOOLS ────────
  {
    name: 'get_actors',
    description: 'Get all actors from the RPG Maker MV project. Returns the full Actors.json data (excluding null entries).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_actor',
    description: 'Get a single actor by ID from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The actor ID to retrieve' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_actor',
    description: 'Create a new actor in the RPG Maker MV project with the specified properties.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Actor name' },
        nickname: { type: 'string', description: 'Actor nickname' },
        classId: { type: ['number', 'string'], description: 'Class ID' },
        initialLevel: { type: ['number', 'string'], description: 'Starting level (default 1)' },
        maxLevel: { type: ['number', 'string'], description: 'Maximum level (default 99)' },
        characterName: { type: 'string', description: 'Character sprite filename' },
        characterIndex: { type: ['number', 'string'], description: 'Character sprite index (0-7)' },
        faceName: { type: 'string', description: 'Face graphic filename' },
        faceIndex: { type: ['number', 'string'], description: 'Face graphic index (0-7)' },
          battlerName: { type: 'string', description: 'Battler sprite filename' },
          profile: { type: 'string', description: 'Actor profile text' },
          traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' },
          equips: { type: 'array', description: 'Array of initial equip IDs' },
          note: { type: 'string', description: 'Note field' }
          },
          required: ['name']
    }
  },
  {
    name: 'update_actor',
    description: 'Update an existing actor\'s properties (partial update). Only the fields provided will be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The actor ID to update' },
        fields: { type: 'object', description: 'Object containing actor fields to update' }
      },
      required: ['id', 'fields']
    }
  },
  {
    name: 'search_actors',
    description: 'Search actors by name or nickname (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to match against name or nickname' }
      },
      required: ['query']
    }
  },

  // ──────── ITEM TOOLS ────────
  {
    name: 'get_items',
    description: 'Get all items from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_weapons',
    description: 'Get all weapons from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_armors',
    description: 'Get all armors from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_skills',
    description: 'Get all skills from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_item',
    description: 'Create a new item (consumable: potions, scrolls, etc.). Generates a complete RPG Maker MV item object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name' },
        description: { type: 'string', description: 'Item description' },
        price: { type: ['number', 'string'], description: 'Shop price' },
        consumable: { type: 'boolean', description: 'Whether the item is consumed on use (default true)' },
        scope: { type: ['number', 'string'], description: 'Target scope: 1=single enemy, 7=all allies, 11=user' },
        occasion: { type: ['number', 'string'], description: 'When usable: 0=always, 1=battle, 2=menu, 3=never' },
        animationId: { type: ['number', 'string'], description: 'Animation ID when used' },
          effects: { type: 'array', description: 'Array of effect objects {code, dataId, value1, value2}' },
          note: { type: 'string', description: 'Note field for plugins' },
          iconIndex: { type: ['number', 'string'], description: 'Icon index' },
          itypeId: { type: ['number', 'string'], description: 'Item type ID' },
          traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' }
          },
          required: ['name']
          }
          },
          {
          name: 'create_weapon',
    description: 'Create a new weapon. Generates a complete RPG Maker MV weapon object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Weapon name' },
        description: { type: 'string', description: 'Weapon description' },
        wtypeId: { type: ['number', 'string'], description: 'Weapon type ID' },
        price: { type: ['number', 'string'], description: 'Shop price' },
        params: {
          type: 'array',
          description: 'Parameter bonuses [mhp, mmp, atk, def, mat, mdf, agi, luk]',
          items: { type: ['number', 'string'] }
        },
          traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' },
          note: { type: 'string', description: 'Note field' },
          iconIndex: { type: ['number', 'string'], description: 'Icon index' },
          etypeId: { type: ['number', 'string'], description: 'Equip type ID' },
          animationId: { type: ['number', 'string'], description: 'Animation ID' }
          },
          required: ['name']
          }
          },
          {
          name: 'create_armor',
    description: 'Create a new armor. Generates a complete RPG Maker MV armor object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Armor name' },
        description: { type: 'string', description: 'Armor description' },
        atypeId: { type: ['number', 'string'], description: 'Armor type ID' },
        price: { type: ['number', 'string'], description: 'Shop price' },
        params: {
          type: 'array',
          description: 'Parameter bonuses [mhp, mmp, atk, def, mat, mdf, agi, luk]',
          items: { type: ['number', 'string'] }
        },
        traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' },
          etypeId: { type: ['number', 'string'], description: 'Equip type: 2=shield, 3=head, 4=body, 5=accessory' },
          note: { type: 'string', description: 'Note field' },
          iconIndex: { type: ['number', 'string'], description: 'Icon index' }
          },
          required: ['name']
          }
          },
          {
          name: 'update_item',
    description: 'Update an existing item, weapon, or armor by ID (partial update).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The item/weapon/armor ID to update' },
        type: { type: 'string', description: 'Type: "item", "weapon", or "armor"', enum: ['item', 'weapon', 'armor'] },
        fields: { type: 'object', description: 'Fields to update' }
      },
      required: ['id', 'type', 'fields']
    }
  },
  {
    name: 'search_items',
    description: 'Search items, weapons, or armors by name or description (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
        type: { type: 'string', description: 'Type: "item", "weapon", or "armor" (default "item")', enum: ['item', 'weapon', 'armor'] }
      },
      required: ['query']
    }
  },

  // ──────── SKILL TOOLS ────────
  {
    name: 'get_skill',
    description: 'Get a single skill by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The skill ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_all_skills',
    description: 'Get all skills from the RPG Maker MV project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_skill',
    description: 'Create a new skill with full control over all properties including damage, effects, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        description: { type: 'string', description: 'Skill description' },
        mpCost: { type: ['number', 'string'], description: 'MP cost' },
        tpCost: { type: ['number', 'string'], description: 'TP cost' },
        scope: { type: ['number', 'string'], description: 'Target scope: 1=single enemy, 2=all enemies, 7=all allies, 11=user' },
        occasion: { type: ['number', 'string'], description: 'When usable: 0=always, 1=battle, 2=menu, 3=never' },
        animationId: { type: ['number', 'string'], description: 'Animation ID' },
        damage: {
          type: 'object',
          description: 'Damage configuration: {type, elementId, formula, variance, critical}',
          properties: {
            type: { type: ['number', 'string'], description: '0=none, 1=HP damage, 2=MP damage, 3=HP recover, 4=MP recover, 5=MP drain' },
            elementId: { type: ['number', 'string'], description: 'Element: 0=none, 2=fire, 3=ice, 4=thunder, etc.' },
            formula: { type: 'string', description: 'Damage formula (e.g. "a.mat * 4 - b.mdf * 2")' },
            variance: { type: ['number', 'string'], description: 'Variance percentage (0-100, default 20)' },
            critical: { type: 'boolean', description: 'Can critical hit (default false)' }
          }
        },
          effects: { type: 'array', description: 'Array of effect objects {code, dataId, value1, value2}' },
          note: { type: 'string', description: 'Note field' },
          iconIndex: { type: ['number', 'string'], description: 'Icon index' },
          stypeId: { type: ['number', 'string'], description: 'Skill type ID' },
          hitType: { type: ['number', 'string'], description: 'Hit type: 0=certain, 1=physical, 2=magical' },
          speed: { type: ['number', 'string'], description: 'Speed correction' },
          successRate: { type: ['number', 'string'], description: 'Success rate (default 100)' },
          repeats: { type: ['number', 'string'], description: 'Number of repeats (default 1)' },
          tpGain: { type: ['number', 'string'], description: 'TP gained (default 0)' },
          message1: { type: 'string', description: 'Message line 1 when used' },
          message2: { type: 'string', description: 'Message line 2 when used' },
          requiredWtypeId1: { type: ['number', 'string'], description: 'Required weapon type ID 1' },
          requiredWtypeId2: { type: ['number', 'string'], description: 'Required weapon type ID 2' },
          messageType: { type: ['number', 'string'], description: 'Message type' },
          traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' }
          },
          required: ['name']
    }
  },
  {
    name: 'create_damage_skill',
    description: 'Create a damage-dealing skill (simplified). Sets damage type to HP damage automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        mpCost: { type: ['number', 'string'], description: 'MP cost' },
        scope: { type: ['number', 'string'], description: 'Target scope: 1=single enemy, 2=all enemies' },
        formula: { type: 'string', description: 'Damage formula (e.g. "a.mat * 4 - b.mdf * 2")' },
        element: { type: ['number', 'string'], description: 'Element ID: 0=none, 2=fire, 3=ice, 4=thunder (default 0)' },
        animationId: { type: ['number', 'string'], description: 'Animation ID (default 1)' }
      },
      required: ['name', 'mpCost', 'scope', 'formula']
    }
  },
  {
    name: 'create_healing_skill',
    description: 'Create a healing skill (simplified). Sets damage type to HP recover automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        mpCost: { type: ['number', 'string'], description: 'MP cost' },
        scope: { type: ['number', 'string'], description: 'Target scope: 7=all allies, 11=user' },
        formula: { type: 'string', description: 'Healing formula (e.g. "a.mat * 3 + 100")' },
        animationId: { type: ['number', 'string'], description: 'Animation ID (default 47)' }
      },
      required: ['name', 'mpCost', 'scope', 'formula']
    }
  },
  {
    name: 'create_buff_skill',
    description: 'Create a buff skill (simplified). Adds a buff effect to a parameter for a number of turns.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        mpCost: { type: ['number', 'string'], description: 'MP cost' },
        scope: { type: ['number', 'string'], description: 'Target scope: 7=all allies, 11=user' },
        paramId: { type: ['number', 'string'], description: 'Parameter to buff: 0=MaxHP, 1=MaxMP, 2=ATK, 3=DEF, 4=MAT, 5=MDF, 6=AGI, 7=LUK' },
        turns: { type: ['number', 'string'], description: 'Number of turns the buff lasts' }
      },
      required: ['name', 'mpCost', 'scope', 'paramId', 'turns']
    }
  },
  {
    name: 'create_state_skill',
    description: 'Create a state-inflicting skill (simplified). Adds a state effect like poison, sleep, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        mpCost: { type: ['number', 'string'], description: 'MP cost' },
        scope: { type: ['number', 'string'], description: 'Target scope: 1=single enemy, 2=all enemies' },
        stateId: { type: ['number', 'string'], description: 'State ID: 4=poison, 5=blind, 6=silence, 8=confusion, 9=sleep' },
        chance: { type: ['number', 'string'], description: 'Success chance (0.0 to 1.0)' }
      },
      required: ['name', 'mpCost', 'scope', 'stateId', 'chance']
    }
  },
  {
    name: 'update_skill',
    description: 'Update an existing skill\'s properties (partial update).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'The skill ID to update' },
        fields: { type: 'object', description: 'Fields to update' }
      },
      required: ['id', 'fields']
    }
  },
  {
    name: 'search_skills',
    description: 'Search skills by name or description (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' }
      },
      required: ['query']
    }
  },

  // ──────── MAP TOOLS ────────
  {
    name: 'get_map_infos',
    description: 'Get information about all maps in the project (MapInfos.json). Returns the map tree structure.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_map',
    description: 'Get full map data by ID including events, tiles, and settings.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID (e.g. 1 for Map001.json)' }
      },
      required: ['mapId']
    }
  },
  {
    name: 'get_map_events',
    description: 'Get all events from a specific map.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' }
      },
      required: ['mapId']
    }
  },
  {
    name: 'get_map_event',
    description: 'Get a specific event from a map by event ID.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        eventId: { type: ['number', 'string'], description: 'The event ID' }
      },
      required: ['mapId', 'eventId']
    }
  },
  {
    name: 'create_map',
    description: 'Create a new map with specified dimensions and properties. Optionally generates a tile layout by theme. When a tilesetId is provided with a theme, uses the enhanced V2 generator that reads actual tileset tile IDs for coherent, beautiful maps with proper shadow/region layers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Map name as shown in the editor' },
        width: { type: ['number', 'string'], description: 'Map width in tiles (default 17)' },
        height: { type: ['number', 'string'], description: 'Map height in tiles (default 13)' },
        tilesetId: { type: ['number', 'string'], description: 'Tileset ID (default 1)' },
        bgmName: { type: 'string', description: 'BGM filename to autoplay' },
        displayName: { type: 'string', description: 'Display name shown to the player' },
        note: { type: 'string', description: 'Note field for plugin metadata' },
        theme: {
          type: 'string',
          description: 'Tile layout theme. When a tilesetId is set, the generator uses the tileset\'s actual tiles (via scan_project_assets) for coherent, beautiful maps. Themes: forest, dungeon, town, castle, cave, village, swamp, desert, ruins, interior, beach',
          enum: ['forest', 'dungeon', 'town', 'castle', 'cave', 'village', 'swamp', 'desert', 'ruins', 'interior', 'beach']
        }
      },
      required: []
    }
  },
  {
    name: 'fill_map_layer',
    description: 'Fill an entire tile layer of a map with a specific tile ID. Useful for setting base terrain.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        layer: { type: ['number', 'string'], description: 'Layer index (0-5): 0-1=ground, 2-3=upper, 4=shadow, 5=region' },
        tileId: { type: ['number', 'string'], description: 'Tile ID to fill with (0=clear)' }
      },
      required: ['mapId', 'layer', 'tileId']
    }
  },
  {
    name: 'create_map_event',
    description: 'Create a new event on a map with specified position, name, trigger, and optional pages.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        x: { type: ['number', 'string'], description: 'X position on the map' },
        y: { type: ['number', 'string'], description: 'Y position on the map' },
        name: { type: 'string', description: 'Event name' },
        trigger: { type: ['number', 'string'], description: 'Trigger: 0=action button, 1=player touch, 2=event touch, 3=autorun, 4=parallel' },
        pages: { type: 'array', description: 'Array of event page objects (optional)' }
      },
      required: ['mapId', 'x', 'y', 'name']
    }
},
{
  name: 'generate_map_v3',
  description: 'Generate a new map using the V3 procedural generator with Perlin noise, BSP dungeon, cellular automata caves. Supports 21 themes: forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world. Generates events automatically (NPCs, chests, bosses, transfers). Returns mapId and seed used.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Map name for MapInfos' },
      displayName: { type: 'string', description: 'Display name shown to player' },
      width: { type: ['number', 'string'], description: 'Map width in tiles (default 30)' },
      height: { type: ['number', 'string'], description: 'Map height in tiles (default 25)' },
      tilesetId: { type: ['number', 'string'], description: 'Tileset ID (1=Overworld,2=Outside,3=Inside,4=Dungeon,5=SF Outside,6=SF Inside,7=Magic Exterior,8=Space Interior)' },
      theme: { type: 'string', description: 'Theme: forest, town, village, castle, dungeon, cave, beach, desert, swamp, ruins, interior, snow, harbor, volcano, sewer, fortress, magic_forest, magic_interior, space_interior, space_exterior, world' },
      seed: { type: ['number', 'string'], description: 'Random seed (omit for random). Same seed = same map.' },
      addEvents: { type: 'boolean', description: 'Generate events automatically (default true)' },
      parentId: { type: ['number', 'string'], description: 'Parent folder ID in map tree (0=root)' }
    },
    required: ['theme']
  }
},
{
  name: 'generate_map_batch',
  description: 'Generate multiple maps in a single call. Each entry specifies theme, size, tilesetId, name. Returns all mapIds for interconnection.',
  inputSchema: {
    type: 'object',
    properties: {
      batch: {
        type: 'array',
        description: 'Array of map specs: [{key, name, theme, width, height, tilesetId, seed, parentId}]',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Reference key for connect_maps later' },
            name: { type: 'string', description: 'Map name' },
            theme: { type: 'string', description: 'Theme name' },
            width: { type: ['number', 'string'] },
            height: { type: ['number', 'string'] },
            tilesetId: { type: ['number', 'string'] },
            seed: { type: ['number', 'string'] },
            parentId: { type: ['number', 'string'] }
          }
        }
      }
    },
    required: ['batch']
  }
},
{
  name: 'connect_maps',
  description: 'Create bidirectional transfer events between two maps. Player touch events at specified positions.',
  inputSchema: {
    type: 'object',
    properties: {
      mapIdA: { type: ['number', 'string'], description: 'First map ID' },
      mapIdB: { type: ['number', 'string'], description: 'Second map ID' },
      posA: { type: 'object', description: 'Position on map A: {x, y, trigger}', properties: { x: { type: ['number', 'string'] }, y: { type: ['number', 'string'] }, trigger: { type: ['number', 'string'] } } },
      posB: { type: 'object', description: 'Position on map B: {x, y, trigger}', properties: { x: { type: ['number', 'string'] }, y: { type: ['number', 'string'] }, trigger: { type: ['number', 'string'] } } }
    },
    required: ['mapIdA', 'mapIdB', 'posA', 'posB']
  }
},
{
  name: 'populate_map_events',
  description: 'Add multiple events of a type (npc, chest, boss) to an existing map at random positions.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      eventType: { type: 'string', description: 'Event type: npc, chest, boss' },
      count: { type: ['number', 'string'], description: 'Number of events to add (default 3)' },
      opts: { type: 'object', description: 'Options: {name, troopId, x, y}' }
    },
    required: ['mapId', 'eventType']
  }
},
{
  name: 'set_map_display_names',
  description: 'Set display names for multiple maps at once. Display name is shown to the player during gameplay.',
  inputSchema: {
    type: 'object',
    properties: {
      names: { type: 'array', description: 'Array of {mapId, name} objects', items: { type: 'object', properties: { mapId: { type: ['number', 'string'] }, name: { type: 'string' } } } }
    },
    required: ['names']
  }
},
{
  name: 'organize_map_tree',
  description: 'Organize maps into folders by setting parentId. Creates a hierarchy in the RPG Maker editor map tree.',
  inputSchema: {
    type: 'object',
    properties: {
      folders: { type: 'array', description: 'Array of {mapId, parentId} objects. parentId=0 means root level.', items: { type: 'object', properties: { mapId: { type: ['number', 'string'] }, parentId: { type: ['number', 'string'] } } } }
    },
    required: ['folders']
  }
},
{
  name: 'update_map_event',
    description: 'Update an existing map event\'s properties (partial update).',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        eventId: { type: ['number', 'string'], description: 'The event ID to update' },
        fields: { type: 'object', description: 'Fields to update (e.g. name, x, y, pages)' }
      },
      required: ['mapId', 'eventId', 'fields']
    }
  },
  {
    name: 'add_event_command',
    description: 'Add an event command to a specific page of an event. Command is inserted before the page terminator (code 0).',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        eventId: { type: ['number', 'string'], description: 'The event ID (number or numeric string)' },
        pageIndex: { type: ['number', 'string'], description: 'Page index (0-based)' },
        command: {
          type: 'object',
          description: 'The event command object: {code, indent, parameters}',
          properties: {
            code: { type: ['number', 'string'], description: 'MV event command code' },
            indent: { type: ['number', 'string'], description: 'Indent level (default 0)' },
            parameters: { type: 'array', description: 'Command parameters' }
          },
          required: ['code', 'parameters']
        }
      },
      required: ['mapId', 'eventId', 'command']
    }
  },
  {
    name: 'create_npc',
    description: 'HIGH LEVEL: Create an NPC with dialogue on a map. Produces a 2-page event: Page 1 has dialogue triggered by Action Button, Page 2 shows "already talked" when Self Switch A is ON.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        x: { type: ['number', 'string'], description: 'X position' },
        y: { type: ['number', 'string'], description: 'Y position' },
        name: { type: 'string', description: 'NPC name' },
        dialogues: {
          type: 'array',
          description: 'Array of dialogue strings. Each becomes a Show Text command.',
          items: { type: 'string' }
        },
        characterName: { type: 'string', description: 'Character sprite filename' },
        characterIndex: { type: ['number', 'string'], description: 'Character sprite index (0-7)' }
      },
      required: ['mapId', 'x', 'y', 'name', 'dialogues']
    }
  },
  {
    name: 'create_chest',
    description: 'HIGH LEVEL: Create a chest event on a map. Produces a 2-page event: Page 1 gives items and activates Self Switch A, Page 2 shows "already opened" when Self Switch A is ON.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        x: { type: ['number', 'string'], description: 'X position' },
        y: { type: ['number', 'string'], description: 'Y position' },
        items: {
          type: 'array',
          description: 'Array of items to give: {type: "item"|"weapon"|"armor", id: number, amount: number}',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '"item", "weapon", or "armor"' },
              id: { type: ['number', 'string'], description: 'Item/weapon/armor ID' },
              amount: { type: ['number', 'string'], description: 'Quantity (default 1)' }
            }
          }
        },
        characterName: { type: 'string', description: 'Chest sprite filename (default "Chest")' },
        characterIndex: { type: ['number', 'string'], description: 'Chest sprite index (default 0)' }
      },
      required: ['mapId', 'x', 'y', 'items']
    }
  },
  {
    name: 'create_teleport_event',
    description: 'HIGH LEVEL: Create a teleport event that transfers the player to another map position.',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The current map ID' },
        x: { type: ['number', 'string'], description: 'X position on current map' },
        y: { type: ['number', 'string'], description: 'Y position on current map' },
        destMapId: { type: ['number', 'string'], description: 'Destination map ID' },
        destX: { type: ['number', 'string'], description: 'Destination X coordinate' },
        destY: { type: ['number', 'string'], description: 'Destination Y coordinate' },
        trigger: { type: ['number', 'string'], description: 'Trigger: 0=action button (doors), 1=player touch (walk-on, default)' }
      },
      required: ['mapId', 'x', 'y', 'destMapId', 'destX', 'destY']
    }
  },
  {
    name: 'search_map_events',
    description: 'Search map events by name (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'The map ID' },
        query: { type: 'string', description: 'Search term' }
      },
      required: ['mapId', 'query']
    }
  },

  // ──────── SYSTEM TOOLS ────────
  {
    name: 'get_system',
    description: 'Get the full system data from System.json (game title, switches, variables, starting position, etc.).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_switches',
    description: 'Get all game switch names from the project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_variables',
    description: 'Get all game variable names from the project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'set_switch_name',
    description: 'Set a switch name by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Switch ID (1-based)' },
        name: { type: 'string', description: 'New name for the switch' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'set_variable_name',
    description: 'Set a variable name by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['number', 'string'], description: 'Variable ID (1-based)' },
        name: { type: 'string', description: 'New name for the variable' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'get_game_title',
    description: 'Get the game title.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'update_game_title',
    description: 'Update the game title.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'New game title' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_starting_position',
    description: 'Update the player starting position (map ID and coordinates).',
    inputSchema: {
      type: 'object',
      properties: {
        mapId: { type: ['number', 'string'], description: 'Starting map ID' },
        x: { type: ['number', 'string'], description: 'Starting X coordinate' },
        y: { type: ['number', 'string'], description: 'Starting Y coordinate' }
      },
      required: ['mapId', 'x', 'y']
    }
  },

  // ──────── CLASS TOOLS ────────
{
  name: 'get_classes',
  description: 'Get all classes from the RPG Maker MV project. Returns all non-null entries from Classes.json.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_class',
  description: 'Get a single class by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'The class ID' } }, required: ['id'] }
},
{
  name: 'create_class',
  description: 'Create a new class with the specified properties. Classes define skill learning, parameters, and traits for actors.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Class name' },
      params: { type: 'array', description: 'Base parameters [mhp, mmp, atk, def, mat, mdf, agi, luk]', items: { type: ['number', 'string'] } },
      expParams: { type: 'array', description: 'EXP curve [base, inflation, correction, max level]', items: { type: ['number', 'string'] } },
      learnings: { type: 'array', description: 'Array of {level, skillId} learning entries' },
      traits: { type: 'array', description: 'Array of trait objects {code, dataId, value}' },
      note: { type: 'string', description: 'Note field' }
    },
    required: ['name']
  }
},
{
  name: 'update_class',
  description: 'Update an existing class (partial update).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Class ID' }, fields: { type: 'object', description: 'Fields to update' } }, required: ['id', 'fields'] }
},
{
  name: 'search_classes',
  description: 'Search classes by name (case-insensitive).',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search term' } }, required: ['query'] }
},
{
  name: 'delete_class',
  description: 'Delete a class by ID (sets entry to null).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Class ID to delete' } }, required: ['id'] }
},
// ──────── ENEMY TOOLS ────────
{
  name: 'get_enemies',
  description: 'Get all enemies from the RPG Maker MV project.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_enemy',
  description: 'Get a single enemy by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Enemy ID' } }, required: ['id'] }
},
{
  name: 'create_enemy',
  description: 'Create a new enemy with the specified properties.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Enemy name' },
      battlerName: { type: 'string', description: 'Battler sprite filename' },
      battlerHue: { type: ['number', 'string'], description: 'Battler hue (0-360)' },
      exp: { type: ['number', 'string'], description: 'EXP given on defeat' },
      gold: { type: ['number', 'string'], description: 'Gold given on defeat' },
      params: { type: 'array', description: 'Parameters [mhp, mmp, atk, def, mat, mdf, agi, luk]', items: { type: ['number', 'string'] } },
      dropItems: { type: 'array', description: 'Drop items array [{kind, dataId, denominator}]' },
      actions: { type: 'array', description: 'Action patterns [{skillId, conditionType, conditionParam1, conditionParam2, rating}]' },
      traits: { type: 'array', description: 'Trait objects {code, dataId, value}' }
    },
    required: ['name']
  }
},
{
  name: 'create_boss_enemy',
  description: 'Create a boss enemy with higher stats and special attack pattern. Simplified helper.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Boss name' },
      battlerName: { type: 'string', description: 'Battler sprite filename' },
      exp: { type: ['number', 'string'], description: 'EXP given (default 500)' },
      gold: { type: ['number', 'string'], description: 'Gold given (default 200)' },
      params: { type: 'array', description: 'Parameters [mhp, mmp, atk, def, mat, mdf, agi, luk]', items: { type: ['number', 'string'] } },
      specialSkillId: { type: ['number', 'string'], description: 'Special skill ID for boss attack pattern' },
      actions: { type: 'array', description: 'Custom action patterns' }
    },
    required: ['name']
  }
},
{
  name: 'update_enemy',
  description: 'Update an existing enemy (partial update).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Enemy ID' }, fields: { type: 'object', description: 'Fields to update' } }, required: ['id', 'fields'] }
},
{
  name: 'search_enemies',
  description: 'Search enemies by name (case-insensitive).',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search term' } }, required: ['query'] }
},
{
  name: 'delete_enemy',
  description: 'Delete an enemy by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Enemy ID to delete' } }, required: ['id'] }
},
// ──────── STATE TOOLS ────────
{
  name: 'get_states',
  description: 'Get all states from the RPG Maker MV project (poison, sleep, confusion, etc.).',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_state',
  description: 'Get a single state by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'State ID' } }, required: ['id'] }
},
{
  name: 'create_state',
  description: 'Create a new state (poison, sleep, confusion, buff, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'State name' },
      iconIndex: { type: ['number', 'string'], description: 'Icon index' },
      restriction: { type: ['number', 'string'], description: 'Restriction: 0=none, 1=attack enemy, 2=attack ally, 3=attack anyone, 4=cannot move' },
      priority: { type: ['number', 'string'], description: 'State priority (default 50)' },
      removeAtBattleEnd: { type: 'boolean', description: 'Remove when battle ends (default false)' },
      removeByDamage: { type: 'boolean', description: 'Chance to remove when damaged (default false)' },
      autoRemovalTiming: { type: ['number', 'string'], description: 'Auto remove: 0=none, 1=action end, 2=turn end' },
      minTurns: { type: ['number', 'string'], description: 'Minimum turns (default 1)' },
      maxTurns: { type: ['number', 'string'], description: 'Maximum turns (default 5)' },
      traits: { type: 'array', description: 'Trait objects {code, dataId, value}' },
      message1: { type: 'string', description: 'Message when applied' },
      message2: { type: 'string', description: 'Message when remaining' },
      message3: { type: 'string', description: 'Message when removed' },
          message4: { type: 'string', description: 'Message on failure' },
          note: { type: 'string', description: 'Note field' },
          removeByRestriction: { type: 'boolean', description: 'Remove by restriction (default false)' },
          stepsToRemove: { type: ['number', 'string'], description: 'Steps to remove (default 100)' }
          },
          required: ['name']
          }
          },
          {
          name: 'update_state',
  description: 'Update an existing state (partial update).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'State ID' }, fields: { type: 'object', description: 'Fields to update' } }, required: ['id', 'fields'] }
},
{
  name: 'search_states',
  description: 'Search states by name (case-insensitive).',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search term' } }, required: ['query'] }
},
{
  name: 'delete_state',
  description: 'Delete a state by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'State ID to delete' } }, required: ['id'] }
},
// ──────── TILESET TOOLS ────────
{
  name: 'get_tilesets',
  description: 'Get all tilesets from the RPG Maker MV project.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_tileset',
  description: 'Get a single tileset by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Tileset ID' } }, required: ['id'] }
},
{
  name: 'update_tileset',
  description: 'Update a tileset (partial update).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Tileset ID' }, fields: { type: 'object', description: 'Fields to update' } }, required: ['id', 'fields'] }
},

// ──────── COMMON EVENT TOOLS ────────
{
  name: 'get_common_events',
  description: 'Get all common events from the RPG Maker MV project.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'create_common_event',
  description: 'Create a new common event. Trigger types: 0=none, 1=autorun, 2=parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Common event name' },
      trigger: { type: ['number', 'string'], description: 'Trigger type: 0=none, 1=autorun, 2=parallel' },
      switchId: { type: ['number', 'string'], description: 'Switch ID that activates this event (required if trigger>0)' },
          list: { type: 'array', description: 'Event command list' },
          note: { type: 'string', description: 'Note field' }
          },
          required: ['name']
          }
          },
          {
          name: 'update_common_event',
  description: 'Update an existing common event (partial update).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Common event ID' }, fields: { type: 'object', description: 'Fields to update' } }, required: ['id', 'fields'] }
},
{
  name: 'add_common_event_command',
  description: 'Add an event command to a common event\'s command list.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: ['number', 'string'], description: 'Common event ID' },
      command: { type: 'object', description: 'Event command {code, indent, parameters}' }
    },
    required: ['id', 'command']
  }
},
// ──────── TROOP TOOLS ────────
{
  name: 'get_troops',
  description: 'Get all troops (enemy groups) from the RPG Maker MV project.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_troop',
  description: 'Get a single troop by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Troop ID' } }, required: ['id'] }
},
{
  name: 'create_troop',
  description: 'Create a new troop (enemy group for battle encounters).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Troop name' },
      members: { type: 'array', description: 'Enemy members [{enemyId, x, y}]' }
    },
    required: ['name']
  }
},
{
            name: 'add_enemy_to_troop',
            description: 'Add an enemy to an existing troop at auto-generated battle position.',
            inputSchema: {
                type: 'object',
                properties: {
                    troopId: { type: ['number', 'string'], description: 'Troop ID' },
                    enemyId: { type: ['number', 'string'], description: 'Enemy ID to add' }
                },
                required: ['troopId', 'enemyId']
            }
        },
{
  name: 'create_random_encounter_troop',
  description: 'Create a troop with specified enemies at auto-generated battle positions. Simplified helper for random encounters.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Troop name' },
      enemyIds: { type: 'array', description: 'Array of enemy IDs to include', items: { type: ['number', 'string'] } }
    },
    required: ['name', 'enemyIds']
  }
},
// ──────── ANIMATION TOOLS ────────
{
  name: 'get_animations',
  description: 'Get all animations from the RPG Maker MV project.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_animation',
  description: 'Get a single animation by ID.',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Animation ID' } }, required: ['id'] }
},
// ──────── DELETE TOOLS (Actors/Items/Skills) ────────
{
  name: 'delete_actor',
  description: 'Delete an actor by ID (sets entry to null in Actors.json).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Actor ID to delete' } }, required: ['id'] }
},
{
  name: 'delete_item',
  description: 'Delete an item, weapon, or armor by ID and type.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: ['number', 'string'], description: 'Item ID to delete' },
      type: { type: 'string', description: 'Type: "item", "weapon", or "armor"', enum: ['item', 'weapon', 'armor'] }
    },
    required: ['id', 'type']
  }
},
{
  name: 'delete_skill',
  description: 'Delete a skill by ID (sets entry to null in Skills.json).',
  inputSchema: { type: 'object', properties: { id: { type: ['number', 'string'], description: 'Skill ID to delete' } }, required: ['id'] }
},
// ──────── NEW MAP HELPER TOOLS ────────
{
  name: 'delete_map_event',
  description: 'Delete an event from a map by event ID.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      eventId: { type: ['number', 'string'], description: 'Event ID to delete' }
    },
    required: ['mapId', 'eventId']
  }
},
{
  name: 'duplicate_map',
  description: 'Duplicate an existing map to create a new one with the same tiles and events.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceMapId: { type: ['number', 'string'], description: 'Source map ID to duplicate' },
      name: { type: 'string', description: 'Name for the new map' },
      displayName: { type: 'string', description: 'Display name shown to player' }
    },
    required: ['sourceMapId', 'name']
  }
},
{
  name: 'create_shop',
  description: 'Create a shop event on a map. Uses Shop Processing event commands with a list of goods.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      x: { type: ['number', 'string'], description: 'X position' },
      y: { type: ['number', 'string'], description: 'Y position' },
      name: { type: 'string', description: 'Event name' },
      goods: { type: 'array', description: 'Array of [type, itemId, priceType, price]. type: 0=item, 1=weapon, 2=armor. priceType: 0=standard, 1=custom', items: { type: 'array' } },
      characterName: { type: 'string', description: 'Character sprite filename' },
      characterIndex: { type: ['number', 'string'], description: 'Character sprite index (0-7)' }
    },
    required: ['mapId', 'x', 'y', 'name', 'goods']
  }
},
{
  name: 'create_inn',
  description: 'Create an inn event on a map. Shows a choice (Yes/No), checks gold, and recovers all if the player can pay.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      x: { type: ['number', 'string'], description: 'X position' },
      y: { type: ['number', 'string'], description: 'Y position' },
      name: { type: 'string', description: 'Event name' },
      cost: { type: ['number', 'string'], description: 'Cost to stay at the inn (default 50)' },
      characterName: { type: 'string', description: 'Character sprite filename' },
      characterIndex: { type: ['number', 'string'], description: 'Character sprite index (0-7)' }
    },
    required: ['mapId', 'x', 'y', 'name']
  }
},
{
  name: 'create_boss_event',
  description: 'Create a boss battle event on a map. 2-page event: page 1 triggers battle, page 2 (self-switch A) for post-battle. On lose: game over.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      x: { type: ['number', 'string'], description: 'X position' },
      y: { type: ['number', 'string'], description: 'Y position' },
      name: { type: 'string', description: 'Event name' },
      troopId: { type: ['number', 'string'], description: 'Troop ID for the boss battle' },
      characterName: { type: 'string', description: 'Character sprite filename' },
      characterIndex: { type: ['number', 'string'], description: 'Character sprite index (0-7)' }
    },
    required: ['mapId', 'x', 'y', 'name', 'troopId']
  }
},
{
  name: 'create_puzzle_switch',
  description: 'Create a puzzle switch and door pair on a map. The switch activates a game switch; the door opens when that switch is ON. Creates 2 events.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID' },
      switchX: { type: ['number', 'string'], description: 'Switch X position' },
      switchY: { type: ['number', 'string'], description: 'Switch Y position' },
      doorX: { type: ['number', 'string'], description: 'Door X position' },
      doorY: { type: ['number', 'string'], description: 'Door Y position' },
      gameSwitchId: { type: ['number', 'string'], description: 'Game switch ID to activate' },
      switchName: { type: 'string', description: 'Switch event name (default "Switch")' },
      doorName: { type: 'string', description: 'Door event name (default "Door")' }
    },
    required: ['mapId', 'switchX', 'switchY', 'doorX', 'doorY', 'gameSwitchId']
  }
},
// ──────── PROJECT TOOLS ────────
{
  name: 'get_project_summary',
  description: 'Get a summary of the current RPG Maker MV project (counts of actors, items, maps, etc.).',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'get_project_context',
  description: 'Get a complete pre-digested context of the project. Call this FIRST before creating maps, events, or database entries. Returns: tilesets with available tile categories, maps list, actors, items/weapons/armors IDs, switches, variables, and available sprites.',
  inputSchema: { type: 'object', properties: {}, required: [] }
},
{
  name: 'validate_map',
  description: 'Validate a map for common errors: invalid tile IDs, wrong layer usage, broken event commands, invalid references to switches/variables/items/troops, missing page terminators. Returns a list of issues found.',
  inputSchema: {
    type: 'object',
    properties: {
      mapId: { type: ['number', 'string'], description: 'Map ID to validate' }
    },
    required: ['mapId']
  }
},
{
  name: 'set_project_path',
  description: 'Switch the server to a different RPG Maker MV project at runtime. Validates the new path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the new RPG Maker MV project directory' }
    },
    required: ['path']
  }
},
// ──────── VISION / IMAGE TOOLS ────────
  {
    name: 'analyze_tileset_image',
    description: 'Analyze a tileset image (base64 PNG) to determine grid dimensions, tile count, rows and columns. Assumes standard RPG Maker MV 48x48 tile size.',
    inputSchema: {
      type: 'object',
      properties: {
        base64PNG: { type: 'string', description: 'Base64-encoded PNG image of a tileset' }
      },
      required: ['base64PNG']
    }
  },
  {
    name: 'read_screenshot',
    description: 'Analyze a screenshot (base64 PNG) by splitting into 4 quadrants and returning the dominant color (average RGB) of each. Useful for visual reasoning about what\'s on screen.',
    inputSchema: {
      type: 'object',
      properties: {
        base64PNG: { type: 'string', description: 'Base64-encoded PNG screenshot' }
      },
      required: ['base64PNG']
    }
  },
  // ──────── ASSET TOOLS ────────
  {
    name: 'scan_project_assets',
    description: 'Scan the project\'s img/ folder and Tilesets.json to build a complete asset index. Returns tileset sheet metadata (dimensions, tile counts, autotile kinds) and categorized available tiles (ground, water, wallSide, wallTop, roof, decoration) for each tileset. Also lists all PNG files in each img/ subdirectory. Use this before creating maps to get tilesetConfig for better tile layouts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_tile_ids_for_tileset',
    description: 'Get categorized tile IDs for a specific tileset. Returns tile IDs organized by category: ground, water, wallSide, wallTop, roof, decoration. Each entry includes the tileId, kind index, and description. Use this to pick specific tiles for manual map editing or to understand what tiles a tileset provides.',
    inputSchema: {
      type: 'object',
      properties: {
        tilesetId: { type: ['number', 'string'], description: 'The tileset ID to scan' }
      },
      required: ['tilesetId']
    }
  },
  // ──────── VISION AI TOOLS ────────
  {
    name: 'analyze_screenshot',
    description: 'Analyze an image from the RPG Maker MV project using NVIDIA Llama 3.2 90B Vision AI. Can analyze: tilesets (tile categories, rows/cols), character sprites (directions, poses), map screenshots (terrain, events, layout), battlers, faces, etc. Returns a detailed textual description. Requires the nvidia-glm-proxy to be running with VISION_MODEL configured.',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Relative path to the image within the project (e.g. "img/tilesets/Outside.png" or "img/characters/Actor1.png")' },
        prompt: { type: 'string', description: 'Custom analysis prompt (optional). Default: RPG Maker specific analysis in Spanish.' },
        resize_max: { type: ['number', 'string'], description: 'Max width in pixels to resize the image before sending (default: 1024, saves tokens)' }
      },
      required: ['image_path']
    }
  },
  {
    name: 'render_map_ascii',
    description: 'Render an ASCII representation of an RPG Maker MV map. Works offline without any API. Shows tile layout, event positions, and region IDs. Useful when no screenshot is available or you need precise coordinate information.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: ['number', 'string'], description: 'Map ID to render' },
        layer: { type: ['number', 'string'], description: 'Tile layer to render (0=ground, 2=upper, default: 0)' },
        show_events: { type: 'boolean', description: 'Show event positions (default: true)' },
        show_regions: { type: 'boolean', description: 'Show region IDs (default: false)' }
      },
      required: ['map_id']
    }
  }
];

// ─── Tool Execution Handler ───
// Dispatches tool calls to the appropriate tool module function

async function handleToolCall(name, args) {
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
      return await itemTools.getSkillsList(p);
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
                return await mapTools.createShop(
                    p, args.mapId, args.x, args.y, args.name,
                    (args.goods || []).filter(function(g) { return g[0] === 0; }).map(function(g) { return g[1]; }),
                    (args.goods || []).filter(function(g) { return g[0] === 1; }).map(function(g) { return g[1]; }),
                    (args.goods || []).filter(function(g) { return g[0] === 2; }).map(function(g) { return g[1]; }),
                    args.characterName, args.characterIndex
                );
            case 'create_inn':
                return await mapTools.createInn(p, args.mapId, args.x, args.y, args.name, args.cost, args.characterName, args.characterIndex);
            case 'create_boss_event':
                return await mapTools.createBossEvent(p, args.mapId, args.x, args.y, args.name, args.troopId, args.characterName, args.characterIndex);
            case 'create_puzzle_switch':
                return await mapTools.createPuzzleSwitch(p, args.mapId, args.switchX, args.switchY, args.gameSwitchId, args.doorX, args.doorY, args.switchName);

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
async function analyzeTilesetImage(base64PNG) {
  const buffer = Buffer.from(base64PNG, 'base64');
  const metadata = await sharp(buffer).metadata();

  const imageWidth = metadata.width;
  const imageHeight = metadata.height;
  const tileSize = 48; // Standard MV tile size
  const cols = Math.floor(imageWidth / tileSize);
  const rows = Math.floor(imageHeight / tileSize);
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
async function readScreenshot(base64PNG) {
  const buffer = Buffer.from(base64PNG, 'base64');
  const metadata = await sharp(buffer).metadata();
  const imageWidth = metadata.width;
  const imageHeight = metadata.height;

  const halfW = Math.floor(imageWidth / 2);
  const halfH = Math.floor(imageHeight / 2);

  // Extract each quadrant and compute average RGB
  const quadrants = [
    { name: 'top-left', x: 0, y: 0, w: halfW, h: halfH },
    { name: 'top-right', x: halfW, y: 0, w: imageWidth - halfW, h: halfH },
    { name: 'bottom-left', x: 0, y: halfH, w: halfW, h: imageHeight - halfH },
    { name: 'bottom-right', x: halfW, y: halfH, w: imageWidth - halfW, h: imageHeight - halfH }
  ];

  const results = {};
  for (var i = 0; i < quadrants.length; i++) {
    var q = quadrants[i];
    // Extract quadrant, resize to 1x1 to get average color, get raw pixel data
    var pixelData = await sharp(buffer)
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

var PROXY_VISION_URL = process.env.PROXY_VISION_URL || 'http://127.0.0.1:9999';

var VISION_DEFAULT_PROMPT = [
  'Analiza esta imagen de un proyecto RPG Maker MV. Describe detalladamente:',
  '1. Tipo de contenido (tileset, sprite de personaje, battler, screenshot de mapa, face, etc.)',
  '2. Si es tileset: número de filas/columnas, categorías de tiles (terreno, agua, muros, techos, decoraciones), colores dominantes',
  '3. Si es sprite de personaje: direcciones, poses, estilo artístico, colores',
  '4. Si es screenshot de mapa: layout, tipos de terreno, eventos visibles, caminos, edificios, agua',
  '5. Si es battler: estilo, tamaño relativo, elementos visuales',
  '6. Problemas visuales potenciales (overlaps, gaps, inconsistencias de color, misaligned tiles)',
].join('\n');

async function analyzeScreenshot(projectPath, imagePath, customPrompt, resizeMax) {
      
  var fullPath = path.join(projectPath, imagePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Image not found: ' + imagePath + ' (resolved: ' + fullPath + ')');
  }

  var maxWidth = resizeMax || 1024;
  var prompt = customPrompt || VISION_DEFAULT_PROMPT;

  var imageBuffer = await sharp(fullPath)
    .resize(maxWidth, null, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  var base64Image = imageBuffer.toString('base64');
  var dataUrl = 'data:image/jpeg;base64,' + base64Image;

  var requestBody = JSON.stringify({
    model: 'meta/llama-3.2-90b-vision-instruct',
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

  return new Promise(function(resolve, reject) {
    var parsedUrl = new URL(PROXY_VISION_URL + '/v1/chat/completions');
    var options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'Authorization': 'Bearer sk-proxy'
      }
    };

    var req = http.request(options, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        try {
          var data = JSON.parse(body);
          if (data.error) {
            reject(new Error('Vision API error: ' + JSON.stringify(data.error)));
            return;
          }
          var content = '';
          if (data.choices && data.choices[0] && data.choices[0].message) {
            content = data.choices[0].message.content || '';
          }
          var usage = data.usage || {};
          resolve({
            image_path: imagePath,
            analysis: content,
            model: data.model || 'unknown',
            tokens_used: {
              prompt: usage.prompt_tokens || 0,
              completion: usage.completion_tokens || 0,
              total: usage.total_tokens || 0
            }
          });
        } catch (e) {
          reject(new Error('Failed to parse vision API response: ' + e.message + ' | body: ' + body.slice(0, 500)));
        }
      });
    });

    req.on('error', function(err) {
      reject(new Error('Vision API request failed: ' + err.message + '. Is nvidia-glm-proxy running at ' + PROXY_VISION_URL + '?'));
    });

    req.setTimeout(120000, function() {
      req.destroy(new Error('Vision API timeout (120s)'));
    });

    req.write(requestBody);
    req.end();
  });
}

async function renderMapAscii(projectPath, mapId, layer, showEvents, showRegions) {
    
  var map = await mapTools.getMap(projectPath, mapId);
  var tileLayer = layer !== undefined ? layer : 0;
  var showEv = showEvents !== false;
  var showReg = showRegions === true;

  var w = map.width;
  var h = map.height;
  var data = map.data;
  if (!data || data.length === 0) {
    return { mapId: mapId, error: 'Map has no tile data' };
  }

  var tilesetList = [];
  try {
    var tilesetContent = fs.readFileSync(path.join(projectPath, 'data', 'Tilesets.json'), 'utf-8');
    tilesetList = JSON.parse(tilesetContent.replace(/^\uFEFF/, ''));
  } catch (e) {}

  var tileset = tilesetList[map.tilesetId] || null;
  var tileCharMap = {};
  tileCharMap[0] = '.';

  if (tileset && tileset.flags) {
    for (var tid = 1; tid <= 8191; tid++) {
      if (tid >= data.length) break;
      var flag = tileset.flags[tid] || 0;
      var isWall = (flag & 0x10) !== 0;
      var isTerrain = (flag & 0x40) !== 0;
      var isLadder = (flag & 0x02) !== 0;
      var isBush = (flag & 0x04) !== 0;
      var isWater = (flag & 0x80) !== 0;
      var isDamage = (flag & 0x20) !== 0;

      if (isWater) tileCharMap[tid] = '~';
      else if (isWall) tileCharMap[tid] = '#';
      else if (isLadder) tileCharMap[tid] = 'H';
      else if (isBush) tileCharMap[tid] = '"';
      else if (isDamage) tileCharMap[tid] = 'x';
      else if (isTerrain) tileCharMap[tid] = ',';
    }
  }

  var autotileChars = 'GTFDRBSCWMLKPAEINU';
  function getTileChar(tileId) {
    if (tileId === 0) return '.';
    if (tileCharMap[tileId]) return tileCharMap[tileId];
    if (tileId < 2048) {
      var kindIdx = Math.floor(tileId / 48);
      return autotileChars[kindIdx % autotileChars.length] || 'A';
    }
    if (tileId >= 2048 && tileId < 2816) return 'A';
    if (tileId >= 2816 && tileId < 4352) return 'T';
    if (tileId >= 4352 && tileId < 5888) return 'W';
    if (tileId >= 5888) return 'D';
    return '?';
  }

  var layerSize = w * h;
  var layerOffset = tileLayer * layerSize;
  var grid = [];
  for (var y = 0; y < h; y++) {
    var row = '';
    for (var x = 0; x < w; x++) {
      var idx = layerOffset + y * w + x;
      var tileId = idx < data.length ? data[idx] : 0;
      row += getTileChar(tileId);
    }
    grid.push(row);
  }

  var eventMarkers = [];
  if (showEv && map.events) {
    for (var ei = 0; ei < map.events.length; ei++) {
      var ev = map.events[ei];
      if (!ev) continue;
      if (ev.x < w && ev.y < h) {
        var marker = ev.name ? ev.name.charAt(0).toUpperCase() : 'E';
        var rowChars = grid[ev.y].split('');
        rowChars[ev.x] = marker;
        grid[ev.y] = rowChars.join('');
        eventMarkers.push({ id: ev.id, name: ev.name, x: ev.x, y: ev.y, marker: marker });
      }
    }
  }

  var regionGrid = null;
  if (showReg && data.length >= 6 * layerSize) {
    regionGrid = [];
    var regOffset = 5 * layerSize;
    for (var y = 0; y < h; y++) {
      var row = '';
      for (var x = 0; x < w; x++) {
        var idx = regOffset + y * w + x;
        var rid = idx < data.length ? data[idx] : 0;
        row += rid === 0 ? '.' : (rid < 10 ? String(rid) : String.fromCharCode(55 + rid));
      }
      regionGrid.push(row);
    }
  }

  var legend = [
    'Legend: . = empty, ~ = water, # = wall, H = ladder,',
    '  " = bush, x = damage, , = terrain, T = tree, W = water tile,',
    '  D = decoration, A = autotile, G/F/R/B/S/C = autotile kinds',
    '  Uppercase letters on map = event markers (first char of name)'
  ];

  var result = {
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

  if (!PROJECT_PATH) {
    logger.error('RPGMAKER_PROJECT_PATH environment variable not set');
    process.exit(1);
  }

  const isValid = await validateProjectPath(PROJECT_PATH);
  if (!isValid) {
    logger.error('Invalid RPG Maker MV project path: ' + PROJECT_PATH);
    logger.error('Make sure the path contains a data/System.json file');
    process.exit(1);
  }

  projectTools.initProjectPath(PROJECT_PATH);
  logger.info('Project path: ' + PROJECT_PATH);

  const server = new Server(
    { name: 'rpgmaker-mv-mcp', version: '4.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async function() {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async function(request) {
    var toolName = request.params.name;
    var args = request.params.arguments || {};
    logger.info('Tool call: ' + toolName);

    try {
      var currentPath = projectTools.getProjectPath();
      if (!currentPath) {
        throw new Error('No project path set. Use set_project_path or set RPGMAKER_PROJECT_PATH.');
      }

      var result = await handleToolCall(toolName, args);

      logger.info('Tool call succeeded: ' + toolName);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      var errorMessage = error instanceof Error ? error.message : String(error);
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

var transport = new StdioServerTransport();
var originalSend = transport.send.bind(transport);
transport.send = function(message) {
  if (message.id !== undefined && message.id !== null && typeof message.id === 'number') {
    message = Object.assign({}, message, { id: String(message.id) });
  }
  return originalSend(message);
};
await server.connect(transport);
  logger.info('RPG Maker MV MCP server v4.0.0 running on stdio (' + TOOL_DEFINITIONS.length + ' tools)');
}

main().catch(function(error) {
  logger.error('Fatal error starting server: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
