import { describe, it, expect } from 'vitest';
import {
  showText,
  showChoices,
  conditionalBranch,
  conditionParameters,
  wait,
  exitEvent,
  label,
  jumpToLabel,
  controlSwitches,
  controlSelfSwitch,
  controlVariables,
  changeGold,
  changeItems,
  changeWeapons,
  changeArmors,
  changePartyMember,
  transferPlayer,
  playAudio,
  fadeScreen,
  tintScreen,
  flashScreen,
  shakeScreen,
  showPicture,
  erasePicture,
  showAnimation,
  showBalloon,
  battleProcessing,
  shopProcessing,
  nameInput,
  changeHp,
  changeMp,
  changeState,
  recoverAll,
  changeExp,
  changeLevel,
  enemyAppear,
  changeEnemyState,
  abortBattle,
} from '../src/parity/events/commandBuilders.js';

describe('battle builders (layouts per rmmz_objects.js command333/335/340)', () => {
  it('enemy appear is [enemyIndex]', () => {
    expect(enemyAppear(1)).toEqual({ code: 335, indent: 0, parameters: [1] });
    expect(() => enemyAppear(-1)).toThrow(/troop slot/);
  });

  it('change enemy state is [enemyIndex, 0 add/1 remove, stateId]; -1 = entire troop', () => {
    expect(changeEnemyState(0, 'add', 12)).toEqual({
      code: 333,
      indent: 0,
      parameters: [0, 0, 12],
    });
    expect(changeEnemyState(-1, 'remove', 4, 1)).toEqual({
      code: 333,
      indent: 1,
      parameters: [-1, 1, 4],
    });
    expect(() => changeEnemyState(-2, 'add', 1)).toThrow();
  });

  it('abort battle is parameterless', () => {
    expect(abortBattle()).toEqual({ code: 340, indent: 0, parameters: [] });
  });
});

/**
 * Byte-for-byte expectations captured from real RPG Maker editor output adapted to MV
 * (TutorialProject Map002 events 12 & 15). The builders must reproduce these
 * exactly — the whole point of a builder is that a client never has to hand-roll
 * these fragile continuation-row structures.
 */
describe('showText (byte-exact)', () => {
  it('matches the editor 101+401 shape with four MV parameters', () => {
    expect(showText(['Hello, \\N[1]'], {  })).toEqual([
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['Hello, \\N[1]'] },
    ]);
  });

  it('defaults face/background/position and emits one 401 per line', () => {
    const cmds = showText(['A', 'B'], { faceName: 'Actor1', faceIndex: 3, position: 'top' });
    expect(cmds[0]).toEqual({ code: 101, indent: 0, parameters: ['Actor1', 3, 0, 0] });
    expect(cmds.slice(1)).toEqual([
      { code: 401, indent: 0, parameters: ['A'] },
      { code: 401, indent: 0, parameters: ['B'] },
    ]);
  });

  it('encodes background and position enums', () => {
    const [setup] = showText(['x'], { background: 'dim', position: 'middle' });
    expect(setup.parameters).toEqual(['', 0, 1, 1]);
  });
});

describe('showChoices (byte-exact)', () => {
  it('reproduces the editor Yes/No block with per-choice branches', () => {
    const block = showChoices(['Yes', 'No'], {
      cancelType: 1,
      branches: [
        [{ code: 213, indent: 0, parameters: [0, 4, false] }],
        [{ code: 213, indent: 0, parameters: [0, 8, false] }],
      ],
    });
    expect(block).toEqual([
      { code: 102, indent: 0, parameters: [['Yes', 'No'], 1, 0, 2, 0] },
      { code: 402, indent: 0, parameters: [0, 'Yes'] },
      { code: 213, indent: 1, parameters: [0, 4, false] },
      { code: 0, indent: 1, parameters: [] },
      { code: 402, indent: 0, parameters: [1, 'No'] },
      { code: 213, indent: 1, parameters: [0, 8, false] },
      { code: 0, indent: 1, parameters: [] },
      { code: 404, indent: 0, parameters: [] },
    ]);
  });

  it('terminates empty branches with a code-0 marker and defaults cancelType to -1', () => {
    const block = showChoices(['A', 'B']);
    expect(block.map((c) => [c.code, c.indent])).toEqual([
      [102, 0],
      [402, 0],
      [0, 1], // empty A branch still gets its terminator
      [402, 0],
      [0, 1], // empty B branch
      [404, 0],
    ]);
    expect(block[0].parameters[1]).toBe(-1); // Disallow
  });

  it('adds a 403 When-Cancel branch and encodes cancelType as choices.length', () => {
    const block = showChoices(['A', 'B'], { cancelBranch: [] });
    expect(block[0].parameters[1]).toBe(2); // branch => choices.length
    expect(block.map((c) => c.code)).toEqual([102, 402, 0, 402, 0, 403, 0, 404]);
  });

  it('throws on an empty choices array', () => {
    expect(() => showChoices([])).toThrow(/non-empty/);
  });
});

describe('conditionalBranch (byte-exact)', () => {
  it('reproduces the editor 111/411/412 block, composing showText branches', () => {
    const block = conditionalBranch(
      { type: 'item', itemId: 7 },
      {
        thenBranch: showText(['Use potions wisely!']),
        elseBranch: showText(['You should get a potion...']),
      },
    );
    expect(block).toEqual([
      { code: 111, indent: 0, parameters: [8, 7] },
      { code: 101, indent: 1, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 1, parameters: ['Use potions wisely!'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 411, indent: 0, parameters: [] },
      { code: 101, indent: 1, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 1, parameters: ['You should get a potion...'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
    ]);
  });

  it('omits the 411 Else block when no elseBranch is given', () => {
    const block = conditionalBranch({ type: 'switch', switchId: 5 });
    expect(block.map((c) => c.code)).toEqual([111, 0, 412]);
  });

  it('nests deeper blocks with correct relative indent', () => {
    const inner = conditionalBranch({ type: 'switch', switchId: 2 }); // authored at indent 0
    const block = conditionalBranch({ type: 'switch', switchId: 1 }, { thenBranch: inner });
    // inner 111 sits at indent 1, its own terminator at indent 2, closer at indent 1.
    expect(block.map((c) => [c.code, c.indent])).toEqual([
      [111, 0],
      [111, 1],
      [0, 2],
      [412, 1],
      [0, 1],
      [412, 0],
    ]);
  });
});

describe('conditionParameters', () => {
  it('encodes each supported condition type', () => {
    expect(conditionParameters({ type: 'switch', switchId: 3 })).toEqual([0, 3, 0]);
    expect(conditionParameters({ type: 'switch', switchId: 3, value: 'off' })).toEqual([0, 3, 1]);
    expect(conditionParameters({ type: 'self_switch', name: 'B' })).toEqual([2, 'B', 0]);
    expect(
      conditionParameters({ type: 'variable', variableId: 4, comparison: '>=', constant: 10 }),
    ).toEqual([1, 4, 0, 10, 1]);
    expect(
      conditionParameters({ type: 'variable', variableId: 4, comparison: '<', variableOperand: 9 }),
    ).toEqual([1, 4, 1, 9, 4]);
    expect(conditionParameters({ type: 'actor_in_party', actorId: 2 })).toEqual([4, 2, 0]);
    expect(conditionParameters({ type: 'gold', value: 500, compare: '<' })).toEqual([7, 500, 2]);
    expect(conditionParameters({ type: 'gold', value: 500 })).toEqual([7, 500, 0]);
    expect(conditionParameters({ type: 'item', itemId: 7 })).toEqual([8, 7]);
  });
});

describe('flow commands', () => {
  it('builds single commands with the right code/params', () => {
    expect(wait(300, 2)).toEqual({ code: 230, indent: 2, parameters: [300] });
    expect(exitEvent()).toEqual({ code: 115, indent: 0, parameters: [] });
    expect(label('start')).toEqual({ code: 118, indent: 0, parameters: ['start'] });
    expect(jumpToLabel('start')).toEqual({ code: 119, indent: 0, parameters: ['start'] });
  });
});

/**
 * Game-state builders. Param encodings verified against the corescript
 * command121/122/123/125/126/127/128/129 handlers (rmmz_objects.js v1.9.0), with the
 * annotated shapes cross-checked against real editor output (TutorialProject).
 */
describe('game-state builders (byte-exact)', () => {
  it('control switches / self switch encode on/off and ranges', () => {
    // Real editor output: [startId, endId, value(0 on/1 off)].
    expect(controlSwitches(3, 3, 'on')).toEqual({ code: 121, indent: 0, parameters: [3, 3, 0] });
    expect(controlSwitches(2, 5, 'off')).toEqual({ code: 121, indent: 0, parameters: [2, 5, 1] });
    expect(controlSwitches(1, 1).parameters).toEqual([1, 1, 0]); // default 'on'
    expect(controlSelfSwitch('A', 'off')).toEqual({ code: 123, indent: 0, parameters: ['A', 1] });
  });

  it('control variables encodes every operand mode', () => {
    // Real editor output: set var 1 to constant 1 -> [1,1,0,0,1].
    expect(controlVariables(1, 'set', { type: 'constant', value: 1 }).parameters).toEqual([
      1, 1, 0, 0, 1,
    ]);
    expect(controlVariables(3, 'add', { type: 'variable', variableId: 7 }).parameters).toEqual([
      3, 3, 1, 1, 7,
    ]);
    expect(
      controlVariables(4, 'set', { type: 'random', min: 1, max: 6 }, { endId: 5 }).parameters,
    ).toEqual([4, 5, 0, 2, 1, 6]);
    // game_data: gold readout (dataType 7 "other", param1 2 = Gold).
    expect(
      controlVariables(2, 'set', { type: 'game_data', dataType: 7, param1: 2 }).parameters,
    ).toEqual([2, 2, 0, 3, 7, 2, 0]);
  });

  it('change gold / items / weapons / armors encode operateValue + includeEquip', () => {
    // Real editor output: gain 1000 gold -> [0,0,1000].
    expect(changeGold('increase', { type: 'constant', value: 1000 }).parameters).toEqual([
      0, 0, 1000,
    ]);
    expect(changeGold('decrease', { type: 'variable', variableId: 4 }).parameters).toEqual([
      1, 1, 4,
    ]);
    // Real editor output: gain 2 of item 11 -> [11,0,0,2].
    expect(changeItems(11, 'increase', { type: 'constant', value: 2 }).parameters).toEqual([
      11, 0, 0, 2,
    ]);
    expect(changeWeapons(3, 'decrease', { type: 'constant', value: 1 }, true).parameters).toEqual([
      3,
      1,
      0,
      1,
      true,
    ]);
    expect(changeArmors(5, 'increase', { type: 'constant', value: 1 }).parameters).toEqual([
      5,
      0,
      0,
      1,
      false,
    ]);
  });

  it('change party member encodes add/remove + initialize', () => {
    expect(changePartyMember(2, 'add', true)).toEqual({
      code: 129,
      indent: 0,
      parameters: [2, 0, true],
    });
    expect(changePartyMember(2, 'remove').parameters).toEqual([2, 1, false]);
  });
});

/**
 * Presentation & transition builders. Param encodings verified against
 * the corescript command201/212/213/221–225/231/235/241–250 handlers (rmmz_objects.js
 * v1.9.0); shapes cross-checked against real editor output where present
 * (201 [0,2,16,0,0,0]; 213 [0,4,false]; 224 [[255,255,255,170],60,true]; 249/250 audio).
 */
describe('presentation builders (byte-exact)', () => {
  it('transfer player encodes designation/direction/fade', () => {
    // Real editor output: direct transfer to map 2 at (16,0), retain facing, black fade.
    expect(transferPlayer(2, 16, 0)).toEqual({
      code: 201,
      indent: 0,
      parameters: [0, 2, 16, 0, 0, 0],
    });
    expect(transferPlayer(5, 3, 4, { direction: 'up', fade: 'none' }).parameters).toEqual([
      0, 5, 3, 4, 8, 2,
    ]);
    // designation 'variable' → params[0] = 1, and mapId/x/y are variable ids.
    expect(transferPlayer(1, 2, 3, { designation: 'variable' }).parameters).toEqual([
      1, 1, 2, 3, 0, 0,
    ]);
  });

  it('play audio emits the {name,volume,pitch,pan} object on the right code', () => {
    expect(playAudio('me', { name: 'Inn2' })).toEqual({
      code: 249,
      indent: 0,
      parameters: [{ name: 'Inn2', volume: 90, pitch: 100, pan: 0 }],
    });
    expect(playAudio('se', { name: 'Move1', volume: 80, pitch: 120, pan: -50 }).parameters).toEqual(
      [{ name: 'Move1', volume: 80, pitch: 120, pan: -50 }],
    );
    expect(playAudio('bgm', { name: 'Battle1' }).code).toBe(241);
    expect(playAudio('bgs', { name: 'City' }).code).toBe(245);
  });

  it('screen fade/tint/flash/shake match the editor param layout', () => {
    expect(fadeScreen('out')).toEqual({ code: 221, indent: 0, parameters: [] });
    expect(fadeScreen('in')).toEqual({ code: 222, indent: 0, parameters: [] });
    expect(tintScreen([-68, -68, 0, 68], 60, true)).toEqual({
      code: 223,
      indent: 0,
      parameters: [[-68, -68, 0, 68], 60, true],
    });
    // Real editor output for a white flash.
    expect(flashScreen([255, 255, 255, 170], 60, true).parameters).toEqual([
      [255, 255, 255, 170],
      60,
      true,
    ]);
    expect(shakeScreen(5, 5, 60, false)).toEqual({
      code: 225,
      indent: 0,
      parameters: [5, 5, 60, false],
    });
  });

  it('show/erase picture encode the full parameter list', () => {
    expect(showPicture(1, 'Title', { origin: 'center', x: 100, y: 50, opacity: 200 })).toEqual({
      code: 231,
      indent: 0,
      parameters: [1, 'Title', 1, 0, 100, 50, 100, 100, 200, 0],
    });
    // defaults: upper_left origin, (0,0), 100% scale, 255 opacity, normal blend.
    expect(showPicture(2, 'Bg').parameters).toEqual([2, 'Bg', 0, 0, 0, 0, 100, 100, 255, 0]);
    expect(showPicture(3, 'X', { blend: 'screen' }).parameters[9]).toBe(3);
    expect(erasePicture(4)).toEqual({ code: 235, indent: 0, parameters: [4] });
  });

  it('show animation / balloon encode character + id + wait', () => {
    // Real editor output: balloon 4 over this event, no wait.
    expect(showBalloon(0, 4)).toEqual({ code: 213, indent: 0, parameters: [0, 4, false] });
    expect(showAnimation(-1, 12, true)).toEqual({
      code: 212,
      indent: 0,
      parameters: [-1, 12, true],
    });
  });
});

/**
 * Scene builders. Param encodings verified against the corescript
 * command301/302/303/311–316 handlers (rmmz_objects.js v1.9.0) + real editor output
 * (301 [0,1,true,false]; 302 [0,7,0,0,false] + 605 [0,10,0,0]; 311 [0,0,0,0,9999,false];
 * 312 [0,0,0,0,9999]; 314 [0,0]; 315 [0,0,0,0,400,false]).
 */
describe('scene builders (byte-exact)', () => {
  it('battle processing encodes troop designation + escape/lose flags', () => {
    // Real editor output: direct troop 1, can escape, cannot lose.
    expect(battleProcessing({ type: 'direct', troopId: 1 }, true, false)).toEqual({
      code: 301,
      indent: 0,
      parameters: [0, 1, true, false],
    });
    expect(battleProcessing({ type: 'variable', variableId: 5 }).parameters).toEqual([
      1,
      5,
      false,
      false,
    ]);
    // 'random' → designation 2, troop id ignored (0).
    expect(battleProcessing({ type: 'random' }, false, true).parameters).toEqual([
      2,
      0,
      false,
      true,
    ]);
  });

  it('shop processing emits 302 setup + one 605 row per extra good', () => {
    // Real editor output: first good is item 7 at db price, purchaseOnly false;
    // extra goods (items 10/12/11) are 605 rows without the purchaseOnly param.
    expect(
      shopProcessing([
        { kind: 'item', id: 7 },
        { kind: 'item', id: 10 },
        { kind: 'item', id: 12 },
      ]),
    ).toEqual([
      { code: 302, indent: 0, parameters: [0, 7, 0, 0, false] },
      { code: 605, indent: 0, parameters: [0, 10, 0, 0] },
      { code: 605, indent: 0, parameters: [0, 12, 0, 0] },
    ]);
    // A specified price → priceType 1; weapon kind → 1, armor → 2; purchaseOnly → true.
    expect(shopProcessing([{ kind: 'weapon', id: 3, price: 250 }], true)).toEqual([
      { code: 302, indent: 0, parameters: [1, 3, 1, 250, true] },
    ]);
    expect(shopProcessing([{ kind: 'armor', id: 4 }])[0].parameters[0]).toBe(2);
    expect(() => shopProcessing([])).toThrow();
  });

  it('name input encodes actor id + max length', () => {
    expect(nameInput(1)).toEqual({ code: 303, indent: 0, parameters: [1, 8] });
    expect(nameInput(2, 12).parameters).toEqual([2, 12]);
  });

  it('change hp/mp/exp/level encode actor target + operateValue triple + flag', () => {
    // Real editor output: whole party (fixed 0), +9999 HP (variable operand 9999), no death.
    expect(
      changeHp({ type: 'fixed', actorId: 0 }, 'increase', { type: 'constant', value: 9999 }),
    ).toEqual({ code: 311, indent: 0, parameters: [0, 0, 0, 0, 9999, false] });
    // MP has no 6th flag param.
    expect(
      changeMp({ type: 'fixed', actorId: 0 }, 'increase', { type: 'constant', value: 9999 }),
    ).toEqual({ code: 312, indent: 0, parameters: [0, 0, 0, 0, 9999] });
    // EXP: showLevelUp flag; decrease → operation 1; variable operand → operandType 1.
    expect(
      changeExp({ type: 'fixed', actorId: 0 }, 'increase', { type: 'constant', value: 400 }),
    ).toEqual({ code: 315, indent: 0, parameters: [0, 0, 0, 0, 400, false] });
    expect(
      changeLevel(
        { type: 'variable', variableId: 3 },
        'decrease',
        { type: 'variable', variableId: 7 },
        true,
      ).parameters,
    ).toEqual([1, 3, 1, 1, 7, true]);
  });

  it('change state and recover all encode the actor target', () => {
    expect(changeState({ type: 'fixed', actorId: 1 }, 'add', 4)).toEqual({
      code: 313,
      indent: 0,
      parameters: [0, 1, 0, 4],
    });
    expect(changeState({ type: 'fixed', actorId: 1 }, 'remove', 4).parameters).toEqual([
      0, 1, 1, 4,
    ]);
    // Real editor output: recover the whole party.
    expect(recoverAll({ type: 'fixed', actorId: 0 })).toEqual({
      code: 314,
      indent: 0,
      parameters: [0, 0],
    });
  });
});
