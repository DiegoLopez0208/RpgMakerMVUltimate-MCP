#!/usr/bin/env node
// Run against a licensed local MV engine; engine source stays outside this repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--engine') {
  console.error('Usage: node scripts/verify-mv-event-runtime.mjs --engine /path/to/project/js/rpg_objects.js');
  console.error('Run npm run build first. Requires the sibling rpg_core.js from your licensed MV project.');
  process.exitCode = 1;
} else {
  await main(resolve(args[1]));
}

async function main(enginePath) {
  const corePath = join(dirname(enginePath), 'rpg_core.js');
  const [objectsSource, coreSource] = await Promise.all([
    readFile(enginePath, 'utf8'),
    readFile(corePath, 'utf8'),
  ]);
  assert.match(coreSource, /Utils\.RPGMAKER_NAME\s*=\s*['"]MV['"]/,
    'The supplied engine must be RPG Maker MV.');
  const version = coreSource.match(/Utils\.RPGMAKER_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? 'unknown';
  const extensionsEnd = coreSource.indexOf('function Utils()');
  assert.ok(extensionsEnd > 0, 'Could not find MV standard JavaScript extensions.');
  // Only MV's standard JS extensions are needed; its renderer requires browser globals.
  const extensionsSource = coreSource.slice(0, extensionsEnd);
  const { buildEventCommands } = await import('../dist/utils/eventCommandBuilders.js');
  const build = (kind, parameters) => buildEventCommands({ kind, ...parameters }).commands;
  const terminator = { code: 0, indent: 0, parameters: [] };
  let passed = 0;

  function run(commands, options = {}) {
    const context = vm.createContext({});
    const evaluate = (source) => vm.runInContext(source, context, { timeout: 2000 });
    vm.runInContext(extensionsSource, context, { filename: basename(corePath), timeout: 2000 });
    vm.runInContext(objectsSource, context, { filename: basename(enginePath), timeout: 2000 });
    context.fixtureJson = JSON.stringify({ commands: [...commands, terminator], ...options });
    evaluate(`
      var fixture = JSON.parse(fixtureJson);
      var refreshes = 0;
      var requestedFaces = [];
      var transfers = [];
      var plugins = [];
      var SceneManager = { isSceneChanging: function() { return false; } };
      var Graphics = { frameCount: 0 };
      var ImageManager = { requestFace: function(name) { requestedFaces.push(name); } };
      var $dataSystem = { switches: new Array(256), variables: new Array(256) };
      var $dataCommonEvents = fixture.commonEvents || [];
      var $gameMap = {
        mapId: function() { return 7; },
        requestRefresh: function() { refreshes++; }
      };
      var $gameParty = { inBattle: function() { return false; } };
      var $gamePlayer = {
        pending: false,
        reserveTransfer: function(mapId, x, y, direction, fade) {
          transfers.push([mapId, x, y, direction, fade]);
          this.pending = true;
        },
        isTransferring: function() { return this.pending; }
      };
      var $gameSwitches = new Game_Switches();
      var $gameVariables = new Game_Variables();
      var $gameSelfSwitches = new Game_SelfSwitches();
      var $gameMessage = new Game_Message();
      Object.keys(fixture.variables || {}).forEach(function(id) {
        $gameVariables.setValue(Number(id), fixture.variables[id]);
      });
      Object.keys(fixture.switches || {}).forEach(function(id) {
        $gameSwitches.setValue(Number(id), fixture.switches[id]);
      });
      Game_Interpreter.prototype.pluginCommand = function(command, args) {
        plugins.push({ command: command, args: args });
      };
      // Keep random operands deterministic while still calling MV's real Math.randomInt.
      var randomValues = [0, 0.999999, 0.5];
      var randomIndex = 0;
      Math.random = function() { return randomValues[randomIndex++ % randomValues.length]; };
      var interpreter = new Game_Interpreter();
      interpreter.setup(fixture.commands, fixture.eventId === undefined ? 3 : fixture.eventId);
    `);
    const messages = [];
    const transferWaits = [];
    const answers = [...(options.choices ?? [])];
    const snapshot = (expression) => JSON.parse(evaluate(`JSON.stringify(${expression})`));
    for (let frame = 0; frame < 100 && evaluate('interpreter.isRunning()'); frame++) {
      evaluate('Graphics.frameCount++; interpreter.update();');
      if (evaluate('$gameMessage.isBusy()')) {
        messages.push(snapshot(`({
          text: $gameMessage.allText(), faceName: $gameMessage.faceName(),
          faceIndex: $gameMessage.faceIndex(), background: $gameMessage.background(),
          positionType: $gameMessage.positionType(), choices: $gameMessage.choices(),
          defaultType: $gameMessage.choiceDefaultType(), cancelType: $gameMessage.choiceCancelType(),
          choiceBackground: $gameMessage.choiceBackground(),
          choicePositionType: $gameMessage.choicePositionType()
        })`));
        if (evaluate('$gameMessage.isChoice()')) {
          assert.ok(answers.length, 'A runtime choice requires an explicit simulated answer.');
          context.answer = answers.shift();
          evaluate('$gameMessage.onChoice(answer);');
        }
        evaluate('$gameMessage.clear();');
      }
      if (evaluate('$gamePlayer.pending')) {
        const before = snapshot('({ index: interpreter._index, variables: $gameVariables._data })');
        evaluate('Graphics.frameCount++; interpreter.update();');
        assert.deepEqual(snapshot('({ index: interpreter._index, variables: $gameVariables._data })'), before,
          'Transfer must block subsequent event execution until the player finishes transferring.');
        transferWaits.push(before);
        evaluate('$gamePlayer.pending = false;');
      }
    }
    assert.equal(evaluate('interpreter.isRunning()'), false, 'Event did not finish within 100 simulated frames.');
    assert.equal(answers.length, 0, 'Not all simulated choice answers were consumed.');
    return {
      variable: (id) => evaluate(`$gameVariables.value(${id})`),
      switch: (id) => evaluate(`$gameSwitches.value(${id})`),
      selfSwitch: (mapId, eventId, letter) => evaluate(`$gameSelfSwitches.value(${JSON.stringify([mapId, eventId, letter])})`),
      messages, transferWaits,
      transfers: snapshot('transfers'), plugins: snapshot('plugins'),
      requestedFaces: snapshot('requestedFaces'), frames: evaluate('Graphics.frameCount'),
    };
  }

  function check(name, execute) {
    execute();
    passed++;
    console.log(`PASS ${name}`);
  }

  // Scenarios below use builders directly, then check actual MV interpreter effects.
  const variable = (variableId, value) => build('control_variable', {
    variableId, operation: 'set', operand: { type: 'constant', value },
  });
  const controlSwitch = (switchId, value, endId = switchId) => build('control_switch', {
    scope: 'switch', switchId, endId, value,
  });

  for (const [answer, expected] of [[0, 11], [1, 22], [-2, 33]]) {
    check(`choice ${answer === -2 ? 'cancel' : answer} executes only its selected branch`, () => {
      const result = run([
        ...build('show_choices', {
          choices: ['Accept', 'Decline'], cancelType: -2,
          branches: [variable(1, 11), variable(1, 22)], cancelBranch: variable(1, 33),
        }),
        ...variable(2, 99),
      ], { choices: [answer] });
      assert.equal(result.variable(1), expected);
      assert.equal(result.variable(2), 99);
      assert.deepEqual(result.messages[0].choices, ['Accept', 'Decline']);
      assert.equal(result.messages[0].cancelType, -2);
    });
  }

  check('nested conditions take the inner else without taking the outer else', () => {
    const result = run([
      ...controlSwitch(1, 'on'),
      ...build('conditional_branch', {
        condition: { type: 'switch', switchId: 1, value: 'on' },
        thenBranch: build('conditional_branch', {
          condition: { type: 'switch', switchId: 2, value: 'on' },
          thenBranch: variable(1, 10), elseBranch: variable(1, 20),
        }),
        elseBranch: variable(1, 30),
      }),
      ...variable(2, 99),
    ]);
    assert.equal(result.variable(1), 20);
    assert.equal(result.variable(2), 99);
  });

  check('choices nested inside a condition preserve branch indentation', () => {
    const commands = build('conditional_branch', {
      condition: { type: 'switch', switchId: 1, value: 'on' },
      thenBranch: build('show_choices', {
        choices: ['First', 'Second'], cancelType: -1,
        branches: [variable(1, 10), variable(1, 20)],
      }),
      elseBranch: variable(1, 30),
    });
    assert.equal(run(commands, { switches: { 1: true }, choices: [1] }).variable(1), 20);
    assert.equal(run(commands, { switches: { 1: false } }).variable(1), 30);
  });

  check('all six variable comparisons, constants, and variable operands', () => {
    for (const [comparison, left, right, expected] of [
      ['==', 5, 5, true], ['==', 4, 5, false],
      ['>=', 5, 5, true], ['>=', 4, 5, false],
      ['<=', 5, 5, true], ['<=', 6, 5, false],
      ['>', 6, 5, true], ['>', 5, 5, false],
      ['<', 4, 5, true], ['<', 5, 5, false],
      ['!=', 4, 5, true], ['!=', 5, 5, false],
    ]) {
      for (const operand of [{ constant: right }, { variableOperand: 2 }]) {
        const result = run(build('conditional_branch', {
          condition: { type: 'variable', variableId: 1, comparison, ...operand },
          thenBranch: variable(3, 1), elseBranch: variable(3, 2),
        }), { variables: { 1: left, 2: right } });
        assert.equal(result.variable(3), expected ? 1 : 2, `${left} ${comparison} ${right}`);
      }
    }
  });

  check('switch ranges and self switches use MV map-event scope', () => {
    const selfSwitch = (name, value) => build('control_switch', { scope: 'self_switch', name, value });
    const commands = [
      ...controlSwitch(1, 'on', 3), ...controlSwitch(2, 'off'),
      ...selfSwitch('A', 'on'), ...selfSwitch('B', 'on'), ...selfSwitch('B', 'off'),
      ...build('conditional_branch', {
        condition: { type: 'self_switch', name: 'A', value: 'on' },
        thenBranch: variable(1, 1), elseBranch: variable(1, 2),
      }),
    ];
    const result = run(commands);
    assert.deepEqual([1, 2, 3].map((id) => result.switch(id)), [true, false, true]);
    assert.equal(result.selfSwitch(7, 3, 'A'), true);
    assert.equal(result.selfSwitch(7, 3, 'B'), false);
    assert.equal(result.selfSwitch(7, 4, 'A'), false);
    assert.equal(result.variable(1), 1);
    assert.equal(run(commands, { eventId: 0 }).selfSwitch(7, 0, 'A'), false);
  });

  check('variable arithmetic and ranges preserve MV integer division', () => {
    const commands = build('control_variable', {
      variableId: 1, endId: 6, operation: 'set', operand: { type: 'constant', value: 10 },
    });
    for (const [variableId, operation, value] of [
      [1, 'add', 7], [2, 'sub', 2], [3, 'mul', 3], [4, 'div', 4], [5, 'mod', 4], [6, 'set', 99],
    ]) {
      commands.push(...build('control_variable', {
        variableId, operation, operand: { type: 'constant', value },
      }));
    }
    commands.push(...build('control_variable', {
      variableId: 1, endId: 3, operation: 'add', operand: { type: 'constant', value: 1 },
    }));
    const result = run(commands);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((id) => result.variable(id)), [18, 9, 31, 2, 2, 99]);
  });

  check('variable, inclusive random, and game-data operands execute in MV', () => {
    const result = run([
      ...variable(30, 13),
      ...build('control_variable', {
        variableId: 10, endId: 11, operation: 'set', operand: { type: 'variable', variableId: 30 },
      }),
      ...build('control_variable', {
        variableId: 20, endId: 22, operation: 'set', operand: { type: 'random', min: 4, max: 6 },
      }),
      ...build('control_variable', {
        variableId: 31, operation: 'set', operand: { type: 'game_data', dataType: 7, param1: 0 },
      }),
    ]);
    assert.deepEqual([10, 11, 20, 21, 22, 31].map((id) => result.variable(id)), [13, 13, 4, 6, 5, 7]);
  });

  check('nested common-event children complete before the parent resumes', () => {
    const add = (value) => build('control_variable', {
      variableId: 40, operation: 'add', operand: { type: 'constant', value },
    });
    const result = run([
      ...variable(40, 1),
      ...build('common_event', { commonEventId: 1 }),
      ...build('control_variable', {
        variableId: 40, operation: 'mul', operand: { type: 'constant', value: 10 },
      }),
    ], { commonEvents: [null,
      { id: 1, list: [
        ...add(2), ...build('common_event', { commonEventId: 2 }),
        ...build('control_switch', { scope: 'self_switch', name: 'C', value: 'on' }), terminator,
      ] },
      { id: 2, list: [...add(3), terminator] },
    ] });
    assert.equal(result.variable(40), 60);
    assert.equal(result.selfSwitch(7, 3, 'C'), true);
  });

  check('direct and variable transfers reserve correct coordinates and wait', () => {
    const result = run([
      ...build('transfer_player', { mapId: 2, x: 4, y: 6, direction: 'up', fade: 'none' }),
      ...variable(1, 9), ...variable(2, 12), ...variable(3, 14),
      ...build('transfer_player', {
        designation: 'variable', mapId: 1, x: 2, y: 3, direction: 'left', fade: 'white',
      }),
      ...variable(4, 99),
    ]);
    assert.deepEqual(result.transfers, [[2, 4, 6, 8, 2], [9, 12, 14, 4, 1]]);
    assert.equal(result.transferWaits.length, 2);
    assert.equal(result.variable(4), 99);
  });

  check('MV four-parameter Show Text shares its message with following choices', () => {
    const textCommands = build('show_text', {
      lines: ['First line', 'Second line'], faceName: 'Actor1', faceIndex: 3,
      background: 'dim', position: 'middle',
    });
    assert.equal(textCommands[0].parameters.length, 4);
    const result = run([
      ...textCommands,
      ...build('show_choices', {
        choices: ['Continue', 'Wait'], branches: [variable(50, 1), variable(50, 2)],
        cancelType: -1, defaultType: 1, background: 'transparent', position: 'left',
      }),
    ], { choices: [1] });
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], {
      text: 'First line\nSecond line', faceName: 'Actor1', faceIndex: 3,
      background: 1, positionType: 1, choices: ['Continue', 'Wait'],
      defaultType: 1, cancelType: -1, choiceBackground: 2, choicePositionType: 0,
    });
    assert.equal(result.variable(50), 2);
    assert.deepEqual(result.requestedFaces, ['Actor1']);
  });

  check('MV command356 invokes the plugin hook with unchanged space splitting', () => {
    const result = run(build('plugin_command', { text: 'AuditHook set  value' }));
    assert.deepEqual(result.plugins, [{ command: 'AuditHook', args: ['set', '', 'value'] }]);
  });

  check('labels, waits, and exit processing control actual execution', () => {
    const result = run([
      ...variable(1, 1),
      ...build('flow', { action: 'jump_to_label', name: 'finish' }),
      ...variable(1, 999),
      ...build('flow', { action: 'label', name: 'finish' }),
      ...build('flow', { action: 'wait', frames: 2 }),
      ...variable(2, 7),
      ...build('flow', { action: 'exit_event' }),
      ...variable(2, 999),
    ]);
    assert.equal(result.variable(1), 1);
    assert.equal(result.variable(2), 7);
    assert.ok(result.frames >= 4, 'Two-frame wait must suspend execution across update frames.');
  });

  console.log(`Verified ${passed} scenarios against RPG Maker MV ${version}.`);
  console.log(`rpg_objects.js SHA256 ${createHash('sha256').update(objectsSource).digest('hex')}`);
  console.log(`rpg_core.js SHA256 ${createHash('sha256').update(coreSource).digest('hex')}`);
  console.log('Headless interpreter verification only; renderer, editor, installed plugins, and gameplay are not exercised.');
}
