/**
 * eventAst.ts — turn a flat RPG Maker MV command list into a logical tree.
 *
 * MV stores an event page (or common event) as a flat array of commands:
 *   { code: number, indent: number, parameters: unknown[] }
 * Structure is implied by `indent` plus a handful of section / terminator /
 * continuation codes the editor inserts. This module reconstructs the intent
 * as an AST so the rest of the intelligence layer can reason about, validate
 * and refactor event logic instead of walking opaque command arrays.
 *
 * The parser is pure (no IO) and defensive: malformed or truncated command
 * lists never throw, they just produce a best-effort tree.
 *
 * Roadmap #2 (AST de Eventos).
 */

export interface RawCommand {
  code: number;
  indent?: number;
  parameters?: unknown[];
}

export interface AstSection {
  /** Human label for the branch, e.g. "then", "else", 'when "Yes"', "if win". */
  label: string;
  /** The marker command code that opened this section (0 for the implicit first section). */
  code: number;
  children: AstNode[];
}

export interface AstNode {
  code: number;
  /** Human-readable command name. */
  name: string;
  indent: number;
  parameters: unknown[];
  /** One-line semantic description, e.g. 'Set Switch(5) = ON'. */
  summary: string;
  /** Folded text/script/comment continuation lines (codes 401/405/408/655). */
  text?: string;
  /** Body of a simple block (Loop). */
  children?: AstNode[];
  /** Labelled branches of a multi-way block (If/Choices/Battle). */
  sections?: AstSection[];
}

/** Command code → display name. Inlined to keep this module pure and dependency-free. */
const COMMAND_NAMES: Record<number, string> = {
  0: 'End', 101: 'Show Text', 102: 'Show Choices', 103: 'Input Number', 104: 'Select Item',
  105: 'Show Scrolling Text', 108: 'Comment', 111: 'Conditional Branch', 112: 'Loop',
  113: 'Break Loop', 115: 'Exit Event Processing', 117: 'Call Common Event', 118: 'Label',
  119: 'Jump to Label', 121: 'Control Switches', 122: 'Control Variables', 123: 'Control Self Switch',
  124: 'Control Timer', 125: 'Change Gold', 126: 'Change Items', 127: 'Change Weapons',
  128: 'Change Armors', 129: 'Change Party Member', 132: 'Change Battle BGM', 133: 'Change Victory ME',
  134: 'Change Save Access', 135: 'Change Menu Access', 136: 'Change Encounter Disable',
  137: 'Change Formation Access', 138: 'Change Window Color', 139: 'Change Defeat ME',
  140: 'Change Vehicle BGM', 201: 'Transfer Player', 202: 'Set Vehicle Location',
  203: 'Set Event Location', 204: 'Scroll Map', 205: 'Set Movement Route',
  206: 'Get On/Off Vehicle', 211: 'Change Transparency', 212: 'Show Animation',
  213: 'Show Balloon Icon', 214: 'Erase Event', 216: 'Change Player Followers',
  217: 'Gather Followers', 221: 'Fadeout Screen', 222: 'Fadein Screen', 223: 'Tint Screen',
  224: 'Flash Screen', 225: 'Shake Screen', 230: 'Wait', 231: 'Show Picture', 232: 'Move Picture',
  233: 'Rotate Picture', 234: 'Tint Picture', 235: 'Erase Picture', 236: 'Set Weather Effect',
  241: 'Play BGM', 242: 'Fadeout BGM', 243: 'Save BGM', 244: 'Resume BGM', 245: 'Play BGS',
  246: 'Fadeout BGS', 249: 'Play ME', 250: 'Play SE', 251: 'Stop SE', 261: 'Play Movie',
  281: 'Change Map Name Display', 282: 'Change Tileset', 283: 'Change Battle Back',
  284: 'Change Parallax', 285: 'Get Location Info', 301: 'Battle Processing', 302: 'Shop Processing',
  303: 'Name Input Processing', 311: 'Change HP', 312: 'Change MP', 313: 'Change State',
  314: 'Recover All', 315: 'Change EXP', 316: 'Change Level', 317: 'Change Parameter',
  318: 'Change Skill', 319: 'Change Equipment', 320: 'Change Name', 321: 'Change Class',
  322: 'Change Actor Images', 323: 'Change Vehicle Image', 324: 'Change Nickname',
  325: 'Change Profile', 326: 'Change TP', 331: 'Change Enemy HP', 332: 'Change Enemy MP',
  333: 'Change Enemy State', 334: 'Enemy Recover All', 335: 'Enemy Appear', 336: 'Enemy Transform',
  337: 'Show Battle Animation', 339: 'Force Action', 340: 'Abort Battle', 351: 'Open Menu Screen',
  352: 'Open Save Screen', 353: 'Game Over', 354: 'Return to Title Screen', 355: 'Script',
  356: 'Plugin Command',
  // continuation / section / terminator codes
  401: 'Text Data', 402: 'When', 403: 'When Cancel', 404: 'End Choices', 405: 'Scroll Text Data',
  408: 'Comment', 411: 'Else', 412: 'End Branch', 413: 'Repeat Above', 505: 'Move Command',
  601: 'If Win', 602: 'If Escape', 603: 'If Lose', 604: 'End Battle', 605: 'Shop Goods',
  655: 'Script Data',
};

/** Codes whose payload folds into the immediately preceding header node. */
const DATA_CONTINUATION = new Set([401, 405, 408, 605, 655]);
/** Block-opening codes that own nested children / sections. */
const OPENERS = new Set([111, 112, 102, 301]);
/** Section markers (same indent as their opener). */
const SECTION_MARKERS = new Set([411, 402, 403, 601, 602, 603]);
/** Terminator markers (same indent as their opener). */
const TERMINATORS = new Set([412, 404, 413, 604]);

function commandName(code: number): string {
  return COMMAND_NAMES[code] || `Command ${code}`;
}

const SWITCH_VALUE = (v: unknown) => (v === 0 ? 'ON' : 'OFF');
const VAR_OP = ['=', '+=', '-=', '*=', '/=', '%='];
const COMPARE = ['==', '>=', '<=', '>', '<', '!='];

/** Best-effort one-line semantic description for a command. Never throws. */
function summarize(code: number, p: unknown[]): string {
  const n = (i: number): number => Number(p[i]);
  switch (code) {
    case 101: return 'Show Text';
    case 102: return `Show Choices [${Array.isArray(p[0]) ? (p[0] as string[]).join(', ') : ''}]`;
    case 108: return `Comment: ${String(p[0] ?? '')}`;
    case 111: return summarizeConditional(p);
    case 112: return 'Loop';
    case 113: return 'Break Loop';
    case 115: return 'Exit Event Processing';
    case 117: return `Call Common Event ${n(0)}`;
    case 121: {
      const a = n(0); const b = n(1);
      const range = a === b ? `Switch(${a})` : `Switches(${a}..${b})`;
      return `Set ${range} = ${SWITCH_VALUE(p[2])}`;
    }
    case 122: {
      const a = n(0); const b = n(1);
      const range = a === b ? `Variable(${a})` : `Variables(${a}..${b})`;
      const op = VAR_OP[n(2)] ?? '=';
      const operand = p[3] === 0 ? String(p[4]) : p[3] === 1 ? `Variable(${n(4)})` : p[3] === 2 ? 'random' : p[3] === 3 ? 'game data' : 'script';
      return `${range} ${op} ${operand}`;
    }
    case 123: return `Self Switch ${String(p[0])} = ${SWITCH_VALUE(p[1])}`;
    case 125: return `Change Gold ${n(0) === 0 ? '+' : '-'}${p[1] === 0 ? n(2) : `Variable(${n(2)})`}`;
    case 126: return `Change Items: item ${n(0)}`;
    case 127: return `Change Weapons: weapon ${n(0)}`;
    case 128: return `Change Armors: armor ${n(0)}`;
    case 201: return p[0] === 0
      ? `Transfer Player → Map ${n(1)} (${n(2)},${n(3)})`
      : 'Transfer Player → (variable-designated)';
    case 212: return `Show Animation ${n(2)}`;
    case 231: return `Show Picture: ${String(p[1] ?? '')}`;
    case 241: return `Play BGM: ${pName(p[0])}`;
    case 245: return `Play BGS: ${pName(p[0])}`;
    case 249: return `Play ME: ${pName(p[0])}`;
    case 250: return `Play SE: ${pName(p[0])}`;
    case 282: return `Change Tileset ${n(0)}`;
    case 301: return `Battle Processing${p[0] === 0 ? ` (troop ${n(1)})` : ''}`;
    case 302: return 'Shop Processing';
    case 313: return `Change State: actor ${n(1)} state ${n(3)}`;
    case 355: return 'Script';
    case 356: return `Plugin Command: ${String(p[0] ?? '')}`;
    default: return commandName(code);
  }
}

/** Pull an audio/picture struct's `.name`, or fall back to the raw value. */
function pName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).name);
  }
  return String(v ?? '');
}

function summarizeConditional(p: unknown[]): string {
  const type = Number(p[0]);
  const n = (i: number): number => Number(p[i]);
  switch (type) {
    case 0: return `If Switch(${n(1)}) == ${SWITCH_VALUE(p[2])}`;
    case 1: {
      const left = `Variable(${n(1)})`;
      const right = p[2] === 0 ? String(p[3]) : `Variable(${n(3)})`;
      const cmp = COMPARE[n(4)] ?? '==';
      return `If ${left} ${cmp} ${right}`;
    }
    case 2: return `If Self Switch ${String(p[1])} == ${SWITCH_VALUE(p[2])}`;
    case 3: return `If Timer ${COMPARE[n(2)] ?? '>='} ${n(1)}s`;
    case 4: return `If Actor ${n(1)} condition`;
    case 5: return `If Enemy ${n(1)} condition`;
    case 6: return `If Character ${n(1)} facing ${n(2)}`;
    case 7: return `If Gold ${COMPARE[n(2)] ?? '>='} ${n(1)}`;
    case 8: return `If party has Item ${n(1)}`;
    case 9: return `If party has Weapon ${n(1)}`;
    case 10: return `If party has Armor ${n(1)}`;
    case 11: return `If Button ${String(p[1])} pressed`;
    case 12: return `If Script: ${String(p[1] ?? '')}`;
    case 13: return `If Vehicle ${n(1)}`;
    default: return 'Conditional Branch';
  }
}

function makeNode(cmd: RawCommand): AstNode {
  const code = Number(cmd.code);
  const parameters = Array.isArray(cmd.parameters) ? cmd.parameters : [];
  return {
    code,
    name: commandName(code),
    indent: Number(cmd.indent ?? 0),
    parameters,
    summary: summarize(code, parameters),
  };
}

/** Append a continuation command's text payload onto the preceding node. */
function foldData(prev: AstNode | undefined, cmd: RawCommand): void {
  if (!prev) return;
  const params = Array.isArray(cmd.parameters) ? cmd.parameters : [];
  const line = String(params[0] ?? '');
  prev.text = prev.text === undefined ? line : `${prev.text}\n${line}`;
}

interface Cursor { i: number; }

function whenLabel(cmd: RawCommand): string {
  const params = Array.isArray(cmd.parameters) ? cmd.parameters : [];
  // 402 params: [choiceIndex, choiceText]; older data may only carry the index.
  if (typeof params[1] === 'string') return `when "${params[1]}"`;
  return `when #${params[0] ?? '?'}`;
}

function parseOpenerBody(cmds: RawCommand[], cur: Cursor, indent: number, code: number, node: AstNode): void {
  const atIndent = () => cur.i < cmds.length && Number(cmds[cur.i].indent ?? 0) === indent;
  const codeAt = () => Number(cmds[cur.i].code);

  if (code === 112) {
    node.children = parseStatements(cmds, cur, indent + 1);
    if (atIndent() && codeAt() === 413) cur.i++; // consume Repeat Above
    return;
  }

  const sections: AstSection[] = [];
  // If/then has an implicit first section (the body before any Else). Choices
  // (102) and Battle (301) get all their sections from explicit markers, so we
  // only keep an implicit one if stray commands precede the first marker.
  const firstChildren = parseStatements(cmds, cur, indent + 1);
  if (code === 111 || firstChildren.length > 0) {
    sections.push({ label: code === 111 ? 'then' : 'section', code: 0, children: firstChildren });
  }

  while (atIndent() && SECTION_MARKERS.has(codeAt())) {
    const marker = cmds[cur.i];
    const mcode = Number(marker.code);
    cur.i++;
    const label =
      mcode === 411 ? 'else' :
      mcode === 402 ? whenLabel(marker) :
      mcode === 403 ? 'when cancel' :
      mcode === 601 ? 'if win' :
      mcode === 602 ? 'if escape' :
      mcode === 603 ? 'if lose' : 'section';
    sections.push({ label, code: mcode, children: parseStatements(cmds, cur, indent + 1) });
  }

  if (atIndent() && TERMINATORS.has(codeAt())) cur.i++; // consume 412/404/604

  node.sections = sections;
}

function parseStatements(cmds: RawCommand[], cur: Cursor, indent: number): AstNode[] {
  const nodes: AstNode[] = [];
  while (cur.i < cmds.length) {
    const cmd = cmds[cur.i];
    const ci = Number(cmd.indent ?? 0);
    if (ci < indent) break;            // belongs to an enclosing block
    if (ci > indent) { cur.i++; continue; } // stray deeper command (malformed) — skip defensively

    const code = Number(cmd.code);
    if (DATA_CONTINUATION.has(code)) {
      foldData(nodes[nodes.length - 1], cmd);
      cur.i++;
      continue;
    }
    if (SECTION_MARKERS.has(code) || TERMINATORS.has(code)) break; // owned by enclosing opener

    const node = makeNode(cmd);
    cur.i++;
    if (OPENERS.has(code)) parseOpenerBody(cmds, cur, indent, code, node);
    nodes.push(node);
  }
  return nodes;
}

/**
 * Parse a flat MV command list into an AST (array of top-level statements).
 * The trailing code-0 terminator, if present, is included as a leaf node.
 */
export function parseEventCommands(commands: RawCommand[] | undefined | null): AstNode[] {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  // Normalise the base indent so a sub-list that starts at indent>0 still parses.
  const base = Math.min(...commands.map((c) => Number(c?.indent ?? 0)));
  return parseStatements(commands, { i: 0 }, base);
}

/** Render an AST as an indented outline — the cheapest way to "see" event logic. */
export function astToOutline(nodes: AstNode[], depth = 0): string {
  const lines: string[] = [];
  const pad = '  '.repeat(depth);
  for (const node of nodes) {
    let line = `${pad}${node.summary}`;
    if (node.text) line += ` — "${node.text.replace(/\n/g, ' / ').slice(0, 60)}"`;
    lines.push(line);
    if (node.children) lines.push(astToOutline(node.children, depth + 1));
    if (node.sections) {
      for (const s of node.sections) {
        if (s.code !== 0) lines.push(`${pad}${s.label}:`);
        lines.push(astToOutline(s.children, depth + 1));
      }
    }
  }
  return lines.filter(Boolean).join('\n');
}
