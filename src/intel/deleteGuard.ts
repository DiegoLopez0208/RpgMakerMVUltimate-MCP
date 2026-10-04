/**
 * deleteGuard.ts — what still points at a database entry about to be deleted.
 *
 * Deleting an entry nulls it in place; anything that still references it then
 * fails at runtime (a shop selling a missing item, a troop with a missing
 * enemy, a class learning a missing skill). This collects those references from
 * two places:
 *  - event command lists, page conditions and encounters, through the project
 *    index's findUsage (the same answers as analyze_project view "usage");
 *  - other database tables: the starting party, actor classes and starting
 *    equipment, class learnings, enemy actions and drops, troop members,
 *    traits, item and skill effects, and animations.
 *
 * Read-only. Event commands that change a skill (code 318) are not indexed by
 * skill, so skills are only checked against the database.
 */
import { readJson } from '../utils/fileHandler.js';
import { getProjectIndex } from './projectIndex.js';
import { findUsage, type RefKind } from './graph.js';

export type DeletableEntity =
  'actors' | 'classes' | 'skills' | 'enemies' | 'states' | 'troops' | 'animations' | 'items' | 'weapons' | 'armors';

/** Entities the project index tracks inside event command lists. */
const EVENT_KIND: Partial<Record<DeletableEntity, RefKind>> = {
  actors: 'actors', states: 'states', troops: 'troops', animations: 'animations',
  items: 'items', weapons: 'weapons', armors: 'armors',
};

// MV trait codes: 13 state rate, 14 state resist, 32 attack state, 43 add skill, 44 seal skill.
// MV effect codes: 21 add state, 22 remove state, 43 learn skill.
type Entry = { id?: number; name?: string; [key: string]: unknown };

export async function referencesTo(projectPath: string, entity: DeletableEntity, id: number): Promise<string[]> {
  const out: string[] = [];
  const kind = EVENT_KIND[entity];
  if (kind) {
    // Rebuilt rather than cached: a stale index would miss a reference added this session.
    const index = await getProjectIndex(projectPath, true);
    for (const hit of findUsage(index, kind, id)) out.push(hit.source);
  }

  const table = async (file: string): Promise<Entry[]> => {
    try {
      const value = await readJson(projectPath, file);
      return Array.isArray(value) ? value.filter((e): e is Entry => !!e && typeof e === 'object') : [];
    } catch { return []; }
  };
  const label = (what: string, e: Entry) => what + ' ' + e.id + (e.name ? ' "' + e.name + '"' : '');
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];

  const traits = async (codes: number[], what: string) => {
    for (const [file, owner] of [['Actors.json', 'Actor'], ['Classes.json', 'Class'], ['Weapons.json', 'Weapon'], ['Armors.json', 'Armor'], ['Enemies.json', 'Enemy'], ['States.json', 'State']]) {
      for (const e of await table(file)) {
        if (list(e.traits).some((t) => codes.includes(t.code as number) && t.dataId === id)) out.push(label(owner, e) + ' ' + what);
      }
    }
  };
  const effects = async (codes: number[], what: string) => {
    for (const [file, owner] of [['Skills.json', 'Skill'], ['Items.json', 'Item']]) {
      for (const e of await table(file)) {
        if (list(e.effects).some((f) => codes.includes(f.code as number) && f.dataId === id)) out.push(label(owner, e) + ' ' + what);
      }
    }
  };

  switch (entity) {
    case 'actors': {
      const system = await readJson(projectPath, 'System.json').catch(() => null) as { partyMembers?: unknown } | null;
      if (Array.isArray(system?.partyMembers) && system!.partyMembers.includes(id)) out.push('System starting party');
      break;
    }
    case 'classes':
      for (const a of await table('Actors.json')) if (a.classId === id) out.push(label('Actor', a) + ' class');
      break;
    case 'skills':
      for (const c of await table('Classes.json')) if (list(c.learnings).some((l) => l.skillId === id)) out.push(label('Class', c) + ' learnings');
      for (const e of await table('Enemies.json')) if (list(e.actions).some((a) => a.skillId === id)) out.push(label('Enemy', e) + ' actions');
      await traits([43, 44], 'trait (add or seal skill)');
      await effects([43], 'effect (learn skill)');
      break;
    case 'states':
      await traits([13, 14, 32], 'trait (state rate, resist or attack state)');
      await effects([21, 22], 'effect (add or remove state)');
      break;
    case 'enemies':
      for (const t of await table('Troops.json')) if (list(t.members).some((m) => m.enemyId === id)) out.push(label('Troop', t) + ' members');
      break;
    case 'animations':
      for (const [file, owner] of [['Skills.json', 'Skill'], ['Items.json', 'Item'], ['Weapons.json', 'Weapon']]) {
        for (const e of await table(file)) if (e.animationId === id) out.push(label(owner, e) + ' animation');
      }
      break;
    case 'items':
    case 'weapons':
    case 'armors': {
      const dropKind = { items: 1, weapons: 2, armors: 3 }[entity];
      for (const e of await table('Enemies.json')) {
        if (list(e.dropItems).some((d) => d.kind === dropKind && d.dataId === id)) out.push(label('Enemy', e) + ' drops');
      }
      if (entity !== 'items') {
        // Slot 0 holds the weapon; the others hold armor (a dual-wield second weapon is not distinguished).
        for (const a of await table('Actors.json')) {
          const equips = Array.isArray(a.equips) ? (a.equips as unknown[]) : [];
          const slots = entity === 'weapons' ? equips.slice(0, 1) : equips.slice(1);
          if (slots.includes(id)) out.push(label('Actor', a) + ' starting equipment');
        }
      }
      break;
    }
    case 'troops':
      break; // battles and encounters are event-level references, covered above
  }
  return [...new Set(out)];
}
