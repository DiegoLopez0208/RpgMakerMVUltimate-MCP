import { describe, expect, it } from 'vitest';
import {
  BLOCK_ENDS, BLOCK_OPENERS, BLOCK_SECTIONS, CONTINUATION_FOR, EVENT_COMMANDS, FOLDED_CONTINUATIONS, commandName,
} from '../src/utils/eventCommandTable.js';
import { cmd } from '../src/utils/commandBuilder.js';
import type { EventCommand } from '../src/types/rpgmaker.js';

const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

describe('event command table', () => {
  it('derives the block structure the parser and validator rely on', () => {
    expect(sorted(BLOCK_OPENERS)).toEqual([102, 111, 112, 301]);
    expect(sorted(BLOCK_SECTIONS)).toEqual([402, 403, 411, 601, 602, 603]);
    expect(sorted(BLOCK_ENDS)).toEqual([404, 412, 413, 604]);
    expect(sorted(FOLDED_CONTINUATIONS)).toEqual([401, 405, 408, 605, 655]);
    expect(CONTINUATION_FOR).toEqual({ 101: 401, 105: 405, 108: 408, 205: 505, 302: 605, 355: 655 });
  });

  it('keeps every entry internally consistent', () => {
    for (const [code, spec] of Object.entries(EVENT_COMMANDS)) {
      expect(spec.name.trim(), `code ${code}`).not.toBe('');
      if (spec.continues !== undefined) expect(EVENT_COMMANDS[spec.continues], `header of ${code}`).toBeDefined();
      if (spec.folds) expect(spec.continues, `${code} folds but continues nothing`).toBeDefined();
      if (Array.isArray(spec.arity)) expect(spec.arity.length, `code ${code}`).toBeGreaterThan(0);
      const counts = spec.arity === undefined ? [] : typeof spec.arity === 'number' ? [spec.arity] : spec.arity;
      if (counts.length > 0 && spec.numeric) {
        const widest = Math.max(...counts);
        for (const slot of spec.numeric) expect(slot, `numeric slot of ${code}`).toBeLessThan(widest);
      }
    }
  });

  it('names unknown codes without throwing', () => {
    expect(commandName(121)).toBe('Control Switches');
    expect(commandName(342)).toBe('Change Enemy TP');
    expect(commandName(9999)).toBe('Command 9999');
  });
});

describe('legacy cmd builders stay within the table', () => {
  // One representative call per builder. A builder added to `cmd` without a call here fails the
  // coverage check below, so the table and the builders cannot drift apart silently.
  const calls: Record<string, () => EventCommand[]> = {
    message: () => cmd.message('Hello\nWorld', '', 0),
    choice: () => cmd.choice(['Yes', 'No'], -1),
    branchChoice: () => cmd.branchChoice(0, 'Yes'),
    endChoices: () => cmd.endChoices(),
    conditionalSwitch: () => cmd.conditionalSwitch(1, true),
    conditionalSelfSwitch: () => cmd.conditionalSelfSwitch('A', true),
    conditionalVariable: () => cmd.conditionalVariable(1, 0, 5),
    endConditional: () => cmd.endConditional(),
    switchControl: () => cmd.switchControl(1, true),
    selfSwitchControl: () => cmd.selfSwitchControl('A', true),
    variableControl: () => cmd.variableControl(1, 0, 5),
    giveItem: () => cmd.giveItem(1, 1),
    giveWeapon: () => cmd.giveWeapon(1, 1),
    giveArmor: () => cmd.giveArmor(1, 1),
    giveMoney: () => cmd.giveMoney(100),
    teleport: () => cmd.teleport(1, 2, 3, 2, 0),
    showAnimation: () => cmd.showAnimation(1, 1),
    playBGM: () => cmd.playBGM('Theme1', 90, 100, 0),
    fadeBGM: () => cmd.fadeBGM(2),
    playSE: () => cmd.playSE('Cursor1', 90, 100, 0),
    playBGS: () => cmd.playBGS('River', 90, 100, 0),
    fadeoutBGS: () => cmd.fadeoutBGS(2),
    playME: () => cmd.playME('Fanfare1', 90, 100, 0),
    wait: () => cmd.wait(30),
    label: () => cmd.label('start'),
    jumpToLabel: () => cmd.jumpToLabel('start'),
    eraseEvent: () => cmd.eraseEvent(),
    gameOver: () => cmd.gameOver(),
    showPicture: () => cmd.showPicture(1, 'Picture', 0, 0),
    pluginCommand: () => cmd.pluginCommand('DoorCtl open 1'),
    comment: () => cmd.comment('note'),
    changePartyMember: () => cmd.changePartyMember(1, true),
    changeHP: () => cmd.changeHP(1, 10, true),
    changeMP: () => cmd.changeMP(1, 10, true),
    changeEXP: () => cmd.changeEXP(1, 10, true),
    changeLevel: () => cmd.changeLevel(1, 1, true),
    changeSkill: () => cmd.changeSkill(1, 1, true),
    changeState: () => cmd.changeState(1, 1, true),
    changeEquip: () => cmd.changeEquip(1, 1, 1),
    scrollMap: () => cmd.scrollMap(2, 1, 4),
    battleProcessing: () => cmd.battleProcessing(1, true, false),
    shopProcessing: () => cmd.shopProcessing([[0, 1, 0, 0]], false),
    nameInput: () => cmd.nameInput(1, 8),
    changeMapDisplayName: () => cmd.changeMapDisplayName('Town'),
    setMoveRoute: () => cmd.setMoveRoute(0, [cmd.moveRouteCommand(1, [])]),
    recoverAll: () => cmd.recoverAll(1),
    changeActorName: () => cmd.changeActorName(1, 'Hero'),
    changeActorClass: () => cmd.changeActorClass(1, 2),
    end: () => cmd.end(),
  };

  it('has a representative call for every builder', () => {
    // moveRouteCommand builds a move-route step (its own code space), not an event command.
    const builders = Object.keys(cmd).filter(name => name !== 'moveRouteCommand').sort();
    expect(Object.keys(calls).sort()).toEqual(builders);
  });

  it.each(Object.entries(calls))('%s emits known codes with an accepted parameter count', (_name, call) => {
    for (const command of call()) {
      const spec = EVENT_COMMANDS[command.code];
      expect(spec, `code ${command.code}`).toBeDefined();
      if (spec.arity !== undefined) {
        const allowed = typeof spec.arity === 'number' ? [spec.arity] : spec.arity;
        expect(allowed, `code ${command.code} with ${JSON.stringify(command.parameters)}`).toContain(command.parameters.length);
      }
    }
  });
});
