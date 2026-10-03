import { refExists } from './references.js';
import { Effect } from '../utils/types.js';

/**
 * Create-time reference guards (Phase 7 P2-3). Where {@link checkReferences} is a
 * read-only warn-by-default *audit* run after the fact, these are the **throw**
 * side: the `create_*` tools call them so a skill/item/enemy that points at a
 * non-existent db record fails at author time — matching the existing throwing
 * checks (`add_class_learning` skillId, `create_troop` member.enemyId,
 * `call_common_event` commonEventId) so reference validation is consistent across
 * every create tool. Pure (no I/O): each returns the first offending reference as
 * an error message, or `null` when everything resolves, so the caller throws.
 *
 * A target array that's empty (its file was absent / failed to load) is treated
 * as "can't verify" and skipped, so a minimal project or test fixture can't
 * produce a false throw — the same false-positive guard `checkReferences` uses.
 */

// Game_Action effect codes carrying a data-id reference (mirrors references.ts).
const EFFECT_ADD_STATE = 21;
const EFFECT_REMOVE_STATE = 22;
const EFFECT_LEARN_SKILL = 43;
const EFFECT_COMMON_EVENT = 44;

/** The db arrays a skill/item effect can reference. */
export interface EffectRefTargets {
  states: readonly (unknown | null)[];
  skills: readonly (unknown | null)[];
  commonEvents: readonly (unknown | null)[];
}

/**
 * First skill/item effect whose dataId points at a missing db record → an error
 * message; `null` if every effect resolves. Add/Remove State (21/22) → state
 * (skips dataId 0, the "normal attack states" sentinel), Learn Skill (43) →
 * skill, Common Event (44) → common event. Buff/Debuff codes (31/32) carry a
 * param index rather than a db id, so they're intentionally not checked.
 */
export function firstMissingEffectRef(
  effects: Effect[] | undefined,
  targets: EffectRefTargets,
): string | null {
  if (!Array.isArray(effects)) return null;
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (!e) continue;
    if (
      (e.code === EFFECT_ADD_STATE || e.code === EFFECT_REMOVE_STATE) &&
      e.dataId !== 0 &&
      targets.states.length > 0 &&
      !refExists(targets.states, e.dataId)
    ) {
      const verb = e.code === EFFECT_ADD_STATE ? 'adds' : 'removes';
      return `effect ${i} ${verb} state ${e.dataId}, which does not exist`;
    }
    if (
      e.code === EFFECT_LEARN_SKILL &&
      targets.skills.length > 0 &&
      !refExists(targets.skills, e.dataId)
    ) {
      return `effect ${i} (Learn Skill) references skill ${e.dataId}, which does not exist`;
    }
    if (
      e.code === EFFECT_COMMON_EVENT &&
      targets.commonEvents.length > 0 &&
      !refExists(targets.commonEvents, e.dataId)
    ) {
      return `effect ${i} (Common Event) references common event ${e.dataId}, which does not exist`;
    }
  }
  return null;
}

/** The db arrays an enemy's actions/drops can reference. */
export interface EnemyRefTargets {
  skills: readonly (unknown | null)[];
  items: readonly (unknown | null)[];
  weapons: readonly (unknown | null)[];
  armors: readonly (unknown | null)[];
}

/**
 * First enemy reference that points at a missing db record → an error message;
 * `null` if everything resolves. `actions[].skillId` → skill; `dropItems[].dataId`
 * → item/weapon/armor by `kind` (1/2/3; kind 0 = no drop, skipped).
 */
export function firstMissingEnemyRef(
  enemy: {
    actions?: Array<{ skillId: number } | null>;
    dropItems?: Array<{ kind: number; dataId: number } | null>;
  },
  targets: EnemyRefTargets,
): string | null {
  if (Array.isArray(enemy.actions) && targets.skills.length > 0) {
    for (let i = 0; i < enemy.actions.length; i++) {
      const a = enemy.actions[i];
      if (a && !refExists(targets.skills, a.skillId)) {
        return `action ${i} uses skill ${a.skillId}, which does not exist`;
      }
    }
  }
  if (Array.isArray(enemy.dropItems)) {
    for (let i = 0; i < enemy.dropItems.length; i++) {
      const d = enemy.dropItems[i];
      if (!d) continue;
      const target =
        d.kind === 1
          ? targets.items
          : d.kind === 2
            ? targets.weapons
            : d.kind === 3
              ? targets.armors
              : null;
      if (target && target.length > 0 && !refExists(target, d.dataId)) {
        const label = d.kind === 1 ? 'item' : d.kind === 2 ? 'weapon' : 'armor';
        return `dropItems[${i}] drops ${label} ${d.dataId}, which does not exist`;
      }
    }
  }
  return null;
}
