import { z } from 'zod';

/**
 * The `run_playtest` step language. Each step is one object with an `action`
 * discriminator; the Zod schema doubles as the advertised JSON Schema and the
 * argument validator, so a malformed script is rejected before a browser starts.
 */

const direction = z.enum(['up', 'down', 'left', 'right']);
const itemKind = z.enum(['item', 'weapon', 'armor']);

export const loadStep = z.object({
  action: z.literal('load'),
  mapId: z.number().int().positive().describe('Map to start on.'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  direction: direction.optional().describe('Facing on arrival (default down).'),
  party: z
    .array(z.number().int().positive())
    .optional()
    .describe('Actor ids, replacing the starting party.'),
  level: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe('Set every party member to this level.'),
  gold: z.number().int().min(0).optional(),
  switches: z.array(z.number().int().positive()).optional().describe('Switch ids to turn ON.'),
  variables: z
    .record(z.string(), z.number())
    .optional()
    .describe('Variable id → value, e.g. {"3": 2}.'),
  selfSwitches: z
    .array(
      z.object({
        mapId: z.number().int().positive(),
        eventId: z.number().int().positive(),
        letter: z.enum(['A', 'B', 'C', 'D']),
        value: z.boolean().optional(),
      }),
    )
    .optional(),
  items: z
    .array(
      z.object({
        kind: itemKind.optional(),
        id: z.number().int().positive(),
        count: z.number().int().positive().optional(),
      }),
    )
    .optional()
    .describe('Inventory to add ({kind default "item", id, count default 1}).'),
  equip: z
    .array(
      z.object({
        actorId: z.number().int().positive(),
        slot: z.number().int().min(0).describe('Equip slot index (0 weapon, 1 shield, …).'),
        kind: z.enum(['weapon', 'armor']),
        id: z.number().int().positive(),
      }),
    )
    .optional(),
  encounters: z
    .boolean()
    .optional()
    .describe('Keep random encounters on (default off, so walks are deterministic).'),
});

export const playtestStep = z.discriminatedUnion('action', [
  loadStep,
  z.object({
    action: z.literal('startEvent'),
    eventId: z.number().int().positive().describe('Map event id on the current map.'),
  }),
  z.object({
    action: z.literal('advanceText'),
    maxMs: z
      .number()
      .int()
      .positive()
      .max(120000)
      .optional()
      .describe('Give up after this long (default 15000).'),
  }),
  z.object({
    action: z.literal('choose'),
    index: z.number().int().min(0).describe('0-based choice to pick in the open choice list.'),
  }),
  z.object({
    action: z.literal('walk'),
    direction,
    steps: z.number().int().min(1).max(100).optional().describe('Tiles to walk (default 1).'),
  }),
  z.object({
    action: z.literal('press'),
    button: z.enum(['ok', 'cancel', 'up', 'down', 'left', 'right', 'shift', 'pageup', 'pagedown']),
    times: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    action: z.literal('wait'),
    ms: z.number().int().min(0).max(60000),
  }),
  z.object({
    action: z.literal('autoBattle'),
    troopId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Start this troop now; omit to fight a battle an event already started.'),
    canEscape: z.boolean().optional(),
    canLose: z.boolean().optional(),
    maxMs: z
      .number()
      .int()
      .positive()
      .max(600000)
      .optional()
      .describe('Give up after this long (default 60000).'),
  }),
  z.object({
    action: z.literal('screenshot'),
    name: z.string().optional().describe('File basename (default step<N>).'),
  }),
  z.object({
    action: z.literal('eval'),
    script: z
      .string()
      .describe(
        'A JS expression evaluated in the game page; its JSON-serializable value is returned.',
      ),
  }),
]);

export type PlaytestStep = z.infer<typeof playtestStep>;
export type LoadStep = z.infer<typeof loadStep>;

/** Maximum number of steps in one script — keeps a runaway script bounded. */
export const MAX_STEPS = 200;

export const playtestSteps = z.array(playtestStep).min(1).max(MAX_STEPS);

/** Engine direction codes (2 down, 4 left, 6 right, 8 up). */
export const DIRECTION_CODE = { down: 2, left: 4, right: 6, up: 8 } as const;

/**
 * Pure pre-flight over a validated script — the checks Zod can't express.
 * Returns problems as messages (empty = runnable).
 */
export function checkSteps(steps: PlaytestStep[]): string[] {
  const problems: string[] = [];
  let loaded = false;
  steps.forEach((step, i) => {
    if (step.action === 'load') loaded = true;
    else if (!loaded && (step.action === 'startEvent' || step.action === 'walk')) {
      problems.push(
        `steps[${i}] (${step.action}) runs before any "load" step — start with {"action":"load", mapId, x, y}.`,
      );
    }
    if (step.action === 'eval' && !step.script.trim()) {
      problems.push(`steps[${i}] (eval) has an empty script.`);
    }
  });
  return problems;
}
