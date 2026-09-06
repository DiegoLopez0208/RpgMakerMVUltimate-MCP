/**
 * eventNormalize.ts — last-line normalisation of map event data before it is
 * written to a project file.
 *
 * RPG Maker MV's editor writes whole numbers for coordinates, ids, opcodes and
 * the numeric slots of event command parameters. Tool arguments arrive as
 * numeric strings often enough ("x": "1") that a string could survive argument
 * handling and land in the JSON, which the engine tolerates at runtime but which
 * makes the file non-canonical: the editor rewrites those values on the next
 * save, and type-aware tooling, diffs and $dataMap consumers see mixed types
 * (issue #15).
 *
 * The rule here is deliberately narrow: coerce ONLY the slots the engine
 * defines as numeric. There is no blanket recursion, because plenty of
 * parameters are strings by design —
 *
 *   101[0] face image filename        118[0]/119[0] label names
 *   102[0] the choice labels          320[1]/324[1]/325[1] names and profiles
 *   401/405 message and scroll text   355/655 script lines, 356 plugin commands
 *   108/408 comments                  111[1] the button name of a key branch
 *
 * — and coercing those corrupts messages and breaks plugins. Any opcode absent
 * from the table below is passed through untouched.
 */

/**
 * Indices of `parameters` that RPG Maker MV defines as numeric, per command
 * code. An empty array documents "this opcode is known and has no numeric
 * slots", which is different from an opcode we simply do not model.
 *
 * Only the opcodes this server emits are listed. Adding one is safe; guessing
 * one is not, so anything unlisted stays as it arrived.
 */
const NUMERIC_PARAMS: Record<number, number[]> = {
  0: [],           // end of list
  101: [1, 2, 3],  // Show Text [faceName, faceIndex, background, positionType]
  102: [1],        // Show Choices [choices[], cancelType]
  108: [],         // Comment
  111: [0],        // Conditional Branch: only the branch type; the rest is shape-dependent (type 12 is a script)
  118: [],         // Label
  119: [],         // Jump to Label
  121: [0, 1, 2],  // Control Switches [start, end, value]
  // 122 Control Variables is handled separately: its operand slots are numeric
  // unless operandType is 4 (Script), where parameters[4] is a string.
  123: [1],        // Control Self Switch ['A'..'D', value]
  125: [0, 1, 2],  // Change Gold [operation, operandType, value]
  126: [0, 1, 2, 3], // Change Items [itemId, operation, operandType, value]
  127: [0, 1, 2, 3], // Change Weapons
  128: [0, 1, 2, 3], // Change Armors
  129: [0, 1],     // Change Party Member [actorId, operation, initialize]
  201: [0, 1, 2, 3, 4, 5], // Transfer Player [type, mapId, x, y, direction, fadeType]
  204: [0, 1, 2],  // Scroll Map [direction, distance, speed]
  205: [0],        // Set Movement Route [characterId, route]
  212: [0, 1],     // Show Animation [characterId, animationId, wait]
  214: [],         // Erase Event
  230: [0],        // Wait [duration]
  231: [0, 2, 3, 4, 5, 6, 7, 8, 9], // Show Picture; [1] is the picture filename
  241: [],         // Play BGM (audio object)
  242: [0],        // Fadeout BGM [duration]
  245: [],         // Play BGS (audio object)
  246: [0],        // Fadeout BGS [duration]
  249: [],         // Play ME (audio object)
  250: [],         // Play SE (audio object)
  301: [0, 1],     // Battle Processing [type, troopId, canEscape, canLose]
  302: [0, 1, 2, 3], // Shop Processing [goodsType, id, priceType, price, purchaseOnly]
  303: [0, 1],     // Name Input [actorId, maxLength]
  311: [0, 1, 2, 3, 4], // Change HP
  312: [0, 1, 2, 3, 4], // Change MP
  313: [0, 1, 2, 3],    // Change State
  314: [0, 1],          // Recover All
  315: [0, 1, 2, 3, 4], // Change EXP
  316: [0, 1, 2, 3, 4], // Change Level
  318: [0, 1, 2, 3],    // Change Skill
  319: [0, 1, 2],       // Change Equipment
  320: [0],        // Change Name [actorId, name]
  321: [0, 1],     // Change Class [actorId, classId, saveExp]
  323: [0, 2],     // Change Vehicle Image [vehicleId, image, index]
  353: [],         // Game Over
  356: [],         // Plugin Command (single string)
  401: [],         // Text data
  402: [0],        // When [n, choiceName]
  403: [],         // When Cancel
  404: [],         // End of choices
  411: [],         // Else
  412: [],         // End of branch
  505: [],         // Move route step (the step object is normalised via moveRoute)
  601: [], 602: [], 603: [], 604: [], // Battle result branches
  605: [],         // Repeat of the previous command's parameters
};

/**
 * Move route command codes whose parameters carry a number, and where.
 * ROUTE_CHANGE_IMAGE is [characterName, characterIndex], so only index 1.
 */
const ROUTE_NUMERIC_PARAMS: Record<number, number[]> = {
  15: [0], // Wait [frames]
  27: [0], // Switch ON [switchId]
  28: [0], // Switch OFF [switchId]
  29: [0], // Change Speed
  30: [0], // Change Frequency
  41: [1], // Change Image [characterName, characterIndex]
  42: [0], // Change Opacity
  43: [0], // Change Blend Mode
};

/** Event fields the engine stores as whole numbers. */
const EVENT_INT_FIELDS = ["id", "x", "y"];
/** Page fields the engine stores as whole numbers. */
const PAGE_INT_FIELDS = ["moveFrequency", "moveSpeed", "moveType", "priorityType", "trigger"];
/** Page image fields; characterName stays a string. */
const IMAGE_INT_FIELDS = ["characterIndex", "direction", "pattern", "tileId"];
/** Page condition fields; selfSwitchCh stays a string and the *Valid flags stay booleans. */
const CONDITION_INT_FIELDS = ["actorId", "itemId", "switch1Id", "switch2Id", "variableId", "variableValue"];

/**
 * A whole number when the value already is one or is a string holding exactly
 * one, and the value untouched otherwise. Never throws: callers have already
 * validated their input, and a value this function does not recognise is more
 * likely a payload it should not be rewriting than an error to raise at the
 * moment of writing a file.
 */
function asInt(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!/^[+-]?\d+$/.test(t)) return value;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : value;
}

function normalizeFields(target: unknown, fields: string[]): void {
  if (!target || typeof target !== "object") return;
  const obj = target as Record<string, unknown>;
  for (const f of fields) {
    if (obj[f] !== undefined) obj[f] = asInt(obj[f]);
  }
}

function normalizeParams(code: number, parameters: unknown, table: Record<number, number[]>): void {
  if (!Array.isArray(parameters)) return;
  const slots = Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
  if (!slots) return;
  for (const i of slots) {
    if (i < parameters.length) parameters[i] = asInt(parameters[i]);
  }
}

/**
 * Control Variables (122): [startId, endId, operation, operandType, ...operand].
 * The first four are always numeric. The operand slots are numeric for every
 * operandType except 4 (Script), where parameters[4] is a line of JavaScript.
 */
function normalizeControlVariables(parameters: unknown): void {
  if (!Array.isArray(parameters)) return;
  for (let i = 0; i < 4 && i < parameters.length; i++) parameters[i] = asInt(parameters[i]);
  if (parameters[3] === 4) return; // Script operand: leave the rest alone
  for (let i = 4; i < parameters.length; i++) parameters[i] = asInt(parameters[i]);
}

function normalizeMoveRoute(route: unknown): void {
  if (!route || typeof route !== "object") return;
  const list = (route as { list?: unknown }).list;
  if (!Array.isArray(list)) return;
  for (const step of list) {
    if (!step || typeof step !== "object") continue;
    const s = step as { code?: unknown; parameters?: unknown };
    s.code = asInt(s.code);
    if (typeof s.code === "number") normalizeParams(s.code, s.parameters, ROUTE_NUMERIC_PARAMS);
  }
}

function normalizeCommandList(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const command of list) {
    if (!command || typeof command !== "object") continue;
    const c = command as { code?: unknown; indent?: unknown; parameters?: unknown };
    c.code = asInt(c.code);
    if (c.indent !== undefined) c.indent = asInt(c.indent);
    if (typeof c.code !== "number") continue;
    if (c.code === 122) {
      normalizeControlVariables(c.parameters);
    } else {
      normalizeParams(c.code, c.parameters, NUMERIC_PARAMS);
      // Set Movement Route carries the route object in parameters[1].
      if (c.code === 205 && Array.isArray(c.parameters)) normalizeMoveRoute(c.parameters[1]);
    }
  }
}

/**
 * Coerce the engine-defined numeric fields of every event on a map, in place.
 * Safe to call on any map object; anything unrecognised is left as it is.
 */
export function normalizeMapEvents(map: unknown): void {
  if (!map || typeof map !== "object") return;
  const events = (map as { events?: unknown }).events;
  if (!Array.isArray(events)) return;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    normalizeFields(event, EVENT_INT_FIELDS);
    const pages = (event as { pages?: unknown }).pages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const p = page as { image?: unknown; conditions?: unknown; list?: unknown; moveRoute?: unknown };
      normalizeFields(page, PAGE_INT_FIELDS);
      normalizeFields(p.image, IMAGE_INT_FIELDS);
      normalizeFields(p.conditions, CONDITION_INT_FIELDS);
      normalizeCommandList(p.list);
      normalizeMoveRoute(p.moveRoute);
    }
  }
}
