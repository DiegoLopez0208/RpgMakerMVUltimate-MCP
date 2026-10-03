import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Enemy, EventCommand, SystemData, Troop, TroopMember, TroopPage } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { summarizeTroopResult } from '../utils/responseSummary.js';
import { definedOnly } from '../utils/records.js';
import { validateCommandList, ValidationWarning } from '../validation/eventCommands.js';
import { PreCommit, writeGate } from '../validation/gate.js';
import { firstMissingEnemyRef } from '../validation/createRefs.js';
import { assetNameWarning, listAssets } from './assetTools.js';
import { validateEventCommands, assertMvCompatibility } from '../../utils/eventCommandValidation.js';

/**
 * Blank enemy mirroring what the RPG Maker MV editor writes for a freshly-created
 * enemy: 100 HP, one "Attack" action, three empty drop slots, no traits. Pure so
 * the template shape can be unit-tested. `params` order is
 * [mhp, mmp, atk, def, mat, mdf, agi, luk].
 */
export function defaultEnemy(): Omit<Enemy, 'id'> {
  return {
    name: '',
    battlerName: '',
    battlerHue: 0,
    params: [100, 0, 10, 10, 10, 10, 10, 10],
    exp: 0,
    gold: 0,
    dropItems: [
      { kind: 0, dataId: 1, denominator: 1 },
      { kind: 0, dataId: 1, denominator: 1 },
      { kind: 0, dataId: 1, denominator: 1 },
    ],
    actions: [{ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 1 }],
    traits: [],
    note: '',
  };
}

/**
 * A blank troop battle-event page matching the editor's default: a "span whole
 * battle" page with an empty (just the code-0 end marker) command list and the
 * editor's default condition values (all toggles off).
 */
export function blankTroopPage(): TroopPage {
  return {
    conditions: {
      actorHp: 50,
      actorId: 1,
      actorValid: false,
      enemyHp: 50,
      enemyIndex: 0,
      enemyValid: false,
      switchId: 1,
      switchValid: false,
      turnA: 0,
      turnB: 0,
      turnEnding: false,
      turnValid: false,
    },
    list: [{ code: 0, indent: 0, parameters: [] }],
    span: 0,
  };
}

/** When a troop battle-event page runs — `span` on disk (0 battle / 1 turn / 2 moment). */
export type TroopPageSpan = 'battle' | 'turn' | 'moment';
const SPAN_CODE: Record<TroopPageSpan, number> = { battle: 0, turn: 1, moment: 2 };

/**
 * The trigger of a troop battle-event page. Every key given is ANDed (the
 * editor's condition checkboxes); at least one is required — a page with no
 * condition enabled never runs (`Game_Troop.meetsConditions` returns false).
 *
 * - `turn: [a, b]` — turn `a + b*X` (b 0 = only turn a). Same formula, and the
 *   same `$gameTroop.turnCount()` read, as an enemy action pattern's Turn
 *   condition, so matching `[a, b]` fire together.
 * - `enemyHpBelow: [enemyIndex, pct]` — that troop slot's HP% ≤ pct.
 * - `actorHpBelow: [actorId, pct]` — that actor's HP% ≤ pct.
 * - `switch: id` — that switch is ON.
 * - `turnEnd: true` — at the end of a turn.
 */
export interface TroopPageWhen {
  turn?: [number, number];
  enemyHpBelow?: [number, number];
  actorHpBelow?: [number, number];
  switch?: number;
  turnEnd?: boolean;
}

/** Validate a 0–100 HP percentage condition value. */
function assertPct(pct: number, what: string): void {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new Error(`${what} HP% must be an integer 0–100, got ${pct}`);
  }
}

/**
 * Build a complete troop battle-event page (`{ conditions, list, span }`) from a
 * compact trigger — the full editor `conditions` object is filled with the
 * editor's defaults for every toggle left off, and `commands` gets its code-0
 * end marker appended when missing. Pure (no I/O) so the shape is unit-testable;
 * `add_troop_page` / `create_troop` / `update_troop` write it.
 */
export function buildTroopPage(
  when: TroopPageWhen,
  span: TroopPageSpan = 'battle',
  commands: EventCommand[] = [],
): TroopPage {
  const page = blankTroopPage();
  const c = page.conditions;
  let any = false;
  if (when.turn !== undefined) {
    const [a, b] = when.turn;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      throw new Error(`turn condition needs non-negative integers [a, b], got [${a}, ${b}]`);
    }
    Object.assign(c, { turnValid: true, turnA: a, turnB: b });
    any = true;
  }
  if (when.enemyHpBelow !== undefined) {
    const [index, pct] = when.enemyHpBelow;
    if (!Number.isInteger(index) || index < 0 || index > 7) {
      throw new Error(`enemyHpBelow needs a 0-based troop slot 0–7, got ${index}`);
    }
    assertPct(pct, 'enemyHpBelow');
    Object.assign(c, { enemyValid: true, enemyIndex: index, enemyHp: pct });
    any = true;
  }
  if (when.actorHpBelow !== undefined) {
    const [actorId, pct] = when.actorHpBelow;
    if (!Number.isInteger(actorId) || actorId < 1) {
      throw new Error(`actorHpBelow needs an actor id ≥ 1, got ${actorId}`);
    }
    assertPct(pct, 'actorHpBelow');
    Object.assign(c, { actorValid: true, actorId, actorHp: pct });
    any = true;
  }
  if (when.switch !== undefined) {
    if (!Number.isInteger(when.switch) || when.switch < 1) {
      throw new Error(`switch condition needs a switch id ≥ 1, got ${when.switch}`);
    }
    Object.assign(c, { switchValid: true, switchId: when.switch });
    any = true;
  }
  if (when.turnEnd) {
    c.turnEnding = true;
    any = true;
  }
  if (!any) {
    throw new Error(
      'A troop page needs at least one condition (turn, enemyHpBelow, actorHpBelow, switch, turnEnd) — with none enabled the engine never runs it',
    );
  }
  const base = commands.length ? Math.min(...commands.map(command => command.indent ?? 0)) : 0;
  const list = validateEventCommands(commands.map(command => ({
    ...command, indent: (command.indent ?? 0) - base,
  })), { fragment: true }).commands;
  const last = list[list.length - 1];
  if (!last || last.code !== 0 || last.indent !== 0) {
    list.push({ code: 0, indent: 0, parameters: [] });
  }
  page.list = list.map(command => ({ ...command, indent: command.indent ?? 0 }));
  if (SPAN_CODE[span] === undefined) throw new Error(`Unknown troop page span: ${span}`);
  page.span = SPAN_CODE[span];
  return page;
}

/**
 * Advisory (never blocking) findings on a troop page's trigger: an HP-condition
 * slot past the end of `members` can never be met, and a page with commands but
 * no condition enabled never runs at all.
 */
function troopPageConditionWarnings(troop: Troop): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const memberCount = Array.isArray(troop.members) ? troop.members.length : 0;
  (Array.isArray(troop.pages) ? troop.pages : []).forEach((page, i) => {
    const c = page?.conditions;
    if (!c) return;
    const path = `troop ${troop.id} / page ${i} / conditions`;
    if (c.enemyValid && c.enemyIndex >= memberCount) {
      warnings.push({
        path,
        severity: 'warning',
        message: `enemyIndex ${c.enemyIndex} is past the troop's ${memberCount} member(s) (it is a 0-based slot, not an enemy id) — this condition can never be met`,
      });
    }
    const hasCommands = Array.isArray(page.list) && page.list.some((command) => command.code !== 0);
    if (
      hasCommands &&
      !c.turnEnding &&
      !c.turnValid &&
      !c.enemyValid &&
      !c.actorValid &&
      !c.switchValid
    ) {
      warnings.push({
        path,
        severity: 'warning',
        message: 'no condition is enabled, so the engine never runs this page',
      });
    }
  });
  return warnings;
}

/**
 * The pre-commit gate the troop-writing tools install. A troop's pages reuse the
 * event-command `list` format, so the same command validator applies — and, as
 * with map events, a structurally invalid page is refused before the write
 * rather than saved and warned about. Page-trigger findings are advisory.
 */
function troopWriteGate(force: boolean | undefined): ReturnType<typeof writeGate<Troop>> {
  return writeGate<Troop>(force, 'troop', (troop) => {
    const warnings: ValidationWarning[] = [];
    if (Array.isArray(troop.pages)) {
      troop.pages.forEach((page, i) => {
        warnings.push(...validateCommandList(page?.list, `troop ${troop.id} / page ${i}`));
      });
    }
    warnings.push(...troopPageConditionWarnings(troop));
    return warnings;
  });
}

/**
 * Whether the project uses side-view battles (`System.optSideView`), which decides
 * the folder RMMV loads enemy battlers from. Fails soft to `false` (front-view)
 * when System.json is missing or unreadable.
 */
async function isSideView(projectPath: string): Promise<boolean> {
  try {
    const system = await readJsonFile<SystemData>(getDataPath(projectPath, 'System.json'));
    return system?.optSideView === true;
  } catch {
    return false;
  }
}

/**
 * Warn (never throw) when an enemy's `battlerName` isn't among the project's
 * enemy battler assets — `img/sv_enemies` when the project is side-view
 * (`System.optSideView`), `img/enemies` otherwise, matching where RMMV loads it.
 * A wrong battler filename is a silent runtime failure (a blank/missing sprite in
 * battle). Skips the check when the name is empty or the asset dir is
 * empty/missing (nothing to validate against — e.g. a fixture), so it can't emit
 * false positives — unless the name exists in the *other* battler folder, which
 * is flagged with a hint saying where it was found. Mirrors
 * `characterNameWarnings` (eventPageTools) and `audioNameWarnings`
 * (eventCommandTools).
 */
export async function battlerNameWarnings(
  projectPath: string,
  name: string | undefined,
): Promise<ValidationWarning[]> {
  if (!projectPath || !name) return [];
  const sideView = await isSideView(projectPath);
  const type = sideView ? 'sv_enemies' : 'enemies';
  const other = sideView ? 'enemies' : 'sv_enemies';
  const [{ names }, { names: otherNames }] = await Promise.all([
    listAssets(projectPath, type),
    listAssets(projectPath, other),
  ]);
  if (!names.includes(name) && otherNames.includes(name)) {
    return [
      {
        path: 'battlerName',
        code: undefined,
        message: `battler "${name}" is not a known ${type} asset — found in img/${other}, but the project is ${sideView ? 'side-view' : 'front-view'} (a wrong folder shows a blank sprite in battle)`,
      },
    ];
  }
  return assetNameWarning(projectPath, type, name, {
    path: 'battlerName',
    label: 'battler',
    consequence: 'a wrong filename shows a blank sprite in battle',
  });
}

/** Attach warn-by-default battler-asset validation to an enemy-write response. */
async function withEnemyAssetWarnings(
  projectPath: string,
  enemy: Enemy,
): Promise<{ enemy: Enemy; warnings?: ValidationWarning[] }> {
  const warnings = await battlerNameWarnings(projectPath, enemy.battlerName);
  return warnings.length > 0 ? { enemy, warnings } : { enemy };
}

// --- Enemies ---------------------------------------------------------------

/** Get all enemies from the project. */
export async function getEnemies(projectPath: string): Promise<(Enemy | null)[]> {
  return await readJsonFile<(Enemy | null)[]>(getDataPath(projectPath, 'Enemies.json'));
}

/** Search enemies by name (case-insensitive). */
export async function searchEnemies(projectPath: string, searchTerm: string): Promise<Enemy[]> {
  const enemies = await getEnemies(projectPath);
  const lower = searchTerm.toLowerCase();
  return enemies.filter((e): e is Enemy => !!e && e.name.toLowerCase().includes(lower));
}

/**
 * Build one new enemy record against the current array — the shared per-record
 * source of truth for both `create_enemy` and `batch_create`. Pure: template
 * first, caller's defined fields next, computed id last so it always wins. Does
 * not push, commit, or run the reference check (that needs cross-file reads).
 */
export function buildEnemyRecord(
  existing: (Enemy | null)[],
  input: Partial<Omit<Enemy, 'id'>>,
): Enemy {
  const maxId = existing.reduce((max, e) => (e && e.id > max ? e.id : max), 0);
  return {
    ...defaultEnemy(),
    ...definedOnly(input),
    id: maxId + 1,
  };
}

/**
 * Reject an enemy whose actions/drops point at a non-existent db record (P2-3:
 * throw at author time, matching create_troop's member.enemyId check). The
 * battlerName stays a *warning* (an asset filename, not a db id). Shared by
 * `create_enemy` and `batch_create`.
 */
export async function assertEnemyRefs(projectPath: string, enemy: Enemy): Promise<void> {
  const [skills, items, weapons, armors] = await Promise.all([
    readJsonArraySoft(getDataPath(projectPath, 'Skills.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Items.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Weapons.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Armors.json')),
  ]);
  const missing = firstMissingEnemyRef(enemy, { skills, items, weapons, armors });
  if (missing) {
    throw new Error(`Cannot create enemy "${enemy.name}": ${missing}`);
  }
}

/**
 * Create a new enemy. Only `name` is required; any omitted field falls back to
 * the editor's new-enemy default (see {@link defaultEnemy}). Allocates the next
 * unused id (max existing + 1) and writes through the commit choke point.
 */
export async function createEnemy(
  projectPath: string,
  overrides: Partial<Omit<Enemy, 'id'>>,
): Promise<Enemy> {
  const enemies = await getEnemies(projectPath);
  const enemy = buildEnemyRecord(enemies, overrides);

  await assertEnemyRefs(projectPath, enemy);

  enemies[enemy.id] = enemy;
  await commitChange(getDataPath(projectPath, 'Enemies.json'), enemies);
  return enemy;
}

/** Update an existing enemy's properties (shallow merge). */
export async function updateEnemy(
  projectPath: string,
  enemyId: number,
  updates: Partial<Enemy>,
): Promise<Enemy> {
  const enemies = await getEnemies(projectPath);
  const index = enemies.findIndex((e) => e && e.id === enemyId);
  if (index === -1) {
    throw new Error(`Enemy with ID ${enemyId} not found`);
  }

  enemies[index] = { ...enemies[index]!, ...updates, id: enemyId };
  await commitChange(getDataPath(projectPath, 'Enemies.json'), enemies);
  return enemies[index]!;
}

// --- Troops ----------------------------------------------------------------

/** Get all troops from the project. */
export async function getTroops(projectPath: string): Promise<(Troop | null)[]> {
  return await readJsonFile<(Troop | null)[]>(getDataPath(projectPath, 'Troops.json'));
}

/** Search troops by name (case-insensitive). */
export async function searchTroops(projectPath: string, searchTerm: string): Promise<Troop[]> {
  const troops = await getTroops(projectPath);
  const lower = searchTerm.toLowerCase();
  return troops.filter((t): t is Troop => !!t && t.name.toLowerCase().includes(lower));
}

/**
 * Assert every troop member references an enemy that exists in Enemies.json, so a
 * troop can't be created pointing at a non-existent enemy (mirrors create_map's
 * parent check). Structural error → throws.
 */
async function assertMembersReferenceEnemies(
  projectPath: string,
  members: TroopMember[],
): Promise<void> {
  if (members.length === 0) return;
  const enemies = await getEnemies(projectPath);
  for (const member of members) {
    if (!enemies.some((e) => e && e.id === member.enemyId)) {
      throw new Error(`Troop member references enemyId ${member.enemyId}, which does not exist`);
    }
  }
}

/**
 * Create a new troop. `name` is required; `members` defaults to empty and `pages`
 * to a single blank battle-event page. Validates that each member references an
 * existing enemy, allocates the next unused id, and writes through the commit
 * choke point. The `precommit` hook (see `validation/gate.ts`) runs on the built
 * troop just before the write, so a structurally invalid page can refuse it.
 */
export async function createTroop(
  projectPath: string,
  options: { name: string; members?: TroopMember[]; pages?: TroopPage[] },
  precommit?: PreCommit<Troop>,
): Promise<Troop> {
  const members = options.members ?? [];
  await assertMembersReferenceEnemies(projectPath, members);

  const troops = await getTroops(projectPath);
  const maxId = troops.reduce((max, t) => (t && t.id > max ? t.id : max), 0);

  const troop: Troop = {
    id: maxId + 1,
    name: options.name,
    members,
    pages: options.pages ?? [blankTroopPage()],
  };

  troops[troop.id] = troop;

  troop.pages.forEach(page => assertMvCompatibility(page.list));
  await precommit?.(troop);

  await commitChange(getDataPath(projectPath, 'Troops.json'), troops);
  return troop;
}

/** Update an existing troop's properties (shallow merge). */
export async function updateTroop(
  projectPath: string,
  troopId: number,
  updates: Partial<Troop>,
  precommit?: PreCommit<Troop>,
): Promise<Troop> {
  const troops = await getTroops(projectPath);
  const index = troops.findIndex((t) => t && t.id === troopId);
  if (index === -1) {
    throw new Error(`Troop with ID ${troopId} not found`);
  }

  const merged: Troop = { ...troops[index]!, ...updates, id: troopId };
  if (updates.members) {
    await assertMembersReferenceEnemies(projectPath, merged.members);
  }

  troops[index] = merged;

  merged.pages.forEach(page => assertMvCompatibility(page.list));
  await precommit?.(merged);

  await commitChange(getDataPath(projectPath, 'Troops.json'), troops);
  return merged;
}

/**
 * Append (or insert at `position`) one battle-event page to an existing troop
 * without re-sending the others. Pages are scanned in order and the first one
 * whose conditions hold runs, so `position` matters when triggers overlap.
 */
export async function addTroopPage(
  projectPath: string,
  troopId: number,
  page: TroopPage,
  position?: number,
  precommit?: PreCommit<Troop>,
): Promise<{ troop: Troop; pageIndex: number }> {
  const troops = await getTroops(projectPath);
  const index = troops.findIndex((t) => t && t.id === troopId);
  if (index === -1) {
    throw new Error(`Troop with ID ${troopId} not found`);
  }
  const troop = troops[index]!;
  const pages = Array.isArray(troop.pages) ? [...troop.pages] : [];
  if (position !== undefined && (!Number.isSafeInteger(position) || position < 0 || position > pages.length)) {
    throw new Error(`position must be an integer from 0 to ${pages.length}`);
  }
  const at = position ?? pages.length;
  pages.splice(at, 0, page);
  const updated: Troop = { ...troop, pages };
  troops[index] = updated;

  updated.pages.forEach(page => assertMvCompatibility(page.list));
  await precommit?.(updated);

  await commitChange(getDataPath(projectPath, 'Troops.json'), troops);
  return { troop: updated, pageIndex: at };
}

/** Zod shape for a compact troop-page trigger (see {@link TroopPageWhen}). */
const troopPageWhenShape = z
  .object({
    turn: z
      .tuple([z.number().int().min(0), z.number().int().min(0)])
      .optional()
      .describe(
        '[a, b]: turn a + b*X (b 0 = only turn a). Match an enemy action-pattern Turn [a, b] to fire on the same turn',
      ),
    enemyHpBelow: z
      .tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(100)])
      .optional()
      .describe('[enemyIndex, pct]: 0-based troop slot (NOT enemy id) at or below pct% HP'),
    actorHpBelow: z
      .tuple([z.number().int().positive(), z.number().int().min(0).max(100)])
      .optional()
      .describe('[actorId, pct]: that actor at or below pct% HP'),
    switch: z.number().int().positive().optional().describe('Switch id that must be ON'),
    turnEnd: z.boolean().optional().describe('true: run at the end of a turn'),
  })
  .describe('Trigger; every key given is ANDed, at least one required');

/** Zod shape for a raw event command inside a troop page. */
const troopCommandShape = z.object({
  code: z.number().int().describe('Event command code'),
  indent: z.number().int().min(0).max(100).optional().describe('Indentation level (default 0)'),
  parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
});

/** Zod shape for a full troop page (e.g. the `page` returned by build_troop_page). */
const troopPageShape = z
  .object({
    conditions: z.record(z.string(), z.unknown()).describe('The full editor conditions object'),
    list: z.array(troopCommandShape).describe('Event commands, ending with the code-0 end marker'),
    span: z.number().int().min(0).max(2).describe('0 battle / 1 turn / 2 moment'),
  })
  .describe('A troop battle-event page, e.g. the `page` from build_troop_page');

const troopMemberSchema = z.object({
  enemyId: z.number().int().describe('Enemy id from Enemies.json'),
  x: z.number().int().describe('X screen position of the enemy in battle'),
  y: z.number().int().describe('Y screen position of the enemy in battle'),
  hidden: z.boolean().optional().default(false).describe('Whether the enemy starts hidden'),
});

export const battleToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_enemy',
    mutates: true,
    description:
      "Create a new enemy in data/Enemies.json. Only `name` is required; omitted fields use the editor's new-enemy defaults (100 HP, one Attack action, no drops). Allocates the next unused enemy id and returns `{ enemy, warnings? }` (warn-by-default: a `battlerName` not found in img/enemies (img/sv_enemies for a side-view project) is flagged, never blocked). Throws if an `actions[].skillId` or a `dropItems[].dataId` (item/weapon/armor by `kind`) references a record that does not exist. NOTE: an enemy with no Hit Rate trait (xparam id 0: trait { code: 22, dataId: 0, value: 0.95 }) always misses physical actions — pass one in `traits` if the enemy should land basic attacks.",
    inputSchema: {
      name: z.string().describe('Enemy name shown in battle and the database'),
      battlerName: z
        .string()
        .optional()
        .describe('Battler graphic filename (img/enemies; img/sv_enemies when System.optSideView)'),
      battlerHue: z.number().int().optional().describe('Battler hue rotation 0-360'),
      params: z
        .array(z.number())
        .length(8)
        .optional()
        .describe('8 base params: [maxHP, maxMP, atk, def, mat, mdf, agi, luk]'),
      exp: z.number().int().optional().describe('EXP granted when defeated'),
      gold: z.number().int().optional().describe('Gold granted when defeated'),
      note: z.string().optional().describe('Note field'),
      traits: z.array(z.unknown()).optional().describe('Trait objects { code, dataId, value }'),
      dropItems: z
        .array(z.unknown())
        .optional()
        .describe('Drop-item objects { kind, dataId, denominator }'),
      actions: z
        .array(z.unknown())
        .optional()
        .describe(
          'Action patterns { skillId, conditionType, conditionParam1, conditionParam2, rating }',
        ),
    },
    handler: async (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      const enemy = await createEnemy(ctx.projectPath, overrides as Partial<Omit<Enemy, 'id'>>);
      return withEnemyAssetWarnings(ctx.projectPath, enemy);
    },
  },
  {
    name: 'update_enemy',
    mutates: true,
    description:
      "Update an enemy's properties (shallow merge into the existing record). Returns `{ enemy, warnings? }` — a `battlerName` not found in img/enemies (img/sv_enemies for a side-view project) is flagged warn-by-default.",
    inputSchema: {
      enemyId: z.number().int().positive().describe('The ID of the enemy to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing enemy properties to update'),
    },
    handler: async (ctx, args) =>
      withEnemyAssetWarnings(
        ctx.projectPath,
        await updateEnemy(ctx.projectPath, args.enemyId, args.updates),
      ),
  },
  {
    name: 'search_enemies',
    description: 'Search enemies by name (case-insensitive)',
    inputSchema: { searchTerm: z.string().describe('The search term to find enemies') },
    handler: (ctx, args) => searchEnemies(ctx.projectPath, args.searchTerm),
  },
  {
    name: 'create_troop',
    mutates: true,
    forceable: true,
    summarize: summarizeTroopResult,
    description:
      'Create a new troop (enemy battle group) in data/Troops.json. `name` is required; `members` defaults to empty and `pages` to one blank battle-event page. Every member.enemyId must reference an existing enemy. A structurally invalid battle-event page refuses the write (nothing is saved) — pass force: true to override.',
    inputSchema: {
      name: z.string().describe('Troop name shown in the database'),
      members: z
        .array(troopMemberSchema)
        .optional()
        .describe('Placed enemies; each references an existing enemyId'),
      pages: z
        .array(z.unknown())
        .optional()
        .describe('Battle-event pages { conditions, list, span }; defaults to one blank page'),
    },
    handler: async (ctx, args) => {
      const gate = troopWriteGate(args.force);
      const troop = await createTroop(
        ctx.projectPath,
        {
          name: args.name,
          members: args.members as TroopMember[] | undefined,
          pages: args.pages as TroopPage[] | undefined,
        },
        gate.precommit,
      );
      return gate.respond({ troop });
    },
  },
  {
    name: 'update_troop',
    mutates: true,
    forceable: true,
    summarize: summarizeTroopResult,
    description:
      "Update a troop's properties (shallow merge). If `members` is provided, each enemyId is validated to exist. A structurally invalid battle-event page refuses the write (nothing is saved) — pass force: true to override.",
    inputSchema: {
      troopId: z.number().int().positive().describe('The ID of the troop to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing troop properties to update (name, members, pages)'),
    },
    handler: async (ctx, args) => {
      const gate = troopWriteGate(args.force);
      const troop = await updateTroop(ctx.projectPath, args.troopId, args.updates, gate.precommit);
      return gate.respond({ troop });
    },
  },
  {
    name: 'build_troop_page',
    requiresProject: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Build a troop battle-event page { conditions, list, span } from a compact trigger — no hand-built 12-field conditions object. `when` keys (ANDed, at least one): turn [a, b] (turn a + b*X; b 0 = only turn a), enemyHpBelow [enemyIndex, pct] (0-based troop slot, NOT enemy id), actorHpBelow [actorId, pct], switch id, turnEnd true. `span`: battle (runs once per battle, default), turn (once per turn), moment (re-runs while the condition holds — guard it with a switch). Timing (turn-based battles): an enemy action pattern with conditionType 1 / [a, b] is chosen during turn N\'s input phase (troop turnCount N-1, +1) and a troop page turn [a, b] is checked once turn N\'s action phase starts (turnCount N), so matching [a, b] land on the same battle turn N — the page runs before anyone acts; add turnEnd: true to run it after that turn resolves instead (the classic telegraph: warn at the end of the wind-up turn, strike next turn). Turn 0 = battle start. With b > 0 use span "turn", or a "battle" page fires only once. `commands` come from the build_* tools (build_show_text, build_battle_command, …); the end marker is appended. Read-only: returns { page } — land it with add_troop_page (or create_troop/update_troop `pages`).',
    inputSchema: {
      when: troopPageWhenShape,
      span: z
        .enum(['battle', 'turn', 'moment'])
        .optional()
        .describe('How often the page may run (default battle)'),
      commands: z
        .array(troopCommandShape)
        .optional()
        .describe("The page's event commands (e.g. from build_* tools); default empty"),
    },
    handler: async (_ctx, args) => ({
      page: buildTroopPage(
        args.when as TroopPageWhen,
        (args.span as TroopPageSpan | undefined) ?? 'battle',
        (args.commands as EventCommand[] | undefined) ?? [],
      ),
    }),
  },
  {
    name: 'add_troop_page',
    mutates: true,
    forceable: true,
    summarize: summarizeTroopResult,
    description:
      'Append one battle-event page (e.g. the `page` from build_troop_page) to an existing troop without re-sending its other pages; `position` inserts it at that 0-based page index instead (the first page whose conditions hold runs, so order matters when triggers overlap). A structurally invalid page refuses the write (nothing is saved) — pass force: true to override; an HP condition on a troop slot past the troop\'s members, or a page with no condition enabled, is warned (never blocked). Returns { troop, pageIndex, warnings? }; fill it further with insert_event_commands target "troop_page".',
    inputSchema: {
      troopId: z.number().int().positive().describe('The troop to add the page to'),
      page: troopPageShape,
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-based page index to insert at (default: append)'),
    },
    handler: async (ctx, args) => {
      const gate = troopWriteGate(args.force);
      const result = await addTroopPage(
        ctx.projectPath,
        args.troopId,
        args.page as TroopPage,
        args.position,
        gate.precommit,
      );
      return gate.respond(result);
    },
  },
  {
    name: 'search_troops',
    description: 'Search troops by name (case-insensitive)',
    inputSchema: { searchTerm: z.string().describe('The search term to find troops') },
    handler: (ctx, args) => searchTroops(ctx.projectPath, args.searchTerm),
  },
];
