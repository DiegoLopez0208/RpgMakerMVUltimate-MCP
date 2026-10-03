import { z } from 'zod';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { State } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { definedOnly } from '../utils/records.js';

/**
 * Blank state mirroring what the RPG Maker MV editor writes for a freshly-created
 * state: no restriction, priority 50, no auto-removal, 1-turn min/max, no
 * messages/icon/traits. Pure so the template shape can be unit-tested. There is no
 * canonical "blank" state in the editor's newdata template (all 30 samples are
 * hand-tuned), so this reproduces the editor's "New State" default field values.
 */
export function defaultState(): Omit<State, 'id'> {
  return {
    name: '',
    restriction: 0,
    priority: 50,
    motion: 0,
    overlay: 0,
    removeAtBattleEnd: false,
    removeByRestriction: false,
    autoRemovalTiming: 0,
    minTurns: 1,
    maxTurns: 1,
    removeByDamage: false,
    chanceByDamage: 100,
    removeByWalking: false,
    stepsToRemove: 100,
    releaseByDamage: false,
    iconIndex: 0,
    message1: '',
    message2: '',
    message3: '',
    message4: '',
    traits: [],
    note: '',
  };
}

/** Get all states from the project. */
export async function getStates(projectPath: string): Promise<(State | null)[]> {
  return await readJsonFile<(State | null)[]>(getDataPath(projectPath, 'States.json'));
}

/**
 * Create a new state. Only `name` is required; any omitted field falls back to
 * the editor's new-state default (see {@link defaultState}). Allocates the next
 * unused id (max existing + 1) and writes through the commit choke point.
 */
/**
 * Build one new state record against the current array — the shared per-record
 * source of truth for both `create_state` and `batch_create`. Pure: template
 * first, caller's defined fields next, computed id last so it always wins.
 */
export function buildStateRecord(
  existing: (State | null)[],
  input: Partial<Omit<State, 'id'>>,
): State {
  const maxId = existing.reduce((max, s) => (s && s.id > max ? s.id : max), 0);
  return {
    ...defaultState(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

export async function createState(
  projectPath: string,
  overrides: Partial<Omit<State, 'id'>>,
): Promise<State> {
  const states = await getStates(projectPath);
  const state = buildStateRecord(states, overrides);
  states[state.id] = state;
  await commitChange(getDataPath(projectPath, 'States.json'), states);
  return state;
}

/** Update an existing state's properties (shallow merge). */
export async function updateState(
  projectPath: string,
  stateId: number,
  updates: Partial<State>,
): Promise<State> {
  const states = await getStates(projectPath);
  const index = states.findIndex((s) => s && s.id === stateId);
  if (index === -1) {
    throw new Error(`State with ID ${stateId} not found`);
  }

  states[index] = { ...states[index]!, ...updates, id: stateId };
  await commitChange(getDataPath(projectPath, 'States.json'), states);
  return states[index]!;
}

export const stateToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_state',
    mutates: true,
    description:
      "Create a new state (status condition like Poison/Sleep) in data/States.json. Only `name` is required; omitted fields use the editor's new-state defaults (no restriction, priority 50, no auto-removal, 1-turn duration). Allocates and returns the next unused state id.",
    inputSchema: {
      name: z.string().describe('State name shown in the database and battle messages'),
      restriction: z
        .number()
        .int()
        .optional()
        .describe(
          'Behavior restriction: 0 none, 1 attack enemy, 2 attack anyone, 3 attack ally, 4 cannot move',
        ),
      priority: z
        .number()
        .int()
        .optional()
        .describe('Icon-slot display priority 0-100 (default 50)'),
      motion: z
        .number()
        .int()
        .optional()
        .describe('SV-actor motion (0 normal, 2 sleep, 3 dead, …)'),
      overlay: z.number().int().optional().describe('Overlay animation index (0 = none)'),
      removeAtBattleEnd: z
        .boolean()
        .optional()
        .describe('Remove automatically when the battle ends'),
      removeByRestriction: z
        .boolean()
        .optional()
        .describe("Remove when the battler's restriction changes"),
      autoRemovalTiming: z
        .number()
        .int()
        .optional()
        .describe('Auto-removal timing: 0 none, 1 at action end, 2 at turn end'),
      minTurns: z.number().int().optional().describe('Minimum duration in turns when auto-removed'),
      maxTurns: z.number().int().optional().describe('Maximum duration in turns when auto-removed'),
      removeByDamage: z.boolean().optional().describe('Remove when the battler takes damage'),
      chanceByDamage: z
        .number()
        .int()
        .optional()
        .describe('Chance (%) of removal per damage instance when removeByDamage'),
      removeByWalking: z.boolean().optional().describe('Remove after walking a number of steps'),
      stepsToRemove: z
        .number()
        .int()
        .optional()
        .describe('Steps to walk off the state when removeByWalking'),
      releaseByDamage: z.boolean().optional().describe('Whether damage can release the state'),
      iconIndex: z
        .number()
        .int()
        .optional()
        .describe('Icon shown on the battler/status (0 = none)'),
      message1: z.string().optional().describe('Message when an actor gains the state'),
      message2: z.string().optional().describe('Message when an enemy gains the state'),
      message3: z.string().optional().describe('Message when the state persists'),
      message4: z.string().optional().describe('Message when the state is removed'),
      traits: z.array(z.unknown()).optional().describe('Trait objects { code, dataId, value }'),
      note: z.string().optional().describe('Note field'),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createState(ctx.projectPath, overrides as Partial<Omit<State, 'id'>>);
    },
  },
  {
    name: 'update_state',
    mutates: true,
    description: "Update a state's properties (shallow merge into the existing record)",
    inputSchema: {
      stateId: z.number().int().positive().describe('The ID of the state to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing state properties to update'),
    },
    handler: (ctx, args) => updateState(ctx.projectPath, args.stateId, args.updates),
  },
];
