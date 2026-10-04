/**
 * eventCommandTable.ts — the single description of every RPG Maker MV event
 * command this server knows about.
 *
 * The validator, the AST parser and the numeric normaliser used to keep their
 * own copies of this data (parameter counts in one file, names and block
 * structure in another, numeric slots in a third), so a fix in one never
 * reached the others. Everything they need now comes from here.
 *
 * Each field is optional on purpose, because leaving it out has a meaning:
 *  - no `arity`: the parameter count is not checked. Only counts confirmed
 *    against what the editor writes belong here; guessing one makes the
 *    validator refuse real projects.
 *  - no `numeric`: the writer passes the parameters through untouched.
 *    `numeric: []` means "known, and has no numeric slots".
 *
 * Pure data with no imports, so any module can use it.
 */

export interface CommandSpec {
  /** Name as the editor shows it. */
  name: string;
  /** Parameter counts the validator accepts; an array lists every count the editor is known to write. */
  arity?: number | readonly number[];
  /** Parameter slots MV stores as whole numbers; only these are coerced from numeric strings. */
  numeric?: readonly number[];
  /** opener owns nested branches, section starts one, end closes the block. All share the opener's indent. */
  block?: 'opener' | 'section' | 'end';
  /** Continuation rows: the header code they extend (401 continues 101). */
  continues?: number;
  /** Continuation rows whose payload is folded into the header's text when the list is read as a tree. */
  folds?: true;
}

export const EVENT_COMMANDS: Readonly<Record<number, CommandSpec>> = {
0: { name: 'End', arity: 0, numeric: [] }, // end of list
  101: { name: 'Show Text', arity: 4, numeric: [1, 2, 3] }, // [faceName, faceIndex, background, positionType]
  102: { name: 'Show Choices', numeric: [1], block: 'opener' }, // [choices[], cancelType]
  103: { name: 'Input Number', arity: 2 },
  104: { name: 'Select Item', arity: 2 },
  105: { name: 'Show Scrolling Text', arity: 2 },
  108: { name: 'Comment', arity: 1, numeric: [] },
  111: { name: 'Conditional Branch', numeric: [0], block: 'opener' }, // only the branch type; the rest is shape-dependent (type 12 is a script)
  112: { name: 'Loop', arity: 0, block: 'opener' },
  113: { name: 'Break Loop', arity: 0 },
  115: { name: 'Exit Event Processing', arity: 0 },
  117: { name: 'Call Common Event', arity: 1 },
  118: { name: 'Label', arity: 1, numeric: [] },
  119: { name: 'Jump to Label', arity: 1, numeric: [] },
  121: { name: 'Control Switches', arity: 3, numeric: [0, 1, 2] }, // [start, end, value]
  122: { name: 'Control Variables' }, // numeric except the Script operand; eventNormalize handles it by operand type
  123: { name: 'Control Self Switch', arity: 2, numeric: [1] }, // ['A'..'D', value]
  124: { name: 'Control Timer', arity: 2 },
  125: { name: 'Change Gold', arity: 3, numeric: [0, 1, 2] }, // [operation, operandType, value]
  126: { name: 'Change Items', arity: 4, numeric: [0, 1, 2, 3] }, // [itemId, operation, operandType, value]
  127: { name: 'Change Weapons', arity: 5, numeric: [0, 1, 2, 3] },
  128: { name: 'Change Armors', arity: 5, numeric: [0, 1, 2, 3] },
  129: { name: 'Change Party Member', arity: 3, numeric: [0, 1] }, // [actorId, operation, initialize]
  132: { name: 'Change Battle BGM' },
  133: { name: 'Change Victory ME' },
  134: { name: 'Change Save Access' },
  135: { name: 'Change Menu Access' },
  136: { name: 'Change Encounter Disable' },
  137: { name: 'Change Formation Access' },
  138: { name: 'Change Window Color' },
  139: { name: 'Change Defeat ME' },
  140: { name: 'Change Vehicle BGM' },
  201: { name: 'Transfer Player', arity: 6, numeric: [0, 1, 2, 3, 4, 5] }, // [type, mapId, x, y, direction, fadeType]
  202: { name: 'Set Vehicle Location' },
  203: { name: 'Set Event Location' },
  204: { name: 'Scroll Map', numeric: [0, 1, 2] }, // [direction, distance, speed]
  205: { name: 'Set Movement Route', arity: 2, numeric: [0] }, // [characterId, route]
  206: { name: 'Get On/Off Vehicle' },
  211: { name: 'Change Transparency' },
  212: { name: 'Show Animation', arity: 3, numeric: [0, 1] }, // [characterId, animationId, wait]
  213: { name: 'Show Balloon Icon', arity: 3 },
  214: { name: 'Erase Event', numeric: [] },
  216: { name: 'Change Player Followers' },
  217: { name: 'Gather Followers' },
  221: { name: 'Fadeout Screen', arity: 0 },
  222: { name: 'Fadein Screen', arity: 0 },
  223: { name: 'Tint Screen', arity: 3 },
  224: { name: 'Flash Screen', arity: 3 },
  225: { name: 'Shake Screen', arity: 4 },
  230: { name: 'Wait', arity: 1, numeric: [0] }, // [duration]
  231: { name: 'Show Picture', arity: 10, numeric: [0, 2, 3, 4, 5, 6, 7, 8, 9] }, // [1] is the picture filename
  232: { name: 'Move Picture' },
  233: { name: 'Rotate Picture' },
  234: { name: 'Tint Picture' },
  235: { name: 'Erase Picture', arity: 1 },
  236: { name: 'Set Weather Effect' },
  241: { name: 'Play BGM', arity: 1, numeric: [] }, // (audio object)
  242: { name: 'Fadeout BGM', numeric: [0] }, // [duration]
  243: { name: 'Save BGM' },
  244: { name: 'Resume BGM' },
  245: { name: 'Play BGS', arity: 1, numeric: [] }, // (audio object)
  246: { name: 'Fadeout BGS', numeric: [0] }, // [duration]
  249: { name: 'Play ME', arity: 1, numeric: [] }, // (audio object)
  250: { name: 'Play SE', arity: 1, numeric: [] }, // (audio object)
  251: { name: 'Stop SE' },
  261: { name: 'Play Movie' },
  281: { name: 'Change Map Name Display' },
  282: { name: 'Change Tileset' },
  283: { name: 'Change Battle Back' },
  284: { name: 'Change Parallax' },
  285: { name: 'Get Location Info' },
  301: { name: 'Battle Processing', arity: 4, numeric: [0, 1], block: 'opener' }, // [type, troopId, canEscape, canLose]
  302: { name: 'Shop Processing', arity: 5, numeric: [0, 1, 2, 3] }, // [goodsType, id, priceType, price, purchaseOnly]
  303: { name: 'Name Input Processing', arity: 2, numeric: [0, 1] }, // Name Input [actorId, maxLength]
  311: { name: 'Change HP', numeric: [0, 1, 2, 3, 4] },
  312: { name: 'Change MP', numeric: [0, 1, 2, 3, 4] },
  313: { name: 'Change State', numeric: [0, 1, 2, 3] },
  314: { name: 'Recover All', numeric: [0, 1] },
  315: { name: 'Change EXP', numeric: [0, 1, 2, 3, 4] },
  316: { name: 'Change Level', numeric: [0, 1, 2, 3, 4] },
  317: { name: 'Change Parameter' },
  318: { name: 'Change Skill', numeric: [0, 1, 2, 3] },
  319: { name: 'Change Equipment', numeric: [0, 1, 2] },
  320: { name: 'Change Name', numeric: [0] }, // [actorId, name]
  321: { name: 'Change Class', numeric: [0, 1] }, // [actorId, classId, saveExp]
  322: { name: 'Change Actor Images' },
  323: { name: 'Change Vehicle Image', numeric: [0, 2] }, // [vehicleId, image, index]
  324: { name: 'Change Nickname' },
  325: { name: 'Change Profile' },
  326: { name: 'Change TP' },
  331: { name: 'Change Enemy HP' },
  332: { name: 'Change Enemy MP' },
  333: { name: 'Change Enemy State' },
  334: { name: 'Enemy Recover All' },
  335: { name: 'Enemy Appear' },
  336: { name: 'Enemy Transform' },
  337: { name: 'Show Battle Animation' },
  339: { name: 'Force Action' },
  340: { name: 'Abort Battle' },
  342: { name: 'Change Enemy TP' },
  351: { name: 'Open Menu Screen', arity: 0 },
  352: { name: 'Open Save Screen', arity: 0 },
  353: { name: 'Game Over', arity: 0, numeric: [] },
  354: { name: 'Return to Title Screen', arity: 0 },
  355: { name: 'Script', arity: 1 },
  356: { name: 'Plugin Command', arity: 1, numeric: [] }, // (single string)
  401: { name: 'Text Data', arity: 1, numeric: [], continues: 101, folds: true }, // Text data
  402: { name: 'When', arity: 2, numeric: [0], block: 'section' }, // [n, choiceName]
  403: { name: 'When Cancel', arity: [0, 2], numeric: [], block: 'section' }, // the editor saves [6, null]; the interpreter ignores the parameters
  404: { name: 'End Choices', arity: 0, numeric: [], block: 'end' }, // End of choices
  405: { name: 'Scroll Text Data', arity: 1, continues: 105, folds: true },
  408: { name: 'Comment', arity: 1, continues: 108, folds: true },
  411: { name: 'Else', arity: 0, numeric: [], block: 'section' },
  412: { name: 'End Branch', arity: 0, numeric: [], block: 'end' }, // End of branch
  413: { name: 'Repeat Above', arity: 0, block: 'end' },
  505: { name: 'Move Command', arity: 1, numeric: [], continues: 205 }, // Move route step (the step object is normalised via moveRoute)
  601: { name: 'If Win', arity: 0, numeric: [], block: 'section' },
  602: { name: 'If Escape', arity: 0, numeric: [], block: 'section' },
  603: { name: 'If Lose', arity: 0, numeric: [], block: 'section' },
  604: { name: 'End Battle', arity: 0, numeric: [], block: 'end' },
  605: { name: 'Shop Goods', arity: 4, numeric: [], continues: 302, folds: true }, // Repeat of the previous command's parameters
  655: { name: 'Script Data', arity: 1, continues: 355, folds: true },
};

const entries = Object.entries(EVENT_COMMANDS).map(([code, spec]) => [Number(code), spec] as const);
const codesWhere = (test: (spec: CommandSpec) => boolean): ReadonlySet<number> =>
  new Set(entries.filter(([, spec]) => test(spec)).map(([code]) => code));

export const BLOCK_OPENERS = codesWhere(spec => spec.block === 'opener');
export const BLOCK_SECTIONS = codesWhere(spec => spec.block === 'section');
export const BLOCK_ENDS = codesWhere(spec => spec.block === 'end');
/** Continuation codes folded into their header (text, scrolling text, comments, shop goods, script). */
export const FOLDED_CONTINUATIONS = codesWhere(spec => spec.folds === true);
/** Header code → the continuation code that may follow it (101 → 401). */
export const CONTINUATION_FOR: Readonly<Record<number, number>> = Object.fromEntries(
  entries.filter(([, spec]) => spec.continues !== undefined).map(([code, spec]) => [spec.continues, code]),
);

export function commandName(code: number): string {
  return EVENT_COMMANDS[code]?.name ?? `Command ${code}`;
}
