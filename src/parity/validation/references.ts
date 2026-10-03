import {
  Actor,
  GameClass,
  Skill,
  Item,
  Weapon,
  Armor,
  Enemy,
  Troop,
  State,
  CommonEvent,
  MapEvent,
  MapInfo,
  SystemData,
  Effect,
} from '../utils/types.js';

/**
 * A single cross-file reference-integrity finding. Like {@link
 * ValidationWarning} this is warn-by-default (it never blocks a write); it tells
 * the caller that one record points at another record that doesn't exist — a
 * dangling id the RPG Maker editor would silently treat as "nothing", producing
 * a subtle runtime bug rather than an error. `category` groups findings by the
 * kind of reference; `path` locates the offending field.
 */
export interface ReferenceWarning {
  category: string;
  path: string;
  message: string;
}

/**
 * The loaded project data the reference linter cross-checks. Every database
 * array is the raw 1-indexed file (slot 0 `null`). `animations` is `null` when
 * `Animations.json` couldn't be loaded, so animation-id checks are skipped
 * rather than flagging every reference. Kept as plain data so {@link
 * checkReferences} stays pure and unit-testable without file I/O.
 */
export interface ProjectData {
  mapInfos: (MapInfo | null)[];
  /**
   * Only the maps that loaded, carrying just the id + events (and, when known,
   * the random-encounter list) the linter needs.
   */
  maps: Array<{
    id: number;
    events: (MapEvent | null)[];
    encounterList?: Array<{ troopId: number }>;
  }>;
  actors: (Actor | null)[];
  classes: (GameClass | null)[];
  skills: (Skill | null)[];
  items: (Item | null)[];
  weapons: (Weapon | null)[];
  armors: (Armor | null)[];
  enemies: (Enemy | null)[];
  troops: (Troop | null)[];
  states: (State | null)[];
  commonEvents: (CommonEvent | null)[];
  /** `null` = Animations.json unavailable → animation-id checks skipped. */
  animations: (unknown | null)[] | null;
  system: SystemData | null;
}

// Game_Action effect codes (rpg_objects.js) that carry a data-id reference.
const EFFECT_ADD_STATE = 21;
const EFFECT_REMOVE_STATE = 22;
const EFFECT_LEARN_SKILL = 43;
const EFFECT_COMMON_EVENT = 44;

// Event command codes that carry a cross-file data-id reference.
const CMD_TRANSFER_PLAYER = 201;
const CMD_COMMON_EVENT = 117;
const CMD_CHANGE_ITEMS = 126;
const CMD_CHANGE_WEAPONS = 127;
const CMD_CHANGE_ARMORS = 128;
const CMD_CHANGE_PARTY_MEMBER = 129;
const CMD_BATTLE_PROCESSING = 301;
const CMD_SHOP_PROCESSING = 302;
const CMD_SHOP_GOODS = 605;
const CMD_CHANGE_STATE = 313;
const CMD_CHANGE_SKILL = 318;
const CMD_SHOW_ANIMATION = 212;
const CMD_SHOW_BATTLE_ANIMATION = 337;

/**
 * Whether `id` names a live entry in a 1-indexed RPG Maker database array (slot
 * 0 is `null`; id === array index). A `0`/negative id, an out-of-range id, or a
 * nulled slot all count as "does not exist". An empty array (a file that failed
 * to load) is treated as "can't verify" — never a match, but callers guard on
 * array length so a failed load doesn't flag every reference.
 */
export function refExists(arr: readonly (unknown | null)[], id: number): boolean {
  return id > 0 && id < arr.length && arr[id] != null;
}

/**
 * Map-tree integrity: a non-root `parentId` must name an existing map, and no
 * map may be its own transitive ancestor. Mirrors `assertNoTreeCycles` in
 * mapTools but collects findings instead of throwing (this is a read-only audit).
 */
function checkMapTree(mapInfos: (MapInfo | null)[]): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];

  for (const info of mapInfos) {
    if (!info) continue;
    if (info.parentId !== 0 && !mapInfos[info.parentId]) {
      warnings.push({
        category: 'map-tree',
        path: `MapInfos[${info.id}]`,
        message: `parentId ${info.parentId} does not match any existing map`,
      });
    }
  }

  for (const start of mapInfos) {
    if (!start) continue;
    const seen = new Set<number>([start.id]);
    let parentId = start.parentId;
    while (parentId !== 0) {
      if (seen.has(parentId)) {
        warnings.push({
          category: 'map-tree',
          path: `MapInfos[${start.id}]`,
          message: `map tree cycle: map ${start.id} is its own ancestor`,
        });
        break;
      }
      seen.add(parentId);
      const parent = mapInfos[parentId];
      if (!parent) break; // dangling parent already reported above
      parentId = parent.parentId;
    }
  }

  return warnings;
}

/** Game-start references: the starting party actors and the start map. */
function checkStartup(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];
  const { system, actors, mapInfos } = data;
  if (!system) return warnings;

  if (Array.isArray(system.partyMembers) && actors.length > 0) {
    system.partyMembers.forEach((actorId, i) => {
      if (!refExists(actors, actorId)) {
        warnings.push({
          category: 'startup',
          path: `System.partyMembers[${i}]`,
          message: `starting party member references actor ${actorId}, which does not exist`,
        });
      }
    });
  }

  if (
    typeof system.startMapId === 'number' &&
    system.startMapId > 0 &&
    !mapInfos[system.startMapId]
  ) {
    warnings.push({
      category: 'startup',
      path: 'System.startMapId',
      message: `starting position references map ${system.startMapId}, which does not exist`,
    });
  }

  return warnings;
}

/**
 * Skill/item effect references: Add/Remove State → an existing state, Learn
 * Skill → an existing skill, Common Event → an existing common event; plus the
 * item/skill `animationId` → an existing animation. Add-State with `dataId 0`
 * (the "normal attack states" sentinel) and a non-positive `animationId` (0 none
 * / -1 normal attack) are intentionally not flagged.
 */
function checkEffects(
  effects: Effect[] | undefined,
  animationId: number | undefined,
  path: string,
  data: ProjectData,
): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];

  if (Array.isArray(effects)) {
    effects.forEach((effect, i) => {
      const at = `${path} / effect ${i}`;
      if (
        (effect.code === EFFECT_ADD_STATE || effect.code === EFFECT_REMOVE_STATE) &&
        effect.dataId !== 0 &&
        data.states.length > 0 &&
        !refExists(data.states, effect.dataId)
      ) {
        warnings.push({
          category: 'effect',
          path: at,
          message: `effect references state ${effect.dataId}, which does not exist`,
        });
      }
      if (
        effect.code === EFFECT_LEARN_SKILL &&
        data.skills.length > 0 &&
        !refExists(data.skills, effect.dataId)
      ) {
        warnings.push({
          category: 'effect',
          path: at,
          message: `Learn Skill effect references skill ${effect.dataId}, which does not exist`,
        });
      }
      if (
        effect.code === EFFECT_COMMON_EVENT &&
        data.commonEvents.length > 0 &&
        !refExists(data.commonEvents, effect.dataId)
      ) {
        warnings.push({
          category: 'effect',
          path: at,
          message: `Common Event effect references common event ${effect.dataId}, which does not exist`,
        });
      }
    });
  }

  if (
    data.animations &&
    typeof animationId === 'number' &&
    animationId > 0 &&
    !refExists(data.animations, animationId)
  ) {
    warnings.push({
      category: 'animation',
      path: `${path} / animationId`,
      message: `references animation ${animationId}, which does not exist`,
    });
  }

  return warnings;
}

/** Skill and item effect/animation references. */
function checkSkillsAndItems(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];
  data.skills.forEach((skill) => {
    if (skill)
      warnings.push(...checkEffects(skill.effects, skill.animationId, `skill ${skill.id}`, data));
  });
  data.items.forEach((item) => {
    if (item)
      warnings.push(...checkEffects(item.effects, item.animationId, `item ${item.id}`, data));
  });
  return warnings;
}

/** Actor `classId` → class, class `learnings[].skillId` → skill. */
function checkActorsAndClasses(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];

  if (data.classes.length > 0) {
    data.actors.forEach((actor) => {
      if (actor && !refExists(data.classes, actor.classId)) {
        warnings.push({
          category: 'class',
          path: `actor ${actor.id} / classId`,
          message: `references class ${actor.classId}, which does not exist`,
        });
      }
    });
  }

  if (data.skills.length > 0) {
    data.classes.forEach((cls) => {
      if (!cls || !Array.isArray(cls.learnings)) return;
      cls.learnings.forEach((learning, i) => {
        if (!refExists(data.skills, learning.skillId)) {
          warnings.push({
            category: 'skill',
            path: `class ${cls.id} / learnings[${i}]`,
            message: `learns skill ${learning.skillId}, which does not exist`,
          });
        }
      });
    });
  }

  return warnings;
}

/**
 * Enemy `actions[].skillId` → skill and `dropItems` → item/weapon/armor, plus
 * troop `members[].enemyId` → enemy.
 */
function checkEnemiesAndTroops(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];

  data.enemies.forEach((enemy) => {
    if (!enemy) return;
    if (Array.isArray(enemy.actions) && data.skills.length > 0) {
      enemy.actions.forEach((action, i) => {
        if (!refExists(data.skills, action.skillId)) {
          warnings.push({
            category: 'skill',
            path: `enemy ${enemy.id} / actions[${i}]`,
            message: `action uses skill ${action.skillId}, which does not exist`,
          });
        }
      });
    }
    if (Array.isArray(enemy.dropItems)) {
      enemy.dropItems.forEach((drop, i) => {
        // kind 0 = no drop; 1 item, 2 weapon, 3 armor.
        const target =
          drop.kind === 1
            ? data.items
            : drop.kind === 2
              ? data.weapons
              : drop.kind === 3
                ? data.armors
                : null;
        if (target && target.length > 0 && !refExists(target, drop.dataId)) {
          const label = drop.kind === 1 ? 'item' : drop.kind === 2 ? 'weapon' : 'armor';
          warnings.push({
            category: 'drop-item',
            path: `enemy ${enemy.id} / dropItems[${i}]`,
            message: `drops ${label} ${drop.dataId}, which does not exist`,
          });
        }
      });
    }
  });

  if (data.enemies.length > 0) {
    data.troops.forEach((troop) => {
      if (!troop || !Array.isArray(troop.members)) return;
      troop.members.forEach((member, i) => {
        if (!refExists(data.enemies, member.enemyId)) {
          warnings.push({
            category: 'troop-member',
            path: `troop ${troop.id} / members[${i}]`,
            message: `references enemy ${member.enemyId}, which does not exist`,
          });
        }
      });
    });
  }

  return warnings;
}

/**
 * Cross-file references embedded in event command lists (map events, common
 * events, troop pages): Transfer Player (201, direct designation) → an existing
 * map, Common Event (117) → an existing common event, Change Items/Weapons/
 * Armors (126–128) and Shop Processing goods (302/605) → the item/weapon/armor,
 * Change Party Member (129) → an actor, Battle Processing (301, direct
 * designation) → a troop, and Change State/Skill (313/318, fixed actor) → the
 * actor and the state/skill. Variable-designated operands can't be resolved
 * statically, so they're skipped.
 */
function checkCommandRefs(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];

  /** Flag a positive numeric id that doesn't resolve (skipped when the table didn't load). */
  const checkId = (
    table: readonly (unknown | null)[],
    id: unknown,
    category: string,
    at: string,
    message: string,
  ): void => {
    if (typeof id === 'number' && id > 0 && table.length > 0 && !refExists(table, id)) {
      warnings.push({ category, path: at, message });
    }
  };

  const goodsTables: Array<[readonly (unknown | null)[], string]> = [
    [data.items, 'item'],
    [data.weapons, 'weapon'],
    [data.armors, 'armor'],
  ];

  const checkList = (list: unknown, path: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((cmd, i) => {
      if (!cmd || !Array.isArray(cmd.parameters)) return;
      const at = `${path} / command ${i}`;

      if (cmd.code === CMD_TRANSFER_PLAYER && cmd.parameters[0] === 0) {
        const mapId = cmd.parameters[1];
        if (typeof mapId === 'number' && mapId > 0 && !data.mapInfos[mapId]) {
          warnings.push({
            category: 'transfer',
            path: at,
            message: `Transfer Player targets map ${mapId}, which does not exist`,
          });
        }
      }

      if (cmd.code === CMD_COMMON_EVENT && data.commonEvents.length > 0) {
        const ceId = cmd.parameters[0];
        if (typeof ceId === 'number' && !refExists(data.commonEvents, ceId)) {
          warnings.push({
            category: 'common-event',
            path: at,
            message: `Common Event call references common event ${ceId}, which does not exist`,
          });
        }
      }

      const p = cmd.parameters;
      switch (cmd.code) {
        case CMD_SHOW_ANIMATION:
        case CMD_SHOW_BATTLE_ANIMATION:
          if (data.animations && !refExists(data.animations, p[1])) {
            warnings.push({
              category: 'animation',
              path: at,
              message: `Show Animation references animation ${p[1]}, which does not exist`,
            });
          }
          break;
        case CMD_CHANGE_ITEMS:
        case CMD_CHANGE_WEAPONS:
        case CMD_CHANGE_ARMORS: {
          const [table, label] = goodsTables[cmd.code - CMD_CHANGE_ITEMS];
          checkId(
            table,
            p[0],
            label,
            at,
            `Change ${label}s references ${label} ${p[0]}, which does not exist`,
          );
          break;
        }
        case CMD_CHANGE_PARTY_MEMBER:
          checkId(
            data.actors,
            p[0],
            'actor',
            at,
            `Change Party Member references actor ${p[0]}, which does not exist`,
          );
          break;
        case CMD_BATTLE_PROCESSING:
          if (p[0] === 0) {
            checkId(
              data.troops,
              p[1],
              'troop',
              at,
              `Battle Processing references troop ${p[1]}, which does not exist`,
            );
          }
          break;
        case CMD_SHOP_PROCESSING:
        case CMD_SHOP_GOODS: {
          const goods = typeof p[0] === 'number' ? goodsTables[p[0]] : undefined;
          if (goods) {
            const [table, label] = goods;
            checkId(
              table,
              p[1],
              label,
              at,
              `Shop Processing sells ${label} ${p[1]}, which does not exist`,
            );
          }
          break;
        }
        case CMD_CHANGE_STATE:
        case CMD_CHANGE_SKILL: {
          const isState = cmd.code === CMD_CHANGE_STATE;
          const name = isState ? 'Change State' : 'Change Skill';
          if (p[0] === 0) {
            checkId(
              data.actors,
              p[1],
              'actor',
              at,
              `${name} references actor ${p[1]}, which does not exist`,
            );
          }
          const label = isState ? 'state' : 'skill';
          checkId(
            isState ? data.states : data.skills,
            p[3],
            label,
            at,
            `${name} references ${label} ${p[3]}, which does not exist`,
          );
          break;
        }
      }
    });
  };

  for (const map of data.maps) {
    for (const event of map.events) {
      if (!event || !Array.isArray(event.pages)) continue;
      event.pages.forEach((page, pi) =>
        checkList(page?.list, `map ${map.id} / event ${event.id} / page ${pi}`),
      );
    }
  }

  data.commonEvents.forEach((ce) => {
    if (ce) checkList(ce.list, `common event ${ce.id}`);
  });

  data.troops.forEach((troop) => {
    if (!troop || !Array.isArray(troop.pages)) return;
    troop.pages.forEach((page, pi) => checkList(page?.list, `troop ${troop.id} / page ${pi}`));
  });

  return warnings;
}

/** Map random encounters (`encounterList[].troopId`) → an existing troop. */
function checkEncounters(data: ProjectData): ReferenceWarning[] {
  const warnings: ReferenceWarning[] = [];
  if (data.troops.length === 0) return warnings;
  for (const map of data.maps) {
    if (!Array.isArray(map.encounterList)) continue;
    map.encounterList.forEach((encounter, i) => {
      if (encounter && !refExists(data.troops, encounter.troopId)) {
        warnings.push({
          category: 'encounter',
          path: `map ${map.id} / encounterList[${i}]`,
          message: `random encounter references troop ${encounter.troopId}, which does not exist`,
        });
      }
    });
  }
  return warnings;
}

/**
 * Run every cross-file reference check over a loaded project snapshot. Pure and
 * warn-by-default: returns an aggregated list of dangling/cyclic references,
 * empty when everything resolves. See {@link ProjectData} for the input shape.
 */
export function checkReferences(data: ProjectData): ReferenceWarning[] {
  return [
    ...checkMapTree(data.mapInfos),
    ...checkStartup(data),
    ...checkSkillsAndItems(data),
    ...checkActorsAndClasses(data),
    ...checkEnemiesAndTroops(data),
    ...checkCommandRefs(data),
    ...checkEncounters(data),
  ];
}
