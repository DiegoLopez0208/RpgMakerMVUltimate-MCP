import { readdirSync } from 'fs';
import { readFile, writeFile, copyFile } from 'fs/promises';
import { readJson, writeJson, getDataPath, getMapPath, nextId } from '../utils/fileHandler.js';
import { cmd } from '../utils/commandBuilder.js';
import type { MapEvent, EventCommand, EventPage, CreateMapParams, CreateMapV3Params, RpgMakerMap } from '../types/rpgmaker.js';


import { generateTileLayoutV3, generateFromTemplate, THEMES as V3_THEMES, THEME_TILESET, makeNpcEvent, makeChestEvent, makeBossEvent, makeTransferEvent, makeDoorEvent } from '../utils/mapGenerator.js';
import { getTileIdsForTileset } from './assetTools.js';

/**
 * Get map info for all maps in the project.
 * Reads MapInfos.json which contains the map tree structure
 * with names, order, and parent IDs.
 */
async function getMapInfos(projectPath: string) {
  return await readJson(projectPath, 'MapInfos.json');
}

/**
 * Get a single map by ID.
 * Reads the Map{NNN}.json file for the given map ID.
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID (e.g. 1 for Map001.json)
 */
async function getMap(projectPath: string, mapId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const mapPath = getMapPath(projectPath, numMapId);
  return await readJsonDirect(mapPath);
}

/**
 * Get all events from a specific map.
 * Returns the events array from the map data (includes null at index 0).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 */
async function getMapEvents(projectPath: string, mapId: number) {
  const map = await getMap(projectPath, mapId);
  return (map as RpgMakerMap).events || [];
}

async function getMapEvent(projectPath: string, mapId: number, eventId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  if (map.events && numEventId! >= 0 && numEventId! < map.events.length) {
    return map.events[numEventId!];
  }
  return null;
}

async function getNextMapId(projectPath: string) {
  const dataDir = getDataPath(projectPath, '');
  const files = readdirSync(dataDir);
  const mapIds = files
    .filter(function(f) { return /^Map(\d{3})\.json$/.test(f) && f !== 'MapInfos.json'; })
    .map(function(f: string) { const m = f.match(/^Map(\d{3})\.json$/); return parseInt(m![1], 10); });
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
async function createMap(projectPath: string, params: CreateMapParams | CreateMapV3Params) {
    const width = params.width || 17;
    const height = params.height || 13;
    const displayName = params.displayName || '';
    const bgmName = params.bgmName || '';
    const note = params.note || '';
    const name = params.name || '';
    const theme = params.theme || '';
    const tilesetId = params.tilesetId || THEME_TILESET[theme] || 1;

    const mapId = await getNextMapId(projectPath);

    let tileResult;
    if (theme) {
        try {
            const tilesetConfig = await getTileIdsForTileset(projectPath, tilesetId);
            const hasTiles = tilesetConfig && tilesetConfig.availableTiles && (
                (tilesetConfig.availableTiles.ground && tilesetConfig.availableTiles.ground.length > 0) ||
                (tilesetConfig.availableTiles.water && tilesetConfig.availableTiles.water.length > 0) ||
                (tilesetConfig.availableTiles.decoration && tilesetConfig.availableTiles.decoration.length > 0)
            );
            if (hasTiles) {
                tileResult = await generateTileLayoutV3(width, height, theme, tilesetConfig);
            } else {
                tileResult = await generateTileLayoutV3(width, height, theme);
            }
        } catch (_) {
            tileResult = await generateTileLayoutV3(width, height, theme);
        }
    } else {
        tileResult = { data: new Array(width * height * 6).fill(0) };
    }

    const map: RpgMakerMap = {
        autoplayBgm: bgmName ? true : false,
        autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: bgmName, pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false,
        displayName: displayName,
        encounterList: [], encounterStep: 30,
        height: height, width: width,
        note: note,
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: tilesetId,
        data: tileResult.data,
        events: [null]
    };

    const mapPath = getMapPath(projectPath, mapId);
    await writeMapJson(projectPath, mapPath, map);

    const mapInfos = await readJson(projectPath, 'MapInfos.json') as unknown[];
    while (mapInfos.length <= mapId) mapInfos.push(null);

    const maxOrder = (mapInfos as unknown[]).reduce(function(max: number, info: unknown) {
        return info && (info as Record<string, number>).order && (info as Record<string, number>).order > max ? (info as Record<string, number>).order : max;
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

async function createMapV3(projectPath: string, params: CreateMapV3Params) {
    const width = params.width || 30;
    const height = params.height || 25;
    const displayName = params.displayName || '';
    const bgmName = params.bgmName || '';
    const note = params.note || '';
    const name = params.name || '';
    const theme = params.theme || 'forest';
    const seed = params.seed;
    // Pick the tileset whose tiles this theme emits (Outside/Inside/Dungeon/
    // Overworld) unless the caller forces one — otherwise e.g. a town's Outside
    // tiles land on the Overworld tileset and render as garbage.
    const tilesetId = params.tilesetId || THEME_TILESET[theme] || 1;

    const v3opts: Record<string, unknown> = {
        seed: seed,
        addEvents: params.addEvents !== false,
        transferPoints: params.transferPoints || [],
        tilesetId: tilesetId,
        templateId: (params as Record<string, unknown>).templateId,
        useTemplate: (params as Record<string, unknown>).useTemplate
    };

    // Scan the project's real tileset tiles (same path createMap uses) and pass
    // them in, so the procedural generator can fall back to real object tiles on
    // projects whose tilesets differ from the hardcoded RTP table. Without this,
    // a custom tileset's decoration fallback emitted single A5 fragments.
    try {
        const tsCfg = await getTileIdsForTileset(projectPath, tilesetId);
        if (tsCfg && tsCfg.availableTiles) v3opts.availableTiles = tsCfg.availableTiles;
    } catch (_) { /* scan optional — generator falls back to its built-in table */ }

    const tileResult = await generateTileLayoutV3(width, height, theme, v3opts);

    const map: RpgMakerMap = {
        autoplayBgm: bgmName ? true : false,
        autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: bgmName, pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false,
        displayName: displayName,
        encounterList: [], encounterStep: 30,
        height: height, width: width,
        note: note,
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: tilesetId,
        data: tileResult.data,
        events: tileResult.events
    };

    const mapId = await getNextMapId(projectPath);

    // Auto-wire random encounters for combat themes from the project's troops,
    // so a generated dungeon/cave actually has enemies. Opt out: encounters:false.
    if ((params as Record<string, unknown>).encounters !== false && COMBAT_THEMES.indexOf(theme) >= 0) {
        const enc = await autoEncounterList(projectPath);
        if (enc.length > 0) {
            map.encounterList = enc;
            map.encounterStep = theme === 'world' ? 40 : 30;
        }
    }

    // Enterable houses: town/village generators return house rectangles. For
    // each house we create an interior map and a two-way warp — an action-button
    // door on the house entrance leads inside, and a walk-on exit mat in the
    // interior returns the player to the street just below the door. Interiors
    // get sequential IDs right after the exterior. Opt out with
    // enterableHouses: false. (Interior tileset 3 = the default project's Inside.)
    const interiorsWanted = (params as Record<string, unknown>).enterableHouses !== false
        && (theme === 'town' || theme === 'village')
        && Array.isArray(tileResult.houses) && tileResult.houses.length > 0;

    const interiors: { id: number; map: RpgMakerMap; name: string }[] = [];
    if (interiorsWanted) {
        const houses = tileResult.houses as { x: number; y: number; w: number; h: number; doorX?: number; doorY?: number }[];
        // Item IDs the shop can sell (if the project has any).
        let shopItemIds: number[] = [];
        try { shopItemIds = (await readJson(projectPath, 'Items.json') as unknown[]).map(function (it, i) { return it ? i : 0; }).filter(Boolean).slice(0, 4); } catch (_) { /* none */ }
        for (let i = 0; i < houses.length; i++) {
            const ho = houses[i];
            const doorX = ho.doorX !== undefined ? ho.doorX : ho.x + Math.floor(ho.w / 2);
            const doorY = ho.doorY !== undefined ? ho.doorY : ho.y + ho.h - 1;
            const interiorId = mapId + 1 + i;
            // Mix of building types with purpose (one inn, every 3rd a shop, rest homes).
            const roomType = i === 0 ? 'inn' : (i % 3 === 1 ? 'shop' : 'home');
            const label = roomType === 'shop' ? 'Shop' : roomType === 'inn' ? 'Inn' : 'House';
            // Vary each interior's size + (via seed) floor/furniture so no two feel identical.
            const iseed = (seed || 0) + 101 + i;
            // INTERIORS FROM RTP TEMPLATES: instead of generating a procedural
            // interior (which looked ugly — flat walls, random furniture), clone
            // a real hand-authored RTP interior map. These have proper 3D A4
            // walls, coherent furniture, and a real door/exit. Picked by room
            // type so a shop is a shop, an inn is an inn, a home is a home.
            const INTERIOR_TEMPLATES: Record<string, number[]> = {
                home: [33, 34],          // House 1 (19x15), House 2 (21x17)
                shop: [39, 40, 41],      // Weapon Shop, Armor Shop, Item Shop
                inn: [42, 43]            // Inn 1F (21x20), Inn 2F (17x15)
            };
            const tids = INTERIOR_TEMPLATES[roomType] || INTERIOR_TEMPLATES.home;
            const templateId = tids[iseed % tids.length];
            const tpl = await generateFromTemplate(templateId, {});
            const IW = tpl ? tpl.width : (9 + (iseed % 5));
            const IH = tpl ? tpl.height : (7 + ((iseed >> 2) % 4));
            const exitX = Math.floor(IW / 2), exitY = IH - 2;
            // Exterior door (action button) → interior, landing one tile above the exit mat.
            tileResult.events.push(makeDoorEvent(tileResult.events.length, doorX, doorY, interiorId, exitX, exitY - 1));
            // Build the interior map from the RTP template tiles + add the exit
            // mat + occupant. Template tiles already include walls/furniture/door.
            const innerEvents: (MapEvent | null)[] = tpl && tpl.events && tpl.events.length > 0 ? tpl.events.slice() : [null];
            innerEvents.push(makeTransferEvent(innerEvents.length, exitX, exitY, mapId, doorX, doorY + 1, 1));
            // A fitting occupant: shopkeeper (functional shop), innkeeper (free rest), or resident.
            innerEvents.push(makeInteriorOccupant(innerEvents.length, Math.floor(IW / 2), 3, roomType, shopItemIds));
            const innerData = tpl ? tpl.data : (await generateTileLayoutV3(IW, IH, 'interior', { seed: iseed, addEvents: false, roomType: roomType })).data;
            interiors.push({ id: interiorId, map: makeMapObject(innerData, IW, IH, innerEvents, 3, ''), name: (name || 'Town') + ' ' + label + ' ' + (i + 1) });
        }
    }

    const mapPath = getMapPath(projectPath, mapId);
    await writeMapJson(projectPath, mapPath, map);
    for (const it of interiors) await writeMapJson(projectPath, getMapPath(projectPath, it.id), it.map);

    const mapInfos = await readJson(projectPath, 'MapInfos.json') as unknown[];
    const lastId = interiors.length > 0 ? interiors[interiors.length - 1].id : mapId;
    while (mapInfos.length <= lastId) mapInfos.push(null);

    let nextOrder = (mapInfos as unknown[]).reduce(function(max: number, info: unknown) {
        return info && (info as Record<string, number>).order && (info as Record<string, number>).order > max ? (info as Record<string, number>).order : max;
    }, 0) + 1;

    mapInfos[mapId] = {
        id: mapId, expanded: false,
        name: name || 'MAP' + String(mapId).padStart(3, '0'),
        order: nextOrder++, parentId: params.parentId || 0,
        scrollX: Math.floor(width * 32 * 0.8),
        scrollY: Math.floor(height * 32 * 0.8)
    };
    // Interiors are nested under the exterior map in the editor tree.
    for (const it of interiors) {
        mapInfos[it.id] = {
            id: it.id, expanded: false, name: it.name,
            order: nextOrder++, parentId: mapId,
            scrollX: 11 * 32, scrollY: 9 * 32
        };
    }

    await writeJson(projectPath, 'MapInfos.json', mapInfos);
    return { mapId: mapId, seed: tileResult.seed, theme: theme, interiorMapIds: interiors.map(function(it) { return it.id; }) };
}

/** Assemble a minimal RPG Maker MV map object from generated tile data + events. */
function makeMapObject(data: number[], width: number, height: number, events: (MapEvent | null)[], tilesetId: number, displayName: string): RpgMakerMap {
    return {
        autoplayBgm: false, autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: '', pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false, displayName: displayName,
        encounterList: [], encounterStep: 30,
        height: height, width: width, note: '',
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: tilesetId, data: data, events: events
    };
}

// A fitting occupant for a generated interior: a functional shopkeeper, an
// innkeeper who fully heals the party, or a resident with a line of dialogue —
// so houses have purpose, not just furniture.
function makeInteriorOccupant(id: number, x: number, y: number, roomType: string, shopItemIds: number[]): MapEvent {
  const msg = function (txt: string): EventCommand[] {
    const m = cmd.message(txt, '', 0);
    return m.filter(function (c, i) { return !(c.code === 0 && i === m.length - 1); }); // drop trailing terminator
  };
  const term: EventCommand = { code: 0, indent: 0, parameters: [] };
  let list: EventCommand[];
  let nm: string;
  if (roomType === 'shop' && shopItemIds.length > 0) {
    nm = 'Shopkeeper';
    const goods = shopItemIds.map(function (iid) { return [0, iid, 0, 0] as [number, number, number, number]; });
    list = msg('Welcome! Take a look at my wares.').concat(cmd.shopProcessing(goods, false), [term]);
  } else if (roomType === 'inn') {
    nm = 'Innkeeper';
    list = msg('Welcome to the inn — rest and recover!').concat(cmd.recoverAll(0), msg('Sleep well, traveler.'), [term]);
  } else {
    nm = 'Resident';
    list = msg(roomType === 'shop' ? 'Come back when I have stock to sell.' : 'Welcome to our home, traveler.').concat([term]);
  }
  return {
    id: id, name: nm, note: '', x: x, y: y,
    pages: [{
      conditions: createDefaultConditions(), directionFix: false,
      image: { characterIndex: id % 8, characterName: 'People1', direction: 2, pattern: 1, tileId: 0 },
      list: list, moveFrequency: 3,
      moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
    }]
  } as unknown as MapEvent;
}

/**
 * Create a new map from one of the bundled reference templates (knowledge/maps).
 * The template's tile data (and optionally its events) are copied into a brand-new
 * map file registered in MapInfos.json.
 */
async function createMapFromTemplate(projectPath: string, params: Record<string, unknown>) {
    const templateId = toNum(params.templateId, 'templateId');
    const tileResult = await generateFromTemplate(templateId, {
        width: params.width as number,
        height: params.height as number,
        keepEvents: params.keepEvents !== false
    } as Record<string, unknown>);
    if (!tileResult) {
        throw new Error('Template ' + templateId + ' not found. List templates with get_project_context detail "templates".');
    }

    const bgmName = (params.bgmName as string) || '';
    const map: RpgMakerMap = {
        autoplayBgm: bgmName ? true : false,
        autoplayBgs: false,
        battleback1Name: '', battleback2Name: '',
        bgm: { name: bgmName, pan: 0, pitch: 100, volume: 90 },
        bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
        disableDashing: false,
        displayName: (params.displayName as string) || '',
        encounterList: [], encounterStep: 30,
        height: tileResult.height, width: tileResult.width,
        note: (params.note as string) || '',
        parallaxLoopX: false, parallaxLoopY: false,
        parallaxName: '', parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0,
        scrollType: 0, specifyBattleback: false,
        tilesetId: (params.tilesetId as number) || 1,
        data: tileResult.data,
        events: tileResult.events && tileResult.events.length > 0 ? tileResult.events : [null]
    };

    const mapId = await getNextMapId(projectPath);
    await writeJsonDirect(getMapPath(projectPath, mapId), map);

    const mapInfos = await readJson(projectPath, 'MapInfos.json') as unknown[];
    while (mapInfos.length <= mapId) mapInfos.push(null);
    const maxOrder = (mapInfos as unknown[]).reduce(function(max: number, info: unknown) {
        return info && (info as Record<string, number>).order && (info as Record<string, number>).order > max ? (info as Record<string, number>).order : max;
    }, 0);
    mapInfos[mapId] = {
        id: mapId, expanded: false,
        name: (params.name as string) || 'MAP' + String(mapId).padStart(3, '0'),
        order: maxOrder + 1, parentId: (params.parentId as number) || 0,
        scrollX: Math.floor(tileResult.width * 32 * 0.8),
        scrollY: Math.floor(tileResult.height * 32 * 0.8)
    };
    await writeJson(projectPath, 'MapInfos.json', mapInfos);
    return { mapId: mapId, templateId: templateId, width: tileResult.width, height: tileResult.height };
}

async function createMapBatch(projectPath: string, batchSpec: unknown[]) {
    const results: unknown[] = [];
    const mapIds: Record<string, number> = {};
    for (let i = 0; i < batchSpec.length; i++) {
        const spec = batchSpec[i] as Record<string, unknown>;
        const params: CreateMapV3Params = {
            width: (spec.width as number) || 30,
            height: (spec.height as number) || 25,
            tilesetId: (spec.tilesetId as number) || THEME_TILESET[(spec.theme as string) || 'forest'] || 2,
            displayName: (spec.displayName as string) || (spec.name as string) || '',
            name: (spec.name as string) || '',
            theme: (spec.theme as string) || 'forest',
            seed: spec.seed as number,
            addEvents: spec.addEvents !== false,
            parentId: (spec.parentId as number) || 0,
            note: (spec.note as string) || ''
        };
        const result = await createMapV3(projectPath, params);
        mapIds[spec.key as string || spec.name as string] = result.mapId;
        results.push({ key: spec.key || spec.name, mapId: result.mapId, seed: result.seed, theme: result.theme });
    }
    return { maps: results, mapIds: mapIds };
}

async function connectMaps(projectPath: string, mapIdA: number, mapIdB: number, posA: Record<string, number>, posB: Record<string, number>) {
  const numMapIdA = toNum(mapIdA, 'mapIdA');
  const numMapIdB = toNum(mapIdB, 'mapIdB');
  const mapA = await getMap(projectPath, numMapIdA) as RpgMakerMap;
  const mapB = await getMap(projectPath, numMapIdB) as RpgMakerMap;
  const newIdA = nextId(mapA.events);
  const evA = makeTransferEvent(newIdA, posA.x, posA.y, numMapIdB, posB.x, posB.y, posA.trigger || 1);
  while (mapA.events.length <= newIdA) mapA.events.push(null);
  mapA.events[newIdA] = evA;
  await writeMapJson(projectPath, getMapPath(projectPath, numMapIdA), mapA);

  const newIdB = nextId(mapB.events);
  const evB = makeTransferEvent(newIdB, posB.x, posB.y, numMapIdA, posA.x, posA.y, posB.trigger || 1);
  while (mapB.events.length <= newIdB) mapB.events.push(null);
  mapB.events[newIdB] = evB;
  await writeMapJson(projectPath, getMapPath(projectPath, numMapIdB), mapB);

  return { eventA: evA, eventB: evB };
}

async function populateMapEvents(projectPath: string, mapId: number, eventType: string, count: number, opts: Record<string, unknown>) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  opts = opts || {};
  const numCount = toNum(count || 3, 'count');
  const added: unknown[] = [];
  for (let i = 0; i < numCount!; i++) {
        const x = (opts.x as number) || Math.floor(Math.random() * (map.width - 4)) + 2;
        const y = (opts.y as number) || Math.floor(Math.random() * (map.height - 4)) + 2;
        const newId = nextId(map.events);
        var ev;
        if (eventType === 'npc') ev = makeNpcEvent(newId, x, y, (opts.name as string) || 'NPC');
        else if (eventType === 'chest') ev = makeChestEvent(newId, x, y);
        else if (eventType === 'boss') ev = makeBossEvent(newId, x, y, (opts.troopId as number) || 1);
        else ev = makeNpcEvent(newId, x, y, eventType || 'Event');
        while (map.events.length <= newId) map.events.push(null);
        map.events[newId] = ev;
        added.push(ev);
    }
  await writeMapJson(projectPath, getMapPath(projectPath, numMapId), map);
  return { added: added, mapId: numMapId };
}

/**
 * Set a map's random-encounter list. Without this, generated dungeons/caves
 * have no enemies — encounterList stays [] and walking never triggers a battle.
 * Entries are shaped exactly as the engine reads them in
 * Game_Player.makeEncounterTroopId: { troopId, weight, regionSet }.
 * @param encounters - [{ troopId, weight?, regionSet? }] (weight default 5,
 *   regionSet default [] = whole map). troopId must already exist.
 * @param encounterStep - average steps between battles (default keeps current/30)
 */
async function setMapEncounters(projectPath: string, mapId: number, encounters: Record<string, unknown>[], encounterStep?: number) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const troops = await readJson(projectPath, 'Troops.json') as unknown[];
  const list = (encounters || []).map(function (e) {
    const troopId = toNum(e.troopId, 'troopId');
    if (!troops[troopId]) throw new Error('Troop ' + troopId + ' does not exist. Create it first (create_database_entry entity "troops").');
    return {
      troopId: troopId,
      weight: e.weight !== undefined ? toNum(e.weight, 'weight') : 5,
      regionSet: Array.isArray(e.regionSet) ? e.regionSet : []
    };
  });
  map.encounterList = list;
  if (encounterStep !== undefined) map.encounterStep = toNum(encounterStep, 'encounterStep');
  else if (!map.encounterStep) map.encounterStep = 30;
  await writeJsonDirect(getMapPath(projectPath, numMapId), map);
  return { mapId: numMapId, encounterList: list, encounterStep: map.encounterStep };
}

// Themes that should auto-wire random encounters from the project's troops.
const COMBAT_THEMES = ['dungeon', 'cave', 'world', 'fortress', 'sewer', 'volcano'];

// Build a weighted encounterList from the project's existing, non-empty troops
// (weaker/lower IDs weighted higher). Returns [] if there are no usable troops.
async function autoEncounterList(projectPath: string): Promise<{ troopId: number; weight: number; regionSet: number[] }[]> {
  try {
    const troops = await readJson(projectPath, 'Troops.json') as Array<{ members?: unknown[] } | null>;
    const valid: number[] = [];
    for (let i = 1; i < troops.length; i++) {
      const t = troops[i];
      if (t && Array.isArray(t.members) && t.members.length > 0) valid.push(i);
    }
    const pick = valid.slice(0, 6);
    return pick.map(function (id, idx) { return { troopId: id, weight: Math.max(1, pick.length - idx) * 5, regionSet: [] }; });
  } catch (_) { return []; }
}

async function setMapDisplayNames(projectPath: string, nameMap: Record<string, unknown>[]) {
  // Sets the player-visible displayName inside each MapNNN.json
  // (NOT the editor tree name in MapInfos.json — use organize_map_tree/MapInfos for that).
  const updated: unknown[] = [];
  const skipped: unknown[] = [];
  for (let i = 0; i < nameMap.length; i++) {
    const entry = nameMap[i];
    const id = toNum(entry.mapId, 'mapId in names[' + i + ']');
    try {
      const map = await getMap(projectPath, id) as RpgMakerMap;
      map.displayName = entry.name as string;
      await writeJsonDirect(getMapPath(projectPath, id), map);
      updated.push({ mapId: id, displayName: entry.name });
    } catch (_) {
      skipped.push({ mapId: id, reason: 'map file not found' });
    }
  }
  return { updated: updated, skipped: skipped };
}

async function organizeMapTree(projectPath: string, folderMap: Record<string, unknown>[]) {
  const mapInfos = await readJson(projectPath, 'MapInfos.json') as unknown[];
  const updated: unknown[] = [];
  for (let i = 0; i < folderMap.length; i++) {
    const entry = folderMap[i];
    const id = toNum(entry.mapId, 'mapId in folders[' + i + ']');
    const pid = toNum(entry.parentId || 0, 'parentId in folders[' + i + ']');
    if (id! < mapInfos.length && mapInfos[id!]) {
      (mapInfos[id!] as Record<string, number>).parentId = pid;
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
async function fillMapLayer(projectPath: string, mapId: number, layer: number, tileId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numLayer = toNum(layer, 'layer');
  const numTileId = toNum(tileId, 'tileId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (numLayer! < 0 || numLayer! > 5) {
    throw new Error('Layer must be between 0 and 5');
  }

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const index = (numLayer! * map.height + y) * map.width + x;
      map.data[index] = numTileId;
    }
  }

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { mapId: numMapId, layer: numLayer, tileId: numTileId, filled: map.width * map.height };
}

async function fillMapRect(projectPath: string, mapId: number, layer: number, x1: number, y1: number, x2: number, y2: number, tileId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numLayer = toNum(layer, 'layer');
  const numX1 = toNum(x1, 'x1');
  const numY1 = toNum(y1, 'y1');
  const numX2 = toNum(x2, 'x2');
  const numY2 = toNum(y2, 'y2');
  const numTileId = toNum(tileId, 'tileId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (numLayer! < 0 || numLayer! > 5) {
    throw new Error('Layer must be between 0 and 5');
  }

  const startX = Math.max(0, Math.min(numX1!, numX2!));
  const endX = Math.min(map.width - 1, Math.max(numX1!, numX2!));
  const startY = Math.max(0, Math.min(numY1!, numY2!));
  const endY = Math.min(map.height - 1, Math.max(numY1!, numY2!));

  let filled = 0;
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const index = (numLayer! * map.height + y) * map.width + x;
      map.data[index] = numTileId;
      filled++;
    }
  }

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { mapId: numMapId, layer: numLayer, x1: numX1, y1: numY1, x2: numX2, y2: numY2, tileId: numTileId, filled };
}

async function setMapTile(projectPath: string, mapId: number, layer: number, x: number, y: number, tileId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numLayer = toNum(layer, 'layer');
  const numX = toNum(x, 'x');
  const numY = toNum(y, 'y');
  const numTileId = toNum(tileId, 'tileId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (numLayer! < 0 || numLayer! > 5) {
    throw new Error('Layer must be between 0 and 5');
  }
  if (numX! < 0 || numX! >= map.width || numY! < 0 || numY! >= map.height) {
    throw new Error('Coordinates (' + numX + ',' + numY + ') are out of bounds for map size ' + map.width + 'x' + map.height);
  }

  const index = (numLayer! * map.height + numY!) * map.width + numX!;
  map.data[index] = numTileId;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { mapId: numMapId, layer: numLayer, x: numX, y: numY, tileId: numTileId };
}

async function replaceMapTile(projectPath: string, mapId: number, layer: number, oldTileId: number, newTileId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numLayer = toNum(layer, 'layer');
  const numOldTileId = toNum(oldTileId, 'oldTileId');
  const numNewTileId = toNum(newTileId, 'newTileId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (numLayer! < 0 || numLayer! > 5) {
    throw new Error('Layer must be between 0 and 5');
  }

  let replaced = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const index = (numLayer! * map.height + y) * map.width + x;
      if (map.data[index] === numOldTileId) {
        map.data[index] = numNewTileId;
        replaced++;
      }
    }
  }

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { mapId: numMapId, layer: numLayer, oldTileId: numOldTileId, newTileId: numNewTileId, replaced };
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
// RPG Maker MV halts the whole game with a fatal "Loading Error" screen if an
// event references a character sprite file that doesn't exist (e.g. an agent
// hand-authoring a chest with characterName "Chest" when the project ships
// "!Chest"). The MCP must never persist a sprite that isn't on disk. This
// validates each event image against img/characters/, auto-correcting the
// RPG Maker object prefixes agents commonly miss ('!'/'$'), and blanking
// (invisible, harmless) anything it still can't resolve.
const _assetCache = new Map<string, Set<string>>();
function listAssets(dir: string): Set<string> {
  if (_assetCache.has(dir)) return _assetCache.get(dir)!;
  let set: Set<string>;
  try {
    set = new Set(readdirSync(dir).map(function (f) { return f.replace(/\.(png|ogg|m4a|rpgmvo|rpgmvm)$/i, ''); }));
  } catch { set = new Set(); }
  _assetCache.set(dir, set);
  return set;
}

// Resolve an asset name against a project folder; '' if unresolvable so a
// missing asset renders/plays nothing instead of halting the game. `null`
// return means "folder absent, can't validate — leave the name as-is".
function resolveAsset(projectPath: string, subdir: string, name: string): string | null {
  if (!name) return name;
  const dir = projectPath + '/' + subdir;
  const set = listAssets(dir);
  if (set.size === 0) return null; // can't validate
  if (set.has(name)) return name;
  // RPG Maker object-character prefixes agents commonly miss.
  if (subdir === 'img/characters') {
    if (!name.startsWith('!') && set.has('!' + name)) return '!' + name;
    if (name.startsWith('!') && set.has(name.slice(1))) return name.slice(1);
    if (!name.startsWith('$') && set.has('$' + name)) return '$' + name;
  }
  return '';
}

function resolveCharacterName(projectPath: string, name: string): string {
  const r = resolveAsset(projectPath, 'img/characters', name);
  return r === null ? name : r;
}

// Sanitize every asset reference a map can hold so none can trigger MV's fatal
// "Loading Error": event character sprites + Show Text (101) face graphics, and
// the map's parallax/battleback images and bgm/bgs audio.
function sanitizeMapAssets(projectPath: string, map: RpgMakerMap): void {
  if (!map) return;
  if (Array.isArray(map.events)) for (const e of map.events) sanitizeEventImages(projectPath, e as MapEvent | null);
  const clear = (subdir: string, val: unknown): string | undefined => {
    if (typeof val !== 'string' || !val) return val as string | undefined;
    const r = resolveAsset(projectPath, subdir, val);
    return r === null ? val : r; // '' if missing
  };
  const m = map as unknown as Record<string, unknown>;
  if (typeof m.parallaxName === 'string') m.parallaxName = clear('img/parallaxes', m.parallaxName);
  if (typeof m.battleback1Name === 'string') m.battleback1Name = clear('img/battlebacks1', m.battleback1Name);
  if (typeof m.battleback2Name === 'string') m.battleback2Name = clear('img/battlebacks2', m.battleback2Name);
  const bgm = m.bgm as { name?: string } | undefined;
  if (bgm && typeof bgm.name === 'string' && clear('audio/bgm', bgm.name) === '') { bgm.name = ''; m.autoplayBgm = false; }
  const bgs = m.bgs as { name?: string } | undefined;
  if (bgs && typeof bgs.name === 'string' && clear('audio/bgs', bgs.name) === '') { bgs.name = ''; m.autoplayBgs = false; }
}

function sanitizeEventImages(projectPath: string, event: MapEvent | null): void {
  if (!event || !Array.isArray(event.pages)) return;
  for (const pg of event.pages) {
    const page = pg as EventPage;
    const img = page && page.image;
    if (img && typeof img.characterName === 'string') {
      img.characterName = resolveCharacterName(projectPath, img.characterName);
    }
    // Show Text (101): params[0] is a face graphic in img/faces.
    if (page && Array.isArray(page.list)) {
      for (const c of page.list as EventCommand[]) {
        if (c && c.code === 101 && Array.isArray(c.parameters) && typeof c.parameters[0] === 'string' && c.parameters[0]) {
          const r = resolveAsset(projectPath, 'img/faces', c.parameters[0] as string);
          if (r !== null) c.parameters[0] = r;
        }
      }
    }
  }
}

async function createMapEvent(projectPath: string, mapId: number, x: number, y: number, name: string, trigger: number, pages: EventPage[]) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  const newId = nextId(map.events);
  const triggerVal = toNum(trigger !== undefined ? trigger : 0, 'trigger');

  if (pages && pages.length > 0) {
    // Apply trigger to pages that don't have one set
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].trigger === undefined) pages[i].trigger = triggerVal;
      if (!pages[i].list || pages[i].list.length === 0) {
        pages[i].list = [{ code: 0, indent: 0, parameters: [] }];
      }
      // Ensure terminator
      const last = pages[i].list[pages[i].list.length - 1];
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

  const event = {
    id: newId,
    name: name || 'EV' + newId,
    note: '',
    x: x,
    y: y,
    pages: pages
  };

  sanitizeEventImages(projectPath, event as MapEvent);
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

/**
 * Update an existing map event's properties (partial update).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {number} eventId - The event ID to update
 * @param {object} fields - Fields to update
 */
async function updateMapEvent(projectPath: string, mapId: number, eventId: number, fields: Partial<MapEvent>) {
  const numMapId = toNum(mapId, 'mapId');
  const numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (!map.events[numEventId!]) {
    throw new Error('Event ' + numEventId + ' not found on map ' + numMapId + '. Available: ' + map.events.map(function(e: MapEvent | null, i: number) { return e ? i + ':' + e.name : null; }).filter(Boolean).join(', '));
  }

  map.events[numEventId!] = Object.assign({}, map.events[numEventId!], fields) as MapEvent;
  sanitizeEventImages(projectPath, map.events[numEventId!]);

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return map.events[numEventId!];
}

async function addEventCommand(projectPath: string, mapId: number, eventId: number, pageIndex: number, command: EventCommand) {
  const numMapId = toNum(mapId, 'mapId');
  const numEventId = toNum(eventId, 'eventId');
  const numPageIndex = toNum(pageIndex !== undefined ? pageIndex : 0, 'pageIndex');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;

  if (!map.events[numEventId!]) {
    throw new Error('Event ' + numEventId + ' not found on map ' + numMapId + '. Available: ' + map.events.map(function(e: MapEvent | null, i: number) { return e ? i + ':' + e.name : null; }).filter(Boolean).join(', '));
  }

  const event = map.events[numEventId!]!;
  if (!event.pages[numPageIndex!]) {
    throw new Error('Page ' + numPageIndex! + ' not found on event ' + numEventId + ' (has ' + event.pages.length + ' pages)');
  }

  const commandList = event.pages[numPageIndex!].list;

  commandList.splice(commandList.length - 1, 0, command);

  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
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
async function createNpc(projectPath: string, mapId: number, x: number, y: number, name: string, dialogues: string[], characterName: string, characterIndex: number) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);

  characterName = characterName || '';
  characterIndex = characterIndex || 0;

  const page1List: EventCommand[] = [];
  const dialogueLines = dialogues && dialogues.length > 0 ? dialogues : ['...'];
  for (let d = 0; d < dialogueLines.length; d++) {
    const msgCommands = cmd.message(dialogueLines[d], '', 0);
    // Remove the trailing code 0 terminator from each message block
    // (we add one at the very end of the page)
    for (let i = 0; i < msgCommands.length; i++) {
      if (msgCommands[i].code === 0 && i === msgCommands.length - 1) continue;
      page1List.push(msgCommands[i]);
    }
    }
    // Self Switch A = ON (MV: parameters[1] === 0 means ON) so page 2 takes over
    page1List.push({ code: 123, indent: 0, parameters: ['A', 0] });
    // Add the page terminator (code 0 = End of Event Processing)
    page1List.push({ code: 0, indent: 0, parameters: [] });

  // Page 1: Action button trigger, NPC sprite, dialogue
  const page1 = {
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
  const page2 = {
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

  const event = {
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
  await writeMapJson(projectPath, mapPath, map);
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
async function createChest(projectPath: string, mapId: number, x: number, y: number, items: Record<string, unknown>[], characterName: string, characterIndex: number) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);

  characterName = characterName || '!Chest';
  characterIndex = characterIndex || 0;

  const page1List: EventCommand[] = [];

  // Give each item/weapon/armor
  const itemEntries = items || [];
  for (let idx = 0; idx < itemEntries.length; idx++) {
    const item = itemEntries[idx];
    const amount = (item.amount as number) || 1;
    if (item.type === 'item') {
      page1List.push.apply(page1List, cmd.giveItem(item.id as number, amount));
    } else if (item.type === 'weapon') {
      page1List.push.apply(page1List, cmd.giveWeapon(item.id as number, amount));
    } else if (item.type === 'armor') {
      page1List.push.apply(page1List, cmd.giveArmor(item.id as number, amount));
    }
  }

  // Activate Self Switch A = ON (so the chest stays open)
  page1List.push.apply(page1List, cmd.selfSwitchControl('A', true));

  // Show "found items" message
  const msgCmds = cmd.message('Found items inside the chest!', '', 0);
  for (let i = 0; i < msgCmds.length; i++) {
    // Skip the code 0 terminator from the message helper — we add our own
    if (msgCmds[i].code === 0 && i === msgCmds.length - 1) continue;
    page1List.push(msgCmds[i]);
  }

  // Add page terminator
  page1List.push({ code: 0, indent: 0, parameters: [] });

  // Page 1: Action button, chest closed sprite
  const page1 = {
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
  const page2 = {
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

  const event = {
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
  await writeMapJson(projectPath, mapPath, map);
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
async function createTeleportEvent(projectPath: string, mapId: number, x: number, y: number, destMapId: number, destX: number, destY: number, trigger: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numDestMapId = toNum(destMapId, 'destMapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);

  const teleportCmds = cmd.teleport(numDestMapId, destX, destY, 0, 0);
  const pageList = teleportCmds.slice();
  pageList.push({ code: 0, indent: 0, parameters: [] });

  const eventTrigger = trigger !== undefined ? toNum(trigger, 'trigger') : 1;

  const page = {
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

  const event = {
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
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

/**
 * HIGH LEVEL HELPER: Create a door — an action-button warp into another map
 * (e.g. a house entrance). Unlike createTeleportEvent (a walk-on transfer
 * zone), a door is pressed to enter and can show a sprite and be locked.
 *
 * Without a lock it is a single page: face the door, press the action button,
 * transfer. With `lockedSwitchId` it gets two pages — page 1 (switch OFF) shows
 * a "locked" message; page 2 (switch ON) performs the transfer — so a key/quest
 * switch can gate it.
 *
 * @param destMapId/destX/destY - where the door leads (not validated)
 * @param opts - { characterName?, characterIndex?, trigger?, lockedSwitchId?, lockedMessage? }
 */
async function createDoor(projectPath: string, mapId: number, x: number, y: number, destMapId: number, destX: number, destY: number, opts: Record<string, unknown> = {}) {
  const numMapId = toNum(mapId, 'mapId');
  const numDestMapId = toNum(destMapId, 'destMapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);

  const characterName = (opts.characterName as string) || '';
  const characterIndex = opts.characterIndex !== undefined ? toNum(opts.characterIndex, 'characterIndex') : 0;
  // Doors default to the action button (trigger 0); pass trigger 1 for a
  // walk-on doorway.
  const trigger = opts.trigger !== undefined ? toNum(opts.trigger, 'trigger') : 0;
  const lockedSwitchId = opts.lockedSwitchId !== undefined ? toNum(opts.lockedSwitchId, 'lockedSwitchId') : 0;
  const lockedMessage = (opts.lockedMessage as string) || "It's locked.";

  function imageFor(): Record<string, unknown> {
    return { characterIndex: characterIndex, characterName: characterName, direction: 8, pattern: 1, tileId: 0 };
  }
  function pageShell(list: EventCommand[], conditions: Record<string, unknown>): Record<string, unknown> {
    return {
      conditions: conditions, directionFix: true, image: imageFor(), list: list, moveFrequency: 3,
      moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
      moveSpeed: 2, moveType: 0, priorityType: trigger === 0 ? 1 : 0, stepAnime: false,
      through: trigger !== 0, trigger: trigger, walkAnime: false
    };
  }

  const transferList = cmd.teleport(numDestMapId, destX, destY, 0, 0).slice();
  transferList.push({ code: 0, indent: 0, parameters: [] });

  let pages: Record<string, unknown>[];
  if (lockedSwitchId > 0) {
    // Page 1 (switch OFF): show the locked message.
    const lockedList = cmd.message(lockedMessage, '', 0);
    const transferPage = pageShell(transferList, Object.assign(createDefaultConditions(), { switch1Id: lockedSwitchId, switch1Valid: true }));
    pages = [pageShell(lockedList, createDefaultConditions()), transferPage];
  } else {
    pages = [pageShell(transferList, createDefaultConditions())];
  }

  const event = { id: newId, name: (opts.name as string) || ('Door to Map' + numDestMapId), note: '', x: x, y: y, pages: pages } as unknown as MapEvent;
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

/**
 * Search map events by name (case-insensitive).
 * @param {string} projectPath - The project root path
 * @param {number} mapId - The map ID
 * @param {string} query - Search term
 */
async function searchMapEvents(projectPath: string, mapId: number, query: string) {
  const events = await getMapEvents(projectPath, mapId) as unknown[];
  const lowerQuery = query.toLowerCase();
  return events.filter(function(e: unknown) {
    return e !== null && (e as MapEvent).name.toLowerCase().includes(lowerQuery);
  });
}

function toNum(val: unknown, name: string): number {
  if (val === undefined || val === null) throw new Error('Missing required parameter: ' + name);
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
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
function createDefaultEventPage(trigger: number): EventPage {
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

async function readJsonDirect(filePath: string) {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
}

// Write a map to disk, first sanitizing every asset reference (event sprites,
// face graphics, parallax/battleback images, bgm/bgs) against the project so a
// missing resource can never halt the game. All map writes go through this;
// sanitizing is idempotent.
async function writeMapJson(projectPath: string, filePath: string, map: RpgMakerMap) {
  sanitizeMapAssets(projectPath, map);
  await writeJsonDirect(filePath, map);
}

async function writeJsonDirect(filePath: string, data: unknown) {
  const backupPath = filePath + '.bak';

  try {
    await copyFile(filePath, backupPath);
  } catch (_) {
    // If backup fails (file doesn't exist yet), continue
  }

  const jsonString = JSON.stringify(data, null, 2);
  await writeFile(filePath, jsonString, 'utf-8');
}

async function deleteMapEvent(projectPath: string, mapId: number, eventId: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numEventId = toNum(eventId, 'eventId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  if (!map.events[numEventId!]) throw new Error('Event ' + numEventId + ' not found on map ' + numMapId);
  const deleted = map.events[numEventId!];
  map.events[numEventId!] = null;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { deleted: deleted };
}

async function duplicateMap(projectPath: string, sourceMapId: number, params: Record<string, unknown>) {
  const numSourceMapId = toNum(sourceMapId, 'sourceMapId');
  const sourceMap = await getMap(projectPath, numSourceMapId) as RpgMakerMap;
  const newMapId = await getNextMapId(projectPath);
  const newMap = JSON.parse(JSON.stringify(sourceMap)) as RpgMakerMap;
  if (params && params.width) newMap.width = params.width as number;
  if (params && params.height) newMap.height = params.height as number;
  if (params && params.displayName) newMap.displayName = params.displayName as string;
  if (params && params.tilesetId) newMap.tilesetId = params.tilesetId as number;
  const mapPath = getMapPath(projectPath, newMapId);
  await writeMapJson(projectPath, mapPath, newMap);
  const mapInfos = await readJson(projectPath, 'MapInfos.json') as unknown[];
  while (mapInfos.length <= newMapId) mapInfos.push(null);
  const maxOrder = mapInfos.reduce(function(max: number, info: unknown) {
    return info && (info as Record<string, number>).order && (info as Record<string, number>).order > max ? (info as Record<string, number>).order : max;
  }, 0);
  const name = (params && params.name) || ('Copy of Map' + numSourceMapId);
  mapInfos[newMapId] = {
    id: newMapId, expanded: false, name: name,
    order: maxOrder + 1, parentId: 0,
    scrollX: Math.floor(newMap.width * 32 * 0.8),
    scrollY: Math.floor(newMap.height * 32 * 0.8)
  };
  await writeJson(projectPath, 'MapInfos.json', mapInfos);
  return { mapId: newMapId, map: newMap };
}

async function createShop(projectPath: string, mapId: number, x: number, y: number, name: string, goods: unknown[][], characterName: string, characterIndex: number) {
  const numMapId = toNum(mapId, 'mapId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  // Each good is [type(0=item,1=weapon,2=armor), id, priceType(0=standard,1=custom), price]
  const normalized = (goods || []).map(function(g: unknown[]) {
    return [toNum(g[0], 'goods type'), toNum(g[1], 'goods id'), g[2] !== undefined ? toNum(g[2], 'goods priceType') : 0, g[3] !== undefined ? toNum(g[3], 'goods price') : 0];
  });
  if (normalized.length === 0) throw new Error('create_shop requires at least one entry in goods');
  // MV Shop Processing: command 302 carries the FIRST good (plus purchaseOnly flag);
  // each additional good is a 605 command following it.
  const first = normalized[0];
  const pageList = [
    { code: 302, indent: 0, parameters: [first[0], first[1], first[2], first[3], false] as unknown[] },
  ];
  for (let i = 1; i < normalized.length; i++) {
    pageList.push({ code: 605, indent: 0, parameters: normalized[i] });
  }
  pageList.push({ code: 0, indent: 0, parameters: [] });
  const page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: pageList, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const event = { id: newId, name: name || 'Shop', note: '', x: x, y: y, pages: [page1] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

async function createInn(projectPath: string, mapId: number, x: number, y: number, name: string, cost: number, characterName: string, characterIndex: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numCost = toNum(cost || 50, 'cost');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  cost = cost || 50;
  const page1List: EventCommand[] = [
  { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
  { code: 401, indent: 0, parameters: ['Rest here for ' + numCost + ' gold?'] },
  { code: 102, indent: 0, parameters: [['Yes', 'No'], 1] },
  { code: 402, indent: 0, parameters: [0, 'Yes'] },
  { code: 111, indent: 1, parameters: [12, '$gameParty.gold() >= ' + numCost] },
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
  const page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: page1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const event = { id: newId, name: name || 'Inn', note: '', x: x, y: y, pages: [page1] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

async function createBossEvent(projectPath: string, mapId: number, x: number, y: number, name: string, troopId: number, characterName: string, characterIndex: number) {
  const numMapId = toNum(mapId, 'mapId');
  const numTroopId = toNum(troopId, 'troopId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const newId = nextId(map.events);
  characterName = characterName || '';
  characterIndex = characterIndex || 0;
  const page1List: EventCommand[] = [
  { code: 301, indent: 0, parameters: [0, numTroopId, 0, 1] },
        { code: 601, indent: 0, parameters: [] },
        // Self Switch A = ON (value 0) on victory so the boss stays defeated
        { code: 123, indent: 1, parameters: ['A', 0] },
        { code: 0, indent: 1, parameters: [] },
        { code: 602, indent: 0, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 603, indent: 0, parameters: [] },
        { code: 353, indent: 1, parameters: [] },
        { code: 0, indent: 1, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
    ];
  const page2 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: true, trigger: 0, walkAnime: false
  };
  const page1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: characterIndex, characterName: characterName, direction: 2, pattern: 1, tileId: 0 },
    list: page1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const event = { id: newId, name: name || 'Boss', note: '', x: x, y: y, pages: [page1, page2] };
  while (map.events.length <= newId) map.events.push(null);
  map.events[newId] = event;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return event;
}

async function createPuzzleSwitch(projectPath: string, mapId: number, x: number, y: number, doorX: number, doorY: number, switchId: number, switchName?: string, doorName?: string) {
  const numMapId = toNum(mapId, 'mapId');
  const numSwitchId = toNum(switchId, 'gameSwitchId');
  const map = await getMap(projectPath, numMapId) as RpgMakerMap;
  const switchId2 = nextId(map.events);
  const switchPage1List = [
  { code: 121, indent: 0, parameters: [numSwitchId, numSwitchId, 0] },
    { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
    { code: 401, indent: 0, parameters: ['Switch activated!'] },
    { code: 123, indent: 0, parameters: ['A', 0] },
    { code: 0, indent: 0, parameters: [] }
  ];
  const switchPage1 = {
    conditions: createDefaultConditions(), directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 0, tileId: 0 },
    list: switchPage1List, moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const switchPage2 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const switchEvent = { id: switchId2, name: switchName || 'Switch', note: '', x: x, y: y, pages: [switchPage1, switchPage2] };
  while (map.events.length <= switchId2) map.events.push(null);
  map.events[switchId2] = switchEvent;
  const doorId = nextId(map.events);
  const doorPage1 = {
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
  const doorPage2 = {
    conditions: Object.assign({}, createDefaultConditions(), { switch1Id: numSwitchId, switch1Valid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
        list: [
        { code: 205, indent: 0, parameters: [-1, { list: [{ code: 44, parameters: [] }, { code: 0, parameters: [] }], repeat: false, skippable: true, wait: true }] },
        { code: 505, indent: 0, parameters: [{ code: 44, parameters: [] }] },
        // Self Switch A = ON (value 0) so the door stays open (page 3)
        { code: 123, indent: 0, parameters: ['A', 0] },
        { code: 0, indent: 0, parameters: [] }
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
  };
  const doorPage3 = {
    conditions: Object.assign({}, createDefaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
    directionFix: true,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: 0, walkAnime: false
  };
  const doorEvent = { id: doorId, name: doorName || 'Door', note: '', x: doorX, y: doorY, pages: [doorPage1, doorPage2, doorPage3] };
  while (map.events.length <= doorId) map.events.push(null);
  map.events[doorId] = doorEvent;
  const mapPath = getMapPath(projectPath, numMapId);
  await writeMapJson(projectPath, mapPath, map);
  return { switchEvent: switchEvent, doorEvent: doorEvent };
}

export { getMapInfos };
export { getMap };
export { getMapEvents };
export { getMapEvent };
export { getNextMapId };
export { createMap };
export { createMapV3 };
export { createMapFromTemplate };
export { createMapBatch };
export { connectMaps };
export { populateMapEvents };
export { setMapEncounters };
export { fillMapLayer };
export { createMapEvent };
export { updateMapEvent };
export { addEventCommand };
export { createNpc };
export { createChest };
export { createTeleportEvent };
export { createDoor };
export { searchMapEvents };
export { deleteMapEvent };
export { duplicateMap };
export { createShop };
export { createInn };
export { createBossEvent };
export { createPuzzleSwitch };
export { setMapDisplayNames };
export { organizeMapTree };
export { fillMapRect };
export { setMapTile };
export { replaceMapTile };
