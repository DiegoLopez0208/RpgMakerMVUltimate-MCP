import { z } from 'zod';
import { readJsonFile, getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, MapEvent, EventCommand, MoveCommand, MoveRoute } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { validateMoveRoute } from '../validation/moveCommands.js';
import { validateEvent } from '../validation/eventCommands.js';
import { PreCommit, writeGate } from '../validation/gate.js';
import { validateEventCommands, assertMvCompatibility } from '../../utils/eventCommandValidation.js';

/** Event command code for "Set Movement Route" (force a character along a route). */
const SET_MOVEMENT_ROUTE_CODE = 205;
/** Continuation command code the editor writes per move step under a 205. */
const MOVE_ROUTE_STEP_CODE = 505;

/** Move-route command codes used by the named-pattern builders. */
const ROUTE_END = 0;
const ROUTE_MOVE_RANDOM = 9;
const ROUTE_MOVE_TOWARD = 10;
const ROUTE_MOVE_AWAY = 11;

/** A cardinal direction's "move" move-command code (Game_Character ROUTE_MOVE_*). */
const DIR_MOVE: Record<string, number> = { down: 1, left: 2, right: 3, up: 4 };
/** The opposite direction's move code — used to walk a patrol back to its start. */
const DIR_OPPOSITE: Record<string, number> = { down: 4, up: 1, left: 3, right: 2 };

/** Build a single move command with an always-present parameters array. */
function mc(code: number, ...parameters: unknown[]): MoveCommand {
  return { code, parameters };
}

/** Whether a pattern loops by default (a patrol/wander repeats; a one-shot does not). */
const REPEAT_BY_DEFAULT: Record<string, boolean> = {
  patrol: true,
  approach: true,
  flee: true,
  wander: true,
  custom: false,
};

export type MovePattern = 'patrol' | 'approach' | 'flee' | 'wander' | 'custom';

export interface MoveRouteOptions {
  /** Primary direction for `patrol` (walks there and back). Default `right`. */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Step count for `patrol` (each leg). Default 3. */
  steps?: number;
  /** Raw move commands for `custom`. */
  commands?: MoveCommand[];
  /** Loop the route. Defaults per pattern (see REPEAT_BY_DEFAULT). */
  repeat?: boolean;
  /** Skip the step if movement is blocked. Default false. */
  skippable?: boolean;
  /** Wait for the route to finish before continuing the event. Default false. */
  wait?: boolean;
}

/** Build the move-command list (without the Route-End terminator) for a pattern. */
function patternList(pattern: MovePattern, options: MoveRouteOptions): MoveCommand[] {
  switch (pattern) {
    case 'patrol': {
      const direction = options.direction ?? 'right';
      const steps = options.steps ?? 3;
      const forward = DIR_MOVE[direction];
      const back = DIR_OPPOSITE[direction];
      if (forward === undefined) {
        throw new Error(`Unknown patrol direction: ${direction}`);
      }
      if (!Number.isInteger(steps) || steps <= 0) {
        throw new Error(`patrol steps must be a positive integer (got ${steps})`);
      }
      return [
        ...Array.from({ length: steps }, () => mc(forward)),
        ...Array.from({ length: steps }, () => mc(back)),
      ];
    }
    case 'approach':
      return [mc(ROUTE_MOVE_TOWARD)];
    case 'flee':
      return [mc(ROUTE_MOVE_AWAY)];
    case 'wander':
      return [mc(ROUTE_MOVE_RANDOM)];
    case 'custom': {
      const commands = options.commands ?? [];
      if (commands.length === 0) {
        throw new Error('custom pattern requires a non-empty `commands` array');
      }
      // Normalize each to a { code, parameters } shape and drop any terminator
      // the caller included (createMoveRoute re-adds exactly one).
      return commands
        .filter((c) => c.code !== ROUTE_END)
        .map((c) => mc(c.code, ...(Array.isArray(c.parameters) ? c.parameters : [])));
    }
  }
}

/**
 * Build a MoveRoute from a named pattern instead of hand-rolling raw move codes.
 * The returned route is terminated by the Route-End marker (code 0) and can be
 * used two ways: as an event page's autonomous `moveRoute` (via update_map_event
 * with moveType 3), or as the forced route inserted by {@link setMovementRoute}.
 * Pure (no I/O) so the shape is unit-testable.
 */
export function createMoveRoute(pattern: MovePattern, options: MoveRouteOptions = {}): MoveRoute {
  const list = patternList(pattern, options);
  list.push(mc(ROUTE_END));
  return {
    list,
    repeat: options.repeat ?? REPEAT_BY_DEFAULT[pattern],
    skippable: options.skippable ?? false,
    wait: options.wait ?? false,
  };
}

/** Coerce an arbitrary route object into a well-formed, terminated MoveRoute. */
function normalizeRoute(route: MoveRoute): MoveRoute {
  const list = (Array.isArray(route.list) ? route.list : []).map((c) =>
    mc(c.code, ...(Array.isArray(c.parameters) ? c.parameters : [])),
  );
  // A move route only functions if it ends with the Route-End marker.
  if (list.length === 0 || list[list.length - 1].code !== ROUTE_END) {
    list.push(mc(ROUTE_END));
  }
  return {
    list,
    repeat: route.repeat ?? false,
    skippable: route.skippable ?? false,
    wait: route.wait ?? false,
  };
}

/**
 * Build the event-command sequence the editor writes for a forced "Set Movement
 * Route" (command 205): the 205 carrying the full route in its parameters, then
 * one 505 continuation row per move step (including the terminator) so the editor
 * can display and re-edit the route. Both the runtime (reads the 205) and the
 * editor (reads the 505 rows) stay happy.
 */
export function moveRouteCommands(
  characterId: number,
  route: MoveRoute,
  indent = 0,
): EventCommand[] {
  const normalized = normalizeRoute(route);
  const commands: EventCommand[] = [
    { code: SET_MOVEMENT_ROUTE_CODE, indent, parameters: [characterId, normalized] },
  ];
  for (const step of normalized.list) {
    commands.push({ code: MOVE_ROUTE_STEP_CODE, indent, parameters: [step] });
  }
  return commands;
}

async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  return await readJsonFile<MapData>(getMapPath(projectPath, mapId));
}

/**
 * Insert a forced "Set Movement Route" (command 205 + its 505 continuation rows)
 * into an event page's command list, so the character moves as part of that page's
 * event processing. Writes through the commit choke point. `characterId`: -1 =
 * player, 0 = this event, N = event id N on the map.
 */
export async function setMovementRoute(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  characterId: number,
  route: MoveRoute,
  indent = 0,
  position?: number,
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
  const commandList = event.pages[pageIndex].list;
  const validated = validateEventCommands(commandList);
  const insertAt = position ?? commandList.length - 1;
  const targetIndent = validated.insertionPoints.get(insertAt);
  if (targetIndent === undefined) throw new Error(`position ${insertAt} is not a safe event-command insertion boundary`);
  if (indent !== 0 && indent !== targetIndent) throw new Error('indent does not match the insertion boundary');
  const commands = moveRouteCommands(characterId, route, targetIndent);
  commandList.splice(insertAt, 0, ...commands);

  assertMvCompatibility(commandList);
  await precommit?.(event);

  await commitChange(getMapPath(projectPath, mapId), map);
  return event;
}

/**
 * The pre-commit gate `set_movement_route` installs: the move route's own
 * findings plus the resulting page's, with a structural problem in either
 * refusing the write before it happens.
 */
function moveWriteGate(
  force: boolean | undefined,
  route: MoveRoute,
): ReturnType<typeof writeGate<MapEvent>> {
  return writeGate<MapEvent>(force, 'movement route', (event) => [
    ...validateMoveRoute(route, `event ${event.id} move route`),
    ...validateEvent(event).warnings,
  ]);
}

/** Zod shape for a raw move command (parameters optional; defaulted to []). */
const moveCommandShape = z.object({
  code: z.number().int().describe('Move-route command code (Game_Character ROUTE_*)'),
  parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
});

/** Zod shape for a move route object (e.g. the output of create_move_route). */
const moveRouteShape = z.object({
  list: z.array(moveCommandShape).describe('Move commands; auto-terminated with code 0 if missing'),
  repeat: z.boolean().optional(),
  skippable: z.boolean().optional(),
  wait: z.boolean().optional(),
});

export const moveToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_move_route',
    requiresProject: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Build a movement route from a named pattern (patrol/approach/flee/wander/custom) instead of raw move-command codes. Read-only: returns { moveRoute, warnings? }. Use the route as an event page’s autonomous moveRoute (update_map_event with moveType 3), or feed it to set_movement_route for a forced route in an event command list.',
    inputSchema: {
      pattern: z
        .enum(['patrol', 'approach', 'flee', 'wander', 'custom'])
        .describe(
          'patrol (walk a direction and back), approach (toward player), flee (away from player), wander (random), or custom (your own move commands)',
        ),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('patrol only: primary direction, walked out and back (default right)'),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('patrol only: steps per leg (default 3)'),
      commands: z
        .array(moveCommandShape)
        .optional()
        .describe('custom only: raw move commands { code, parameters }'),
      repeat: z.boolean().optional().describe('Loop the route (patterns loop by default)'),
      skippable: z.boolean().optional().describe('Skip a step when movement is blocked'),
      wait: z.boolean().optional().describe('Wait for the route to finish before continuing'),
    },
    handler: async (_ctx, args) => {
      const route = createMoveRoute(args.pattern as MovePattern, {
        direction: args.direction,
        steps: args.steps,
        commands: args.commands as MoveCommand[] | undefined,
        repeat: args.repeat,
        skippable: args.skippable,
        wait: args.wait,
      });
      const warnings = validateMoveRoute(route);
      return warnings.length > 0 ? { moveRoute: route, warnings } : { moveRoute: route };
    },
  },
  {
    name: 'set_movement_route',
    mutates: true,
    forceable: true,
    description:
      'Insert a forced "Set Movement Route" (event command 205, plus the 505 continuation rows the editor expects) into an event page’s command list, moving a character as part of that page. characterId: -1 player, 0 this event, N event id. Pass a moveRoute from create_move_route. A structurally invalid route or page refuses the write (nothing is saved) — pass force: true to override.',
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map'),
      eventId: z.number().int().positive().describe('The ID of the event'),
      pageIndex: z.number().int().min(0).describe('Zero-based page index'),
      characterId: z
        .number()
        .int()
        .describe('Target character: -1 player, 0 this event, N event id on the map'),
      moveRoute: moveRouteShape.describe('The move route to force (e.g. from create_move_route)'),
      indent: z.number().int().min(0).max(100).optional().describe('Indentation level in the list (default 0)'),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Insertion index; defaults to the end of the list'),
    },
    handler: async (ctx, args) => {
      // Normalize before gating: the gate must judge the route as written (with the
      // auto-appended Route-End the schema promises), not the raw caller input.
      const route = normalizeRoute(args.moveRoute as MoveRoute);
      const gate = moveWriteGate(args.force, route);
      const event = await setMovementRoute(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.pageIndex,
        args.characterId,
        route,
        args.indent ?? 0,
        args.position,
        gate.precommit,
      );
      return gate.respond({ event });
    },
  },
];
