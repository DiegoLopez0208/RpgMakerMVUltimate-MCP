import { z } from 'zod';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { assertMvCompatibility } from '../../utils/eventCommandValidation.js';
import { CommonEvent, EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { summarizeCommonEventResult } from '../utils/responseSummary.js';
import { definedOnly } from '../utils/records.js';
import { validateCommandList } from '../validation/eventCommands.js';
import { PreCommit, writeGate } from '../validation/gate.js';

/** Command code for "Common Event" (call a common event from an event page). */
const CALL_COMMON_EVENT_CODE = 117;

/**
 * A blank common event mirroring what the RPG Maker MV editor writes for a fresh
 * slot: no trigger (call-only), switch 1, and an empty (just the code-0 end
 * marker) command list. Pure so the template shape can be unit-tested. Field
 * order mirrors the editor's on-disk shape.
 */
export function defaultCommonEvent(): Omit<CommonEvent, 'id'> {
  return {
    list: [{ code: 0, indent: 0, parameters: [] }],
    name: '',
    switchId: 1,
    trigger: 0,
  };
}

/**
 * The pre-commit gate the common-event-writing tools install. A common event's
 * `list` reuses the event-command format, so the same command validator applies
 * — and a structurally invalid list is refused before the write rather than
 * saved and warned about.
 */
function commonEventWriteGate(
  force: boolean | undefined,
): ReturnType<typeof writeGate<CommonEvent>> {
  return writeGate<CommonEvent>(force, 'common event', (commonEvent) =>
    validateCommandList(commonEvent.list, `common event ${commonEvent.id}`),
  );
}

/** Get all common events from the project (`data/CommonEvents.json`). */
export async function getCommonEvents(projectPath: string): Promise<(CommonEvent | null)[]> {
  return await readJsonFile<(CommonEvent | null)[]>(getDataPath(projectPath, 'CommonEvents.json'));
}

/**
 * Create a new common event. Only `name` is required; any omitted field falls
 * back to the editor's new-slot default (see {@link defaultCommonEvent}).
 * Allocates the next unused id (max existing + 1) and writes through the commit
 * choke point.
 */
export async function createCommonEvent(
  projectPath: string,
  overrides: { name: string } & Partial<Omit<CommonEvent, 'id' | 'name'>>,
  precommit?: PreCommit<CommonEvent>,
): Promise<CommonEvent> {
  const commonEvents = await getCommonEvents(projectPath);
  const maxId = commonEvents.reduce((max, ce) => (ce && ce.id > max ? ce.id : max), 0);

  // Template first, caller's defined fields next, computed id last so it always wins.
  const commonEvent: CommonEvent = {
    ...defaultCommonEvent(),
    ...definedOnly(overrides),
    id: maxId + 1,
  };

  commonEvents[commonEvent.id] = commonEvent;

  assertMvCompatibility(commonEvent.list);
  await precommit?.(commonEvent);

  await commitChange(getDataPath(projectPath, 'CommonEvents.json'), commonEvents);
  return commonEvent;
}

/** Update an existing common event's properties (shallow merge; id re-pinned). */
export async function updateCommonEvent(
  projectPath: string,
  commonEventId: number,
  updates: Partial<CommonEvent>,
  precommit?: PreCommit<CommonEvent>,
): Promise<CommonEvent> {
  const commonEvents = await getCommonEvents(projectPath);
  const index = commonEvents.findIndex((ce) => ce && ce.id === commonEventId);
  if (index === -1) {
    throw new Error(`Common event with ID ${commonEventId} not found`);
  }

  commonEvents[index] = { ...commonEvents[index]!, ...updates, id: commonEventId };

  assertMvCompatibility(commonEvents[index]!.list);
  await precommit?.(commonEvents[index]!);

  await commitChange(getDataPath(projectPath, 'CommonEvents.json'), commonEvents);
  return commonEvents[index]!;
}

/**
 * Build a "Common Event" event command (code 117) that calls the given common
 * event — the helper for wiring shared logic into a map/battle event page via
 * `add_event_command`. Validates that the referenced common event exists (throws
 * otherwise, mirroring create_map's parent check).
 */
export async function callCommonEvent(
  projectPath: string,
  commonEventId: number,
  indent = 0,
): Promise<EventCommand> {
  const commonEvents = await getCommonEvents(projectPath);
  if (!commonEvents.some((ce) => ce && ce.id === commonEventId)) {
    throw new Error(`Common event with ID ${commonEventId} does not exist`);
  }
  return { code: CALL_COMMON_EVENT_CODE, indent, parameters: [commonEventId] };
}

export const commonEventToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_common_event',
    mutates: true,
    forceable: true,
    summarize: summarizeCommonEventResult,
    description:
      "Create a new common event (reusable event-command list) in data/CommonEvents.json. Only `name` is required; omitted fields use the editor's new-slot defaults (empty command list, trigger 0 = call-only, switchId 1). Allocates and returns the next unused id. A structurally invalid command list refuses the write (nothing is saved) — pass force: true to override.",
    inputSchema: {
      name: z.string().describe('Common event name shown in the database'),
      trigger: z
        .number()
        .int()
        .optional()
        .describe('How it runs on its own: 0 None (call-only), 1 Autorun, 2 Parallel'),
      switchId: z
        .number()
        .int()
        .optional()
        .describe('Switch that gates an Autorun/Parallel trigger (ignored when trigger is 0)'),
      list: z
        .array(z.unknown())
        .optional()
        .describe('Event-command list { code, indent, parameters }; must end with code 0'),
    },
    handler: async (ctx, args) => {
      // dryRun/force are dispatcher arguments, not common-event fields — strip
      // them so they can't leak into the record via the spread below.
      const { dryRun: _dryRun, force, ...overrides } = args;
      const gate = commonEventWriteGate(force);
      const commonEvent = await createCommonEvent(
        ctx.projectPath,
        overrides as { name: string } & Partial<Omit<CommonEvent, 'id' | 'name'>>,
        gate.precommit,
      );
      return gate.respond({ commonEvent });
    },
  },
  {
    name: 'update_common_event',
    mutates: true,
    forceable: true,
    summarize: summarizeCommonEventResult,
    description:
      "Update a common event's properties (shallow merge into the existing record). Use for name, trigger, switchId, or to replace the whole command list. A structurally invalid command list refuses the write (nothing is saved) — pass force: true to override.",
    inputSchema: {
      commonEventId: z.number().int().positive().describe('The ID of the common event to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe(
          'Object containing common event properties to update (name, trigger, switchId, list)',
        ),
    },
    handler: async (ctx, args) => {
      const gate = commonEventWriteGate(args.force);
      const commonEvent = await updateCommonEvent(
        ctx.projectPath,
        args.commonEventId,
        args.updates,
        gate.precommit,
      );
      return gate.respond({ commonEvent });
    },
  },
  {
    name: 'call_common_event',
    description:
      'Build a "Common Event" event command (code 117) that calls the given common event, for insertion into an event page via insert_event_commands. Validates the common event exists. Read-only: returns `{ command }` (matching the build_* tools, so it composes into a thenBranch/commands array); writes nothing.',
    inputSchema: {
      commonEventId: z
        .number()
        .int()
        .positive()
        .describe('The ID of the common event to call (must exist)'),
      indent: z
        .number()
        .int()
        .optional()
        .describe('Indentation level in the target list (default 0)'),
    },
    handler: async (ctx, args) => ({
      command: await callCommonEvent(ctx.projectPath, args.commonEventId, args.indent),
    }),
  },
];
