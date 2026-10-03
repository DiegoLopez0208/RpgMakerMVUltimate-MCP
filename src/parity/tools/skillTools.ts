import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Skill } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { firstMissingEffectRef } from '../validation/createRefs.js';
import { assertMvActionScope, mvActionScopeSchema, mvActionScopeDescription } from '../../utils/actionScope.js';

/**
 * Get all skills from the project
 */
export async function getSkills(projectPath: string): Promise<(Skill | null)[]> {
  const skillsPath = getDataPath(projectPath, 'Skills.json');
  return await readJsonFile<(Skill | null)[]>(skillsPath);
}

/** The caller-supplied skill shape accepted by both `create_skill` and `batch_create`. */
export interface SkillInput {
  name: string;
  description?: string;
  iconIndex?: number;
  mpCost?: number;
  tpCost?: number;
  scope?: number;
  damage?: {
    type: number;
    elementId: number;
    formula: string;
    variance?: number;
    critical?: boolean;
  };
  effects?: Array<{
    code: number;
    dataId: number;
    value1: number;
    value2: number;
  }>;
  animationId?: number;
  message1?: string;
  message2?: string;
  stypeId?: number;
  occasion?: number;
  hitType?: number;
  speed?: number;
  repeats?: number;
  successRate?: number;
  tpGain?: number;
  requiredWtypeId1?: number;
  requiredWtypeId2?: number;
  note?: string;
}

/** MV skill scopes that target the user or an ally (7–11). */
function targetsAllies(scope: number): boolean {
  return scope >= 7 && scope <= 11;
}

/**
 * Default hit type for a new skill when the caller doesn't pass one:
 * 0 (certain hit) for recovery and for anything aimed at the user/allies — it
 * shouldn't be dodgeable or countered; otherwise 2 (magical) for a Magic skill
 * (`stypeId` 1); otherwise 1 (physical) when the skill deals damage; otherwise
 * 0. Keyed on the skill type, not the damage type — deriving it from
 * `damage.type` turned every damaging spell into a physical hit.
 */
export function defaultSkillHitType(stypeId: number, scope: number, damageType: number): number {
  if (damageType === 3 || damageType === 4 || targetsAllies(scope)) return 0;
  if (stypeId === 1) return 2;
  return damageType > 0 ? 1 : 0;
}

/**
 * Build one new skill record against the current array — the shared per-record
 * source of truth for both `create_skill` and `batch_create`. Pure: allocates the
 * next unused id (max existing + 1) and fills every unsupplied field with the
 * new-skill default. Does not push or commit, and does not run the effect
 * reference check (that needs cross-file reads) — the caller owns both.
 */
export function buildSkillRecord(existing: (Skill | null)[], input: SkillInput): Skill {
  if (input.scope !== undefined) assertMvActionScope(input.scope);
  const maxId = existing.reduce((max, skill) => (skill && skill.id > max ? skill.id : max), 0);

  const stypeId = input.stypeId ?? 1; // Default: Magic
  const scope = input.scope ?? 1; // Default: enemy single
  const damageType = input.damage?.type ?? 0;

  return {
    id: maxId + 1,
    name: input.name,
    description: input.description ?? '',
    iconIndex: input.iconIndex ?? 64,
    mpCost: input.mpCost ?? 0,
    tpCost: input.tpCost ?? 0,
    tpGain: input.tpGain ?? 0,
    scope,
    occasion: input.occasion ?? 1, // Default: battle only
    speed: input.speed ?? 0,
    successRate: input.successRate ?? 100,
    repeats: input.repeats ?? 1,
    hitType: input.hitType ?? defaultSkillHitType(stypeId, scope, damageType),
    animationId: input.animationId ?? 0,
    damage: {
      type: damageType,
      elementId: input.damage?.elementId ?? 0,
      formula: input.damage?.formula ?? '0',
      variance: input.damage?.variance ?? 20,
      critical: input.damage?.critical ?? false,
    },
    effects: input.effects ?? [],
    message1: input.message1 ?? '',
    message2: input.message2 ?? '',
    note: input.note ?? '',
    stypeId,
    requiredWtypeId1: input.requiredWtypeId1 ?? 0,
    requiredWtypeId2: input.requiredWtypeId2 ?? 0,
  };
}

/**
 * Reject a skill/item whose effects point at a non-existent state / skill /
 * common event (P2-3: throw at author time, like add_class_learning /
 * create_troop). Shared by `create_skill` and `batch_create`.
 */
export async function assertSkillEffectRefs(
  projectPath: string,
  skill: Skill,
  skills: (Skill | null)[],
): Promise<void> {
  const [states, commonEvents] = await Promise.all([
    readJsonArraySoft(getDataPath(projectPath, 'States.json')),
    readJsonArraySoft(getDataPath(projectPath, 'CommonEvents.json')),
  ]);
  const missing = firstMissingEffectRef(skill.effects, { states, skills, commonEvents });
  if (missing) {
    throw new Error(`Cannot create skill "${skill.name}": ${missing}`);
  }
}

/**
 * Create a new skill
 */
export async function createSkill(projectPath: string, skillData: SkillInput): Promise<Skill> {
  const skills = await getSkills(projectPath);
  const newSkill = buildSkillRecord(skills, skillData);

  await assertSkillEffectRefs(projectPath, newSkill, skills);

  skills[newSkill.id] = newSkill;

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return newSkill;
}

/**
 * Update a skill's data
 */
export async function updateSkill(
  projectPath: string,
  skillId: number,
  updates: Partial<Skill>,
): Promise<Skill> {
  if ('scope' in updates) assertMvActionScope(updates.scope);
  const skills = await getSkills(projectPath);
  const skillIndex = skills.findIndex((skill) => skill && skill.id === skillId);

  if (skillIndex === -1) {
    throw new Error(`Skill with ID ${skillId} not found`);
  }

  skills[skillIndex] = { ...skills[skillIndex]!, ...updates, id: skillId };

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return skills[skillIndex]!;
}

/**
 * Delete a skill
 */
export async function deleteSkill(projectPath: string, skillId: number): Promise<boolean> {
  const skills = await getSkills(projectPath);
  const skillIndex = skills.findIndex((skill) => skill && skill.id === skillId);

  if (skillIndex === -1) {
    return false;
  }

  // Don't delete core skills (1, 2)
  if (skillId === 1 || skillId === 2) {
    throw new Error('Cannot delete core skills (Attack/Guard)');
  }

  skills[skillIndex] = null;

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return true;
}

/**
 * Search skills by name
 */
export async function searchSkills(projectPath: string, searchTerm: string): Promise<Skill[]> {
  const skills = await getSkills(projectPath);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return skills.filter(
    (skill): skill is Skill =>
      !!skill &&
      (skill.name.toLowerCase().includes(lowerSearchTerm) ||
        skill.description.toLowerCase().includes(lowerSearchTerm)),
  );
}

/**
 * Create a damage skill (attack spell or physical skill)
 */
export async function createDamageSkill(
  projectPath: string,
  name: string,
  damageFormula: string,
  mpCost: number,
  scope: number,
  elementId?: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Deals damage with ${name}.`,
    mpCost,
    scope,
    damage: {
      type: 1, // HP damage
      elementId: elementId || 0,
      formula: damageFormula,
      variance: 20,
      critical: true,
    },
    animationId: 1,
    message1: '%1 casts %2!', // %1 = subject name, %2 = skill name
    stypeId: 1, // Magic
  });
}

/**
 * Create a healing skill
 */
export async function createHealingSkill(
  projectPath: string,
  name: string,
  healFormula: string,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Restores HP with ${name}.`,
    mpCost,
    scope,
    damage: {
      type: 3, // HP recovery
      elementId: 0,
      formula: healFormula,
      variance: 20,
      critical: false,
    },
    animationId: 47,
    message1: '%1 casts %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 72,
  });
}

/**
 * Create a buff skill
 */
export async function createBuffSkill(
  projectPath: string,
  name: string,
  buffType: number,
  turns: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Strengthens allies with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 31, // Add buff
        dataId: buffType,
        value1: turns,
        value2: 0,
      },
    ],
    animationId: 52,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 73,
  });
}

/**
 * Create a debuff skill
 */
export async function createDebuffSkill(
  projectPath: string,
  name: string,
  debuffType: number,
  turns: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Weakens enemies with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 32, // Add debuff
        dataId: debuffType,
        value1: turns,
        value2: 0,
      },
    ],
    animationId: 40,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 74,
  });
}

/**
 * Create a state-inflicting skill
 */
export async function createStateSkill(
  projectPath: string,
  name: string,
  stateId: number,
  chance: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Inflicts a status ailment with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 21, // Add state
        dataId: stateId,
        value1: chance,
        value2: 0,
      },
    ],
    damage: {
      type: 0,
      elementId: 0,
      formula: '0',
      variance: 20,
      critical: false,
    },
    animationId: 1,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
  });
}

export const skillToolDefinitions: ToolDefinition[] = [
  {
    name: 'create_skill',
    mutates: true,
    description:
      'Create a new skill with custom properties. Omitted fields use new-skill defaults: stypeId 1 (Magic), scope 1, occasion 1 (battle only), hitType derived — 0 certain for recovery or ally/user scopes, else 2 magical for Magic skills, else 1 physical if it deals damage, else 0. An effect referencing a missing record throws: Add/Remove State (code 21/22) → state, Learn Skill (43) → skill, Common Event (44) → common event.',
    inputSchema: {
      name: z.string().describe('Skill name'),
      description: z.string().optional().describe('Skill description'),
      iconIndex: z.number().int().min(0).optional().describe('Icon index (0-1000+)'),
      mpCost: z.number().optional().describe('MP cost'),
      tpCost: z.number().optional().describe('TP cost'),
      scope: mvActionScopeSchema.optional().describe(mvActionScopeDescription),
      damage: z
        .object({
          type: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Damage type (0=none, 1=HP damage, 3=HP recover, etc.)'),
          elementId: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Element ID (0=none, 2=fire, 3=ice, etc.)'),
          formula: z.string().optional().describe('Damage formula (e.g., "a.mat * 4 - b.mdf * 2")'),
          variance: z.number().optional(),
          critical: z.boolean().optional(),
        })
        .optional()
        .describe('Damage configuration'),
      effects: z
        .array(z.unknown())
        .optional()
        .describe('Skill effects (buffs, debuffs, states, etc.)'),
      animationId: z.number().int().min(0).optional().describe('Animation ID'),
      message1: z.string().optional().describe('Battle message (line 1, %1 = user name)'),
      message2: z.string().optional().describe('Battle message line 2'),
      stypeId: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Skill type (0=none — typical for enemy-only skills, not sealed by Silence; 1=magic, 2=special, etc.). Default 1',
        ),
      occasion: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('Usable: 0 always, 1 battle only (default), 2 menu only, 3 never'),
      hitType: z
        .number()
        .int()
        .min(0)
        .max(2)
        .optional()
        .describe(
          '0 certain hit, 1 physical (HIT/EVA, counterable), 2 magical (MEV, reflectable). Default derived from stypeId/scope/damage',
        ),
      speed: z
        .number()
        .int()
        .optional()
        .describe('Speed correction (-2000..2000; positive acts earlier). Default 0'),
      repeats: z.number().int().min(1).optional().describe('Number of hits (1-9). Default 1'),
      successRate: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Success rate percent. Default 100'),
      tpGain: z.number().int().min(0).optional().describe('User TP gained on use. Default 0'),
      requiredWtypeId1: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Required weapon type 1 (0=none)'),
      requiredWtypeId2: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Required weapon type 2 (0=none)'),
      note: z.string().optional().describe('Note field (notetags)'),
    },
    handler: (ctx, args) => createSkill(ctx.projectPath, args as Parameters<typeof createSkill>[1]),
  },
  {
    name: 'create_damage_skill',
    mutates: true,
    description: 'Create a damage-dealing skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      damageFormula: z.string().describe('Damage formula (e.g., "a.mat * 4")'),
      mpCost: z.number().describe('MP cost'),
      scope: mvActionScopeSchema,
      elementId: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Element ID (0=none, 2=fire, 3=ice, 4=thunder)'),
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createDamageSkill(
        ctx.projectPath,
        args.name,
        args.damageFormula,
        args.mpCost,
        args.scope,
        args.elementId,
        args.description,
      ),
  },
  {
    name: 'create_healing_skill',
    mutates: true,
    description: 'Create a healing skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      healFormula: z.string().describe('Heal formula (e.g., "a.mat * 3 + 100")'),
      mpCost: z.number().describe('MP cost'),
      scope: mvActionScopeSchema,
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createHealingSkill(
        ctx.projectPath,
        args.name,
        args.healFormula,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'create_buff_skill',
    mutates: true,
    description: 'Create a buff skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      buffType: z.number().int().min(0).describe('Buff type (2=ATK, 3=DEF, 4=MAT, 5=MDF, 6=AGI)'),
      turns: z.number().describe('Number of turns the buff lasts'),
      mpCost: z.number().describe('MP cost'),
      scope: mvActionScopeSchema,
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createBuffSkill(
        ctx.projectPath,
        args.name,
        args.buffType,
        args.turns,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'create_state_skill',
    mutates: true,
    description:
      'Create a state-inflicting skill (poison, sleep, etc.). Throws if `stateId` does not exist in States.json (create the state first with create_state).',
    inputSchema: {
      name: z.string().describe('Skill name'),
      stateId: z
        .number()
        .int()
        .positive()
        .describe('State ID (4=poison, 5=blind, 6=silence, 8=confusion, etc.)'),
      chance: z.number().describe('Success chance (0.0-1.0)'),
      mpCost: z.number().describe('MP cost'),
      scope: mvActionScopeSchema,
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createStateSkill(
        ctx.projectPath,
        args.name,
        args.stateId,
        args.chance,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'update_skill',
    mutates: true,
    description: "Update a skill's properties",
    inputSchema: {
      skillId: z.number().int().positive().describe('The skill ID to update'),
      updates: z.object({ scope: mvActionScopeSchema.optional() }).passthrough().describe('Properties to update'),
    },
    handler: (ctx, args) => updateSkill(ctx.projectPath, args.skillId, args.updates),
  },
  {
    name: 'search_skills',
    description: 'Search skills by name or description',
    inputSchema: { searchTerm: z.string().describe('Search term') },
    handler: (ctx, args) => searchSkills(ctx.projectPath, args.searchTerm),
  },
];
