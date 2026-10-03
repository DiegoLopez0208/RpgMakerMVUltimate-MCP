import type { EventCommand, MapData, MapEvent, EventPage } from './types.js';

/**
 * Condensed responses for mutating tools.
 *
 * A write tool that echoes the whole record back is expensive for the one caller
 * that always pays for it: an AI assistant, whose context is the scarce resource.
 * `update_map` returned every event on the map *including every page's full
 * command list* — so a routine "set the BGM" call replayed thousands of tokens of
 * dialogue the caller had written seconds earlier. `insert_event_commands`
 * re-printed the entire growing list on every splice, so building one scene in
 * three calls paid for that scene three times.
 *
 * The precedent for fixing this is already in the codebase: `create_map` and
 * `update_map` drop the tile `data` array from their echo, and `create_map_event`
 * returns `summarizeCreatedEvent(event)` rather than the event. This module
 * generalises that from two ad-hoc cases into one mechanism.
 *
 * THE RULE THESE SUMMARIES FOLLOW: keep everything you would ASSERT on, drop
 * everything you would only re-read. Identity, counts, and the structural shape
 * of a command list stay; command parameters, page conditions and move routes go.
 * The full record is always one read-only call away (`get_map`, `get_map_event`,
 * `get_database`), and `verbose: true` restores the old echo on any single call.
 */

/**
 * Rewrite selected keys of a handler's result, passing every other key through
 * untouched.
 *
 * Pass-through is what makes this safe to bolt onto `writeGate.respond`, whose
 * shape is `{ <payload>, warnings? }`: a summarizer names only the payload key
 * and `warnings` survives automatically. A key that is absent is skipped, so one
 * summarizer can cover handlers whose response shape varies.
 */
export function condense(
  result: unknown,
  rewriters: Record<string, (value: unknown) => unknown>,
): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    out[key] = key in rewriters ? rewriters[key](value) : value;
  }
  return out;
}

/**
 * A command list as its length and its command CODES, without the parameters.
 *
 * The codes are kept deliberately rather than dropping the list entirely: they
 * are how you verify a write did what you asked without re-reading it — "is the
 * 302 still after the two 101s", "did the 214 land at the end", "is the block
 * still balanced". That is a real diagnostic (it is how a shop that appeared not
 * to open was traced to the harness rather than the data), and it costs ~4 bytes
 * a command against ~100 for the full row.
 */
export function commandListShape(list: EventCommand[]): { length: number; codes: number[] } {
  return { length: list.length, codes: list.map((c) => c.code) };
}

/** One event page reduced to what decides its behaviour. */
function pageShape(page: EventPage, index: number): Record<string, unknown> {
  return {
    index,
    trigger: page.trigger,
    priorityType: page.priorityType,
    moveType: page.moveType,
    ...(page.image && page.image.characterName
      ? { characterName: page.image.characterName, characterIndex: page.image.characterIndex }
      : {}),
    ...(page.image && page.image.tileId ? { tileId: page.image.tileId } : {}),
    listLength: page.list.length,
  };
}

/**
 * A full `MapEvent` reduced to its identity plus a per-page behaviour summary.
 *
 * A superset of the existing `summarizeCreatedEvent` (which stops at
 * `pageCount`): the per-page trigger/priority/graphic is exactly what an
 * `update_map_event` or `set_event_page` caller wants to confirm, and it is what
 * catches the classic "action-button page left at priority below" mistake
 * without a second round trip.
 */
export function eventShape(event: MapEvent): Record<string, unknown> {
  return {
    id: event.id,
    name: event.name,
    x: event.x,
    y: event.y,
    pageCount: event.pages.length,
    pages: event.pages.map(pageShape),
  };
}

/**
 * A map echo without its `events` array.
 *
 * `update_map` does not touch events — it merges top-level properties — so
 * echoing them was never informative, and on a map with real cutscenes on it the
 * events dwarf everything else in the response. The count is kept so a caller can
 * still see at a glance that nothing was clobbered.
 */
export function mapShape(map: Partial<MapData> & { events?: unknown }): Record<string, unknown> {
  const { events, ...rest } = map as Record<string, unknown> & { events?: unknown[] };
  return {
    ...rest,
    eventCount: Array.isArray(events) ? events.filter(Boolean).length : 0,
  };
}

/** `{ event }` → `{ event: <shape> }`, warnings and any other key untouched. */
export const summarizeEventResult = (result: unknown): unknown =>
  condense(result, { event: (e) => eventShape(e as MapEvent) });

/** `{ ...map }` → the same map without its `events` array. */
export const summarizeMapResult = (result: unknown): unknown =>
  mapShape(result as Partial<MapData>);

/** `{ list }` → `{ listLength, listCodes }`, for the command-list writers. */
export const summarizeCommandListResult = (result: unknown): unknown => {
  if (result === null || typeof result !== 'object') return result;
  const { list, ...rest } = result as Record<string, unknown>;
  if (!Array.isArray(list)) return result;
  const shape = commandListShape(list as EventCommand[]);
  return { ...rest, listLength: shape.length, listCodes: shape.codes };
};

/** `{ commonEvent }` → identity + trigger wiring + command-list shape. */
export const summarizeCommonEventResult = (result: unknown): unknown =>
  condense(result, {
    commonEvent: (value) => {
      const ce = value as {
        id: number;
        name: string;
        trigger?: number;
        switchId?: number;
        list?: EventCommand[];
      };
      return {
        id: ce.id,
        name: ce.name,
        trigger: ce.trigger,
        switchId: ce.switchId,
        ...(Array.isArray(ce.list)
          ? { listLength: ce.list.length, listCodes: ce.list.map((c) => c.code) }
          : {}),
      };
    },
  });

/** `{ troop }` → identity + members + per-page battle-event list shape. */
export const summarizeTroopResult = (result: unknown): unknown =>
  condense(result, {
    troop: (value) => {
      const troop = value as {
        id: number;
        name: string;
        members?: unknown[];
        pages?: { list?: EventCommand[] }[];
      };
      return {
        id: troop.id,
        name: troop.name,
        // Members are small and are the whole point of a troop — keep them.
        members: troop.members,
        pages: (troop.pages ?? []).map((page, index) => ({
          index,
          listLength: Array.isArray(page.list) ? page.list.length : 0,
        })),
      };
    },
  });
