import { z } from 'zod';

export const mvActionScopeDescription =
  'MV target scope (0=none, 1=one enemy, 2=all enemies, 3–6=random enemies, 7=one ally, 8=all allies, 9=one dead ally, 10=all dead allies, 11=user)';

export const mvActionScopeSchema = z.number().int().min(0).max(11).describe(mvActionScopeDescription);

/** MV has no targets for MZ-only scopes 12–14. Apply this before any write path. */
export function assertMvActionScope(scope: unknown): asserts scope is number {
  if (typeof scope !== 'number' || !Number.isInteger(scope) || scope < 0 || scope > 11) {
    throw new Error('scope must be an integer from 0 to 11 for RPG Maker MV');
  }
}
