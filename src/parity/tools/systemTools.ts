import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath, getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { SystemData, Terms, Actor, MapInfo, MapData, AudioFile } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { assetNameWarning } from './assetTools.js';
import { ValidationWarning } from '../validation/eventCommands.js';

/**
 * Get system data
 */
export async function getSystem(projectPath: string): Promise<SystemData> {
  const systemPath = getDataPath(projectPath, 'System.json');
  return await readJsonFile<SystemData>(systemPath);
}

/**
 * Update system data
 */
export async function updateSystem(
  projectPath: string,
  updates: Partial<SystemData>,
): Promise<SystemData> {
  const system = await getSystem(projectPath);
  const updatedSystem = { ...system, ...updates };

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, updatedSystem);

  return updatedSystem;
}

/**
 * Get game variables
 */
export async function getVariables(projectPath: string): Promise<string[]> {
  const system = await getSystem(projectPath);
  return system.variables;
}

/**
 * The block the RPG Maker editor grows the switch/variable name lists in. Growing
 * to a multiple of it keeps a file this server wrote indistinguishable from one
 * the editor saved.
 */
const NAME_BLOCK = 20;

/**
 * Hard ceiling on automatic growth. A four-digit id is far more likely to be a
 * typo than a real need, and silently allocating thousands of empty name slots
 * would bloat System.json without anyone noticing.
 */
const MAX_NAME_SLOTS = 5000;

/**
 * Grow a System.json name array (`switches`/`variables`) so `id` has a slot,
 * padding with `''` exactly as the editor does. Returns the array unchanged when
 * the slot already exists.
 *
 * Without this an agent working from `next_free_id` hits a wall the moment it
 * exhausts the default 20 slots — and the only remedy would be "open the RPG
 * Maker editor", in a workflow whose whole premise is not needing to. Nothing is
 * lost by growing: the engine reads `$gameSwitches` independently of these
 * labels, which exist for the editor UI.
 */
function growNameSlots(names: string[], id: number, label: string): void {
  if (id < names.length) return;
  if (id > MAX_NAME_SLOTS) {
    throw new Error(
      `${label} id ${id} is beyond the ${MAX_NAME_SLOTS}-slot ceiling (project declares ${names.length - 1}). That is almost certainly a typo — check next_free_id.`,
    );
  }
  const grown = Math.ceil((id + 1) / NAME_BLOCK) * NAME_BLOCK;
  while (names.length < grown) names.push('');
}

/**
 * Set a variable name. Grows the `variables` array if the id is past the end
 * (see {@link growNameSlots}).
 */
export async function setVariableName(
  projectPath: string,
  variableId: number,
  name: string,
): Promise<void> {
  const system = await getSystem(projectPath);
  if (variableId < 1) {
    throw new Error(`Variable id ${variableId} is out of range (ids are 1-based).`);
  }
  growNameSlots(system.variables, variableId, 'Variable');
  system.variables[variableId] = name;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);
}

/**
 * Get game switches
 */
export async function getSwitches(projectPath: string): Promise<string[]> {
  const system = await getSystem(projectPath);
  return system.switches;
}

/**
 * Set a switch name. Grows the `switches` array if the id is past the end (see
 * {@link growNameSlots}).
 */
export async function setSwitchName(
  projectPath: string,
  switchId: number,
  name: string,
): Promise<void> {
  const system = await getSystem(projectPath);
  if (switchId < 1) {
    throw new Error(`Switch id ${switchId} is out of range (ids are 1-based).`);
  }
  growNameSlots(system.switches, switchId, 'Switch');
  system.switches[switchId] = name;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);
}

/**
 * Get party members
 */
export async function getPartyMembers(projectPath: string): Promise<number[]> {
  const system = await getSystem(projectPath);
  return system.partyMembers;
}

/**
 * Update the starting party (the actor ids the game begins with). Validates every
 * id references an existing actor (throws otherwise — mirrors create_map's parent
 * check) so a bad party can't silently break new-game setup.
 */
export async function updatePartyMembers(
  projectPath: string,
  partyMembers: number[],
): Promise<void> {
  const actors = await readJsonFile<(Actor | null)[]>(getDataPath(projectPath, 'Actors.json'));
  for (const id of partyMembers) {
    if (!actors[id]) {
      throw new Error(`Party member actor id ${id} does not exist in Actors.json`);
    }
  }

  const system = await getSystem(projectPath);
  system.partyMembers = partyMembers;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);
}

/**
 * Get starting position
 */
export async function getStartingPosition(
  projectPath: string,
): Promise<{ mapId: number; x: number; y: number }> {
  const system = await getSystem(projectPath);
  return {
    mapId: system.startMapId,
    x: system.startX,
    y: system.startY,
  };
}

/**
 * Update starting position. Validates the map exists (in MapInfos) and that x/y
 * fall within that map's bounds — consistent with set_party's actor-id check and
 * set_encounters' troop check, so a typo can't point new-game at a missing map or
 * an off-map tile.
 */
export async function updateStartingPosition(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
): Promise<void> {
  const mapInfos = await readJsonArraySoft<MapInfo>(getDataPath(projectPath, 'MapInfos.json'));
  if (!mapInfos[mapId]) {
    throw new Error(`Starting map id ${mapId} does not exist in MapInfos.json`);
  }

  const map = await readJsonFile<MapData>(getMapPath(projectPath, mapId));
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
    throw new Error(
      `Starting position (${x}, ${y}) is out of bounds for map ${mapId} (${map.width}x${map.height})`,
    );
  }

  const system = await getSystem(projectPath);
  system.startMapId = mapId;
  system.startX = x;
  system.startY = y;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);
}

/**
 * Get game title
 */
export async function getGameTitle(projectPath: string): Promise<string> {
  const system = await getSystem(projectPath);
  return system.gameTitle;
}

/**
 * Update game title
 */
export async function updateGameTitle(projectPath: string, title: string): Promise<void> {
  const system = await getSystem(projectPath);
  system.gameTitle = title;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);
}

/** Title screen settings: the two background layers, the BGM, and whether the
 * game title text is drawn over the art (System.json's optDrawTitle). */
export interface TitleScreen {
  title1Name: string;
  title2Name: string;
  titleBgm: AudioFile;
  drawTitle: boolean;
}

/**
 * Get title screen settings
 */
export async function getTitleScreen(projectPath: string): Promise<TitleScreen> {
  const system = await getSystem(projectPath);
  return {
    title1Name: system.title1Name,
    title2Name: system.title2Name,
    titleBgm: system.titleBgm,
    drawTitle: system.optDrawTitle,
  };
}

/**
 * Update title screen settings. Only the provided fields are changed.
 */
export async function updateTitleScreen(
  projectPath: string,
  updates: Partial<TitleScreen>,
): Promise<TitleScreen> {
  const system = await getSystem(projectPath);
  if (updates.title1Name !== undefined) system.title1Name = updates.title1Name;
  if (updates.title2Name !== undefined) system.title2Name = updates.title2Name;
  if (updates.titleBgm !== undefined) system.titleBgm = updates.titleBgm;
  if (updates.drawTitle !== undefined) system.optDrawTitle = updates.drawTitle;

  const systemPath = getDataPath(projectPath, 'System.json');
  await commitChange(systemPath, system);

  return {
    title1Name: system.title1Name,
    title2Name: system.title2Name,
    titleBgm: system.titleBgm,
    drawTitle: system.optDrawTitle,
  };
}

/**
 * Warn (never throw) when the title screen's background images or BGM aren't
 * among the project's assets — a wrong filename is a silent runtime failure
 * (blank background / no music). Only checks fields present in `updates`, so a
 * partial update doesn't re-warn on fields it didn't touch. Mirrors
 * `withEnemyAssetWarnings` (battleTools) and `audioNameWarnings` (eventCommandTools).
 */
async function titleScreenAssetWarnings(
  projectPath: string,
  updates: Partial<TitleScreen>,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = [];
  if (updates.title1Name !== undefined) {
    warnings.push(
      ...(await assetNameWarning(projectPath, 'titles1', updates.title1Name, {
        path: 'title1Name',
        label: 'image',
        consequence: 'a wrong filename shows a blank title background',
      })),
    );
  }
  if (updates.title2Name !== undefined) {
    warnings.push(
      ...(await assetNameWarning(projectPath, 'titles2', updates.title2Name, {
        path: 'title2Name',
        label: 'image',
        consequence: 'a wrong filename shows a blank title background',
      })),
    );
  }
  if (updates.titleBgm !== undefined) {
    warnings.push(
      ...(await assetNameWarning(projectPath, 'bgm', updates.titleBgm.name, {
        path: 'titleBgm.name',
        label: 'audio',
        consequence: 'a wrong filename fails silently at runtime',
      })),
    );
  }
  return warnings;
}

/**
 * Get all terms (vocabulary): the `basic`, `commands`, `params` string arrays
 * and the `messages` string map.
 */
export async function getTerms(projectPath: string): Promise<Terms> {
  const system = await getSystem(projectPath);
  return system.terms;
}

/** The four vocabulary categories in System.json's `terms`. */
export type TermCategory = 'basic' | 'commands' | 'params' | 'messages';

/**
 * Set one vocabulary term. For `basic`/`commands`/`params` the `key` is a numeric
 * index (passed as a string); for `messages` it's a string message key. Throws on
 * an out-of-range index (so a typo can't silently grow a sparse array).
 */
export async function setTerm(
  projectPath: string,
  category: TermCategory,
  key: string,
  value: string,
): Promise<Terms> {
  const system = await getSystem(projectPath);
  const terms = system.terms;

  if (category === 'messages') {
    terms.messages[key] = value;
  } else {
    const index = Number(key);
    const arr = terms[category];
    if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
      throw new Error(`terms.${category} index ${key} is out of range (0..${arr.length - 1})`);
    }
    arr[index] = value;
  }

  await commitChange(getDataPath(projectPath, 'System.json'), system);
  return terms;
}

/** The System.json "type name" arrays other data references by index. */
export type TypeCategory = 'elements' | 'skillTypes' | 'weaponTypes' | 'armorTypes' | 'equipTypes';

/** Get one type-name array (elements, skillTypes, weaponTypes, armorTypes, equipTypes). */
export async function getTypes(projectPath: string, category: TypeCategory): Promise<string[]> {
  const system = await getSystem(projectPath);
  return system[category];
}

/**
 * Rename one entry in a type-name array. `index` 0 is the conventional empty slot
 * (kept as `""` by the editor). Throws on an out-of-range index rather than
 * growing the array with holes.
 */
export async function setTypeName(
  projectPath: string,
  category: TypeCategory,
  index: number,
  name: string,
): Promise<string[]> {
  const system = await getSystem(projectPath);
  const arr = system[category];
  if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
    throw new Error(`${category} index ${index} is out of range (0..${arr.length - 1})`);
  }
  arr[index] = name;

  await commitChange(getDataPath(projectPath, 'System.json'), system);
  return arr;
}

/** Set the currency unit shown next to gold amounts (e.g. "G"). */
export async function setCurrencyUnit(projectPath: string, unit: string): Promise<void> {
  const system = await getSystem(projectPath);
  system.currencyUnit = unit;
  await commitChange(getDataPath(projectPath, 'System.json'), system);
}

export const systemToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_system',
    description: 'Get system data',
    inputSchema: {},
    handler: (ctx) => getSystem(ctx.projectPath),
  },
  {
    name: 'get_variables',
    description: 'Get all game variable names',
    inputSchema: {},
    handler: (ctx) => getVariables(ctx.projectPath),
  },
  {
    name: 'set_variable_name',
    mutates: true,
    description:
      "Set a variable name. Grows the project's variable list if the id is past the end (padded to the editor's 20-slot block), so an id from next_free_id can always be labelled. Naming a variable as soon as you claim it is what makes it visible to the next session — see list_allocated_ids.",
    inputSchema: {
      variableId: z.number().int().positive().describe('The 1-based variable ID'),
      name: z.string().describe('The name to assign'),
    },
    handler: async (ctx, args) => {
      await setVariableName(ctx.projectPath, args.variableId, args.name);
      return { success: true };
    },
  },
  {
    name: 'get_switches',
    description: 'Get all game switch names',
    inputSchema: {},
    handler: (ctx) => getSwitches(ctx.projectPath),
  },
  {
    name: 'set_switch_name',
    mutates: true,
    description:
      "Set a switch name. Grows the project's switch list if the id is past the end (padded to the editor's 20-slot block), so an id from next_free_id can always be labelled. Naming a switch as soon as you claim it is what makes it visible to the next session — see list_allocated_ids.",
    inputSchema: {
      switchId: z.number().int().positive().describe('The 1-based switch ID'),
      name: z.string().describe('The name to assign'),
    },
    handler: async (ctx, args) => {
      await setSwitchName(ctx.projectPath, args.switchId, args.name);
      return { success: true };
    },
  },
  {
    name: 'get_game_title',
    description: 'Get the game title',
    inputSchema: {},
    handler: (ctx) => getGameTitle(ctx.projectPath),
  },
  {
    name: 'update_game_title',
    mutates: true,
    description: 'Update the game title',
    inputSchema: { title: z.string().describe('The new game title') },
    handler: async (ctx, args) => {
      await updateGameTitle(ctx.projectPath, args.title);
      return { success: true };
    },
  },
  {
    name: 'get_title_screen',
    description:
      'Get the title screen settings: title1Name/title2Name (background layers, from list_assets("titles1"/"titles2") — title2Name draws over title1Name), titleBgm (the AudioFile that plays while it is shown), and drawTitle (whether the game title text is drawn over the art).',
    inputSchema: {},
    handler: (ctx) => getTitleScreen(ctx.projectPath),
  },
  {
    name: 'update_title_screen',
    mutates: true,
    description:
      'Update the title screen: background layers (title1Name/title2Name, basenames from list_assets("titles1"/"titles2")), the BGM that plays while it is shown, and/or whether the game title text is drawn over the art. Only the provided fields are changed. Warns (never blocks) when an image/audio name is not a known asset. Returns the updated title screen settings.',
    inputSchema: {
      title1Name: z
        .string()
        .optional()
        .describe('Background image basename from list_assets("titles1") (the far layer)'),
      title2Name: z
        .string()
        .optional()
        .describe('Background image basename from list_assets("titles2") (drawn over title1Name)'),
      titleBgm: z
        .object({
          name: z.string().describe('Audio basename from list_assets("bgm")'),
          volume: z.number().optional().describe('Volume 0–100 (default 90)'),
          pitch: z.number().optional().describe('Pitch 50–150 (default 100)'),
          pan: z.number().optional().describe('Pan -100–100 (default 0)'),
        })
        .optional()
        .describe('BGM that plays while the title screen is shown'),
      drawTitle: z
        .boolean()
        .optional()
        .describe(
          'Whether to draw the game title text over the background art (the editor\'s "Draw Game Title" option)',
        ),
    },
    handler: async (ctx, args) => {
      const updates: Partial<TitleScreen> = {};
      if (args.title1Name !== undefined) updates.title1Name = args.title1Name;
      if (args.title2Name !== undefined) updates.title2Name = args.title2Name;
      if (args.titleBgm !== undefined) {
        updates.titleBgm = {
          name: args.titleBgm.name,
          volume: args.titleBgm.volume ?? 90,
          pitch: args.titleBgm.pitch ?? 100,
          pan: args.titleBgm.pan ?? 0,
        };
      }
      if (args.drawTitle !== undefined) updates.drawTitle = args.drawTitle;

      const [titleScreen, warnings] = await Promise.all([
        updateTitleScreen(ctx.projectPath, updates),
        titleScreenAssetWarnings(ctx.projectPath, updates),
      ]);
      return warnings.length > 0 ? { ...titleScreen, warnings } : titleScreen;
    },
  },
  {
    name: 'get_starting_position',
    description: 'Get the game starting position ({ mapId, x, y })',
    inputSchema: {},
    handler: (ctx) => getStartingPosition(ctx.projectPath),
  },
  {
    name: 'update_starting_position',
    mutates: true,
    description: 'Update the game starting position',
    inputSchema: {
      mapId: z.number().int().positive().describe('Starting map ID'),
      x: z.number().int().nonnegative().describe('Starting x tile'),
      y: z.number().int().nonnegative().describe('Starting y tile'),
    },
    handler: async (ctx, args) => {
      await updateStartingPosition(ctx.projectPath, args.mapId, args.x, args.y);
      return { success: true };
    },
  },
  {
    name: 'get_party',
    description:
      "Get the starting party — the actor ids the game begins with. Returns `{ partyMembers }`, rhyming with set_party's input/output shape.",
    inputSchema: {},
    handler: async (ctx) => ({ partyMembers: await getPartyMembers(ctx.projectPath) }),
  },
  {
    name: 'set_party',
    mutates: true,
    description:
      'Set the starting party (the actor ids the game begins with, in order). Every id must reference an existing actor.',
    inputSchema: {
      partyMembers: z
        .array(z.number().int().positive())
        .describe('Ordered actor ids for the starting party'),
    },
    handler: async (ctx, args) => {
      await updatePartyMembers(ctx.projectPath, args.partyMembers);
      return { success: true, partyMembers: args.partyMembers };
    },
  },
  {
    name: 'get_terms',
    description:
      'Get the game vocabulary/terms: the `basic`, `commands`, `params` string arrays and the `messages` map (menu labels, system messages).',
    inputSchema: {},
    handler: (ctx) => getTerms(ctx.projectPath),
  },
  {
    name: 'set_term',
    mutates: true,
    description:
      "Set one vocabulary term. For category 'basic'/'commands'/'params' the key is a numeric index (as a string); for 'messages' it's a message key (e.g. 'actorDamage'). Returns the updated terms.",
    inputSchema: {
      category: z
        .enum(['basic', 'commands', 'params', 'messages'])
        .describe('Which term group to edit'),
      key: z.string().describe('Index (for basic/commands/params) or message key (for messages)'),
      value: z.string().describe('The new term text'),
    },
    handler: (ctx, args) =>
      setTerm(ctx.projectPath, args.category as TermCategory, args.key, args.value),
  },
  {
    name: 'get_types',
    description:
      'Get one System.json type-name array — the named lists other data references by index: elements, skillTypes, weaponTypes, armorTypes, or equipTypes.',
    inputSchema: {
      category: z
        .enum(['elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes'])
        .describe('Which type-name array to read'),
    },
    handler: (ctx, args) => getTypes(ctx.projectPath, args.category as TypeCategory),
  },
  {
    name: 'set_type_name',
    mutates: true,
    description:
      'Rename one entry in a System.json type-name array (elements/skillTypes/weaponTypes/armorTypes/equipTypes). Index 0 is the conventional empty slot. Returns the updated array.',
    inputSchema: {
      category: z
        .enum(['elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes'])
        .describe('Which type-name array to edit'),
      index: z.number().int().nonnegative().describe('Index within the array (0 = empty slot)'),
      name: z.string().describe('The new type name'),
    },
    handler: (ctx, args) =>
      setTypeName(ctx.projectPath, args.category as TypeCategory, args.index, args.name),
  },
  {
    name: 'set_currency_unit',
    mutates: true,
    description: 'Set the currency unit shown next to gold amounts (e.g. "G", "Gold").',
    inputSchema: { unit: z.string().describe('The currency unit string') },
    handler: async (ctx, args) => {
      await setCurrencyUnit(ctx.projectPath, args.unit);
      return { success: true, currencyUnit: args.unit };
    },
  },
];
