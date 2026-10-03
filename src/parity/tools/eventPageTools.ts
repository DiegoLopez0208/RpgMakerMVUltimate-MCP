import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath, getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, MapEvent, EventImage, MoveRoute, EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import {
  createMapEvent,
  blankEventPage,
  eventWriteGate,
  summarizeCreatedEvent,
} from './mapTools.js';
import { ValidationWarning } from '../validation/eventCommands.js';
import { PreCommit } from '../validation/gate.js';
import {
  showText,
  ShowTextOptions,
  changeGold,
  changeItems,
  changeWeapons,
  changeArmors,
  controlSelfSwitch,
  transferPlayer,
  GainOperand,
  TransferDirection,
  TransferFade,
} from '../events/commandBuilders.js';
import { refExists } from '../validation/references.js';
import { WrapMode } from '../validation/textMetrics.js';
import { showTextWrapShape } from './eventCommandTools.js';
import { assetNameWarning } from './assetTools.js';
import { summarizeEventResult } from '../utils/responseSummary.js';
import { assertMvCompatibility } from '../../utils/eventCommandValidation.js';

/** Event trigger names ↔ the on-disk `trigger` code. */
const TRIGGER_CODE = {
  action_button: 0,
  player_touch: 1,
  event_touch: 2,
  autorun: 3,
  parallel: 4,
} as const;
type TriggerName = keyof typeof TRIGGER_CODE;

/** Priority (stacking vs. the player) names ↔ the on-disk `priorityType` code. */
const PRIORITY_CODE = { below: 0, same: 1, above: 2 } as const;
type PriorityName = keyof typeof PRIORITY_CODE;

/** Autonomous movement names ↔ the on-disk `moveType` code. */
const MOVE_TYPE_CODE = { fixed: 0, random: 1, approach: 2, custom: 3 } as const;
type MoveTypeName = keyof typeof MOVE_TYPE_CODE;

/** Facing names ↔ the RPG Maker direction code. */
const DIRECTION_CODE = { down: 2, left: 4, right: 6, up: 8 } as const;
type DirectionName = keyof typeof DIRECTION_CODE;

async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  return await readJsonFile<MapData>(getMapPath(projectPath, mapId));
}

// `blankEventPage` now lives in mapTools (alongside createMapEvent and the other
// event-page primitives) to keep the module dependency one-way; re-exported here
// so existing importers of this module keep working.
export { blankEventPage };

/**
 * Warn (never throw) when a sprite `characterName` isn't among the project's
 * `img/characters` assets — a wrong sprite name is a silent runtime failure in
 * the engine. Skips the check when the name is empty (no graphic) or the asset
 * dir is empty/missing (nothing to validate against — e.g. a fixture project),
 * so it can't emit false positives. Mirrors `audioNameWarnings` in eventCommandTools.
 */
async function characterNameWarnings(
  projectPath: string,
  name: string | undefined,
): Promise<ValidationWarning[]> {
  return assetNameWarning(projectPath, 'characters', name, {
    path: 'image.characterName',
    label: 'character',
    consequence: 'a wrong filename fails silently at runtime',
  });
}

/**
 * Warn (never block) when a `create_npc` call sets no graphic at all — an NPC
 * whose whole purpose is to be a visible, talkable character is almost always a
 * mistake when invisible (F1: the Signpost NPC was created with no sprite and was
 * unfindable in-game). Scoped to `create_npc`: a bare `create_map_event` trigger
 * or a door-tile transfer legitimately has no graphic, so this doesn't fire there.
 */
function missingGraphicWarnings(characterName: string | undefined): ValidationWarning[] {
  if (characterName) return [];
  return [
    {
      path: 'image.characterName',
      code: undefined,
      message:
        'create_npc made an NPC with no graphic — it will be invisible in-game. Set a characterName from list_assets("characters"), or use create_map_event if you meant an invisible trigger/controller event.',
    },
  ];
}

/** The page-level properties `set_event_page` can change (all optional). */
export interface EventPageUpdates {
  image?: Partial<EventImage>;
  trigger?: number;
  priorityType?: number;
  through?: boolean;
  walkAnime?: boolean;
  stepAnime?: boolean;
  directionFix?: boolean;
  moveType?: number;
  moveSpeed?: number;
  moveFrequency?: number;
  moveRoute?: MoveRoute;
}

/**
 * Update one event page's properties — graphic (`image`), trigger, priority, and
 * movement — without rebuilding the whole page or touching its command `list`.
 * The `image` fields are merged onto the existing graphic (so setting just a
 * `direction` keeps the sprite); the rest overwrite. Writes through the commit
 * choke point.
 */
export async function setEventPage(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  updates: EventPageUpdates,
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }
  const event = map.events[eventId]!;

  if (!event.pages[pageIndex]) {
    throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
  }
  const page = event.pages[pageIndex];

  if (updates.image) page.image = { ...page.image, ...updates.image };
  if (updates.trigger !== undefined) page.trigger = updates.trigger;
  if (updates.priorityType !== undefined) page.priorityType = updates.priorityType;
  if (updates.through !== undefined) page.through = updates.through;
  if (updates.walkAnime !== undefined) page.walkAnime = updates.walkAnime;
  if (updates.stepAnime !== undefined) page.stepAnime = updates.stepAnime;
  if (updates.directionFix !== undefined) page.directionFix = updates.directionFix;
  if (updates.moveType !== undefined) page.moveType = updates.moveType;
  if (updates.moveSpeed !== undefined) page.moveSpeed = updates.moveSpeed;
  if (updates.moveFrequency !== undefined) page.moveFrequency = updates.moveFrequency;
  if (updates.moveRoute !== undefined) page.moveRoute = updates.moveRoute;

  event.pages.forEach(p => assertMvCompatibility(p.list));
  await precommit?.(event);

  await commitChange(getMapPath(projectPath, mapId), map);
  return event;
}

/** Coerce a loosely-typed command array into well-formed EventCommands. */
function asCommands(raw: unknown): EventCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const cmd = c as Partial<EventCommand>;
    return {
      code: cmd.code as number,
      indent: cmd.indent ?? 0,
      parameters: Array.isArray(cmd.parameters) ? cmd.parameters : [],
    };
  });
}

/** Ensure a page command list ends with the code-0 end marker (never duplicated). */
function terminated(list: EventCommand[]): EventCommand[] {
  const last = list[list.length - 1];
  if (last && last.code === 0) return list;
  return [...list, { code: 0, indent: 0, parameters: [] }];
}

/** Options for `create_npc` beyond the required position/name. */
export interface CreateNpcOptions {
  characterName?: string;
  characterIndex?: number;
  direction?: number;
  pattern?: number;
  text?: string[];
  faceName?: string;
  faceIndex?: number;
  wrap?: boolean | WrapMode;
  commands?: EventCommand[];
  trigger?: number;
  priorityType?: number;
  through?: boolean;
}

/**
 * One-shot "talking NPC" builder: create a complete, placed event on a map with a
 * single page — a graphic, a trigger, and a command list. The list comes from
 * `text` (built as a Show Text sequence) or an explicit `commands` array
 * (`commands` wins if both are given); either way it's code-0 terminated. Reuses
 * `createMapEvent` so id allocation + the commit choke point are shared.
 *
 * Defaults tuned for the common case: a solid, action-button NPC facing down —
 * `priorityType` same-as-characters, `pattern` 1 (idle frame) when a sprite is
 * set.
 */
export async function createNpc(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  name: string,
  options: CreateNpcOptions = {},
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const hasGraphic = !!options.characterName;
  const page = blankEventPage();
  page.image = {
    characterName: options.characterName ?? '',
    characterIndex: options.characterIndex ?? 0,
    direction: options.direction ?? 2,
    pattern: options.pattern ?? (hasGraphic ? 1 : 0),
    tileId: 0,
  };
  page.trigger = options.trigger ?? TRIGGER_CODE.action_button;
  page.priorityType = options.priorityType ?? PRIORITY_CODE.same;
  if (options.through !== undefined) page.through = options.through;

  if (options.commands && options.commands.length > 0) {
    page.list = terminated(asCommands(options.commands));
  } else if (options.text && options.text.length > 0) {
    const textOptions: ShowTextOptions = {
      faceName: options.faceName,
      faceIndex: options.faceIndex,
      wrap: options.wrap,
    };
    page.list = terminated(showText(options.text, textOptions));
  }

  assertMvCompatibility(page.list);
  return await createMapEvent(
    projectPath,
    mapId,
    { name, note: '', x, y, pages: [page] },
    precommit,
  );
}

// --- One-shot idiom builders: chests & transfers ----------------------------

/** What a chest hands the party when opened. */
export type ChestKind = 'item' | 'weapon' | 'armor' | 'gold';

/** The db file + label backing each non-gold chest kind. */
const CHEST_REF: Record<Exclude<ChestKind, 'gold'>, { file: string; label: string }> = {
  item: { file: 'Items.json', label: 'item' },
  weapon: { file: 'Weapons.json', label: 'weapon' },
  armor: { file: 'Armors.json', label: 'armor' },
};

/** Options for `create_chest` beyond the required position/contents. */
export interface CreateChestOptions {
  name?: string;
  id?: number;
  amount?: number;
  characterName?: string;
  characterIndex?: number;
  closedDirection?: number;
  openedDirection?: number;
  text?: string[];
  selfSwitch?: 'A' | 'B' | 'C' | 'D';
}

/** The Change Gold/Items/Weapons/Armors command that pays out a chest's contents. */
function chestGainCommand(kind: ChestKind, id: number, amount: number): EventCommand {
  const operand: GainOperand = { type: 'constant', value: amount };
  switch (kind) {
    case 'gold':
      return changeGold('increase', operand);
    case 'item':
      return changeItems(id, 'increase', operand);
    case 'weapon':
      return changeWeapons(id, 'increase', operand);
    case 'armor':
      return changeArmors(id, 'increase', operand);
  }
}

/**
 * One-shot treasure-chest builder: the two-page self-switch idiom, complete and
 * correct, in a single call.
 *
 * - **Page 1** (closed chest): action-button, priority `same` so it fires when the
 *   player *faces* it, gives the contents, then flips its self switch on.
 * - **Page 2** (opened chest): gated on that self switch, shows the opened graphic
 *   and does nothing — so the chest can never be looted twice.
 *
 * The RTP `!Chest` sheet packs the open/closed states on the *direction* rows of one
 * character block (down = closed, left/right = mid-open, up = fully open), which is
 * why the two pages differ only by `direction`.
 */
export async function createChest(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  kind: ChestKind,
  options: CreateChestOptions = {},
  precommit?: PreCommit<MapEvent>,
): Promise<MapEvent> {
  const amount = options.amount ?? 1;
  const id = options.id ?? 0;
  if (kind !== 'gold' && id <= 0) {
    throw new Error(`create_chest: an \`id\` is required for a ${kind} chest`);
  }

  // Reject a chest paying out a record that doesn't exist — the create-time throw
  // convention (matching create_item / create_enemy), not an after-the-fact audit.
  if (kind !== 'gold') {
    const { file, label } = CHEST_REF[kind];
    const records = await readJsonArraySoft(getDataPath(projectPath, file));
    if (records.length > 0 && !refExists(records, id)) {
      throw new Error(`create_chest: ${label} ${id} does not exist`);
    }
  }

  const channel = options.selfSwitch ?? 'A';
  const characterName = options.characterName ?? '';
  const characterIndex = options.characterIndex ?? 0;
  const pattern = characterName ? 1 : 0;

  const openList: EventCommand[] = [
    ...(options.text && options.text.length > 0 ? showText(options.text) : []),
    chestGainCommand(kind, id, amount),
    controlSelfSwitch(channel, 'on'),
  ];

  const closedPage = blankEventPage();
  closedPage.image = {
    characterName,
    characterIndex,
    direction: options.closedDirection ?? DIRECTION_CODE.down,
    pattern,
    tileId: 0,
  };
  closedPage.trigger = TRIGGER_CODE.action_button;
  // Priority `same` is load-bearing: an action-button event on a `below` page only
  // fires when the player stands *on* it, which a solid chest never allows.
  closedPage.priorityType = PRIORITY_CODE.same;
  closedPage.list = terminated(openList);

  const openedPage = blankEventPage();
  openedPage.conditions = {
    ...openedPage.conditions,
    selfSwitchValid: true,
    selfSwitchCh: channel,
  };
  openedPage.image = {
    characterName,
    characterIndex,
    direction: options.openedDirection ?? DIRECTION_CODE.up,
    pattern,
    tileId: 0,
  };
  openedPage.trigger = TRIGGER_CODE.action_button;
  openedPage.priorityType = PRIORITY_CODE.same;

  return await createMapEvent(
    projectPath,
    mapId,
    {
      name: options.name ?? 'Chest',
      note: '',
      x,
      y,
      pages: [closedPage, openedPage],
    },
    precommit,
  );
}

/** How the player activates a transfer event. */
export type TransferIdiom = 'action_button' | 'player_touch';

/** Options for `create_transfer` beyond the required source/target positions. */
export interface CreateTransferOptions {
  name?: string;
  idiom?: TransferIdiom;
  direction?: TransferDirection;
  fade?: TransferFade;
  characterName?: string;
  characterIndex?: number;
}

/**
 * One-shot map-transfer builder covering the two idioms that actually work:
 *
 * - **`action_button`** (default): a priority-`same` event the player faces and
 *   presses — the right shape for a solid landmark (building, dungeon mouth, door).
 * - **`player_touch`**: an invisible priority-`below` doormat the player steps onto —
 *   for interior exits and map-edge gaps.
 *
 * Throws if the destination map doesn't exist, and warns when the destination tile
 * is outside that map's bounds (the player would land nowhere).
 */
export async function createTransfer(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  targetMapId: number,
  targetX: number,
  targetY: number,
  options: CreateTransferOptions = {},
  precommit?: PreCommit<MapEvent>,
): Promise<{ event: MapEvent; warnings: ValidationWarning[] }> {
  const mapInfos = await readJsonArraySoft(getDataPath(projectPath, 'MapInfos.json'));
  if (mapInfos.length > 0 && !refExists(mapInfos, targetMapId)) {
    throw new Error(`create_transfer: target map ${targetMapId} does not exist`);
  }

  const warnings: ValidationWarning[] = [];
  try {
    const target = await getMap(projectPath, targetMapId);
    if (targetX < 0 || targetY < 0 || targetX >= target.width || targetY >= target.height) {
      warnings.push({
        path: 'targetX/targetY',
        message: `destination (${targetX}, ${targetY}) is outside map ${targetMapId}'s ${target.width}x${target.height} bounds — the player would land off-map`,
      });
    }
  } catch {
    // Unreadable target map file: the MapInfos check above already covers the
    // "map doesn't exist" case, so fail soft rather than block the write.
  }

  const idiom = options.idiom ?? 'action_button';
  const characterName = options.characterName ?? '';

  const page = blankEventPage();
  page.image = {
    characterName,
    characterIndex: options.characterIndex ?? 0,
    direction: DIRECTION_CODE.down,
    pattern: characterName ? 1 : 0,
    tileId: 0,
  };
  page.trigger = idiom === 'player_touch' ? TRIGGER_CODE.player_touch : TRIGGER_CODE.action_button;
  // An action-button transfer is meant to fire from the player *facing* a solid
  // landmark, which needs `same`; a doormat is walked onto, so it stays `below`.
  page.priorityType = idiom === 'player_touch' ? PRIORITY_CODE.below : PRIORITY_CODE.same;
  page.list = terminated([
    transferPlayer(targetMapId, targetX, targetY, {
      direction: options.direction ?? 'retain',
      fade: options.fade ?? 'black',
    }),
  ]);

  const event = await createMapEvent(
    projectPath,
    mapId,
    {
      name: options.name ?? 'Transfer',
      note: '',
      x,
      y,
      pages: [page],
    },
    precommit,
  );

  return { event, warnings };
}

export const eventPageToolDefinitions: ToolDefinition[] = [
  {
    name: 'set_event_page',
    mutates: true,
    summarize: summarizeEventResult,
    forceable: true,
    description:
      "Update an existing event page's graphic and behavior in one call, without rebuilding the whole page or touching its command list: sprite (characterName/characterIndex/direction/pattern or a tileId), trigger, priority, movement (type/speed/frequency/route), and the through/walkAnime/stepAnime/directionFix flags. Graphic fields merge onto the current image; warns (never blocks) on an unknown characterName. Refuses the write if the change would leave the event unreachable (an action-button page with priority `below` on an impassable tile) — pass force: true to override.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
      pageIndex: z.number().int().min(0).describe('Zero-based page index'),
      characterName: z
        .string()
        .optional()
        .describe('Sprite sheet basename (from list_assets("characters")); "" = no sprite'),
      characterIndex: z.number().int().min(0).max(7).optional().describe('Sprite index 0–7 in the sheet'),
      direction: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing direction of the sprite'),
      pattern: z.number().int().min(0).max(2).optional().describe('Sprite animation frame 0–2 (1 = idle)'),
      tileId: z
        .number()
        .int()
        .optional()
        .describe('Use a tile as the graphic instead of a sprite (0 = none)'),
      trigger: z
        .enum(['action_button', 'player_touch', 'event_touch', 'autorun', 'parallel'])
        .optional()
        .describe('What starts the page'),
      priority: z
        .enum(['below', 'same', 'above'])
        .optional()
        .describe('Stacking vs. the player: below/same/above characters (same = solid)'),
      through: z.boolean().optional().describe('Let the player/others pass through the event'),
      walkAnime: z.boolean().optional().describe('Animate the walk cycle while moving'),
      stepAnime: z.boolean().optional().describe('Animate in place while stopped'),
      directionFix: z.boolean().optional().describe('Lock the facing direction'),
      moveType: z
        .enum(['fixed', 'random', 'approach', 'custom'])
        .optional()
        .describe('Autonomous movement (custom uses moveRoute)'),
      moveSpeed: z.number().int().min(1).max(6).optional().describe('Movement speed 1–6 (4 = normal)'),
      moveFrequency: z.number().int().min(1).max(5).optional().describe('Movement frequency 1–5 (3 = normal)'),
      moveRoute: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Autonomous move route (from create_move_route); pairs with moveType "custom"'),
      indent: z.number().int().min(0).max(100).optional().describe('(unused; page-level tool)'),
    },
    handler: async (ctx, args) => {
      const image: Partial<EventImage> = {};
      if (args.characterName !== undefined) image.characterName = args.characterName;
      if (args.characterIndex !== undefined) image.characterIndex = args.characterIndex;
      if (args.direction !== undefined)
        image.direction = DIRECTION_CODE[args.direction as DirectionName];
      if (args.pattern !== undefined) image.pattern = args.pattern;
      if (args.tileId !== undefined) image.tileId = args.tileId;

      const updates: EventPageUpdates = {
        image: Object.keys(image).length > 0 ? image : undefined,
        trigger: args.trigger !== undefined ? TRIGGER_CODE[args.trigger as TriggerName] : undefined,
        priorityType:
          args.priority !== undefined ? PRIORITY_CODE[args.priority as PriorityName] : undefined,
        through: args.through,
        walkAnime: args.walkAnime,
        stepAnime: args.stepAnime,
        directionFix: args.directionFix,
        moveType:
          args.moveType !== undefined ? MOVE_TYPE_CODE[args.moveType as MoveTypeName] : undefined,
        moveSpeed: args.moveSpeed,
        moveFrequency: args.moveFrequency,
        moveRoute: args.moveRoute as MoveRoute | undefined,
      };

      const gate = eventWriteGate(
        ctx.projectPath,
        args.mapId,
        args.force,
        await characterNameWarnings(ctx.projectPath, args.characterName),
      );
      const event = await setEventPage(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.pageIndex,
        updates,
        gate.precommit,
      );
      return gate.respond({ event });
    },
  },
  {
    name: 'create_npc',
    mutates: true,
    forceable: true,
    description:
      'Create a complete, placed NPC event on a map in one call — a graphic + trigger + a talk list. Provide `text` (built into a Show Text sequence, with an optional face; `wrap: true` word-wraps paragraphs into 4-line message boxes) or an explicit `commands` array (commands wins if both given). Defaults to a solid, action-button NPC facing down. Warns (never blocks) on an unknown characterName, and on NO graphic at all (an NPC with no characterName is invisible in-game — use create_map_event for an intentionally-invisible trigger). The one-shot "make a talking NPC that says X" primitive.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to place the NPC on'),
      x: z.number().int().describe('X tile position'),
      y: z.number().int().describe('Y tile position'),
      name: z.string().describe('Event name (editor label)'),
      characterName: z
        .string()
        .optional()
        .describe('Sprite sheet basename (from list_assets("characters"))'),
      characterIndex: z.number().int().min(0).max(7).optional().describe('Sprite index 0–7 in the sheet'),
      direction: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing direction (default down)'),
      pattern: z
        .number()
        .int()
        .optional()
        .describe('Sprite frame 0–2 (default 1 = idle when a sprite is set)'),
      text: z
        .array(z.string())
        .optional()
        .describe('Dialogue lines shown when the NPC is triggered (built as Show Text)'),
      faceName: z
        .string()
        .optional()
        .describe('text: face image basename (from list_assets("faces"))'),
      faceIndex: z.number().int().min(0).max(7).optional().describe('text: face index 0–7'),
      wrap: showTextWrapShape,
      commands: z
        .array(
          z.object({
            code: z.number().int().describe('Event command code'),
            indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
            parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
          }),
        )
        .optional()
        .describe('Explicit command list (from the build_* tools); overrides `text` if given'),
      trigger: z
        .enum(['action_button', 'player_touch', 'event_touch', 'autorun', 'parallel'])
        .optional()
        .describe('What starts the event (default action_button)'),
      priority: z
        .enum(['below', 'same', 'above'])
        .optional()
        .describe('Stacking vs. the player (default same = solid)'),
      through: z.boolean().optional().describe('Let the player pass through (default false)'),
    },
    handler: async (ctx, args) => {
      const options: CreateNpcOptions = {
        characterName: args.characterName,
        characterIndex: args.characterIndex,
        direction:
          args.direction !== undefined
            ? DIRECTION_CODE[args.direction as DirectionName]
            : undefined,
        pattern: args.pattern,
        text: args.text as string[] | undefined,
        faceName: args.faceName,
        faceIndex: args.faceIndex,
        wrap: args.wrap,
        commands: args.commands !== undefined ? asCommands(args.commands) : undefined,
        trigger: args.trigger !== undefined ? TRIGGER_CODE[args.trigger as TriggerName] : undefined,
        priorityType:
          args.priority !== undefined ? PRIORITY_CODE[args.priority as PriorityName] : undefined,
        through: args.through,
      };
      const gate = eventWriteGate(ctx.projectPath, args.mapId, args.force, [
        ...missingGraphicWarnings(args.characterName),
        ...(await characterNameWarnings(ctx.projectPath, args.characterName)),
      ]);
      const event = await createNpc(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.name,
        options,
        gate.precommit,
      );
      // Return a compact summary, not the full event with every defaulted page
      // field — a huge token cost on every NPC (re-read via get_map_event).
      return gate.respond({ event: summarizeCreatedEvent(event) });
    },
  },
  {
    name: 'create_chest',
    mutates: true,
    forceable: true,
    description:
      'Create a complete, placed treasure chest on a map in one call — the two-page self-switch idiom done correctly, so the chest can never be looted twice. Page 1 (closed) is an action-button, priority-`same` event that optionally shows `text`, gives the contents, then flips its self switch; page 2 (opened) is gated on that self switch, shows the opened graphic and does nothing. `kind` picks the payout: item/weapon/armor (needs `id`) or gold. On the RTP `!Chest` sheet the open/closed states are the *direction* rows of one character block (down = closed, up = open), which is what closedDirection/openedDirection default to. Throws if the item/weapon/armor `id` does not exist; warns (never blocks) on an unknown characterName or a chest with no graphic.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to place the chest on'),
      x: z.number().int().min(0).describe('X tile position'),
      y: z.number().int().min(0).describe('Y tile position'),
      kind: z
        .enum(['item', 'weapon', 'armor', 'gold'])
        .describe('What the chest gives; item/weapon/armor require `id`'),
      id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The item/weapon/armor ID to give (omit for kind "gold")'),
      amount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How many (or how much gold) to give; default 1'),
      name: z.string().optional().describe('Event name (editor label); default "Chest"'),
      characterName: z
        .string()
        .optional()
        .describe('Chest sprite basename from list_assets("characters"), e.g. "!Chest"'),
      characterIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Which chest in the sheet (0-7); default 0'),
      closedDirection: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Direction row showing the CLOSED chest; default "down"'),
      openedDirection: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Direction row showing the OPENED chest; default "up"'),
      text: z
        .array(z.string())
        .optional()
        .describe('Optional message shown on opening, e.g. ["Found a Potion!"]'),
      selfSwitch: z
        .enum(['A', 'B', 'C', 'D'])
        .optional()
        .describe('Self switch channel marking the chest looted; default "A"'),
    },
    handler: async (ctx, args) => {
      const options: CreateChestOptions = {
        name: args.name,
        id: args.id,
        amount: args.amount,
        characterName: args.characterName,
        characterIndex: args.characterIndex,
        closedDirection:
          args.closedDirection !== undefined
            ? DIRECTION_CODE[args.closedDirection as DirectionName]
            : undefined,
        openedDirection:
          args.openedDirection !== undefined
            ? DIRECTION_CODE[args.openedDirection as DirectionName]
            : undefined,
        text: args.text as string[] | undefined,
        selfSwitch: args.selfSwitch as 'A' | 'B' | 'C' | 'D' | undefined,
      };
      const gate = eventWriteGate(ctx.projectPath, args.mapId, args.force, [
        ...missingGraphicWarnings(args.characterName),
        ...(await characterNameWarnings(ctx.projectPath, args.characterName)),
      ]);
      const event = await createChest(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.kind as ChestKind,
        options,
        gate.precommit,
      );
      return gate.respond({ event: summarizeCreatedEvent(event) });
    },
  },
  {
    name: 'create_transfer',
    mutates: true,
    forceable: true,
    description:
      'Create a complete, placed map-transfer event in one call, using whichever of the two working idioms you pick. `idiom: "action_button"` (default) makes a priority-`same` event the player faces and presses — the right shape for a solid landmark (building, dungeon mouth, door); `idiom: "player_touch"` makes an invisible priority-`below` doormat the player walks onto — for interior exits and map-edge gaps. `direction` is the facing the player lands with, `fade` the screen transition. Throws if the destination map does not exist; warns if the destination tile is outside that map, if the characterName is unknown, or if the event can never fire from where it sits.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map the trigger is placed on'),
      x: z.number().int().min(0).describe('X tile position of the trigger'),
      y: z.number().int().min(0).describe('Y tile position of the trigger'),
      targetMapId: z.number().int().positive().describe('The ID of the destination map'),
      targetX: z.number().int().min(0).describe('X tile the player lands on'),
      targetY: z.number().int().min(0).describe('Y tile the player lands on'),
      idiom: z
        .enum(['action_button', 'player_touch'])
        .optional()
        .describe(
          'action_button = face a solid landmark and press (priority same, default); player_touch = walk onto a doormat (priority below)',
        ),
      name: z.string().optional().describe('Event name (editor label); default "Transfer"'),
      direction: z
        .enum(['retain', 'down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing after the transfer; default "retain"'),
      fade: z
        .enum(['black', 'white', 'none'])
        .optional()
        .describe('Screen fade during the transfer; default "black"'),
      characterName: z
        .string()
        .optional()
        .describe('Optional sprite basename (a doormat is normally left invisible)'),
      characterIndex: z.number().int().min(0).optional().describe('Sprite index 0-7 in the sheet'),
    },
    handler: async (ctx, args) => {
      const options: CreateTransferOptions = {
        name: args.name,
        idiom: args.idiom as TransferIdiom | undefined,
        direction: args.direction as TransferDirection | undefined,
        fade: args.fade as TransferFade | undefined,
        characterName: args.characterName,
        characterIndex: args.characterIndex,
      };
      const gate = eventWriteGate(
        ctx.projectPath,
        args.mapId,
        args.force,
        await characterNameWarnings(ctx.projectPath, args.characterName),
      );
      const { event, warnings: transferWarnings } = await createTransfer(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.targetMapId,
        args.targetX,
        args.targetY,
        options,
        gate.precommit,
      );
      // createTransfer's own findings (destination bounds, graphic) are advisory,
      // so they only need to reach the response — not the gate's block decision.
      gate.warnings.push(...transferWarnings);
      return gate.respond({ event: summarizeCreatedEvent(event) });
    },
  },
];
