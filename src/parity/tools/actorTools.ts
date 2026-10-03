import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Actor } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { definedOnly } from '../utils/records.js';

/**
 * A blank actor mirroring what the RPG Maker MV editor writes for a freshly-created
 * actor (the "New Actor" shape from newdata/data/Actors.json): class 1, level 1-99,
 * five empty equip slots, no traits, empty graphic/name fields. Pure so the template
 * shape can be unit-tested.
 *
 * Every field is present — `create_actor` previously wrote only the fields a caller
 * passed, so an actor made with just `name` was missing `equips`/`traits`/etc.
 * entirely, which crashes the engine on load (Game_Actor reads `equips.length` and
 * concats `traits` unconditionally). Field order mirrors the editor's on-disk shape.
 */
export function defaultActor(): Omit<Actor, 'id'> {
  return {
    name: '',
    nickname: '',
    classId: 1,
    initialLevel: 1,
    maxLevel: 99,
    characterName: '',
    characterIndex: 0,
    faceName: '',
    faceIndex: 0,
    battlerName: '',
    equips: [0, 0, 0, 0, 0],
    traits: [],
    note: '',
    profile: '',
  };
}

/**
 * Get all actors from the project
 */
export async function getActors(projectPath: string): Promise<(Actor | null)[]> {
  const actorsPath = getDataPath(projectPath, 'Actors.json');
  return await readJsonFile<(Actor | null)[]>(actorsPath);
}

/**
 * Update an actor's data
 */
export async function updateActor(
  projectPath: string,
  actorId: number,
  updates: Partial<Actor>,
): Promise<Actor> {
  const actors = await getActors(projectPath);
  const actorIndex = actors.findIndex((actor) => actor && actor.id === actorId);

  if (actorIndex === -1) {
    throw new Error(`Actor with ID ${actorId} not found`);
  }

  actors[actorIndex] = { ...actors[actorIndex]!, ...updates, id: actorId };
  await assertActorRefs(projectPath, actors[actorIndex]!);

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return actors[actorIndex]!;
}

/**
 * Build one new actor record against the current array — the shared per-record
 * source of truth for both `create_actor` and `batch_create`. Pure: allocates the
 * next unused id (max existing + 1), then merges the caller's defined fields over
 * the {@link defaultActor} template with the computed id last so it always wins.
 * Does not push or commit — the caller owns persistence (batch pushes N records
 * onto the same array, then writes once).
 */
export function buildActorRecord(
  existing: (Actor | null)[],
  input: Partial<Omit<Actor, 'id'>>,
): Actor {
  const maxId = existing.reduce((max, actor) => (actor && actor.id > max ? actor.id : max), 0);
  return {
    ...defaultActor(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

/** A missing fixture database is unverifiable; a loaded missing class is an error. */
export async function assertActorRefs(projectPath: string, actor: Actor): Promise<void> {
  const classes = await readJsonArraySoft(getDataPath(projectPath, 'Classes.json'));
  if (!Number.isInteger(actor.classId) || actor.classId <= 0 || (classes.length > 0 && !classes[actor.classId])) {
    throw new Error(`Actor "${actor.name}" references classId ${actor.classId}, which does not exist`);
  }
}

/**
 * Create a new actor. Only `name` is required; any omitted field falls back to the
 * editor's new-actor default (see {@link defaultActor}) so the record is always
 * complete. Allocates the next unused id (max existing + 1) and writes through the
 * commit choke point.
 */
export async function createActor(
  projectPath: string,
  overrides: Partial<Omit<Actor, 'id'>>,
): Promise<Actor> {
  const actors = await getActors(projectPath);
  const newActor = buildActorRecord(actors, overrides);
  await assertActorRefs(projectPath, newActor);
  actors[newActor.id] = newActor;

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return newActor;
}

/**
 * Delete an actor
 */
export async function deleteActor(projectPath: string, actorId: number): Promise<boolean> {
  const actors = await getActors(projectPath);
  const actorIndex = actors.findIndex((actor) => actor && actor.id === actorId);

  if (actorIndex === -1) {
    return false;
  }

  actors[actorIndex] = null;

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return true;
}

/**
 * Search actors by name
 */
export async function searchActors(projectPath: string, searchTerm: string): Promise<Actor[]> {
  const actors = await getActors(projectPath);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return actors.filter(
    (actor): actor is Actor =>
      !!actor &&
      (actor.name.toLowerCase().includes(lowerSearchTerm) ||
        actor.nickname.toLowerCase().includes(lowerSearchTerm)),
  );
}

export const actorToolDefinitions: ToolDefinition[] = [
  {
    name: 'update_actor',
    mutates: true,
    description: "Update an actor's properties",
    inputSchema: {
      actorId: z.number().int().positive().describe('The ID of the actor to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing actor properties to update'),
    },
    handler: (ctx, args) => updateActor(ctx.projectPath, args.actorId, args.updates),
  },
  {
    name: 'create_actor',
    mutates: true,
    description:
      "Create a new actor in data/Actors.json. Only `name` is required; omitted fields use the editor's new-actor defaults (class 1, level 1-99, five empty equip slots, no traits). Allocates and returns the next unused actor id. NOTE: an actor's physical accuracy comes from its class + own traits — a class/actor with no Hit Rate trait (xparam id 0: trait { code: 22, dataId: 0, value: 0.95 }) always misses physical actions. The built-in class 1 has one; a custom class needs it added.",
    inputSchema: {
      name: z.string(),
      nickname: z.string().optional(),
      profile: z.string().optional(),
      classId: z.number().int().positive().optional(),
      initialLevel: z.number().optional(),
      maxLevel: z.number().optional(),
      characterName: z.string().optional(),
      characterIndex: z.number().int().min(0).optional(),
      faceName: z.string().optional(),
      faceIndex: z.number().int().min(0).optional(),
      battlerName: z.string().optional(),
      traits: z.array(z.unknown()).optional(),
      equips: z.array(z.number()).optional(),
      note: z.string().optional(),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createActor(ctx.projectPath, overrides as Partial<Omit<Actor, 'id'>>);
    },
  },
  {
    name: 'search_actors',
    description: 'Search actors by name or nickname',
    inputSchema: { searchTerm: z.string().describe('The search term to find actors') },
    handler: (ctx, args) => searchActors(ctx.projectPath, args.searchTerm),
  },
];
