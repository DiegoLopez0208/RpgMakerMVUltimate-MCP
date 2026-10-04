/**
 * troopPage.ts — build a troop battle-event page from a compact trigger.
 *
 * A troop page is { conditions, list, span }. The editor always writes all twelve
 * condition fields and turns individual checks on with the *Valid flags, and
 * Game_Troop.meetsConditions refuses a page with none of them on. So a caller
 * names only the checks it wants and everything else gets the editor's defaults.
 *
 * Pure: no I/O. Ported from the troop page builder in PR #20.
 */
import { z } from "zod";
import type { EventCommand } from "../types/rpgmaker.js";
import { validateEventCommands } from "./eventCommandValidation.js";

export interface TroopPage {
  conditions: {
    actorHp: number; actorId: number; actorValid: boolean;
    enemyHp: number; enemyIndex: number; enemyValid: boolean;
    switchId: number; switchValid: boolean;
    turnA: number; turnB: number; turnEnding: boolean; turnValid: boolean;
  };
  list: EventCommand[];
  span: number;
}

const whole = (min: number, max = Number.MAX_SAFE_INTEGER) => z.preprocess(
  value => (typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
  z.number().int().min(min).max(max),
);
const command = z.object({ code: whole(0), indent: whole(0, 100).default(0), parameters: z.array(z.unknown()) }).strict();

/** Every check given is ANDed, as the editor's checkboxes are; at least one is required. */
export const troopPageSchema = z.object({
  when: z.object({
    /** Turn a + b*X; b 0 means only turn a. Same formula as an enemy action's turn condition. */
    turn: z.tuple([whole(0), whole(0)]).optional(),
    /** Troop slot (from 0) at or below this HP percentage. */
    enemyHpBelow: z.tuple([whole(0, 7), whole(0, 100)]).optional(),
    /** Actor at or below this HP percentage. */
    actorHpBelow: z.tuple([whole(1), whole(0, 100)]).optional(),
    switchId: whole(1).optional(),
    turnEnd: z.boolean().optional(),
  }).strict().refine(when => Object.values(when).some(value => value !== undefined && value !== false), {
    message: "a troop page needs at least one condition (turn, enemyHpBelow, actorHpBelow, switchId, turnEnd); with none the engine never runs it",
  }),
  /** How often the page may run: once per battle, once per turn, or every time its conditions hold. */
  span: z.enum(["battle", "turn", "moment"]).default("battle"),
  commands: z.array(command).default([]),
  /** Zero-based page index to insert at; default appends. */
  position: whole(0).optional(),
}).strict();

export function buildTroopPage(input: unknown): { page: TroopPage; position?: number; warnings: string[] } {
  const args = troopPageSchema.parse(input);
  const { when } = args;
  const conditions: TroopPage["conditions"] = {
    actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false,
    switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false,
  };
  if (when.turn) Object.assign(conditions, { turnValid: true, turnA: when.turn[0], turnB: when.turn[1] });
  if (when.enemyHpBelow) Object.assign(conditions, { enemyValid: true, enemyIndex: when.enemyHpBelow[0], enemyHp: when.enemyHpBelow[1] });
  if (when.actorHpBelow) Object.assign(conditions, { actorValid: true, actorId: when.actorHpBelow[0], actorHp: when.actorHpBelow[1] });
  if (when.switchId !== undefined) Object.assign(conditions, { switchValid: true, switchId: when.switchId });
  if (when.turnEnd) conditions.turnEnding = true;

  const base = args.commands.length ? Math.min(...args.commands.map(c => c.indent)) : 0;
  const fragment = validateEventCommands(args.commands.map(c => ({ ...c, indent: c.indent - base })), { fragment: true });
  const list = [...fragment.commands, { code: 0, indent: 0, parameters: [] }];
  return {
    page: { conditions, list, span: { battle: 0, turn: 1, moment: 2 }[args.span] },
    ...(args.position === undefined ? {} : { position: args.position }),
    warnings: fragment.warnings,
  };
}
