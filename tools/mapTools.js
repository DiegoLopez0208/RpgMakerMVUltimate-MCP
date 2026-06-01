const { readdirSync } = require('fs');
const { readFile, writeFile, copyFile } = require('fs/promises');
const path = require('path');
const { readJson, writeJson, getDataPath, getMapPath, nextId } = require('../utils/fileHandler');
const { cmd } = require('../utils/commandBuilder');
const { generateTileLayout } = require('../utils/mapGenerator');
const { generateTileLayoutV2 } = require('../utils/mapGeneratorV2');
const { generateTileLayoutV3, THEMES: V3_THEMES } = require('../utils/mapGeneratorV3');
const { getTileIdsForTileset } = require('./assetTools');

/**
 * Get map info for all maps in the project.
 * Reads MapInfos.json which contains the map tree structure
 * with names, order, and parent IDs.
 */
async function getMapInfos(projectPath) {
  return await readJson(projectPath, 'MapInfos.json');
}

/**
 * Get a single map by ID.
 * Reads the Map{NNN}.json file for the given map ID.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID (e.g. 1 for Map001.json)
 */
async function getMap(projectPath, mapId) {
  var numMapId = toNum(mapId, 'mapId');
  const mapPath = getMapPath(projectPath, numMapId);
  return await readJsonDirect(mapPath);
}

/**
 * Get all events from a specific map.
 * Returns the events array from the map data (includes null at index 0).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 */
async function getMapEvents(projectPath, mapId) {
  const map = await getMap(projectPath, mapId);
  return map.events || [];
}

/**
 * Get a specific event from a map by event ID.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} eventId - The event ID
 */
async function getMapEvent(projectPath, mapId, eventId) {
  var numMapId = toNum(mapId, 'mapId');
  var numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId);
  if (map.events && numEventId >= 0 && numEventId < map.events.length) {
    return map.events[numEventId];
  }
  return null;
}

/**
 * Find the next available map ID by scanning existing map files.
 * Map files are named Map001.json, Map002.json, etc.
 */
async function getNextMapId(projectPath) {
  const dataDir = getDataPath(projectPath, '');
  const files = readdirSync(dataDir);
  const mapIds = files
    .filter(function(f) { return /^Map(\d{3})\.json$/.test(f) && f !== 'MapInfos.json'; })
    .map(function(f) { return parseInt(f.match(/^Map(\d{3})\.json$/)[1], 10); });
  if (mapIds.length === 0) return 1;
  return Math.max.apply(null, mapIds) + 1;
}

/**
 * Create a new map with the specified dimensions and properties.
 * Also registers the map in MapInfos.json and generates a tile layout
 * if a theme is provided.
 * @param {string} projectPath - The project root path
 * @param {object} params - Map creation parameters
 */
async function createMap(projectPath, params) {
    const width = params.width || 17;
    const height = params.height || 13;
    const tilesetId = params.tilesetId || 1;
    const displayName = params.displayName || '';
    const bgmName = params.bgmName || '';
    const note = params.note || '';
    const name = params.name || '';
    const theme = params.theme || '';

    const mapId = await getNextMapId(projectPath);

    var tileResult;
    if (theme) {
        try {
            var tilesetConfig = await getTileIdsForTileset(projectPath, tilesetId);
            var hasTiles = tilesetConfig && tilesetConfig.availableTiles && (
                (tilesetConfig.availableTiles.ground && tilesetConfig.availableTiles.ground.length > 0) ||
                (tilesetConfig.availableTiles.water && tilesetConfig.availableTiles.water.length > 0) ||
                (tilesetConfig.availableTiles.decoration && tilesetConfig.availableTiles.decoration.length > 0)
            );
            if (hasTiles) {
                tileResult = generateTileLayoutV2(width, height, theme, tilesetConfig);
            } else {
                tileResult = generateTileLayout(width, height, theme);
            }
        } catch (_) {
            tileResult = generateTileLayout(width, height, theme);
        }
    } else {
        tileResult = { data: new Array(width * height * 6).fill(0) };
    }

    var map = {
        autoplayBgm: bgmName ? true : false,
        autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: bgmName, pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false,
        displayName: displayName,
        encounterList: [], encounterStep: 30,
        height: height, width: width,
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: tilesetId,
        data: tileResult.data,
        events: [null]
    };

    if (note) map.note = note;

    const mapPath = getMapPath(projectPath, mapId);
    await writeJsonDirect(mapPath, map);

    const mapInfos = await readJson(projectPath, 'MapInfos.json');
    while (mapInfos.length <= mapId) mapInfos.push(null);

    const maxOrder = mapInfos.reduce(function(max, info) {
        return info && info.order && info.order > max ? info.order : max;
    }, 0);

    mapInfos[mapId] = {
        id: mapId, expanded: false,
        name: name || 'MAP' + String(mapId).padStart(3, '0'),
        order: maxOrder + 1, parentId: 0,
        scrollX: Math.floor(width * 32 * 0.8),
        scrollY: Math.floor(height * 32 * 0.8)
    };

    await writeJson(projectPath, 'MapInfos.json', mapInfos);
    return { mapId: mapId, map: map };
}

async function createMapV3(projectPath, params) {
    const width = params.width || 30;
    const height = params.height || 25;
    const tilesetId = params.tilesetId || 1;
    const displayName = params.displayName || '';
    const bgmName = params.bgmName || '';
    const note = params.note || '';
    const name = params.name || '';
    const theme = params.theme || 'forest';
    const seed = params.seed;

    var v3opts = {
        seed: seed,
        addEvents: params.addEvents !== false,
        transferPoints: params.transferPoints || []
    };

    var tileResult = generateTileLayoutV3(width, height, theme, v3opts);

    var map = {
        autoplayBgm: bgmName ? true : false,
        autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: bgmName, pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false,
        displayName: displayName,
        encounterList: [], encounterStep: 30,
        height: height, width: width,
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: tilesetId,
        data: tileResult.data,
        events: tileResult.events
    };

    if (note) map.note = note;

    const mapId = await getNextMapId(projectPath);
    const mapPath = getMapPath(projectPath, mapId);
    await writeJsonDirect(mapPath, map);

    const mapInfos = await readJson(projectPath, 'MapInfos.json');
    while (mapInfos.length <= mapId) mapInfos.push(null);

    const maxOrder = mapInfos.reduce(function(max, info) {
        return info && info.order && info.order > max ? info.order : max;
    }, 0);

    mapInfos[mapId] = {
        id: mapId, expanded: false,
        name: name || 'MAP' + String(mapId).padStart(3, '0'),
        order: maxOrder + 1, parentId: params.parentId || 0,
        scrollX: Math.floor(width * 32 * 0.8),
        scrollY: Math.floor(height * 32 * 0.8)
    };

    await writeJson(projectPath, 'MapInfos.json', mapInfos);
    return { mapId: mapId, seed: tileResult.seed, theme: theme };
}

async function createMapBatch(projectPath, batchSpec) {
    var results = [];
    var mapIds = {};
    for (var i = 0; i < batchSpec.length; i++) {
        var spec = batchSpec[i];
        var params = {
            width: spec.width || 30,
            height: spec.height || 25,
            tilesetId: spec.tilesetId || 2,
            displayName: spec.displayName || spec.name || '',
            name: spec.name || '',
            theme: spec.theme || 'forest',
            seed: spec.seed,
            addEvents: spec.addEvents !== false,
            parentId: spec.parentId || 0,
            note: spec.note || ''
        };
        var result = await createMapV3(projectPath, params);
        mapIds[spec.key || spec.name] = result.mapId;
        results.push({ key: spec.key || spec.name, mapId: result.mapId, seed: result.seed, theme: result.theme });
    }
    return { maps: results, mapIds: mapIds };
}

async function connectMaps(projectPath, mapIdA, mapIdB, posA, posB) {
  var numMapIdA = toNum(mapIdA, 'mapIdA');
  var numMapIdB = toNum(mapIdB, 'mapIdB');
  var mapA = await getMap(projectPath, numMapIdA);
  var mapB = await getMap(projectPath, numMapIdB);
  var newIdA = nextId(mapA.events);
  var evA = makeTransferEvent(newIdA, posA.x, posA.y, numMapIdB, posB.x, posB.y, posA.trigger || 1);
  while (mapA.events.length <= newIdA) mapA.events.push(null);
  mapA.events[newIdA] = evA;
  await writeJsonDirect(getMapPath(projectPath, numMapIdA), mapA);

  var newIdB = nextId(mapB.events);
  var evB = makeTransferEvent(newIdB, posB.x, posB.y, numMapIdA, posA.x, posA.y, posB.trigger || 1);
  while (mapB.events.length <= newIdB) mapB.events.push(null);
  mapB.events[newIdB] = evB;
  await writeJsonDirect(getMapPath(projectPath, numMapIdB), mapB);

  return { eventA: evA, eventB: evB };
}

async function populateMapEvents(projectPath, mapId, eventType, count, opts) {
  var numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId);
  opts = opts || {};
  var numCount = toNum(count || 3, 'count');
  var added = [];
  for (var i = 0; i < numCount; i++) {
        var x = opts.x || Math.floor(Math.random() * (map.width - 4)) + 2;
        var y = opts.y || Math.floor(Math.random() * (map.height - 4)) + 2;
        var newId = nextId(map.events);
        var ev;
        if (eventType === 'npc') ev = makeNpcEvent(newId, x, y, opts.name || 'NPC');
        else if (eventType === 'chest') ev = makeChestEvent(newId, x, y);
        else if (eventType === 'boss') ev = makeBossEvent(newId, x, y, opts.troopId || 1);
        else ev = makeNpcEvent(newId, x, y, eventType || 'Event');
        while (map.events.length <= newId) map.events.push(null);
        map.events[newId] = ev;
        added.push(ev);
    }
  await writeJsonDirect(getMapPath(projectPath, numMapId), map);
  return { added: added, mapId: numMapId };
}

async function setMapDisplayNames(projectPath, nameMap) {
  const mapInfos = await readJson(projectPath, 'MapInfos.json');
  var updated = [];
  for (var i = 0; i < nameMap.length; i++) {
    var entry = nameMap[i];
    var id = toNum(entry.mapId, 'mapId in names[' + i + ']');
    if (id < mapInfos.length && mapInfos[id]) {
      mapInfos[id].name = entry.name;
      updated.push({ mapId: id, name: entry.name });
    }
  }
  await writeJson(projectPath, 'MapInfos.json', mapInfos);
  return { updated: updated };
}

async function organizeMapTree(projectPath, folderMap) {
  const mapInfos = await readJson(projectPath, 'MapInfos.json');
  var updated = [];
  for (var i = 0; i < folderMap.length; i++) {
    var entry = folderMap[i];
    var id = toNum(entry.mapId, 'mapId in folders[' + i + ']');
    var pid = toNum(entry.parentId || 0, 'parentId in folders[' + i + ']');
    if (id < mapInfos.length && mapInfos[id]) {
      mapInfos[id].parentId = pid;
      updated.push({ mapId: id, parentId: pid });
    }
  }
  await writeJson(projectPath, 'MapInfos.json', mapInfos);
  return { updated: updated };
}

/**
 * Fill an entire layer of a map with tile data.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} layer - Layer index (0-5)
 * @param {number} tileId - Tile ID to fill the layer with
 */
async function fillMapLayer(projectPath, mapId, layer, tileId) {
  var numMapId = toNum(mapId, 'mapId');
  var numLayer = toNum(layer, 'layer');
  var numTileId = toNum(tileId, 'tileId');
  const map = await getMap(projectPath, numMapId);

  if (numLayer < 0 || numLayer > 5) {
    throw new Error('Layer must be between 0 and 5');
  }

  for (var y = 0; y < map.height; y++) {
    for (var x = 0; x < map.width; x++) {
      var index = (numLayer * map.height + y) * map.width + x;
      map.data[index] = numTileId;
    }
  }

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return { mapId: numMapId, layer: numLayer, tileId: numTileId, filled: map.width * map.height };
}

/**
 * Create a new event on a map.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} x - X position on the map
 * @param {number} y - Y position on the map
 * @param {string} name - Event name
 * @param {number} trigger - Trigger type: 0=action button, 1=player touch,
 *                           2=event touch, 3=autorun, 4=parallel
 * @param {Array} pages - Array of event page objects (optional, creates default page if omitted)
 */
async function createMapEvent(projectPath, mapId, x, y, name, trigger, pages) {
  var numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId);

  const newId = nextId(map.events);
  var triggerVal = toNum(trigger !== undefined ? trigger : 0, 'trigger');

  if (pages && pages.length > 0) {
    // Apply trigger to pages that don't have one set
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].trigger === undefined) pages[i].trigger = triggerVal;
      if (!pages[i].list || pages[i].list.length === 0) {
        pages[i].list = [{ code: 0, indent: 0, parameters: [] }];
      }
      // Ensure terminator
      var last = pages[i].list[pages[i].list.length - 1];
      if (!last || last.code !== 0) {
        pages[i].list.push({ code: 0, indent: 0, parameters: [] });
      }
      // Fill missing conditions
      if (!pages[i].conditions) pages[i].conditions = createDefaultConditions();
      if (!pages[i].image) pages[i].image = { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 };
    }
  } else {
    pages = [createDefaultEventPage(triggerVal)];
  }

  var event = {
    id: newId,
    name: name || 'EV' + newId,
    note: '',
    x: x,
    y: y,
    pages: pages
  };

  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

/**
 * Update an existing map event's properties (partial update).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} eventId - The event ID to update
 * @param {object} fields - Fields to update
 */
async function updateMapEvent(projectPath, mapId, eventId, fields) {
  var numMapId = toNum(mapId, 'mapId');
  var numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId);

  if (!map.events[numEventId]) {
    throw new Error('Event ' + numEventId + ' not found on map ' + numMapId + '. Available: ' + map.events.map(function(e, i) { return e ? i + ':' + e.name : null; }).filter(Boolean).join(', '));
  }

  map.events[numEventId] = Object.assign({}, map.events[numEventId], fields);

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return map.events[numEventId];
}

/**
 * Add an event command to a specific page of an event.
 * Commands are inserted before the last command (code 0 terminator).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} eventId - The event ID
 * @param {number} pageIndex - Page index (0-based)
 * @param {object} command - The event command {code, indent, parameters}
 */
async function addEventCommand(projectPath, mapId, eventId, pageIndex, command) {
  var numMapId = toNum(mapId, 'mapId');
  var numEventId = toNum(eventId, 'eventId');
  var numPageIndex = toNum(pageIndex !== undefined ? pageIndex : 0, 'pageIndex');
  const map = await getMap(projectPath, numMapId);

  if (!map.events[numEventId]) {
    throw new Error('Event ' + numEventId + ' not found on map ' + numMapId + '. Available: ' + map.events.map(function(e, i) { return e ? i + ':' + e.name : null; }).filter(Boolean).join(', '));
  }

  var event = map.events[numEventId];
  if (!event.pages[numPageIndex]) {
    throw new Error('Page ' + numPageIndex + ' not found on event ' + numEventId + ' (has ' + event.pages.length + ' pages)');
  }

  var commandList = event.pages[numPageIndex].list;

  // Insert before the last command (code 0 = End of Event Processing)
  commandList.splice(commandList.length - 1, 0, command);

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return { eventId: numEventId, pageIndex: numPageIndex, command: command, totalCommands: commandList.length };
}

/**
 * HIGH LEVEL HELPER: Create an NPC with dialogue.
 * Produces a complete 2-page event:
 *   Page 1: Action button trigger, character sprite, dialogue lines triggered by interaction
 *   Page 2: Self-switch A condition (optional continuation)
 *
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {string} name - NPC name
 * @param {string[]} dialogues - Array of dialogue strings (each becomes a message command)
 * @param {string} characterName - Character sprite filename
 * @param {number} characterIndex - Character sprite index (0-7)
 */
async function createNpc(projectPath, mapId, x, y, name, dialogues, characterName, characterIndex) {
  var numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);

  characterName = characterName || '';
  characterIndex = characterIndex || 0;

  // Build command list for Page 1: dialogue triggered by Action Button
  var page1List = [];
  var dialogueLines = dialogues && dialogues.length > 0 ? dialogues : ['...'];
  for (var d = 0; d < dialogueLines.length; d++) {
    var msgCommands = cmd.message(dialogueLines[d], '', 0);
    // Remove the trailing code 0 terminator from each message block
    // (we add one at the very end of the page)
    for (var i = 0; i < msgCommands.length; i++) {
      if (msgCommands[i].code === 0 && i === msgCommands.length - 1) continue;
      page1List.push(msgCommands[i]);
    }
    }
    page1List.push({ code: 123, indent: 0, parameters: ['A', 1] });
    // Add the page terminator (code 0 = End of Event Processing)
    page1List.push({ code: 0, indent: 0, parameters: [] });

  // Page 1: Action button trigger, NPC sprite, dialogue
  var page1 = {
    conditions: createDefaultConditions(),
    directionFix: false,
    image: {
      characterIndex: characterIndex,
      characterName: characterName,
      direction: 2,   // Facing down
      pattern: 1,     // Center pattern
      tileId: 0
    },
    list: page1List,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 1,       // Random walk
    priorityType: 1,   // Same as characters
    stepAnime: false,
    through: false,
    trigger: 0,        // Action button
    walkAnime: true
  };

  // Page 2: Self-switch A is ON condition (optional "talked already" state)
  var page2 = {
    conditions: Object.assign({}, createDefaultConditions(), {
      selfSwitchCh: 'A',
      selfSwitchValid: true
    }),
    directionFix: false,
    image: {
      characterIndex: characterIndex,
      characterName: characterName,
      direction: 2,
      pattern: 1,
      tileId: 0
    },
    list: [
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['We already talked!'] },
      { code: 0, indent: 0, parameters: [] }
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 1,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true
  };

  var event = {
    id: newId,
    name: name || 'NPC',
    note: '',
    x: x,
    y: y,
    pages: [page1, page2]
  };

  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

/**
 * HIGH LEVEL HELPER: Create a chest event.
 * Produces a 2-page event:
 *   Page 1: Action button trigger, gives items + activates Self Switch A
 *   Page 2: Self Switch A = ON, shows "already opened" message
 *
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {Array} items - Array of {type: "item"|"weapon"|"armor", id: number, amount: number}
 * @param {string} characterName - Chest sprite filename
 * @param {number} characterIndex - Chest sprite index
 */
async function createChest(projectPath, mapId, x, y, items, characterName, characterIndex) {
  var numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);

  characterName = characterName || 'Chest';
  characterIndex = characterIndex || 0;

  // Build Page 1 command list: open chest, give items, activate Self Switch A
  var page1List = [];

  // Give each item/weapon/armor
  var itemEntries = items || [];
  for (var idx = 0; idx < itemEntries.length; idx++) {
    var item = itemEntries[idx];
    var amount = item.amount || 1;
    if (item.type === 'item') {
      page1List.push.apply(page1List, cmd.giveItem(item.id, amount));
    } else if (item.type === 'weapon') {
      page1List.push.apply(page1List, cmd.giveWeapon(item.id, amount));
    } else if (item.type === 'armor') {
      page1List.push.apply(page1List, cmd.giveArmor(item.id, amount));
    }
  }

  // Activate Self Switch A = ON (so the chest stays open)
  page1List.push.apply(page1List, cmd.selfSwitchControl('A', true));

  // Show "found items" message
  var msgCmds = cmd.message('Found items inside the chest!', '', 0);
  for (var i = 0; i < msgCmds.length; i++) {
    // Skip the code 0 terminator from the message helper — we add our own
    if (msgCmds[i].code === 0 && i === msgCmds.length - 1) continue;
    page1List.push(msgCmds[i]);
  }

  // Add page terminator
  page1List.push({ code: 0, indent: 0, parameters: [] });

  // Page 1: Action button, chest closed sprite
  var page1 = {
    conditions: createDefaultConditions(),
    directionFix: true,
    image: {
      characterIndex: characterIndex,
      characterName: characterName,
      direction: 2,    // Closed chest direction
      pattern: 0,      // First pattern = closed
      tileId: 0
    },
    list: page1List,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 0,       // Fixed (chests don't move)
    priorityType: 1,   // Same as characters
    stepAnime: false,
    through: false,
    trigger: 0,        // Action button
    walkAnime: false
  };

  // Page 2: Self Switch A = ON, show "already opened" message
  var page2 = {
    conditions: Object.assign({}, createDefaultConditions(), {
      selfSwitchCh: 'A',
      selfSwitchValid: true
    }),
    directionFix: true,
    image: {
      characterIndex: characterIndex,
      characterName: characterName,
      direction: 2,    // Open chest direction
      pattern: 1,      // Second pattern = open
      tileId: 0
    },
    list: [
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['The chest is already open.'] },
      { code: 0, indent: 0, parameters: [] }
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 0,        // Action button
    walkAnime: false
  };

  var event = {
    id: newId,
    name: 'Chest',
    note: '',
    x: x,
    y: y,
    pages: [page1, page2]
  };

  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

/**
 * HIGH LEVEL HELPER: Create a teleport event.
 * Creates a single-page event that transfers the player to another map.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The current map ID
 * @param {number} x - X position on current map
 * @param {number} y - Y position on current map
 * @param {number} destMapId - Destination map ID
 * @param {number} destX - Destination X coordinate
 * @param {number} destY - Destination Y coordinate
 * @param {number} trigger - Trigger type (1=player touch for walk-on teleports, 0=action button for doors)
 */
async function createTeleportEvent(projectPath, mapId, x, y, destMapId, destX, destY, trigger) {
  var numMapId = toNum(mapId, 'mapId');
  var numDestMapId = toNum(destMapId, 'destMapId');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);

  var teleportCmds = cmd.teleport(numDestMapId, destX, destY, 0, 0);
  var pageList = teleportCmds.slice();
  pageList.push({ code: 0, indent: 0, parameters: [] });

  var eventTrigger = trigger !== undefined ? toNum(trigger, 'trigger') : 1;

  var page = {
    conditions: createDefaultConditions(),
    directionFix: false,
    image: {
      characterIndex: 0,
      characterName: '',   // Invisible by default (use a sprite if it's a door/portal)
      direction: 2,
      pattern: 1,
      tileId: 0
    },
    list: pageList,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 0,       // Fixed
    priorityType: 0,   // Below characters (walk-on teleport)
    stepAnime: false,
    through: true,      // Walk through (for teleport zones)
    trigger: eventTrigger,
    walkAnime: false
  };

  var event = {
    id: newId,
    name: 'Teleport to Map' + numDestMapId,
    note: '',
    x: x,
    y: y,
    pages: [page]
  };

  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

/**
 * Search map events by name (case-insensitive).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {string} query - Search term
 */
async function searchMapEvents(projectPath, mapId, query) {
  const events = await getMapEvents(projectPath, mapId);
  const lowerQuery = query.toLowerCase();
  return events.filter(function(e) {
    return e !== null && e.name.toLowerCase().includes(lowerQuery);
  });
}

// ─── Safe ID Casting Helper ───

function toNum(val, name) {
  if (val === undefined || val === null) return undefined;
  var n = typeof val === 'number' ? val : parseInt(val, 10);
  if (isNaN(n)) throw new Error('Invalid ' + name + ': ' + JSON.stringify(val) + ' - expected number or numeric string');
  return n;
}

// ─── Internal Helper Functions ───

/**
 * Create a default event conditions object.
 * All conditions are disabled by default.
 */
function createDefaultConditions() {
  return {
    actorId: 1,
    actorValid: false,
    itemId: 1,
    itemValid: false,
    selfSwitchCh: 'A',
    selfSwitchValid: false,
    switch1Id: 1,
    switch1Valid: false,
    switch2Id: 1,
    switch2Valid: false,
    variableId: 1,
    variableValid: false,
    variableValue: 0
  };
}

/**
 * Create a default blank event page.
 * @param {number} trigger - Trigger type
 */
function createDefaultEventPage(trigger) {
  return {
    conditions: createDefaultConditions(),
    directionFix: false,
    image: {
      characterIndex: 0,
      characterName: '',
      direction: 2,
      pattern: 1,
      tileId: 0
    },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: trigger,
    walkAnime: true
  };
}

/**
 * Read JSON from an absolute path (used for map files which use getMapPath).
 * Unlike readJson which takes a projectPath + filename, this takes the full path.
 */
async function readJsonDirect(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
}

/**
 * Write JSON to an absolute path with backup support.
 * Creates a .bak file before writing.
 */
async function writeJsonDirect(filePath, data) {
  var backupPath = filePath + '.bak';

  try {
    await copyFile(filePath, backupPath);
  } catch (_) {
    // If backup fails (file doesn't exist yet), continue
  }

  var jsonString = JSON.stringify(data, null, 2);
  await writeFile(filePath, jsonString, 'utf-8');
}

async function deleteMapEvent(projectPath, mapId, eventId) {
  var numMapId = toNum(mapId, 'mapId');
  var numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId);
  if (!map.events[numEventId]) throw new Error('Event ' + numEventId + ' not found on map ' + numMapId);
  var deleted = map.events[numEventId];
  map.events[numEventId] = null;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return { deleted: deleted };
}

async function duplicateMap(projectPath, sourceMapId, params) {
  var numSourceMapId = toNum(sourceMapId, 'sourceMapId');
  const sourceMap = await getMap(projectPath, numSourceMapId);
  const newMapId = await getNextMapId(projectPath);
  var newMap = JSON.parse(JSON.stringify(sourceMap));
  if (params && params.width) newMap.width = params.width;
  if (params && params.height) newMap.height = params.height;
  if (params && params.displayName) newMap.displayName = params.displayName;
  if (params && params.tilesetId) newMap.tilesetId = params.tilesetId;
  const mapPath = getMapPath(projectPath, newMapId);
  await writeJsonDirect(mapPath, newMap);
  const mapInfos = await readJson(projectPath, 'MapInfos.json');
  while (mapInfos.length <= newMapId) mapInfos.push(null);
  const maxOrder = mapInfos.reduce(function(max, info) {
    return info && info.order && info.order > max ? info.order : max;
  }, 0);
  var name = (params && params.name) || ('Copy of Map' + numSourceMapId);
  mapInfos[newMapId] = {
    id: newMapId, expanded: false, name: name,
    order: maxOrder + 1, parentId: 0,
    scrollX: Math.floor(newMap.width * 32 * 0.8),
    scrollY: Math.floor(newMap.height * 32 * 0.8)
  };
  await writeJson(projectPath, 'MapInfos.json', mapInfos);
  return { mapId: newMapId, map: newMap };
}

async function createShop(projectPath, mapId, x, y, name, itemIds, weaponIds, armorIds, characterName, characterIndex) {
  var numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  var itemList = (itemIds || []).map(function(id) { return [0, id, 0, 0]; });
  var weaponList = (weaponIds || []).map(function(id) { return [1, id, 0, 0]; });
  var armorList = (armorIds || []).map(function(id) { return [2, id, 0, 0]; });
  var goods = itemList.concat(weaponList).concat(armorList);
    if (goods.length === 0) goods = [[0, 1, 0, 0]];
    var pageList = [
        { code: 302, indent: 0, parameters: [0, 1] },
    ];
    for (var i = 0; i < goods.length; i++) {
        pageList.push({ code: 605, indent: 0, parameters: goods[i] });
    }
    pageList.push({ code: 0, indent: 0, parameters: [] });
  var page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: pageList, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var event = { id: newId, name: name || 'Shop', note: '', x: x, y: y, pages: [page1] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

async function createInn(projectPath, mapId, x, y, name, cost, characterName, characterIndex) {
  var numMapId = toNum(mapId, 'mapId');
  var numCost = toNum(cost || 50, 'cost');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  cost = cost || 50;
  var page1List = [
  { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
  { code: 401, indent: 0, parameters: ['Rest here for ' + numCost + ' gold?'] },
  { code: 102, indent: 0, parameters: [['Yes', 'No'], 1] },
  { code: 402, indent: 0, parameters: [0, 'Yes'] },
  { code: 111, indent: 1, parameters: [11, '$gameParty.gold() >= ' + numCost] },
  { code: 125, indent: 2, parameters: [1, 0, numCost] },
    { code: 314, indent: 2, parameters: [0, 0] },
    { code: 101, indent: 2, parameters: ['', 0, 0, 2] },
    { code: 401, indent: 2, parameters: ['You feel refreshed!'] },
    { code: 0, indent: 2, parameters: [] },
    { code: 411, indent: 1, parameters: [] },
    { code: 101, indent: 2, parameters: ['', 0, 0, 2] },
    { code: 401, indent: 2, parameters: ['Not enough gold...'] },
    { code: 0, indent: 2, parameters: [] },
    { code: 412, indent: 1, parameters: [] },
    { code: 402, indent: 0, parameters: [1, 'No'] },
    { code: 0, indent: 0, parameters: [] },
    { code: 404, indent: 0, parameters: [] },
    { code: 0, indent: 0, parameters: [] }
  ];
  var page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: page1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var event = { id: newId, name: name || 'Inn', note: '', x: x, y: y, pages: [page1] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

async function createBossEvent(projectPath, mapId, x, y, name, troopId, characterName, characterIndex) {
  var numMapId = toNum(mapId, 'mapId');
  var numTroopId = toNum(troopId, 'troopId');
  const map = await getMap(projectPath, numMapId);
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  var page1List = [
  { code: 301, indent: 0, parameters: [0, numTroopId, 0, 1] },
        { code: 601, indent: 0, parameters: [] },
        { code: 123, indent: 1, parameters: ['A', 1] },
        { code: 0, indent: 1, parameters: [] },
        { code: 602, indent: 0, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 603, indent: 0, parameters: [] },
        { code: 353, indent: 1, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
    ];
  var page2 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: true, trigger: 0, walkAnime: false
  };
  var page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: page1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var event = { id: newId, name: name || 'Boss', note: '', x: x, y: y, pages: [page1, page2] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return event;
}

async function createPuzzleSwitch(projectPath, mapId, x, y, switchId, doorX, doorY, switchCharacterName) {
  var numMapId = toNum(mapId, 'mapId');
  var numSwitchId = toNum(switchId, 'switchId');
  const map = await getMap(projectPath, numMapId);
  const switchId2 = nextId(map.events);
  var switchPage1List = [
  { code: 121, indent: 0, parameters: [numSwitchId, numSwitchId, 0] },
    { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
    { code: 401, indent: 0, parameters: ['Switch activated!'] },
    { code: 123, indent: 0, parameters: ['A', 0] },
    { code: 0, indent: 0, parameters: [] }
  ];
  var switchPage1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: 0, characterName: switchCharacterName || '', direction: 2, pattern: 0, tileId: 0 },
    list: switchPage1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var switchPage2 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: switchCharacterName || '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var switchEvent = { id: switchId2, name: 'Switch', note: '', x: x, y: y, pages: [switchPage1, switchPage2] };
  while (map.events.length <= switchId2) map.events.push(null);
  map.events[switchId2] = switchEvent;
  var doorId = nextId(map.events);
  var doorPage1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['The door is locked. Find the switch!'] },
      { code: 0, indent: 0, parameters: [] }
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var doorPage2 = {
    conditions: Object.assign({}, createDefaultConditions(), { switch1Id: numSwitchId, switch1Valid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
        list: [
        { code: 205, indent: 0, parameters: [-1, { list: [{ code: 44, parameters: [] }, { code: 0, parameters: [] }], repeat: false, skippable: true, wait: true }] },
        { code: 505, indent: 0, parameters: [{ code: 44, parameters: [] }] },
        { code: 123, indent: 0, parameters: ['A', 1] },
        { code: 0, indent: 0, parameters: [] }
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  var doorPage3 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: 0, walkAnime: false
  };
  var doorEvent = { id: doorId, name: 'Door', note: '', x: doorX, y: doorY, pages: [doorPage1, doorPage2, doorPage3] };
  while (map.events.length <= doorId) map.events.push(null);
  map.events[doorId] = doorEvent;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeJsonDirect(mapPath, map);
  return { switchEvent: switchEvent, doorEvent: doorEvent };
}

module.exports = {
    getMapInfos, getMap, getMapEvents, getMapEvent, getNextMapId,
    createMap, createMapV3, createMapBatch, connectMaps, populateMapEvents,
    fillMapLayer, createMapEvent, updateMapEvent, addEventCommand,
    createNpc, createChest, createTeleportEvent, searchMapEvents,
    deleteMapEvent, duplicateMap, createShop, createInn, createBossEvent, createPuzzleSwitch,
    setMapDisplayNames, organizeMapTree
};
